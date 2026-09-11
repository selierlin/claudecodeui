import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach, beforeEach } from 'node:test';

import { workbuddyRuntime, resetWorkbuddyRuntimeForTests } from '@/modules/providers/list/workbuddy/workbuddy-runtime.provider.js';
import { WorkbuddySessionsProvider } from '@/modules/providers/list/workbuddy/workbuddy-sessions.provider.js';
import { resetWorkbuddyCommandForTests } from '@/modules/providers/list/workbuddy/workbuddy-auth.provider.js';
import type { ProviderModelsDefinition, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

const MOCK_CLI = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wb-mock-cli.mjs'),
);

// New workbuddy sessions point the engine at the WorkBuddy desktop config root
// (where the user's skills and plugins live) instead of the embedded CLI's
// default ~/.codebuddy.
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.workbuddy');
const ORIGINAL_PATH = process.env.PATH;

type Captured = {
  kind: string;
  id?: string;
  role?: string;
  provider?: string;
  content?: unknown;
  streamChannel?: string;
  toolName?: string;
  toolId?: string;
  newSessionId?: string;
  exitCode?: number;
  aborted?: boolean;
  status?: string;
  summary?: string;
  taskId?: string;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The runtime inherits the parent env and always overrides the config-dir
// vars with the resolved session config dir (defaulting to ~/.workbuddy for
// new sessions). Developers' shells often export
// CODEBUDDY_CONFIG_DIR/WORKBUDDY_CONFIG_DIR, which would otherwise leak into
// the spawned mock CLI and corrupt the CFG suffix assertions. The command
// resolution cache is cleared too so each test re-resolves CODEBUDDY_COMMAND.
beforeEach(() => {
  delete process.env.CODEBUDDY_CONFIG_DIR;
  delete process.env.WORKBUDDY_CONFIG_DIR;
  resetWorkbuddyCommandForTests();
});

afterEach(() => {
  resetWorkbuddyRuntimeForTests();
  resetWorkbuddyCommandForTests();
  delete process.env.CODEBUDDY_COMMAND;
  delete process.env.MOCK_MODE;
  delete process.env.CODEBUDDY_CONFIG_DIR;
  delete process.env.WORKBUDDY_CONFIG_DIR;
  delete process.env.WORKBUDDY_PROJECTS_ROOT;
  delete process.env.WORKBUDDY_RUN_TIMEOUT_MS;
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
});

function makeContext(
  providerSessionIds: Map<string, string | null>,
  configDir?: string,
  resumeModel?: string,
  models: ProviderModelsDefinition = { OPTIONS: [], DEFAULT: 'auto' },
): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: (sessionId) => providerSessionIds.get(sessionId ?? '') ?? null,
    resolveProviderConfigDir: (sessionId) => (sessionId && configDir ? configDir : null),
    resolveSettingsFile: () => null,
    resolveResumeModel: async () => resumeModel,
    getProviderModels: async () => models,
    normalizeMessage: (raw, sessionId) => new WorkbuddySessionsProvider().normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
}

function makeWriter(captured: Captured[]): ProviderRuntimeWriter {
  return {
    send(message: any) {
      captured.push({
        kind: message.kind,
        id: message.id,
        role: message.role,
        provider: message.provider,
        content: message.content,
        streamChannel: message.streamChannel,
        toolName: message.toolName,
        toolId: message.toolId,
        newSessionId: message.newSessionId,
        exitCode: message.exitCode,
        aborted: message.aborted,
        status: message.status,
        summary: message.summary,
        taskId: message.taskId,
      });
    },
    userId: null,
  };
}

