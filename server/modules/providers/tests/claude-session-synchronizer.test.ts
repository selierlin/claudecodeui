import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

async function withIsolatedEnvironment(
  runTest: (homeDir: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-session-sync-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const restoreHomeDir = patchHomeDir(tempDirectory);

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    restoreHomeDir();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function writeSessionFile(
  homeDir: string,
  sessionId: string,
  events: unknown[],
): Promise<void> {
  const dir = path.join(homeDir, '.claude', 'projects', sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    events.map((event) => JSON.stringify(event)).join('\n'),
  );
}

const makeUserMessage = (sessionId: string, cwd: string, text: string) => ({
  type: 'user',
  sessionId,
  cwd,
  message: { role: 'user', content: text },
});

const makeAssistantMessage = (sessionId: string, cwd: string, text: string) => ({
  type: 'assistant',
  sessionId,
  cwd,
  message: { role: 'assistant', content: text },
});

const makeAiTitle = (sessionId: string, cwd: string, title: string) => ({
  type: 'ai-title',
  sessionId,
  cwd,
  aiTitle: title,
});

const readCustomName = (sessionId: string): string | null =>
  sessionsDb.getSessionByProviderSessionId(sessionId)?.custom_name ?? null;

test('uses the first user prompt when no title metadata exists', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const sessionId = 'sess-first-prompt';
    const cwd = path.join(homeDir, 'project');
    await writeSessionFile(homeDir, sessionId, [
      makeUserMessage(sessionId, cwd, 'How do I sort an array in JavaScript?'),
      makeAssistantMessage(sessionId, cwd, 'Use Array.prototype.sort().'),
    ]);

    await new ClaudeSessionSynchronizer().synchronize();

    assert.equal(readCustomName(sessionId), 'How do I sort an array in JavaScript?');
  });
});

test('prefers ai-title metadata over the first user prompt', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const sessionId = 'sess-ai-title';
    const cwd = path.join(homeDir, 'project');
    await writeSessionFile(homeDir, sessionId, [
      makeUserMessage(sessionId, cwd, 'How do I sort an array in JavaScript?'),
      makeAssistantMessage(sessionId, cwd, 'Use Array.prototype.sort().'),
      makeAiTitle(sessionId, cwd, 'Sorting arrays'),
    ]);

    await new ClaudeSessionSynchronizer().synchronize();

    assert.equal(readCustomName(sessionId), 'Sorting arrays');
  });
});

test('prefers ai-title metadata over the history.jsonl display prompt', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const sessionId = 'sess-ai-title-vs-history';
    const cwd = path.join(homeDir, 'project');
    await mkdir(path.join(homeDir, '.claude'), { recursive: true });
    await writeFile(
      path.join(homeDir, '.claude', 'history.jsonl'),
      `${JSON.stringify({ sessionId, display: 'Delete operation prompt' })}\n`
    );
    await writeSessionFile(homeDir, sessionId, [
      makeUserMessage(sessionId, cwd, 'Delete operation prompt'),
      makeAssistantMessage(sessionId, cwd, 'ok'),
      makeAiTitle(sessionId, cwd, 'Uncommitted changes'),
    ]);

    await new ClaudeSessionSynchronizer().synchronize();

    assert.equal(readCustomName(sessionId), 'Uncommitted changes');
  });
});

test('skips a leading slash command and uses the next real prompt', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const sessionId = 'sess-slash';
    const cwd = path.join(homeDir, 'project');
    await writeSessionFile(homeDir, sessionId, [
      makeUserMessage(sessionId, cwd, '/clear'),
      makeAssistantMessage(sessionId, cwd, 'ok'),
      makeUserMessage(sessionId, cwd, 'Explain promises in JS'),
    ]);

    await new ClaudeSessionSynchronizer().synchronize();

    assert.equal(readCustomName(sessionId), 'Explain promises in JS');
  });
});

test('falls back to Untitled when no usable prompt exists', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const sessionId = 'sess-untitled';
    const cwd = path.join(homeDir, 'project');
    await writeSessionFile(homeDir, sessionId, [
      makeUserMessage(sessionId, cwd, '/clear'),
      makeAssistantMessage(sessionId, cwd, 'ok'),
    ]);

    await new ClaudeSessionSynchronizer().synchronize();

    assert.equal(readCustomName(sessionId), 'Untitled Claude Session');
  });
});
