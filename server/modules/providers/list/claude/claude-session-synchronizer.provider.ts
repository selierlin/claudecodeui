import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { SessionNameSource } from '@/shared/types.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  sessionNameSource?: SessionNameSource;
};

type ClaudeTitleMetadata = {
  name: string;
  source: SessionNameSource;
  /** The newest `last-prompt` value, retained for legacy title matching. */
  lastPrompt?: string;
};

type BackfillNameSourceResult = {
  sessionId: string;
  providerSessionId: string;
  previousName: string | null;
  nextName: string | null;
  source: SessionNameSource | null;
  action:
    | 'updated'
    | 'source_only'
    | 'skipped_ambiguous'
    | 'skipped_missing_transcript'
    | 'skipped_no_ai_or_custom_title';
};

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
        parsed.sessionNameSource ?? 'provider_title'
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
      parsed.sessionNameSource ?? 'provider_title'
    );
  }

  /**
   * Resolves the on-disk transcript path for one Claude provider session id.
   *
   * Claude stores top-level transcripts as
   * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where `<encoded-cwd>`
   * is an opaque transform of the working directory. The transform is not a
   * simple slash-substitution for non-ASCII paths, so rather than re-derive it
   * this scans the projects tree for the uniquely-named transcript, skipping
   * subagent/tool-result sidecar files. Used by permanent deletes and by
   * session branching to attach a freshly forked transcript to an app row.
   */
  async resolveTranscriptPath(
    providerSessionId: string,
    _projectPath: string,
  ): Promise<string | null> {
    const targetName = `${providerSessionId}.jsonl`;
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      null
    );

    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }
      if (path.basename(filePath) === targetName) {
        return filePath;
      }
    }

    return null;
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    const existingSource = existingSession?.name_source ?? 'legacy_unknown';
    if (
      existingSessionName
      && existingSessionName !== 'Untitled Claude Session'
      && shouldPreserveExistingClaudeName(existingSource)
    ) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
        sessionNameSource: existingSource,
      };
    }

    let sessionName: string | undefined;
    let sessionNameSource: SessionNameSource | undefined;
    const providerTitle = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
    if (providerTitle) {
      sessionName = providerTitle.name;
      sessionNameSource = providerTitle.source;
    }
    if (!sessionName) {
      sessionName = nameMap.get(parsed.sessionId);
      sessionNameSource = sessionName ? 'history_display' : undefined;
    }
    if (!sessionName) {
      // Last-resort title source. A transcript that was `/clear`ed and then
      // closed without further input has no ai-title/last-prompt/custom-title
      // event, so fall back to the first real user prompt instead of leaving
      // the session labelled "Untitled Claude Session".
      sessionName = await this.extractFirstUserMessage(filePath, parsed.sessionId);
      sessionNameSource = sessionName ? 'first_user_prompt' : undefined;
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
      sessionNameSource,
    };
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string,
    includeLastPrompt = false
  ): Promise<ClaudeTitleMetadata | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      let aiTitle: string | undefined;
      let customTitle: string | undefined;
      let lastPrompt: string | undefined;

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
        const eventAiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const eventLastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

        if (eventSessionId !== sessionId) {
          continue;
        }

        // A `/rename` title is the strongest on-disk signal. Without a caller
        // that needs `last-prompt`, return it immediately; the backfill pass
        // opts into the full scan so it can still match legacy last-prompt
        // titles against the current name.
        if (eventType === 'custom-title' && claudeRenamedTitle?.trim()) {
          if (!includeLastPrompt) {
            return { name: claudeRenamedTitle, source: 'claude_custom_title' };
          }
          if (customTitle === undefined) {
            customTitle = claudeRenamedTitle;
          }
          continue;
        }
        if (eventType === 'ai-title' && eventAiTitle?.trim() && aiTitle === undefined) {
          aiTitle = eventAiTitle;
        }
        if (eventType === 'last-prompt' && eventLastPrompt?.trim() && lastPrompt === undefined) {
          lastPrompt = eventLastPrompt;
        }
      }

      if (customTitle) {
        return { name: customTitle, source: 'claude_custom_title', lastPrompt };
      }
      if (aiTitle) {
        return { name: aiTitle, source: 'claude_ai_title', lastPrompt };
      }
      if (lastPrompt) {
        return { name: lastPrompt, source: 'claude_last_prompt', lastPrompt };
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }

  /**
   * Fallback title source: the first usable user prompt in the transcript.
   *
   * `extractSessionAiTitleFromEnd` only honours Claude's own title metadata
   * events. When those are absent (e.g. a session cleared with `/clear` and
   * closed before any new message), the opening user prompt still yields a
   * meaningful title. Slash commands are skipped because they make poor
   * titles; the next genuine prompt is used instead.
   */
  private async extractFirstUserMessage(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      return findFirstUserMessageText(content.split(/\r?\n/), sessionId);
    } catch {
      // Ignore missing/unreadable files so sync can continue.
      return undefined;
    }
  }

  /**
   * Backfills the title source for legacy Claude rows whose provenance was
   * never recorded.
   *
   * The synchronizer intentionally leaves `legacy_unknown` rows untouched, but
   * this one-off pass can safely upgrade rows whose current title still equals
   * a value the old indexer would have produced. It only accepts
   * `ai-title`/`custom-title` targets; `last-prompt` is retained solely for
   * matching legacy candidates, not as a backfill target.
   */
  async backfillLegacyNameSources(
    options: { apply?: boolean } = {}
  ): Promise<BackfillNameSourceResult[]> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const rows = [...sessionsDb.getAllSessions(), ...sessionsDb.getArchivedSessions()].filter(
      (row) => row.provider === this.provider && row.name_source === 'legacy_unknown'
    );
    const results: BackfillNameSourceResult[] = [];

    for (const row of rows) {
      const providerSessionId = row.provider_session_id ?? row.session_id;
      const filePath = row.jsonl_path
        ?? await this.resolveTranscriptPath(providerSessionId, row.project_path ?? '');
      if (!filePath) {
        results.push({
          sessionId: row.session_id,
          providerSessionId,
          previousName: row.custom_name,
          nextName: null,
          source: null,
          action: 'skipped_missing_transcript',
        });
        continue;
      }

      const providerTitle = await this.extractSessionAiTitleFromEnd(filePath, providerSessionId, true);
      if (
        !providerTitle
        || (providerTitle.source !== 'claude_ai_title' && providerTitle.source !== 'claude_custom_title')
      ) {
        results.push({
          sessionId: row.session_id,
          providerSessionId,
          previousName: row.custom_name,
          nextName: null,
          source: null,
          action: 'skipped_no_ai_or_custom_title',
        });
        continue;
      }

      const existingName = normalizeSessionName(row.custom_name ?? undefined, 'Untitled Claude Session');
      const nextName = normalizeSessionName(providerTitle.name, 'Untitled Claude Session');
      const firstUserMessage = await this.extractFirstUserMessage(filePath, providerSessionId);
      const legacyCandidates = [
        nameMap.get(providerSessionId),
        firstUserMessage,
        firstUserMessage ? buildClaudeSessionNamePrefix(firstUserMessage) : undefined,
        providerTitle.lastPrompt,
      ];
      const matchesLegacyCandidate = legacyCandidates.some(
        (candidate) => typeof candidate === 'string'
          && normalizeSessionName(candidate, 'Untitled Claude Session') === existingName
      );
      const isLegacyAutoTitle = !row.custom_name
        || existingName === 'Untitled Claude Session'
        || matchesLegacyCandidate;

      if (!isLegacyAutoTitle && nextName !== existingName) {
        results.push({
          sessionId: row.session_id,
          providerSessionId,
          previousName: row.custom_name,
          nextName,
          source: providerTitle.source,
          action: 'skipped_ambiguous',
        });
        continue;
      }

      const action = nextName === existingName ? 'source_only' : 'updated';
      if (options.apply) {
        sessionsDb.updateSessionCustomName(row.session_id, nextName, providerTitle.source);
      }
      results.push({
        sessionId: row.session_id,
        providerSessionId,
        previousName: row.custom_name,
        nextName,
        source: providerTitle.source,
        action,
      });
    }

    return results;
  }
}