test('workbuddy run drives a new session and emits thinking/text/complete', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];
  const context = makeContext(new Map());

  await workbuddyRuntime.run(
    'hello',
    { sessionId: 'wb-test-1', cwd: '/tmp' },
    makeWriter(captured),
    context,
  );

  const kinds = captured.map((entry) => entry.kind);
  assert.ok(kinds.includes('session_created'), `kinds: ${kinds.join(',')}`);
  assert.ok(kinds.includes('thinking'), `kinds: ${kinds.join(',')}`);
  assert.ok(kinds.includes('text'), `kinds: ${kinds.join(',')}`);
  assert.ok(kinds.includes('complete'), `kinds: ${kinds.join(',')}`);

  const sessionCreated = captured.find((entry) => entry.kind === 'session_created');
  assert.equal(sessionCreated?.newSessionId, 'mock-session-123');

  const text = captured.find((entry) => entry.kind === 'text');
  assert.equal(text?.content, `OK:hello:perm=none CFG:${DEFAULT_CONFIG_DIR}`);

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 0);
});

test('workbuddy run closes one-shot stdin so a completed CLI can emit its terminal result', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'assistant-complete-await-eof';
  process.env.WORKBUDDY_RUN_TIMEOUT_MS = '50';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'finish after EOF',
    { sessionId: 'wb-eof-terminal', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  assert.equal(captured.find((entry) => entry.kind === 'text')?.content, 'assistant response finished');
  assert.equal(captured.find((entry) => entry.kind === 'complete')?.exitCode, 0);
  assert.equal(captured.some((entry) => entry.kind === 'error'), false);
});

test('workbuddy run resumes an existing session id', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];
  const providerSessionIds = new Map<string, string | null>([
    ['wb-test-2', 'previous-session-id'],
  ]);

  await workbuddyRuntime.run(
    'continue work',
    { sessionId: 'wb-test-2', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(providerSessionIds),
  );

  const text = captured.find((entry) => entry.kind === 'text');
  assert.equal(text?.content, `RESUMED:previous-session-id:continue work CFG:${DEFAULT_CONFIG_DIR}`);
  // A resumed session must not announce a fresh session id.
  assert.equal(captured.some((entry) => entry.kind === 'session_created'), false);
});

test('workbuddy run sends image and file attachments as stream-json stdin', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wb-attach-'));
  const imagePath = path.join(tempDir, 'photo.png');
  const filePath = path.join(tempDir, 'notes.txt');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await writeFile(filePath, 'hello file');

  try {
    await workbuddyRuntime.run(
      'look at this',
      {
        sessionId: 'wb-attach',
        cwd: tempDir,
        attachments: [
          { path: imagePath, name: 'photo.png', mimeType: 'image/png' },
          { path: filePath, name: 'notes.txt' },
        ],
      },
      makeWriter(captured),
      makeContext(new Map()),
    );

    // The mock echoes the prompt plus a count of the stdin content blocks, so
    // this asserts the runtime switched to stream-json and serialized one
    // image block and one document block.
    const text = captured.find((entry) => entry.kind === 'text');
    assert.equal(text?.content, `OK:look at this:perm=none CFG:${DEFAULT_CONFIG_DIR} STDIN:1img:1file`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('workbuddy run keeps attachments working when resuming a session', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];
  const providerSessionIds = new Map<string, string | null>([
    ['wb-attach-resume', 'previous-session-id'],
  ]);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wb-attach-resume-'));
  const imagePath = path.join(tempDir, 'photo.png');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

  try {
    await workbuddyRuntime.run(
      'still looking',
      {
        sessionId: 'wb-attach-resume',
        cwd: tempDir,
        attachments: [{ path: imagePath, name: 'photo.png', mimeType: 'image/png' }],
      },
      makeWriter(captured),
      makeContext(providerSessionIds),
    );

    const text = captured.find((entry) => entry.kind === 'text');
    assert.equal(text?.content, `RESUMED:previous-session-id:still looking CFG:${DEFAULT_CONFIG_DIR} STDIN:1img:0file`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('workbuddy run forwards the permission mode flag', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'edit the file',
    { sessionId: 'wb-test-3', cwd: '/tmp', permissionMode: 'acceptEdits' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const text = captured.find((entry) => entry.kind === 'text');
  assert.equal(text?.content, `OK:edit the file:perm=acceptEdits CFG:${DEFAULT_CONFIG_DIR}`);
});

test('workbuddy run forwards the selected model to a new session', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'hello',
    { sessionId: 'wb-model-new', cwd: '/tmp', model: 'glm-5.1' },
    makeWriter(captured),
    makeContext(new Map(), undefined, 'glm-5.1'),
  );

  const text = captured.find((entry) => entry.kind === 'text');
  assert.equal(text?.content, `OK:hello:perm=none MODEL:glm-5.1 CFG:${DEFAULT_CONFIG_DIR}`);
});

test('workbuddy run forwards a model-supported reasoning effort', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'reason carefully',
    { sessionId: 'wb-effort', cwd: '/tmp', model: 'glm-5.3', effort: 'xhigh' },
    makeWriter(captured),
    makeContext(new Map(), undefined, 'glm-5.3', {
      OPTIONS: [{ value: 'glm-5.3', label: 'GLM-5.3', effort: { values: [{ value: 'low' }, { value: 'xhigh' }] } }],
      DEFAULT: 'glm-5.3',
    }),
  );

  assert.equal(captured.find((entry) => entry.kind === 'text')?.content, `OK:reason carefully:perm=none MODEL:glm-5.3 EFFORT:xhigh CFG:${DEFAULT_CONFIG_DIR}`);
});

test('workbuddy run forwards the recorded model when resuming a session', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];
  const providerSessionIds = new Map<string, string | null>([
    ['wb-model-resume', 'previous-session-id'],
  ]);

  await workbuddyRuntime.run(
    'continue work',
    { sessionId: 'wb-model-resume', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(providerSessionIds, undefined, 'glm-4.7'),
  );

  const text = captured.find((entry) => entry.kind === 'text');
  assert.equal(text?.content, `RESUMED:previous-session-id:continue work MODEL:glm-4.7 CFG:${DEFAULT_CONFIG_DIR}`);
});

