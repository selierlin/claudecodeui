import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach, beforeEach } from 'node:test';

import { PiSessionsProvider } from '@/modules/providers/list/pi/pi-sessions.provider.js';
import { resetPiCommandForTests } from '@/modules/providers/list/pi/pi-auth.provider.js';
import { piRuntime, resetPiRuntimeForTests } from '@/modules/providers/list/pi/pi-runtime.provider.js';
import type { ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

const MOCK_CLI = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi-mock-cli.mjs'),
);

type Captured = {
  kind: string;
  id?: string;
  role?: string;
  provider?: string;
  content?: unknown;
  newSessionId?: string;
  exitCode?: number;
  aborted?: boolean;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  resetPiCommandForTests();
});

afterEach(() => {
  resetPiRuntimeForTests();
  resetPiCommandForTests();
  delete process.env.PI_COMMAND;
  delete process.env.MOCK_MODE;
  delete process.env.PI_MOCK_ARGS_FILE;
  delete process.env.PI_RUN_TIMEOUT_MS;
});

function makeContext(
  providerSessionIds: Map<string, string | null>,
  resumeModel?: string,
): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: (sessionId) => providerSessionIds.get(sessionId ?? '') ?? null,
    resolveProviderConfigDir: () => null,
    resolveSettingsFile: () => null,
    resolveResumeModel: async () => resumeModel,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'auto' }),
    normalizeMessage: (raw, sessionId) => new PiSessionsProvider().normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
}

function makeWriter(captured: Captured[]): ProviderRuntimeWriter {
  return {
    send(message: { kind: string; id?: string; role?: string; provider?: string; content?: unknown; newSessionId?: string; exitCode?: number; aborted?: boolean }) {
      captured.push(message);
    },
    userId: 1,
  };
}

test('new session announces its id and streams assistant text', async () => {
  const captured: Captured[] = [];
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';

  await piRuntime.run('Say hi', { sessionId: 'app-1', projectPath: process.cwd() }, makeWriter(captured), makeContext(new Map()));

  const kinds = captured.map((entry) => entry.kind);
  // session_created then the normalized assistant rows then a terminal complete.
  assert.ok(kinds.includes('session_created'));
  assert.ok(kinds.includes('thinking'));
  assert.ok(kinds.includes('text'));
  const created = captured.find((entry) => entry.kind === 'session_created');
  assert.equal(created?.newSessionId, 'mock-session-uuid');
  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 0);
  // The user echo must not be forwarded.
  assert.equal(captured.filter((entry) => entry.role === 'user' && entry.kind === 'text').length, 0);
});

test('resumed session passes --session and does not re-announce', async () => {
  const captured: Captured[] = [];
  const argsFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'pi-args-')), 'args.json');
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  process.env.PI_MOCK_ARGS_FILE = argsFile;

  const sessions = new Map<string, string | null>([['app-1', 'existing-uuid']]);
  await piRuntime.run('Continue', { sessionId: 'app-1', projectPath: process.cwd() }, makeWriter(captured), makeContext(sessions, 'ark/deepseek-v4-flash'));

  assert.equal(captured.some((entry) => entry.kind === 'session_created'), false);
  const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
  assert.ok(args.includes('--session'));
  assert.ok(args.includes('existing-uuid'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('ark/deepseek-v4-flash'));
  assert.ok(args.includes('--no-approve'));
  const text = captured.find((entry) => entry.kind === 'text' && entry.role === 'assistant');
  assert.ok(typeof text?.content === 'string');
  assert.ok(text.content.includes('RESUMED:existing-uuid'));
  await rm(path.dirname(argsFile), { recursive: true, force: true });
});

test('maps the readonly permission mode onto the Pi tool allowlist', async () => {
  const captured: Captured[] = [];
  const argsFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'pi-args-')), 'args.json');
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  process.env.PI_MOCK_ARGS_FILE = argsFile;

  await piRuntime.run(
    'Review only',
    { sessionId: 'app-1', projectPath: process.cwd(), permissionMode: 'readonly' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
  assert.ok(args.includes('--tools'));
  assert.ok(args.includes('read,grep,find,ls'));
  await rm(path.dirname(argsFile), { recursive: true, force: true });
});

