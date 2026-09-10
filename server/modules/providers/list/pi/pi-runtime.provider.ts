import { spawn, type ChildProcess } from 'node:child_process';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  isAllowedImageSourcePath,
  normalizeAttachmentDescriptors,
  resolveImageAbsolutePath,
} from '@/shared/image-attachments.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

import { getPiCommand } from './pi-auth.provider.js';
import { redactPiDiagnosticText } from './pi-sessions.provider.js';

const activeProcesses = new Map<string, ChildProcess>();
const abortedSessionIds = new Set<string>();
const DEFAULT_PI_RUN_TIMEOUT_MS = 60 * 60 * 1000;

function resolvePiRunTimeoutMs(): number {
  const configured = Number(process.env.PI_RUN_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PI_RUN_TIMEOUT_MS;
}

/**
 * Provider registry runtime adapter driving the Pi CLI in one-shot JSON mode
 * (`pi --mode json -p`). Each `chat.send` spawns one process whose stdout is a
 * newline-delimited JSON event stream ending with `agent_end`/`agent_settled`.
 *
 * Session identity: a brand-new run's first stdout line is the session header,
 * whose UUID is announced as `session_created`; resuming passes `--session
 * <uuid>` and appends to the same transcript. Abort uses SIGTERM (Pi's print
 * mode has no stdin control protocol) with a SIGKILL backstop.
 *
 * Errors: Pi exits 0 even when a turn ends with `stopReason: "error"`, so the
 * terminal failure is derived from the message payload; startup/argument
 * errors exit non-zero with no terminal event. `--no-approve` is always passed
 * so an untrusted project never blocks the run on a trust prompt.
 */
export const piRuntime: IProviderRuntime = {
  async run(command, options, writer, context): Promise<unknown> {
    const appSessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
    if (!appSessionId) {
      writer.send(createCompleteMessage({ provider: 'pi', sessionId: null, exitCode: 1 }));
      return;
    }

    let resolvedModel: string | undefined;
    let workingDir: string;
    let providerSessionId: string | null;
    try {
      resolvedModel = await context.resolveResumeModel(appSessionId, options.model);
      workingDir = typeof options.cwd === 'string' && options.cwd
        ? options.cwd
        : typeof options.projectPath === 'string' && options.projectPath
          ? options.projectPath
          : process.cwd();
      providerSessionId = context.resolveProviderSessionId(appSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writer.send(createNormalizedMessage({
        kind: 'error',
        provider: 'pi',
        sessionId: appSessionId,
        content: message,
      }));
      writer.send(createCompleteMessage({ provider: 'pi', sessionId: appSessionId, exitCode: 1 }));
      return;
    }

    return new Promise<void>((resolveRun) => {
      if (activeProcesses.has(appSessionId)) {
        writer.send(createNormalizedMessage({
          kind: 'error',
          provider: 'pi',
          sessionId: appSessionId,
          content: 'This Pi session already has a running task.',
        }));
        writer.send(createCompleteMessage({ provider: 'pi', sessionId: appSessionId, exitCode: 1 }));
        resolveRun();
        return;
      }
      // A stale flag from a superseded run must not mark this run aborted.
      abortedSessionIds.delete(appSessionId);

      const args: string[] = ['--mode', 'json', '-p'];
      if (providerSessionId) {
        args.push('--session', providerSessionId);
      }
      if (resolvedModel) {
        args.push('--model', resolvedModel);
      }
      if (typeof options.effort === 'string' && options.effort !== 'default') {
        args.push('--thinking', options.effort);
      }
      // Pi's only native safety lever is the built-in tool allowlist: the
      // read-only mode pins it to the read-only tools (mirroring Pi's own
      // documented read-only example). Any other mode (default, and the agent
      // runner's bypassPermissions) means Pi runs tools autonomously.
      if (options.permissionMode === 'readonly') {
        args.push('--tools', 'read,grep,find,ls');
      }
      // Never block on a project trust prompt; project-local files load only
      // when Pi already trusts the project from an interactive session.
      args.push('--no-approve');

      // All trusted attachments (images and files) ride Pi's native `@file`
      // positional arguments, which Pi reads into context itself.
      for (const descriptor of normalizeAttachmentDescriptors(options.attachments)) {
        const resolvedPath = resolveImageAbsolutePath(workingDir, descriptor.path);
        if (!isAllowedImageSourcePath(resolvedPath, workingDir)) {
          continue;
        }
        args.push(`@${resolvedPath}`);
      }

      if (typeof command === 'string' && command.trim()) {
        args.push('--', command.trim());
      }

      const child = spawn(getPiCommand(), args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      activeProcesses.set(appSessionId, child);

      const sessionName = typeof options.sessionSummary === 'string'
        ? options.sessionSummary
        : undefined;
      const userId = writer.userId ?? null;

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let capturedSessionId: string | null = null;
      let sessionCreatedSent = false;
      let completeSent = false;
      let pendingFinish: { exitCode: number; aborted?: boolean; error?: string } | null = null;
      let timedOut = false;
      let terminationRequested = false;
      let timeoutId: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const finish = (payload: { exitCode: number; aborted?: boolean; error?: string }) => {
        if (completeSent) {
          return;
        }
        completeSent = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        resolveRun();
        writer.send(createCompleteMessage({
          provider: 'pi',
          sessionId: appSessionId,
          actualSessionId: capturedSessionId ?? undefined,
          exitCode: payload.exitCode,
          aborted: payload.aborted,
        }));
        if (payload.aborted) {
          notifyRunStopped({ userId, provider: 'pi', sessionId: appSessionId, sessionName, stopReason: 'aborted' });
        } else if (payload.exitCode === 0) {
          notifyRunStopped({ userId, provider: 'pi', sessionId: appSessionId, sessionName, stopReason: 'completed' });
        } else {
          notifyRunFailed({
            userId,
            provider: 'pi',
            sessionId: appSessionId,
            sessionName,
            error: payload.error ?? `Pi exited with code ${payload.exitCode}`,
          });
        }
      };

      const terminateChild = () => {
        if (terminationRequested) {
          return;
        }
        terminationRequested = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // The process may have exited between a terminal stream event and the signal.
        }
        forceKillTimer = setTimeout(() => {
          if (!completeSent) {
            try {
              child.kill('SIGKILL');
            } catch {
              // Already gone.
            }
          }
        }, 3000);
        forceKillTimer.unref();
      };

      const failAndTerminate = (error: string) => {
        if (completeSent || terminationRequested) {
          return;
        }
        pendingFinish = { exitCode: 1, error };
        writer.send(createNormalizedMessage({
          kind: 'error',
          provider: 'pi',
          sessionId: appSessionId,
          content: error,
        }));
        terminateChild();
      };

      // The prompt travels as an argv message, so stdin can close immediately.
      child.stdin.on('error', (error) => {
        if (completeSent) {
          return;
        }
        console.error('[Pi] CLI stdin error', {
          sessionId: appSessionId,
          code: (error as NodeJS.ErrnoException).code,
        });
        if (abortedSessionIds.has(appSessionId)) {
          terminateChild();
          return;
        }
        failAndTerminate('Pi input channel closed unexpectedly.');
      });
      child.stdin.end();

      timeoutId = setTimeout(() => {
        if (completeSent || terminationRequested) {
          return;
        }
        timedOut = true;
        const timeoutMs = resolvePiRunTimeoutMs();
        const error = `Pi run timed out after ${timeoutMs}ms`;
        console.error('[Pi] CLI run timed out', { sessionId: appSessionId, timeoutMs });
        failAndTerminate(error);
      }, resolvePiRunTimeoutMs());
      timeoutId.unref();

      const announceSession = () => {
        if (providerSessionId || !capturedSessionId || sessionCreatedSent) {
          return;
        }
        sessionCreatedSent = true;
        writer.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: appSessionId,
          provider: 'pi',
        }));
      };

      const processLine = (line: string) => {
        if (!line.trim()) {
          return;
        }
        let event: AnyRecord;
        try {
          event = JSON.parse(line) as AnyRecord;
        } catch {
          console.warn('[Pi] Ignoring invalid json-mode line', {
            sessionId: appSessionId,
            lineLength: line.length,
          });
          return;
        }

        // The first line is the session header; Pi writes it before any events.
        if (event.type === 'session') {
          if (typeof event.id === 'string' && event.id && !capturedSessionId) {
            capturedSessionId = event.id;
          }
          announceSession();
          return;
        }

        if (event.type === 'message_end') {
          const message = event.message as AnyRecord | null;
          const role = message?.role;
          // Pi echoes the user prompt back as a message_end; skip it so the
          // frontend does not render a duplicate of the composer message.
          if (role === 'user') {
            return;
          }
          const isErrorTurn = role === 'assistant' && message?.stopReason === 'error';
          if (isErrorTurn) {
            const errorText = typeof message?.errorMessage === 'string' && message.errorMessage.trim()
              ? redactPiDiagnosticText(message.errorMessage)
              : 'Pi run failed';
            pendingFinish = { exitCode: 1, error: errorText };
          } else if (role === 'assistant') {
            // A later successful assistant turn clears an earlier error
            // (Pi retries some failed turns), matching Codex's review note.
            pendingFinish = { exitCode: 0 };
          }
          for (const normalized of context.normalizeMessage(event, appSessionId)) {
            writer.send(normalized);
          }
          return;
        }

        if (event.type === 'agent_end' || event.type === 'agent_settled') {
          // The run has produced its last event; only a terminal error keeps
          // the failure outcome. agent_end/agent_settled must not overwrite it.
          if (!pendingFinish) {
            pendingFinish = { exitCode: 0 };
          }
          return;
        }

        // message_start/message_update/tool_execution_*/turn_* stream deltas
        // that message_end supersedes — nothing to render incrementally yet.
        if (
          event.type === 'message_start'
          || event.type === 'message_update'
          || event.type === 'tool_execution_start'
          || event.type === 'tool_execution_update'
          || event.type === 'tool_execution_end'
          || event.type === 'turn_start'
          || event.type === 'turn_end'
          || event.type === 'agent_start'
          || event.type === 'queue_update'
          || event.type === 'compaction_start'
          || event.type === 'compaction_end'
        ) {
          return;
        }

        console.warn('[Pi] Ignoring unsupported json event', {
          sessionId: appSessionId,
          eventType: typeof event.type === 'string' ? event.type : 'missing',
        });
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          newlineIndex = stdoutBuffer.indexOf('\n');
          processLine(line);
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        if (text) {
          stderrBuffer += text;
          console.error('[Pi] CLI stderr', {
            sessionId: appSessionId,
            message: redactPiDiagnosticText(text.trim()),
          });
        }
      });
      child.on('error', (error) => {
        if (activeProcesses.get(appSessionId) === child) {
          activeProcesses.delete(appSessionId);
        }
        finish({ exitCode: 1, error: error.message });
      });
      child.on('close', (code) => {
        if (activeProcesses.get(appSessionId) === child) {
          activeProcesses.delete(appSessionId);
        }
        const wasAborted = abortedSessionIds.delete(appSessionId);
        // Pi may emit its final JSON event without a trailing newline, leaving
        // it stranded in the split buffer. Flush it before judging the run.
        if (stdoutBuffer.trim()) {
          const remainingLine = stdoutBuffer.trim();
          stdoutBuffer = '';
          processLine(remainingLine);
        }
        if (!completeSent) {
          if (!wasAborted && code !== 0 && !pendingFinish) {
            // Startup/argument errors produce no terminal event; surface
            // stderr as an error row so the failure is visible in the chat.
            const stderrText = stderrBuffer.trim();
            const errorText = stderrText
              ? redactPiDiagnosticText(stderrText)
              : `Pi exited with code ${code ?? 'unknown'}`;
            console.error('[Pi] CLI exited before a terminal event', {
              sessionId: appSessionId,
              exitCode: code ?? 'unknown',
            });
            writer.send(createNormalizedMessage({
              kind: 'error',
              provider: 'pi',
              sessionId: appSessionId,
              content: errorText,
            }));
            finish({ exitCode: 1, error: errorText });
          } else {
            finish(wasAborted
              ? { exitCode: 0, aborted: true }
              : timedOut
                ? pendingFinish ?? { exitCode: 1, error: 'Pi run timed out' }
                : pendingFinish ?? { exitCode: code === 0 ? 0 : 1, error: code === 0 ? undefined : `Pi exited with code ${code ?? 'unknown'}` });
          }
        } else {
          resolveRun();
        }
      });
    });
  },

  async abort(sessionId: string): Promise<boolean> {
    const child = activeProcesses.get(sessionId);
    if (!child) {
      return false;
    }
    abortedSessionIds.add(sessionId);
    try {
      child.kill('SIGTERM');
    } catch {
      abortedSessionIds.delete(sessionId);
      return false;
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, 3000).unref();
    return true;
  },
};

/** Drops process tracking (used by tests). */
export function resetPiRuntimeForTests(): void {
  for (const child of activeProcesses.values()) {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
  activeProcesses.clear();
  abortedSessionIds.clear();
}