/**
 * Returns true when an existing Claude session title must not be replaced by
 * a title derived from the transcript during a later sync.
 *
 * User and provider-authored renames are authoritative. Legacy rows with no
 * recorded source are preserved too: their provenance is unknown, so a bulk
 * backfill should decide them explicitly rather than a routine scan silently
 * rewriting a possible manual rename.
 */
function shouldPreserveExistingClaudeName(source: SessionNameSource): boolean {
  return source === 'manual_rename'
    || source === 'claude_custom_title'
    || source === 'fork'
    || source === 'legacy_unknown';
}

/**
 * Produces the four-word prefix that `sessionsService.createAppSession` used
 * for legacy app-created sessions, so a backfill can recognise that shape as
 * an automatic title rather than a manual rename.
 */
function buildClaudeSessionNamePrefix(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
}

/**
 * Returns the first usable user prompt found in a Claude session transcript's
 * lines, or `undefined` when none exists.
 *
 * Pure helper for `ClaudeSessionSynchronizer#extractFirstUserMessage`; kept
 * side-effect free so it can be unit tested without file I/O. Selection rules:
 * the event must be a `user` message for `sessionId` whose `message.role` is
 * `user`, with non-empty text content that is not a bare slash command.
 */
function findFirstUserMessageText(lines: string[], sessionId: string): string | undefined {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const data = parsed as Record<string, unknown>;
    if (data.type !== 'user' || data.sessionId !== sessionId) {
      continue;
    }

    const message = data.message as Record<string, unknown> | undefined;
    if (!message || message.role !== 'user') {
      continue;
    }

    const text = extractMessageText(message.content);
    if (text && !text.trimStart().startsWith('/')) {
      return text.trim();
    }
  }

  return undefined;
}

/**
 * Pulls plain text out of a Claude message `content` value.
 *
 * Claude serialises message content either as a bare string or as an array of
 * content blocks; only `text` blocks carry human-readable content. Returns
 * `undefined` when no text is present (e.g. a message made only of tool
 * results), so callers can skip it in favour of the next message.
 */
function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        return (block as Record<string, unknown>).text as string;
      }
    }
  }
  return undefined;
}
