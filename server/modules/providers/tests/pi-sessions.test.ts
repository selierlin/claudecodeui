import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { PiSessionsProvider } from '@/modules/providers/list/pi/pi-sessions.provider.js';

async function withIsolatedEnvironment(
  runTest: (env: { sessionsRoot: string; cwd: string }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousSessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'pi-sessions-test-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const sessionsRoot = path.join(tempDirectory, 'sessions');
  const cwd = path.join(tempDirectory, 'workspace', 'my-project');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
  await initializeDatabase();
  await mkdir(cwd, { recursive: true });

  try {
    await runTest({ sessionsRoot, cwd });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousSessionsRoot === undefined) {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    } else {
      process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionsRoot;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Mirrors Pi's directory encoding: strip the leading slash, `/:\` → `-`. */
function encodePiCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** Writes one Pi JSONL transcript file with the given entries (header + tree). */
async function writeTranscript(
  sessionsRoot: string,
  cwd: string,
  uuid: string,
  entries: unknown[],
): Promise<string> {
  const dir = path.join(sessionsRoot, encodePiCwd(cwd));
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `2026-09-09T00-00-00-000Z_${uuid}.jsonl`);
  const lines = entries.map((entry) => JSON.stringify(entry));
  await writeFile(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

const header = (uuid: string, cwd: string) => ({
  type: 'session',
  version: 3,
  id: uuid,
  timestamp: '2026-09-09T08:00:00.000Z',
  cwd,
});

const text = (text: string) => ({ type: 'text', text });
const thinking = (thinking: string) => ({ type: 'thinking', thinking, thinkingSignature: '' });
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});

function messageEntry(
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
  timestamp = '2026-09-09T08:00:01.000Z',
): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId,
    timestamp,
    message: {
      timestamp: 1788942863000,
      ...message,
    },
  };
}

function userMessage(id: string, parentId: string | null, content: unknown): Record<string, unknown> {
  return messageEntry(id, parentId, { role: 'user', content });
}

function assistantMessage(
  id: string,
  parentId: string | null,
  content: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return messageEntry(id, parentId, {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'ark',
    model: 'deepseek-v4-flash',
    stopReason: 'stop',
    ...extra,
    content,
  });
}

function toolResultMessage(
  id: string,
  parentId: string | null,
  toolCallId: string,
  content: unknown,
  isError = false,
): Record<string, unknown> {
  return messageEntry(id, parentId, {
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    content,
    isError,
  });
}

test('normalizeMessage maps assistant blocks to thinking/text/tool_use rows', () => {
  const provider = new PiSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'message_end',
    id: 'a1b2c3d4',
    timestamp: '2026-09-09T08:00:02.000Z',
    message: {
      role: 'assistant',
      content: [
        thinking('Let me check'),
        text('Here is the answer'),
        toolCall('call_1', 'bash', { command: 'date' }),
      ],
      stopReason: 'toolUse',
    },
  }, 'session-1');

  assert.deepEqual(messages.map((message) => message.kind), ['thinking', 'text', 'tool_use']);
  assert.equal(messages[0].content, 'Let me check');
  assert.equal(messages[1].content, 'Here is the answer');
  assert.equal(messages[2].toolName, 'bash');
  assert.equal(messages[2].toolId, 'call_1');
  assert.deepEqual(messages[2].toolInput, { command: 'date' });
  // Ids are stable from the entry id.
  assert.equal(messages[0].id, 'pi-a1b2c3d4');
  assert.equal(messages[1].id, 'pi-a1b2c3d4-1');
  assert.equal(messages[2].id, 'pi-a1b2c3d4-2');
});

test('normalizeMessage maps toolResult into a tool_result row', () => {
  const provider = new PiSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'message',
    id: 'd4e5f6g7',
    timestamp: '2026-09-09T08:00:03.000Z',
    message: {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'bash',
      content: [text('2026-09-09')],
      isError: false,
    },
  }, 'session-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].toolId, 'call_1');
  assert.equal(messages[0].content, '2026-09-09');
  assert.equal(messages[0].isError, false);
});

