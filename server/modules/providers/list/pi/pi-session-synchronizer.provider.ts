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
import { getPiSessionsRoot } from '@/modules/providers/list/pi/pi-models.provider.js';
import { resolvePiTranscriptPath } from '@/modules/providers/list/pi/pi-sessions.provider.js';

const FALLBACK_SESSION_NAME = 'Untitled Pi Session';
const TITLE_TAIL_BYTES = 64 * 1024;

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  sessionNameIsExplicit?: boolean;
};

/**
 * Session indexer for Pi JSONL transcripts.
 *
 * Pi persists sessions under `<sessions>/--<encoded-cwd>--/<ISO时间戳>_<UUID>.jsonl`.
 * The header line carries the session UUID and working directory; titles come
 * from `session_info` entries (set via `/name`) and fall back to the first real
 * user prompt. Files are matched by their `_<UUID>.jsonl` suffix so the
 * provider session id is stable regardless of the timestamp prefix.
 */
export class PiSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'pi' as const;
  private hasCompletedInitialScan = false;

  private get sessionRoot(): string {
    return getPiSessionsRoot();
  }

  /**
   * Scans Pi's sessions root and upserts discovered sessions into the DB.
   *
   * The first scan is full because Pi transcripts can predate the persisted
   * global scan cursor. Once that backfill succeeds, later scans use the
   * orchestration cursor and avoid walking unchanged transcripts again.
   */
  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    const scanSince = this.hasCompletedInitialScan ? (since ?? null) : null;
    const files = await findFilesRecursivelyCreatedAfter(this.sessionRoot, '.jsonl', scanSince);
    for (const filePath of files) {
      processed += await this.upsertFile(filePath);
    }

    this.hasCompletedInitialScan = true;
    return processed;
  }

  /**
   * Indexes one Pi transcript triggered by the filesystem watcher.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    return (await this.upsertFile(filePath)) > 0 ? this.lastParsedSessionId : null;
  }

  /**
   * Resolves the on-disk transcript path for one Pi session uuid, so a
   * permanent delete can remove the file even before the watcher indexed the
   * row. Returns null when no transcript exists yet.
   */
  async resolveTranscriptPath(providerSessionId: string, projectPath: string): Promise<string | null> {
    return resolvePiTranscriptPath(providerSessionId, projectPath);
  }

  private lastParsedSessionId: string | null = null;

  /**
   * Parses a Pi transcript header and upserts the session. Returns 1 when a
   * session was created/updated, 0 when the file carries no header.
   */
  private async upsertFile(filePath: string): Promise<number> {
    const parsed = await this.processSessionFile(filePath);
    if (!parsed) {
      return 0;
    }

    const existing = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    // Archive is the user's explicit "hide" choice; a re-scan must not
    // resurrect an archived session while its transcript still sits on disk.
    if (existing?.isArchived) {
      return 0;
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
    this.lastParsedSessionId = parsed.sessionId;
    return 1;
  }

  private async processSessionFile(filePath: string): Promise<ParsedSession | null> {
    const header = await extractFirstValidJsonlData(filePath, (raw) => {
      const data = raw as AnyRecord | null;
      if (data?.type !== 'session') {
        return null;
      }
      const sessionId = typeof data.id === 'string' ? data.id.trim() : '';
      const cwd = typeof data.cwd === 'string' ? data.cwd.trim() : '';
      if (!sessionId || !cwd) {
        return null;
      }
      return { sessionId, cwd };
    });
    if (!header) {
      return null;
    }

    const extractedName = await this.extractSessionName(
      filePath,
      header.sessionId,
      !this.hasExistingCustomName(header.sessionId),
    );
    return {
      sessionId: header.sessionId,
      projectPath: header.cwd,
      sessionName: extractedName?.name,
      sessionNameIsExplicit: extractedName?.isExplicit,
    };
  }

  private hasExistingCustomName(sessionId: string): boolean {
    const existing = sessionsDb.getSessionByProviderSessionId(sessionId);
    return Boolean(existing?.custom_name && existing.custom_name !== FALLBACK_SESSION_NAME);
  }

  /**
   * Reads the newest `session_info` name from a transcript and falls back to
   * the first real user prompt for unnamed/interrupted transcripts.
   */
  private async extractSessionName(
    filePath: string,
    sessionId: string,
    shouldReadFullName: boolean,
  ): Promise<{ name: string; isExplicit: boolean } | undefined> {
    if (!shouldReadFullName) {
      return this.extractNewestNameFromTail(filePath, sessionId);
    }

    let firstUserPrompt: string | undefined;
    let latestName: string | undefined;
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
        if (data.type === 'session_info' && typeof data.name === 'string' && data.name.trim()) {
          latestName = data.name.trim();
          continue;
        }
        if (
          data.type === 'message'
          && (data.message as AnyRecord | null)?.role === 'user'
        ) {
          const prompt = readUserPrompt(data.message);
          if (prompt && !firstUserPrompt) {
            firstUserPrompt = prompt;
          }
        }
      }
    } catch {
      // Unreadable transcripts produce no title; the fallback is used.
    } finally {
      lineReader.close();
      fileStream.destroy();
    }

    if (latestName) {
      return { name: latestName, isExplicit: true };
    }
    return firstUserPrompt ? { name: firstUserPrompt, isExplicit: false } : undefined;
  }

  /** Reads only the transcript tail when its existing title can be retained. */
  private async extractNewestNameFromTail(
    filePath: string,
    _sessionId: string,
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
          if (data.type === 'session_info' && typeof data.name === 'string' && data.name.trim()) {
            return { name: data.name.trim(), isExplicit: true };
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

/** Reads the first text content of a Pi user message (string or blocks). */
function readUserPrompt(message: unknown): string | undefined {
  const record = message as AnyRecord | null;
  if (!record) {
    return undefined;
  }
  const content = record.content;
  if (typeof content === 'string') {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const entry = block as AnyRecord | null;
    if (entry?.type === 'text' && typeof entry.text === 'string' && entry.text.trim()) {
      return entry.text.trim();
    }
  }
  return undefined;
}