test('workbuddy run reports a failed task with exit code 1', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'error';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'do the impossible',
    { sessionId: 'wb-test-4', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 1);
});

test('workbuddy run surfaces a fatal engine error event to the frontend', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'error-event';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'continue work',
    { sessionId: 'wb-error-event', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const error = captured.find((entry) => entry.kind === 'error');
  assert.equal(error?.content, 'No conversation found with session ID: mock-session');

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 1);
});

test('workbuddy run redacts credentials from fatal engine error events', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'error-sensitive';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'continue work',
    { sessionId: 'wb-error-sensitive', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const error = captured.find((entry) => entry.kind === 'error');
  assert.match(String(error?.content), /\[REDACTED\]/);
  assert.doesNotMatch(String(error?.content), /secret-value|another-secret/);
});

test('workbuddy run forwards top-level function call events to the frontend', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'function-events';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'search tools',
    { sessionId: 'wb-function-events', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const toolUse = captured.find((entry) => entry.kind === 'tool_use');
  assert.equal(toolUse?.toolName, 'ToolSearch');
  assert.equal(toolUse?.toolId, 'call-tool-search');

  const toolResult = captured.find((entry) => entry.kind === 'tool_result');
  assert.equal(toolResult?.toolId, 'call-tool-search');
  assert.equal(toolResult?.content, 'No matching tools found');
});

test('workbuddy run forwards reasoning events as thinking messages', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'reasoning-events';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'diagnose',
    { sessionId: 'wb-reasoning-events', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const thinking = captured.filter((entry) => entry.kind === 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]?.content, 'thinking about the problem');
  assert.equal(thinking[0]?.role, 'assistant');
  assert.equal(thinking[0]?.provider, 'workbuddy');

  // The tool call still streams after the thinking block so the UI can show
  // both the in-progress reasoning and the tool lifecycle.
  assert.equal(captured.find((entry) => entry.kind === 'tool_use')?.toolName, 'Bash');
  assert.equal(captured.find((entry) => entry.kind === 'complete')?.exitCode, 0);
});

