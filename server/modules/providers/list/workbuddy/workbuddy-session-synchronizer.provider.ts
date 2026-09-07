import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import {
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';

import { getWorkbuddySessionRoots } from './workbuddy-storage.provider.js';

const FALLBACK_SESSION_NAME = 'Untitled WorkBuddy Session';
const TITLE_TAIL_BYTES = 64 * 1024;

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  sessionNameIsExplicit?: boolean;
};

/**
 * Session indexer for WorkBuddy / CodeBuddy JSONL transcripts.
 *
 * Both the CodeBuddy CLI engine (`~/.codebuddy`) and the WorkBuddy desktop app
 * (`~/.workbuddy`) persist sessions under
 * `projects/<encoded-cwd>/<session-id>.jsonl`, mirroring the Claude Code
 * layout. Session titles come from in-transcript `ai-title` events; the shared
 * `history.jsonl` files carry no `sessionId` field, so they cannot be used to
 * look names up like the Claude synchronizer does.
 */
export class WorkbuddySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'workbuddy' as const;
  private hasCompletedInitialScan = false;

  private get sessionRoots(): string[] {
    return getWorkbuddySessionRoots();
  }

  /**
   * Scans both WorkBuddy engine projects roots and upserts discovered sessions
   * into the DB.
   *
   * The first scan is full because WorkBuddy transcripts can predate the
   * persisted global scan cursor. Once that backfill succeeds, later scans use
   * the orchestration cursor and avoid walking unchanged transcripts again.
   * The flag is set only after both roots complete successfully, so a partial
   * first scan is retried as a full scan on the next attempt.
   */
  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    const scanSince = this.hasCompletedInitialScan ? (since ?? null) : null;
    for (const rootPath of this.sessionRoots) {
      const files = await findFilesRecursivelyCreatedAfter(rootPath, '.jsonl', scanSince);
      for (const filePath of files) {
        if (this.isSubagentTranscript(filePath)) {
          continue;
        }
        const sessionId = path.basename(filePath, '.jsonl');
        const existing = sessionsDb.getSessionByProviderSessionId(sessionId)
          ?? sessionsDb.getSessionById(sessionId);
        const parsed = await this.processSessionFile(
          filePath,
          !existing?.custom_name || existing.custom_name === FALLBACK_SESSION_NAME,
        );
        if (!parsed) {
          continue;
        }
        // Archive is the user's explicit "hide" choice; a full re-scan must not
        // resurrect an archived session while its transcript still sits on disk.
        if (existing?.isArchived) {
          continue;
        }
        const timestamps = await readFileTimestamps(filePath);
        sessionsDb.createSession(
          parsed.sessionId,
          this.provider,
          parsed.projectPath,
          this.resolveSessionName(existing?.custom_name ?? null, parsed.sessionName, parsed.sessionNameIsExplicit),
          timestamps.createdAt,
          timestamps.updatedAt,
          filePath,
        );
        processed += 1;
      }
    }

    this.hasCompletedInitialScan = true;
    return processed;
  }

  /**
   * Indexes one WorkBuddy transcript triggered by the filesystem watcher.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl') || this.isSubagentTranscript(filePath)) {
      return null;
    }

    const sessionId = path.basename(filePath, '.jsonl');
    const existing = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId);
    const parsed = await this.processSessionFile(
      filePath,
      !existing?.custom_name || existing.custom_name === FALLBACK_SESSION_NAME,
    );
    if (!parsed) {
      return null;
    }
    // Archive is the user's explicit "hide" choice; a watcher-triggered sync
    // must not resurrect an archived session while its transcript is on disk.
    if (existing?.isArchived) {
      return null;
    }
    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      this.resolveSessionName(existing?.custom_name ?? null, parsed.sessionName, parsed.sessionNameIsExplicit),
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
    );
  }

  /**
   * Resolves the on-disk transcript path for one engine session id across both
   * engine roots, so a permanent delete can remove the file even before the
   * watcher indexed the row. Returns null when no transcript exists yet.
   */
  async resolveTranscriptPath(providerSessionId: string, projectPath: string): Promise<string | null> {
    const encodedCwd = this.encodeCwd(projectPath);
    for (const rootPath of this.sessionRoots) {
      const candidate = path.join(rootPath, encodedCwd, `${providerSessionId}.jsonl`);
      try {
        await fsp.access(candidate);
        return candidate;
      } catch {
        // Not in this engine root; try the other one.
      }
    }
    return null;
  }

  /** Mirrors the engine's directory encoding: strip the leading slash, `/` → `-`. */
  private encodeCwd(cwd: string): string {
    return cwd.replace(/^\//, '').replace(/\//g, '-');
  }

  /**
   * Skips subagent transcripts and tool results that repeat the parent
   * session's id and would otherwise overwrite the main row's jsonl path.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Skips transient sessions the WorkBuddy desktop app creates in a fresh
   * `~/WorkBuddy/<yyyy-mm-dd-hh-mm-ss>` scratch directory on every open, plus
   * the `automation-<yyyy-mm-dd-hh-mm-ss>` workspaces its automation runner
   * spawns. Both are throwaway workspaces, not real projects, so their
   * sessions must never surface in the app.
   */
  private isTransientWorkBuddyWorkspace(cwd: string): boolean {
    return /\/WorkBuddy\/(?:automation-)?\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(cwd);
  }

  private async processSessionFile(
    filePath: string,
    shouldReadFullName: boolean,
  ): Promise<ParsedSession | null> {
    const sessionId = path.basename(filePath, '.jsonl');
    const parsed = await extractFirstValidJsonlData(filePath, (raw) => {
      const data = raw as AnyRecord | null;
      if (data?.type !== 'message') {
        return null;
      }
      const cwd = typeof data.cwd === 'string' ? data.cwd : undefined;
      if (!cwd) {
        return null;
      }
      if (this.isTransientWorkBuddyWorkspace(cwd)) {
        return null;
      }
      return { cwd };
    });
    if (!parsed) {
      return null;
    }

    const extractedName = await this.extractSessionName(filePath, sessionId, shouldReadFullName);
    return {
      sessionId,
      projectPath: parsed.cwd,
      sessionName: extractedName?.name,
      sessionNameIsExplicit: extractedName?.isExplicit,
    };
  }

  /**
   * Reads the newest `ai-title` event from a transcript for its title and falls
   * back to the first real user prompt for older/interrupted transcripts.
   */
  private async extractSessionName(
    filePath: string,
    sessionId: string,
    shouldReadFullName: boolean,
  ): Promise<{ name: string; isExplicit: boolean } | undefined> {
    if (!shouldReadFullName) {
      return this.extractNewestTitleFromTail(filePath, sessionId);
    }

    let firstUserPrompt: string | undefined;
    let latestTitle: string | undefined;
    const fileStream = createReadStream(filePath, { encoding: 'utf8' });
    const lineReader = createInterface({ input: fileStream, crlfDelay: Infinity });
    try {
      for await (const rawLine of lineReader) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const data = parsed as AnyRecord;
        if (
          data.type === 'message'
          && data.role === 'user'
          && Array.isArray(data.content)
        ) {
          const inputText = data.content.find((block: unknown) => (
            block && typeof block === 'object' && (block as AnyRecord).type === 'input_text'
            && typeof (block as AnyRecord).text === 'string'
          )) as AnyRecord | undefined;
          if (typeof inputText?.text === 'string') {
            const promptMatch = inputText.text.match(/<user_query>([\s\S]*?)<\/user_query>/);
            const prompt = promptMatch?.[1]?.trim() || inputText.text.trim();
          if (prompt && !firstUserPrompt) {
            firstUserPrompt = prompt;
          }
        }
        }
        if (
          data.type === 'ai-title'
          && data.sessionId === sessionId
          && typeof data.aiTitle === 'string'
          && data.aiTitle.trim()
        ) {
          latestTitle = data.aiTitle;
        }
      }
    } catch {
      // Unreadable transcripts produce no title; the fallback is used.
    } finally {
      lineReader.close();
      fileStream.destroy();
    }

    if (latestTitle) {
      return { name: latestTitle, isExplicit: true };
    }
    return firstUserPrompt ? { name: firstUserPrompt, isExplicit: false } : undefined;
  }

  /** Reads only the active transcript tail when its existing title can be retained. */
  private async extractNewestTitleFromTail(
    filePath: string,
    sessionId: string,
  ): Promise<{ name: string; isExplicit: boolean } | undefined> {
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      handle = await fsp.open(filePath, 'r');
      const { size } = await handle.stat();
      const length = Math.min(size, TITLE_TAIL_BYTES);
      const start = Math.max(0, size - length);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);

      for (let index = lines.length - 1; index >= (start > 0 ? 1 : 0); index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }
        try {
          const data = JSON.parse(line) as AnyRecord;
          if (
            data.type === 'ai-title'
            && data.sessionId === sessionId
            && typeof data.aiTitle === 'string'
            && data.aiTitle.trim()
          ) {
            return { name: data.aiTitle, isExplicit: true };
          }
        } catch {
          // The first tail fragment may start in the middle of one JSON line.
        }
      }
    } catch {
      // A concurrent writer can briefly make a transcript unreadable.
    } finally {
      await handle?.close();
    }

    return undefined;
  }

  private resolveSessionName(
    existingName: string | null,
    rawName: string | undefined,
    isExplicit = false,
  ): string {
    if (existingName && existingName !== FALLBACK_SESSION_NAME && !isExplicit) {
      return existingName;
    }
    return normalizeSessionName(rawName, FALLBACK_SESSION_NAME);
  }
}
