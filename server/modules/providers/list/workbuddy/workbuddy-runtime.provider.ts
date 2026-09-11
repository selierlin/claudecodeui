import { spawn, type ChildProcess } from 'node:child_process';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { buildWorkbuddyStreamJsonInput } from '@/shared/image-attachments.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';
import {
  createCompleteMessage,
  createDeltaBatcher,
  createNormalizedMessage,
  omitStreamedAssistantBlocks,
  readObjectRecord,
} from '@/shared/utils.js';

import { getWorkbuddyCommand } from './workbuddy-auth.provider.js';
import { resolveWorkbuddyConfigDir } from './workbuddy-storage.provider.js';

/**
 * Maps the app permission mode onto CodeBuddy's `--permission-mode` choices.
 * The engines share the same vocabulary, so modes pass through 1:1.
 */
const PERMISSION_MODE_MAP: Record<string, string | undefined> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
  plan: 'plan',
  auto: 'auto',
  dontAsk: 'dontAsk',
};

const activeProcesses = new Map<string, ChildProcess>();
// Sessions whose abort() was requested but whose process has not reaped yet.
// The `close` handler consumes the flag so the terminal event reports the run
// as aborted instead of a failed exit code.
const abortedSessionIds = new Set<string>();
const DEFAULT_WORKBUDDY_RUN_TIMEOUT_MS = 60 * 60 * 1000;

function resolveWorkbuddyRunTimeoutMs(): number {
  const configured = Number(process.env.WORKBUDDY_RUN_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_WORKBUDDY_RUN_TIMEOUT_MS;
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*Bearer\s+)[^\s,;}]+/gi, '$1[REDACTED]')
    .replace(
      /((?:authorization|cookie|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|secret|password)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    )
    .slice(0, 2000);
}

/**
 * Validates an optional reasoning effort against the selected WorkBuddy model.
 * The runtime and composer both use the model catalog, so unsupported values
 * are omitted instead of being forwarded as a provider-specific no-op.
 */
async function resolveWorkbuddyEffort(
  requestedEffort: unknown,
  model: string | undefined,
  context: Parameters<IProviderRuntime['run']>[3],
): Promise<string | undefined> {
  if (typeof requestedEffort !== 'string' || requestedEffort === 'default' || !model) {
    return undefined;
  }

  const models = await context.getProviderModels();
  const allowedEfforts = models.OPTIONS.find((option) => option.value === model)?.effort?.values
    .map((entry) => entry.value) ?? [];
  return allowedEfforts.includes(requestedEffort) ? requestedEffort : undefined;
}

/**
 * Provider registry runtime adapter driving the WorkBuddy CLI in print mode
 * (`codebuddy -p --output-format stream-json`). Each run spawns one process;
 * stdout carries newline-delimited JSON events.
 */
