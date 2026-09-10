import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * Reads the `env` block from a Claude Code settings file, keeping only
 * string-valued entries with whitespace trimmed.
 *
 * `settingsPath` defaults to the host user settings (`~/.claude/settings.json`).
 * Callers pass an explicit path to inspect another settings source, such as the
 * per-provider custom settings file CloudCLI forwards to Claude Code as
 * `--settings` (see providerSettingsSourceService).
 *
 * Claude Code applies these values as environment variables on every run, so
 * consumers that need "the effective Claude configuration without spawning a
 * session" read them here. Callers that also look at the server process env
 * must check `process.env` first: real environment variables win over the
 * settings file, matching Claude Code's own priority.
 *
 * Used by the claude auth status provider and the claude model catalog.
 * Missing or malformed files yield an empty record — never an error, because
 * an unconfigured host is a normal, supported state.
 */
export const readClaudeSettingsEnv = async (settingsPath?: string): Promise<Record<string, string>> => {
  try {
    const resolvedPath = settingsPath?.trim() || path.join(os.homedir(), '.claude', 'settings.json');
    const content = await readFile(resolvedPath, 'utf8');
    const settings = readObjectRecord(JSON.parse(content));
    const env = readObjectRecord(settings?.env) ?? {};

    return Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) => {
        const stringValue = readOptionalString(value);
        return stringValue ? [[key, stringValue] as const] : [];
      }),
    );
  } catch {
    return {};
  }
};