test('workbuddy run preserves task lifecycle events with one stable task id', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'task-events';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'run a background task',
    { sessionId: 'wb-task-events', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const taskEvents = captured.filter((entry) => entry.kind === 'task_notification');
  assert.deepEqual(taskEvents.map((entry) => entry.status), ['running', 'running', 'completed', 'completed', 'completed']);
  assert.deepEqual(new Set(taskEvents.map((entry) => entry.id)).size, 1);
  assert.equal(taskEvents[0]?.taskId, 'task-1');
  assert.equal(taskEvents.at(-1)?.summary, 'Background task final notification');
  assert.equal(
    captured.findIndex((entry) => entry.kind === 'complete'),
    captured.length - 1,
  );
});

test('workbuddy run preserves failed task lifecycle events and fails the run', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'task-failure';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'run a failing background task',
    { sessionId: 'wb-task-failure', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const taskEvents = captured.filter((entry) => entry.kind === 'task_notification');
  assert.deepEqual(taskEvents.map((entry) => entry.status), ['running', 'failed', 'failed']);
  assert.equal(new Set(taskEvents.map((entry) => entry.id)).size, 1);
  assert.equal(captured.find((entry) => entry.kind === 'complete')?.exitCode, 1);
});

test('workbuddy run ignores invalid JSON and unknown events without dropping valid output', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'unknown-invalid';
  const captured: Captured[] = [];
  const diagnostics: unknown[][] = [];
  const originalConsoleWarn = console.warn;
  console.warn = (...args: unknown[]) => diagnostics.push(args);

  try {
    await workbuddyRuntime.run(
      'ignore unknown protocol data',
      { sessionId: 'wb-unknown-invalid', cwd: '/tmp' },
      makeWriter(captured),
      makeContext(new Map()),
    );
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(captured.find((entry) => entry.kind === 'text')?.content, 'unknown event ignored');
  assert.equal(captured.some((entry) => entry.kind === 'error'), false);
  assert.equal(captured.find((entry) => entry.kind === 'complete')?.exitCode, 0);
  const diagnosticText = JSON.stringify(diagnostics);
  assert.match(diagnosticText, /invalid stream-json|unsupported stream-json/);
  assert.match(diagnosticText, /wb-unknown-invalid/);
  assert.doesNotMatch(diagnosticText, /not valid json/);
});

test('workbuddy run reports a non-zero CLI exit when no terminal result exists', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'exit-nonzero';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'exit abnormally',
    { sessionId: 'wb-exit-nonzero', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  assert.equal(captured.find((entry) => entry.kind === 'complete')?.exitCode, 1);
});

test('workbuddy runtime redacts sensitive values from CLI stderr diagnostics', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'stderr-sensitive';
  const captured: Captured[] = [];
  const diagnostics: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => diagnostics.push(args);

  try {
    await workbuddyRuntime.run(
      'emit diagnostic',
      { sessionId: 'wb-stderr-sensitive', cwd: '/tmp' },
      makeWriter(captured),
      makeContext(new Map()),
    );
  } finally {
    console.error = originalConsoleError;
  }

  const diagnosticText = JSON.stringify(diagnostics);
  assert.match(diagnosticText, /wb-stderr-sensitive/);
  assert.doesNotMatch(diagnosticText, /secret-value|another-secret/);
  assert.equal(captured.find((entry) => entry.kind === 'complete')?.exitCode, 0);
});

test('workbuddy run points the engine at the session config dir', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'hello',
    { sessionId: 'wb-cfg-test', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map(), '/Users/test/.workbuddy'),
  );

  const text = captured.find((entry) => entry.kind === 'text');
  assert.equal(text?.content, 'OK:hello:perm=none CFG:/Users/test/.workbuddy');
});