test('passes effort as --thinking and attachments as @paths', async () => {
  const captured: Captured[] = [];
  const argsFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'pi-args-')), 'args.json');
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  process.env.PI_MOCK_ARGS_FILE = argsFile;

  const imagePath = path.join(process.cwd(), 'fixtures.png');
  await piRuntime.run(
    'Look',
    {
      sessionId: 'app-1',
      projectPath: process.cwd(),
      effort: 'high',
      attachments: [{ path: imagePath, mimeType: 'image/png' }],
    },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
  assert.ok(args.includes('--thinking'));
  assert.ok(args.includes('high'));
  assert.ok(args.includes(`@${imagePath}`));
  await rm(path.dirname(argsFile), { recursive: true, force: true });
});

test('a terminal error message with exit 0 still reports failure', async () => {
  const captured: Captured[] = [];
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'error-message-exit0';

  await piRuntime.run('Go', { sessionId: 'app-1', projectPath: process.cwd() }, makeWriter(captured), makeContext(new Map()));

  const error = captured.find((entry) => entry.kind === 'error');
  assert.ok(error && typeof error.content === 'string');
  assert.ok(!error.content.includes('sk-12345'));
  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 1);
  assert.equal(complete?.aborted, false);
});

test('an error turn followed by a successful retry reports success', async () => {
  const captured: Captured[] = [];
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'error-then-success';

  await piRuntime.run('Go', { sessionId: 'app-1', projectPath: process.cwd() }, makeWriter(captured), makeContext(new Map()));

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 0);
});

test('a startup error with no terminal event reports failure from stderr', async () => {
  const captured: Captured[] = [];
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'startup-error';

  await piRuntime.run('Go', { sessionId: 'app-1', projectPath: process.cwd() }, makeWriter(captured), makeContext(new Map()));

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 1);
  const error = captured.find((entry) => entry.kind === 'error');
  assert.ok(error && typeof error.content === 'string');
  assert.ok(error.content.includes('Unknown provider'));
});

test('flushes a final event without a trailing newline', async () => {
  const captured: Captured[] = [];
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'no-trailing-newline';

  await piRuntime.run('Hi', { sessionId: 'app-1', projectPath: process.cwd() }, makeWriter(captured), makeContext(new Map()));

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 0);
  assert.ok(captured.some((entry) => entry.kind === 'text'));
});

test('abort terminates a hanging run and reports aborted', async () => {
  const captured: Captured[] = [];
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'hang';

  const runPromise = piRuntime.run(
    'Long task',
    { sessionId: 'app-1', projectPath: process.cwd() },
    makeWriter(captured),
    makeContext(new Map()),
  );
  await sleep(300);
  const aborted = await piRuntime.abort('app-1');
  assert.equal(aborted, true);
  await runPromise;

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.aborted, true);
  assert.equal(complete?.exitCode, 0);
});

test('rejects a second concurrent run on the same session', async () => {
  const captured: Captured[] = [];
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'hang';

  const first = piRuntime.run('One', { sessionId: 'app-1', projectPath: process.cwd() }, makeWriter(captured), makeContext(new Map()));
  await sleep(200);
  await piRuntime.run('Two', { sessionId: 'app-1', projectPath: process.cwd() }, makeWriter(captured), makeContext(new Map()));

  assert.ok(captured.some((entry) => entry.kind === 'error'));
  await piRuntime.abort('app-1');
  await first;
});

test('a timeout reaps the process and reports a failure', async () => {
  const captured: Captured[] = [];
  process.env.PI_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'hang';
  process.env.PI_RUN_TIMEOUT_MS = '200';

  await piRuntime.run('Long', { sessionId: 'app-1', projectPath: process.cwd() }, makeWriter(captured), makeContext(new Map()));

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 1);
  assert.ok(captured.some((entry) => entry.kind === 'error' && typeof entry.content === 'string' && entry.content.includes('timed out')));
});