test('normalizeMessage turns a terminal error into a redacted error row', () => {
  const provider = new PiSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'message_end',
    id: 'e5f6g7h8',
    timestamp: '2026-09-09T08:00:04.000Z',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'API error 401, api key: sk-12345 invalid',
    },
  }, 'session-1');

  const error = messages.find((message) => message.kind === 'error');
  assert.ok(error && typeof error.content === 'string');
  assert.ok(!error.content.includes('sk-12345'));
  assert.ok(error.content.includes('[REDACTED]'));
});

test('normalizeMessage maps user images into inline data URLs', () => {
  const provider = new PiSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'message',
    id: 'f6g7h8i9',
    timestamp: '2026-09-09T08:00:05.000Z',
    message: {
      role: 'user',
      content: [
        text('Here is the screenshot'),
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    },
  }, 'session-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'Here is the screenshot');
  assert.deepEqual(messages[0].images, [{ data: 'data:image/png;base64,AAAA' }]);
});

test('fetchHistory reads a linear transcript oldest first', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    const engineId = 'a1b2c3d4';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, 'Hello'),
      assistantMessage('a2', 'a1', [text('Hi!')]),
      toolResultMessage('a3', 'a2', 'call_1', [text('output')]),
    ]);

    sessionsDb.createAppSession('app-1', 'pi', cwd, 'Pi session');
    sessionsDb.assignProviderSessionId('app-1', uuid);

    const result = await new PiSessionsProvider().fetchHistory('app-1');
    assert.equal(result.total, 3);
    assert.equal(result.hasMore, false);
    assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant', 'user']);
    assert.deepEqual(result.messages.map((message) => message.kind), ['text', 'text', 'tool_result']);
    assert.equal(result.messages[0].content, 'Hello');
    assert.equal(result.messages[1].content, 'Hi!');
  });
});

test('fetchHistory pages the tail when limit/offset are supplied', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, 'First'),
      assistantMessage('a2', 'a1', [text('Second')]),
      userMessage('a3', 'a2', 'Third'),
      assistantMessage('a4', 'a3', [text('Fourth')]),
      userMessage('a5', 'a4', 'Fifth'),
    ]);

    sessionsDb.createAppSession('app-1', 'pi', cwd, 'Paged');
    sessionsDb.assignProviderSessionId('app-1', uuid);

    const provider = new PiSessionsProvider();
    const firstPage = await provider.fetchHistory('app-1', { limit: 2, offset: 0 });
    assert.deepEqual(firstPage.messages.map((message) => message.content), ['Fourth', 'Fifth']);
    assert.equal(firstPage.total, 5);
    assert.equal(firstPage.hasMore, true);

    const secondPage = await provider.fetchHistory('app-1', { limit: 2, offset: 2 });
    assert.deepEqual(secondPage.messages.map((message) => message.content), ['Second', 'Third']);
    assert.equal(secondPage.hasMore, true);

    const oldestPage = await provider.fetchHistory('app-1', { limit: 2, offset: 4 });
    assert.deepEqual(oldestPage.messages.map((message) => message.content), ['First']);
    assert.equal(oldestPage.hasMore, false);

    const emptyPage = await provider.fetchHistory('app-1', { limit: 0 });
    assert.deepEqual(emptyPage.messages, []);
    assert.equal(emptyPage.hasMore, true);

    const fullHistory = await provider.fetchHistory('app-1');
    assert.equal(fullHistory.messages.length, 5);
  });
});

test('fetchHistory returns empty history when no transcript exists', async () => {
  await withIsolatedEnvironment(async ({ cwd }) => {
    sessionsDb.createAppSession('app-1', 'pi', cwd, 'Empty');
    sessionsDb.assignProviderSessionId('app-1', 'missing');
    const result = await new PiSessionsProvider().fetchHistory('app-1');
    assert.equal(result.total, 0);
    assert.deepEqual(result.messages, []);
  });
});