test('workbuddy run preserves an explicit config-root override for new sessions', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  process.env.CODEBUDDY_CONFIG_DIR = '/custom/workbuddy-root';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'hello',
    { sessionId: 'wb-env-cfg', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  assert.equal(captured.find((entry) => entry.kind === 'text')?.content, 'OK:hello:perm=none CFG:/custom/workbuddy-root');
});

test('workbuddy run defaults the engine config dir to ~/.workbuddy for new sessions', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'success';
  const captured: Captured[] = [];

  // No session-row config dir exists for a brand-new session, so the runtime
  // must still point the engine at the WorkBuddy desktop config root — where
  // the user's skills and plugins live — instead of the embedded CLI default.
  await workbuddyRuntime.run(
    'hello',
    { sessionId: 'wb-default-cfg', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const text = captured.find((entry) => entry.kind === 'text');
  assert.equal(text?.content, `OK:hello:perm=none CFG:${DEFAULT_CONFIG_DIR}`);
});

test('workbuddy run flushes a final event that lacks a trailing newline', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'no-trailing-newline';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'no trailing newline',
    { sessionId: 'wb-nonl', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const text = captured.find((entry) => entry.kind === 'text');
  assert.equal(text?.content, 'final line without newline');

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 0);
});

test('workbuddy run without a session id completes immediately with exit code 1', async () => {
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'orphan prompt',
    { cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  assert.deepEqual(captured.map((entry) => entry.kind), ['complete']);
  assert.equal(captured[0]?.exitCode, 1);
});

test('workbuddy abort of an unknown session returns false', async () => {
  assert.equal(await workbuddyRuntime.abort('no-such-session'), false);
});

test('workbuddy abort kills a running process and reports an aborted complete', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'hang';
  const captured: Captured[] = [];

  const runPromise = workbuddyRuntime.run(
    'hang forever',
    { sessionId: 'wb-abort', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );
  // Give the mock CLI time to spawn before aborting it.
  await sleep(150);

  assert.equal(await workbuddyRuntime.abort('wb-abort'), true);
  await runPromise;

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 0);
  assert.equal(complete?.aborted, true);
});

test('workbuddy run handles a closed stdin pipe without crashing the server', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'stdin-closed';
  const captured: Captured[] = [];

  const runPromise = workbuddyRuntime.run(
    'close stdin before interrupt',
    { sessionId: 'wb-stdin-closed', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );
  await sleep(100);

  assert.equal(await workbuddyRuntime.abort('wb-stdin-closed'), true);
  await runPromise;

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 0);
  assert.equal(complete?.aborted, true);
});

test('workbuddy reaps a process after a fatal stream error before allowing another run', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'error-event-hang';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'fatal engine error',
    { sessionId: 'wb-error-event-hang', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  assert.equal(captured.find((entry) => entry.kind === 'complete')?.exitCode, 1);
  assert.equal(captured.some((entry) => entry.content === 'must be ignored after fatal error'), false);
  assert.equal(await workbuddyRuntime.abort('wb-error-event-hang'), false);
});

test('workbuddy run times out a silent CLI and cleans up the process', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'hang';
  process.env.WORKBUDDY_RUN_TIMEOUT_MS = '50';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'hang until timeout',
    { sessionId: 'wb-timeout', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 1);
  assert.equal(captured.find((entry) => entry.kind === 'error')?.content, 'WorkBuddy run timed out after 50ms');
  assert.equal(await workbuddyRuntime.abort('wb-timeout'), false);
});

for (const mode of ['success-result-hang', 'error-result-hang']) {
  test(`workbuddy run still times out after ${mode}`, async () => {
    process.env.CODEBUDDY_COMMAND = MOCK_CLI;
    process.env.MOCK_MODE = mode;
    process.env.WORKBUDDY_RUN_TIMEOUT_MS = '50';
    const captured: Captured[] = [];
    const sessionId = `wb-${mode}`;

    await workbuddyRuntime.run(
      'emit a result and hang',
      { sessionId, cwd: '/tmp' },
      makeWriter(captured),
      makeContext(new Map()),
    );

    const complete = captured.find((entry) => entry.kind === 'complete');
    const lastError = captured.filter((entry) => entry.kind === 'error').at(-1);
    assert.equal(complete?.exitCode, 1);
    assert.equal(lastError?.content, 'WorkBuddy run timed out after 50ms');
    assert.equal(await workbuddyRuntime.abort(sessionId), false);
  });
}