export const workbuddyRuntime: IProviderRuntime = {
  async run(command, options, writer, context): Promise<unknown> {
    const appSessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
    if (!appSessionId) {
      writer.send(createCompleteMessage({ provider: 'workbuddy', sessionId: null, exitCode: 1 }));
      return;
    }
    let resolvedModel: string | undefined;
    let resolvedEffort: string | undefined;
    let workingDir: string;
    let providerSessionId: string | null;
    let streamInput: string;
    let configDir: string;
    try {
      // Prefer the model recorded on the session row when resuming; fall back to
      // the model selected in the composer for new sessions.
      resolvedModel = await context.resolveResumeModel(appSessionId, options.model);
      resolvedEffort = await resolveWorkbuddyEffort(options.effort, resolvedModel, context);
      workingDir = typeof options.cwd === 'string' && options.cwd
        ? options.cwd
        : typeof options.projectPath === 'string' && options.projectPath
          ? options.projectPath
          : process.cwd();
      providerSessionId = context.resolveProviderSessionId(appSessionId);

      // Always use the stream-json input protocol. Besides carrying image and
      // document blocks, it keeps stdin available for the official interrupt
      // control request while a task or workflow is still running.
      streamInput = await buildWorkbuddyStreamJsonInput(command, options.attachments, workingDir);
      configDir = resolveWorkbuddyConfigDir(context.resolveProviderConfigDir(appSessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writer.send(createNormalizedMessage({
        kind: 'error',
        provider: 'workbuddy',
        sessionId: appSessionId,
        content: message,
      }));
      writer.send(createCompleteMessage({ provider: 'workbuddy', sessionId: appSessionId, exitCode: 1 }));
      return;
    }

    return new Promise<void>((resolveRun) => {
      if (activeProcesses.has(appSessionId)) {
      writer.send(createNormalizedMessage({
        kind: 'error',
        provider: 'workbuddy',
        sessionId: appSessionId,
        content: 'This WorkBuddy session already has a running task.',
      }));
      writer.send(createCompleteMessage({ provider: 'workbuddy', sessionId: appSessionId, exitCode: 1 }));
      resolveRun();
        return;
      }
      // A stale flag from a superseded run must not mark this run aborted.
      abortedSessionIds.delete(appSessionId);

    // `--include-partial-messages` adds token-level `stream_event` frames
    // (content_block_delta) so the WebUI can render the reasoning trace and the
    // reply as they arrive instead of waiting for the whole assistant message.
    const args: string[] = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
    ];
    if (providerSessionId) {
      args.push('--resume', providerSessionId);
    }
    const permissionMode = typeof options.permissionMode === 'string'
      ? PERMISSION_MODE_MAP[options.permissionMode]
      : undefined;
    if (permissionMode) {
      args.push('--permission-mode', permissionMode);
    }
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }
    if (resolvedEffort) {
      args.push('--effort', resolvedEffort);
    }

    // The embedded engine defaults its config root to ~/.codebuddy, but the
    // WorkBuddy desktop app runs it against ~/.workbuddy — where the user's
    // skills, plugins, and sessions live. Resumed sessions use the config dir
    // recorded on the session row (so --resume finds the same transcript);
    // brand-new sessions fall back to ~/.workbuddy so the engine reads the
    // same skills/plugins as the desktop app.
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.CODEBUDDY_CONFIG_DIR = configDir;
    env.WORKBUDDY_CONFIG_DIR = configDir;

    const child = spawn(getWorkbuddyCommand(), args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    activeProcesses.set(appSessionId, child);

    // Partial messages arrive as one `stream_delta` per token; coalesce them
    // like the Claude runtime so a long reasoning pass cannot overrun this
    // run's replay buffer. `send` is the only outbound path from here on.
    //
    // `streamHalted` becomes true once this run must publish nothing further:
    // its terminal `complete` went out through the batcher, or the user aborted
    // it (the abort handler emits that complete directly, bypassing this
    // batcher, so `haltStream` arms the flag). A delta surfacing after that
    // would resurrect the client's already-finalized placeholder row.
    let streamHalted = false;
    const deltaBatcher = createDeltaBatcher((message) => {
      if (message.kind === 'complete') {
        streamHalted = true;
      }
      if (message.kind === 'stream_delta' && streamHalted) {
        return;
      }
      writer.send(message);
    });
    const send = (message: NormalizedMessage) => deltaBatcher.send(message);

    // Which channels the current assistant message already streamed, so the
    // full assistant events that follow `message_stop` do not repeat them.
    let streamedText = false;
    let streamedThinking = false;

    type HaltableChild = ChildProcess & { haltStream?: () => void };
    (child as HaltableChild).haltStream = () => {
      streamHalted = true;
      deltaBatcher.dispose();
    };

    const sessionName = typeof options.sessionSummary === 'string'
      ? options.sessionSummary
      : undefined;
    const userId = writer.userId ?? null;

    let stdoutBuffer = '';
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
      send(createCompleteMessage({
        provider: 'workbuddy',
        sessionId: appSessionId,
        actualSessionId: capturedSessionId ?? undefined,
        exitCode: payload.exitCode,
        aborted: payload.aborted,
      }));
      if (payload.aborted) {
        notifyRunStopped({ userId, provider: 'workbuddy', sessionId: appSessionId, sessionName, stopReason: 'aborted' });
      } else if (payload.exitCode === 0) {
        notifyRunStopped({ userId, provider: 'workbuddy', sessionId: appSessionId, sessionName, stopReason: 'completed' });
      } else {
        notifyRunFailed({
          userId,
          provider: 'workbuddy',
          sessionId: appSessionId,
          sessionName,
          error: payload.error ?? `WorkBuddy exited with code ${payload.exitCode}`,
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
      send(createNormalizedMessage({
        kind: 'error',
        provider: 'workbuddy',
        sessionId: appSessionId,
        content: error,
      }));
      terminateChild();
    };

    // A CloudCLI chat send is one WorkBuddy CLI invocation, so EOF must follow
    // its only stream-json input message. Otherwise the CLI can wait forever
    // for another input and never emit its terminal `result` event. A CLI can
    // still close that pipe before its process exits; without this listener
    // Node treats the asynchronous EPIPE as an unhandled EventEmitter error.
    child.stdin.on('error', (error) => {
      if (completeSent) {
        return;
      }
      console.error('[WorkBuddy] CLI stdin error', {
        sessionId: appSessionId,
        code: (error as NodeJS.ErrnoException).code,
      });
      if (abortedSessionIds.has(appSessionId)) {
        terminateChild();
        return;
      }
      failAndTerminate('WorkBuddy input channel closed unexpectedly.');
    });
    child.stdin.end(streamInput + '\n');

    timeoutId = setTimeout(() => {
      if (completeSent || terminationRequested) {
        return;
      }
      timedOut = true;
      const timeoutMs = resolveWorkbuddyRunTimeoutMs();
      const error = `WorkBuddy run timed out after ${timeoutMs}ms`;
      console.error('[WorkBuddy] CLI run timed out', {
        sessionId: appSessionId,
        timeoutMs,
      });
      // A terminal result is recorded before the process actually exits so
      // trailing workflow notifications remain deliverable. If the CLI hangs
      // after that result, the run timeout must still replace the pending
      // outcome and reap the process.
      failAndTerminate(error);
    }, resolveWorkbuddyRunTimeoutMs());
    timeoutId.unref();

    const announceSession = () => {
      // Resumed sessions already carry a provider id; only brand-new sessions
      // announce their id for persistence.
      if (providerSessionId || !capturedSessionId || sessionCreatedSent) {
        return;
      }
      sessionCreatedSent = true;
      send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        sessionId: appSessionId,
        provider: 'workbuddy',
      }));
    };

    const processLine = (line: string) => {
      if (!line.trim()) {
        return;
      }
      if (pendingFinish?.exitCode === 1) {
        return;
      }
      let event: AnyRecord;
      try {
        event = JSON.parse(line) as AnyRecord;
      } catch {
        console.warn('[WorkBuddy] Ignoring invalid stream-json line', {
          sessionId: appSessionId,
          lineLength: line.length,
        });
        return;
      }

      if (event.type === 'error') {
        // A fatal engine error (e.g. --resume pointing at an unknown session)
        // arrives as a single error event with no assistant/result follow-up.
        // Surface it to the frontend instead of dropping it silently.
        const errorText = typeof event.error === 'string' && event.error.trim()
          ? redactDiagnosticText(event.error)
          : typeof event.message === 'string' && event.message.trim()
            ? redactDiagnosticText(event.message)
            : 'WorkBuddy 运行失败';
        failAndTerminate(errorText);
        return;
      }

      if (event.type === 'stream_event') {
        const inner = readObjectRecord(event.event);
        if (!inner) {
          return;
        }
        // A new assistant message opens a fresh streaming window; clear the
        // channels the previous one recorded so its full copy is not falsely
        // suppressed (or a fresh one missed).
        if (inner.type === 'message_start') {
          streamedText = false;
          streamedThinking = false;
          return;
        }
        // content_block_delta → stream_delta, message_stop → stream_end.
        // Tracking the channel marks the block as streamed so the full
        // assistant events that follow `message_stop` do not repeat it.
        for (const message of context.normalizeMessage(inner, appSessionId)) {
          if (message.kind === 'stream_delta') {
            if (message.streamChannel === 'thinking') {
              streamedThinking = true;
            } else {
              streamedText = true;
            }
          }
          send(message);
        }
        return;
      }

      if (event.type === 'system' && event.subtype === 'init') {
        if (typeof event.session_id === 'string' && event.session_id) {
          capturedSessionId = event.session_id;
          announceSession();
        }
        return;
      }

      if (event.type === 'system' && typeof event.subtype === 'string' && event.subtype.startsWith('task_')) {
        for (const message of context.normalizeMessage(event, appSessionId)) {
          send(message);
        }
        return;
      }

      if (event.type === 'assistant' && !sessionCreatedSent && !providerSessionId) {
        // The engine publishes the session id on the first assistant event too.
        if (typeof event.session_id === 'string' && event.session_id && !capturedSessionId) {
          capturedSessionId = event.session_id;
        }
        announceSession();
      }

      if (event.type === 'assistant') {
        // The reply/thinking already streamed via `stream_event` deltas; keep
        // only the blocks that were not streamed (e.g. tool calls) so the full
        // assistant event does not render the text a second time.
        const assistantMessage = readObjectRecord(event.message);
        if (assistantMessage && Array.isArray(assistantMessage.content)) {
          event = {
            ...event,
            message: {
              ...assistantMessage,
              content: omitStreamedAssistantBlocks(assistantMessage.content, {
                text: streamedText,
                thinking: streamedThinking,
              }),
            },
          };
        }
        for (const message of context.normalizeMessage(event, appSessionId)) {
          send(message);
        }
        return;
      }

      if (event.type === 'reasoning') {
        // Model reasoning streams as its own top-level event while it thinks
        // between tool calls. Surface the text as a thinking message so the UI
        // shows an in-progress indicator instead of stalling on the last tool.
        for (const message of context.normalizeMessage(event, appSessionId)) {
          send(message);
        }
        return;
      }

      if (event.type === 'function_call' || event.type === 'function_call_result') {
        for (const message of context.normalizeMessage(event, appSessionId)) {
          send(message);
        }
        return;
      }

      if (event.type === 'control_response') {
        return;
      }

      if (event.type === 'result') {
        if (timedOut) {
          return;
        }
        if (!capturedSessionId && typeof event.session_id === 'string' && event.session_id) {
          capturedSessionId = event.session_id;
        }
        announceSession();
        if (event.subtype === 'success' && !event.is_error) {
          // Workflows can emit task_notification after the ordinary result.
          // Keep the run open until the child closes so those final events are
          // still sequenced and delivered to the websocket client.
          pendingFinish = { exitCode: 0 };
        } else {
          const message = typeof event.result === 'string'
            ? redactDiagnosticText(event.result)
            : event.error && typeof event.error === 'string'
              ? redactDiagnosticText(event.error)
              : 'WorkBuddy task failed';
          pendingFinish = { exitCode: 1, error: message };
        }
        return;
      }

      console.warn('[WorkBuddy] Ignoring unsupported stream-json event', {
        sessionId: appSessionId,
        eventType: typeof event.type === 'string' ? event.type : 'missing',
        subtype: typeof event.subtype === 'string' ? event.subtype : undefined,
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
      const text = chunk.toString().trim();
      if (text) {
        console.error('[WorkBuddy] CLI stderr', {
          sessionId: appSessionId,
          message: redactDiagnosticText(text),
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
      // The engine may emit its final JSON event (usually `result`) without a
      // trailing newline, leaving it stranded in the split buffer. Flush it
      // before judging the run, so the terminal event and session id are not
      // lost and a clean completion is not misread as a failure.
      if (stdoutBuffer.trim()) {
        const remainingLine = stdoutBuffer.trim();
        stdoutBuffer = '';
        processLine(remainingLine);
      }
      if (!completeSent) {
        if (!wasAborted && code !== 0 && !pendingFinish) {
          console.error('[WorkBuddy] CLI exited before a terminal result', {
            sessionId: appSessionId,
            exitCode: code ?? 'unknown',
          });
        }
        finish(wasAborted
          ? { exitCode: 0, aborted: true }
          : timedOut
            ? pendingFinish ?? { exitCode: 1, error: 'WorkBuddy run timed out' }
            : pendingFinish ?? { exitCode: code === 0 ? 0 : 1, error: code === 0 ? undefined : `WorkBuddy exited with code ${code ?? 'unknown'}` });
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
    // The abort handler sends the terminal complete on this run's behalf
    // (bypassing the coalescer), so halt the stream first: a buffered delta
    // must not land after that complete and resurrect the client's row.
    (child as ChildProcess & { haltStream?: () => void }).haltStream?.();
    try {
      if (child.stdin && child.stdin.writable && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({
          type: 'control_request',
          request_id: `cloudcli-interrupt-${Date.now()}`,
          request: { subtype: 'interrupt' },
        })}\n`);
      } else {
        child.kill('SIGTERM');
      }
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
export function resetWorkbuddyRuntimeForTests(): void {
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