test('fetchHistory walks only the active branch, skipping abandoned ones', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      // Main branch.
      userMessage('a1', null, 'Root prompt'),
      assistantMessage('a2', 'a1', [text('Main answer')]),
      // Branch point: abandoned branch continues from a1.
      userMessage('b1', 'a1', 'Abandoned prompt'),
      assistantMessage('b2', 'b1', [text('Abandoned answer')]),
      // Active leaf continues the main branch from a2.
      userMessage('a3', 'a2', 'Continued prompt'),
      assistantMessage('a4', 'a3', [text('Active answer')]),
    ]);

    sessionsDb.createAppSession('app-1', 'pi', cwd, 'Branch');
    sessionsDb.assignProviderSessionId('app-1', uuid);

    const result = await new PiSessionsProvider().fetchHistory('app-1');
    const contents = result.messages.map((message) => message.content);
    assert.deepEqual(contents, ['Root prompt', 'Main answer', 'Continued prompt', 'Active answer']);
  });
});

test('fetchHistory honors compaction via firstKeptEntryId', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, 'Old 1'),
      assistantMessage('a2', 'a1', [text('Old 2')]),
      userMessage('a3', 'a2', 'Old 3'),
      {
        type: 'compaction',
        id: 'c1',
        parentId: 'a3',
        timestamp: '2026-09-09T09:00:00.000Z',
        summary: 'Earlier turns were summarized.',
        firstKeptEntryId: 'a3',
        tokensBefore: 50000,
      },
      userMessage('a4', 'c1', 'Kept after compaction'),
      assistantMessage('a5', 'a4', [text('Answer')]),
    ]);

    sessionsDb.createAppSession('app-1', 'pi', cwd, 'Compacted');
    sessionsDb.assignProviderSessionId('app-1', uuid);

    const result = await new PiSessionsProvider().fetchHistory('app-1');
    const contents = result.messages.map((message) => message.content);
    // a1/a2 dropped (before firstKeptEntryId), summary first, a3 kept, then tail.
    assert.deepEqual(contents, [
      'Earlier turns were summarized.',
      'Old 3',
      'Kept after compaction',
      'Answer',
    ]);
    assert.equal(result.messages[0].isCompactSummary, true);
  });
});

test('fetchHistory honors compaction via retainedTail (defensive compat)', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, 'Old 1'),
      assistantMessage('a2', 'a1', [text('Old 2')]),
      {
        type: 'compaction',
        id: 'c1',
        parentId: 'a2',
        timestamp: '2026-09-09T09:00:00.000Z',
        summary: 'Everything was compacted.',
        retainedTail: [
          { role: 'user', content: 'Checkpoint prompt' },
          { role: 'assistant', content: [text('Checkpoint answer')] },
        ],
      },
      userMessage('a3', 'c1', 'After checkpoint'),
    ]);

    sessionsDb.createAppSession('app-1', 'pi', cwd, 'Compacted tail');
    sessionsDb.assignProviderSessionId('app-1', uuid);

    const result = await new PiSessionsProvider().fetchHistory('app-1');
    const contents = result.messages.map((message) => message.content);
    assert.deepEqual(contents, [
      'Everything was compacted.',
      'Checkpoint prompt',
      'Checkpoint answer',
      'After checkpoint',
    ]);
  });
});

test('fetchHistory reports token usage from the newest assistant turn', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, 'Hello'),
      assistantMessage('a2', 'a1', [text('Hi')], {
        usage: {
          input: 100,
          output: 20,
          cacheRead: 10,
          cacheWrite: 0,
          totalTokens: 130,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    ]);

    sessionsDb.createAppSession('app-1', 'pi', cwd, 'Usage');
    sessionsDb.assignProviderSessionId('app-1', uuid);

    const result = await new PiSessionsProvider().fetchHistory('app-1');
    assert.deepEqual(result.tokenUsage, {
      used: 120,
      total: 130,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      cacheTokens: 10,
      breakdown: { input: 110, output: 20 },
    });
  });
});