test('workbuddy fatal error overrides a pending successful result', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'result-then-error-hang';
  process.env.WORKBUDDY_RUN_TIMEOUT_MS = '200';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'fail after a result',
    { sessionId: 'wb-result-then-error', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  assert.equal(captured.find((entry) => entry.kind === 'error')?.content, 'fatal error after terminal result');
  assert.equal(captured.find((entry) => entry.kind === 'complete')?.exitCode, 1);
  assert.equal(await workbuddyRuntime.abort('wb-result-then-error'), false);
});

test('workbuddy abort terminates a one-shot stdin run and reports completion as aborted', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'interruptible';
  const captured: Captured[] = [];

  const runPromise = workbuddyRuntime.run(
    'interrupt this task',
    { sessionId: 'wb-interrupt', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );
  await sleep(100);

  assert.equal(await workbuddyRuntime.abort('wb-interrupt'), true);
  await runPromise;

  assert.equal(captured.find((entry) => entry.kind === 'complete')?.aborted, true);
});

test('workbuddy rejects a concurrent run for the same app session', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'hang';
  const firstCaptured: Captured[] = [];
  const secondCaptured: Captured[] = [];
  const firstRun = workbuddyRuntime.run(
    'first task',
    { sessionId: 'wb-concurrent', cwd: '/tmp' },
    makeWriter(firstCaptured),
    makeContext(new Map()),
  );

  await sleep(100);
  await workbuddyRuntime.run(
    'second task',
    { sessionId: 'wb-concurrent', cwd: '/tmp' },
    makeWriter(secondCaptured),
    makeContext(new Map()),
  );
  assert.equal(secondCaptured.find((entry) => entry.kind === 'complete')?.exitCode, 1);
  assert.match(String(secondCaptured.find((entry) => entry.kind === 'error')?.content), /already has a running task/);

  assert.equal(await workbuddyRuntime.abort('wb-concurrent'), true);
  await firstRun;
});

test('workbuddy run reports a spawn failure as exit code 1', async () => {
  resetWorkbuddyCommandForTests();
  process.env.CODEBUDDY_COMMAND = path.join('/nonexistent', 'codebuddy-missing');
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'cannot spawn',
    { sessionId: 'wb-spawn-fail', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const complete = captured.find((entry) => entry.kind === 'complete');
  assert.equal(complete?.exitCode, 1);

  resetWorkbuddyCommandForTests();
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  resetWorkbuddyRuntimeForTests();
});

test('workbuddy normalizeMessage ignores non-assistant events', () => {
  const provider = new WorkbuddySessionsProvider();

  assert.deepEqual(provider.normalizeMessage({ type: 'result', subtype: 'success' }, 's'), []);
  assert.deepEqual(provider.normalizeMessage(null, 's'), []);
});

test('workbuddy normalizeMessage preserves thinking, text, and tool blocks', () => {
  const provider = new WorkbuddySessionsProvider();
  const event = {
    type: 'assistant',
    session_id: 'mock-session-123',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '  ' },
        { type: 'thinking', thinking: 'real thought' },
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
        { type: 'text', text: '' },
      ],
    },
  };

  const messages = provider.normalizeMessage(event, 'app-session');

  assert.deepEqual(messages.map((message) => message.kind), ['thinking', 'text', 'tool_use', 'tool_result']);
  assert.equal(messages[0]?.content, 'real thought');
  assert.equal(messages[0]?.provider, 'workbuddy');
  assert.equal(messages[1]?.content, 'hello world');
  assert.equal(messages[1]?.sessionId, 'app-session');
  assert.equal(messages[2]?.toolName, 'Bash');
  assert.deepEqual(messages[2]?.toolInput, { command: 'pwd' });
  assert.equal(messages[3]?.toolId, 'tool-1');
  assert.equal(messages[3]?.content, 'ok');

  assert.deepEqual(
    provider.normalizeMessage({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'failed', is_error: true }] },
    }, 'app-session').map((message) => ({ kind: message.kind, toolId: message.toolId, isError: message.isError })),
    [{ kind: 'tool_result', toolId: 'tool-2', isError: true }],
  );

  const functionCall = provider.normalizeMessage({
    type: 'function_call',
    id: 'function-event-1',
    callId: 'call-search-1',
    name: 'ToolSearch',
    arguments: '{"queries":["smoke"]}',
  }, 'app-session');
  const functionResult = provider.normalizeMessage({
    type: 'function_call_result',
    id: 'function-result-1',
    callId: 'call-search-1',
    name: 'ToolSearch',
    status: 'completed',
    output: { type: 'text', text: 'No matching tools found' },
  }, 'app-session');
  assert.equal(functionCall[0]?.kind, 'tool_use');
  assert.equal(functionCall[0]?.toolId, 'call-search-1');
  assert.equal(functionResult[0]?.kind, 'tool_result');
  assert.equal(functionResult[0]?.toolId, 'call-search-1');
  assert.equal(functionResult[0]?.content, 'No matching tools found');

  const deniedResult = provider.normalizeMessage({
    type: 'function_call_result',
    id: 'function-result-denied',
    callId: 'call-search-denied',
    name: 'ToolSearch',
    status: 'denied',
    output: { type: 'text', text: 'permission denied' },
  }, 'app-session');
  assert.equal(deniedResult[0]?.kind, 'tool_result');
  assert.equal(deniedResult[0]?.isError, true);
  assert.equal(deniedResult[0]?.status, 'denied');

  const failedTask = provider.normalizeMessage({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task-failed',
    status: 'failed',
    description: 'failed task',
  }, 'app-session');
  assert.equal(failedTask[0]?.kind, 'task_notification');
  assert.equal(failedTask[0]?.status, 'failed');
  assert.equal(failedTask[0]?.isFinal, true);
});

test('workbuddy normalizeMessage maps top-level reasoning events to thinking messages', () => {
  const provider = new WorkbuddySessionsProvider();

  const messages = provider.normalizeMessage({
    type: 'reasoning',
    id: 'reasoning-1',
    rawContent: [
      { type: 'reasoning_text', text: 'first thought' },
      { type: 'reasoning_text', text: '  ' },
      { type: 'reasoning_text', text: 'second thought' },
    ],
  }, 'app-session');

  assert.deepEqual(messages.map((message) => message.kind), ['thinking', 'thinking']);
  assert.deepEqual(messages.map((message) => message.content), ['first thought', 'second thought']);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0]?.provider, 'workbuddy');
  assert.equal(messages[0]?.sessionId, 'app-session');

  // The rawContent array is authoritative; a reasoning event with no text
  // produces no messages rather than a fake assistant turn.
  assert.deepEqual(provider.normalizeMessage({ type: 'reasoning', rawContent: [] }, 's'), []);
  assert.deepEqual(
    provider.normalizeMessage({ type: 'reasoning', rawContent: [{ type: 'other', text: 'ignored' }] }, 's'),
    [],
  );
});

test('workbuddy normalizeMessage maps streamed deltas and message_stop', () => {
  const provider = new WorkbuddySessionsProvider();

  const thinking = provider.normalizeMessage({
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: 'a thought' },
  }, 'app-session');
  assert.equal(thinking[0]?.kind, 'stream_delta');
  assert.equal(thinking[0]?.streamChannel, 'thinking');
  assert.equal(thinking[0]?.content, 'a thought');
  assert.equal(thinking[0]?.provider, 'workbuddy');

  const text = provider.normalizeMessage({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'hi' },
  }, 'app-session');
  assert.equal(text[0]?.kind, 'stream_delta');
  assert.equal(text[0]?.streamChannel, 'text');
  assert.equal(text[0]?.content, 'hi');

  const stop = provider.normalizeMessage({ type: 'message_stop' }, 'app-session');
  assert.equal(stop[0]?.kind, 'stream_end');

  // Non-delta content-block frames and empty deltas produce nothing.
  assert.deepEqual(provider.normalizeMessage({ type: 'content_block_start', index: 0 }, 's'), []);
  assert.deepEqual(provider.normalizeMessage({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }, 's'), []);
});

test('workbuddy streams thinking/reply deltas and suppresses the full-message copy', async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'streaming';
  const captured: Captured[] = [];

  await workbuddyRuntime.run(
    'hello',
    { sessionId: 'wb-streaming', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const deltas = captured.filter((entry) => entry.kind === 'stream_delta');
  const reply = deltas.filter((entry) => entry.streamChannel !== 'thinking').map((entry) => entry.content).join('');
  const thinking = deltas.filter((entry) => entry.streamChannel === 'thinking').map((entry) => entry.content).join('');
  assert.equal(reply, 'OK:hello:perm=none');
  assert.equal(thinking, 'mock thinking');

  const streamEndIndex = captured.findIndex((entry) => entry.kind === 'stream_end');
  assert.notEqual(streamEndIndex, -1, 'expected a stream_end to finalize the placeholder rows');
  const lastDeltaIndex = captured.map((entry) => entry.kind).lastIndexOf('stream_delta');
  assert.ok(lastDeltaIndex < streamEndIndex, 'every delta must precede stream_end');

  // The full assistant events that follow `message_stop` must not re-emit the
  // blocks that streamed.
  const duplicated = captured
    .slice(streamEndIndex + 1)
    .filter((entry) => entry.kind === 'text' || entry.kind === 'thinking');
  assert.deepEqual(duplicated, [], `unexpected duplicated content: ${JSON.stringify(duplicated)}`);

  assert.equal(captured.find((entry) => entry.kind === 'complete')?.exitCode, 0);
});

// The regression depends on SIGTERM reaching the child and letting it emit one
// last delta, which is POSIX-specific; Windows kill semantics would not.
test('a workbuddy abort drops a delta that arrives after the terminal complete', { skip: process.platform === 'win32' }, async () => {
  process.env.CODEBUDDY_COMMAND = MOCK_CLI;
  process.env.MOCK_MODE = 'streaming-hang';
  const captured: Captured[] = [];

  const runPromise = workbuddyRuntime.run(
    'hang and stream',
    { sessionId: 'wb-abort-stream', cwd: '/tmp' },
    makeWriter(captured),
    makeContext(new Map()),
  );

  const deadline = Date.now() + 5000;
  while (!captured.some((entry) => entry.kind === 'stream_delta')) {
    if (Date.now() > deadline) {
      assert.fail('timed out waiting for the mock CLI to stream');
    }
    await sleep(20);
  }

  assert.equal(await workbuddyRuntime.abort('wb-abort-stream'), true);
  // `handleChatAbort` emits the terminal complete directly on the writer,
  // bypassing the runtime's coalescer — reproduce that here.
  captured.push({ kind: 'complete', provider: 'workbuddy', aborted: true });

  await runPromise;
  // Outlast both the coalescer window (50ms) and the mock's 300ms linger.
  await sleep(400);

  const completeIndex = captured.findIndex((entry) => entry.kind === 'complete');
  assert.notEqual(completeIndex, -1);
  const lateDeltas = captured
    .slice(completeIndex + 1)
    .filter((entry) => entry.kind === 'stream_delta');
  assert.deepEqual(lateDeltas, [], `unexpected delta after complete: ${JSON.stringify(lateDeltas)}`);
});
