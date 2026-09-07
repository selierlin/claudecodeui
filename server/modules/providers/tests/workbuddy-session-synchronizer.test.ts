import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { WorkbuddySessionSynchronizer } from '@/modules/providers/list/workbuddy/workbuddy-session-synchronizer.provider.js';
import { WorkbuddySessionsProvider } from '@/modules/providers/list/workbuddy/workbuddy-sessions.provider.js';

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
  // The root resolution prefers explicit overrides over the patched home
  // directory. Developers' shells often export WORKBUDDY_CONFIG_DIR /
  // CODEBUDDY_CONFIG_DIR, which would otherwise redirect the scan to the real
  // user data and break the isolated fixtures.
  const previousProjectsRoot = process.env.WORKBUDDY_PROJECTS_ROOT;
  const previousWorkbuddyConfigDir = process.env.WORKBUDDY_CONFIG_DIR;
  const previousCodebuddyConfigDir = process.env.CODEBUDDY_CONFIG_DIR;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'workbuddy-session-sync-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const restoreHomeDir = patchHomeDir(tempDirectory);

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  delete process.env.WORKBUDDY_PROJECTS_ROOT;
  delete process.env.WORKBUDDY_CONFIG_DIR;
  delete process.env.CODEBUDDY_CONFIG_DIR;
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
    if (previousProjectsRoot === undefined) {
      delete process.env.WORKBUDDY_PROJECTS_ROOT;
    } else {
      process.env.WORKBUDDY_PROJECTS_ROOT = previousProjectsRoot;
    }
    if (previousWorkbuddyConfigDir === undefined) {
      delete process.env.WORKBUDDY_CONFIG_DIR;
    } else {
      process.env.WORKBUDDY_CONFIG_DIR = previousWorkbuddyConfigDir;
    }
    if (previousCodebuddyConfigDir === undefined) {
      delete process.env.CODEBUDDY_CONFIG_DIR;
    } else {
      process.env.CODEBUDDY_CONFIG_DIR = previousCodebuddyConfigDir;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Mirrors the engine's directory encoding: strip the leading slash, `/` → `-`. */
const encodeCwd = (cwd: string): string => cwd.replace(/^\//, '').replace(/\//g, '-');

async function writeSessionFile(
  homeDir: string,
  engineRoot: string,
  cwd: string,
  sessionId: string,
  events: unknown[],
): Promise<void> {
  const dir = path.join(homeDir, engineRoot, 'projects', encodeCwd(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${sessionId}.jsonl`), events.map((event) => JSON.stringify(event)).join('\n'));
}

const makeUserMessage = (sessionId: string, cwd: string, text: string, time: number) => ({
  id: `msg-${time}`,
  timestamp: time,
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
  sessionId,
  cwd,
});

const makeAiTitle = (sessionId: string, cwd: string, title: string) => ({
  timestamp: Date.now(),
  type: 'ai-title',
  aiTitle: title,
  sessionId,
  cwd,
});

const makeAssistantMessage = (sessionId: string, cwd: string, blocks: unknown[], time: number) => ({
  id: `msg-${time}`,
  timestamp: time,
  type: 'message',
  role: 'assistant',
  content: blocks,
  sessionId,
  cwd,
});

test('synchronizer indexes sessions from both engine roots and uses ai-title as the name', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'project-a');
    const sessionA = 'wb-session-a';
    const sessionB = 'wb-session-b';

    await writeSessionFile(homeDir, '.codebuddy', cwd, sessionA, [
      makeUserMessage(sessionA, cwd, 'Initial prompt', 1_700_000_000_000),
      makeAiTitle(sessionA, cwd, 'Debug the failing test'),
    ]);
    await writeSessionFile(homeDir, '.workbuddy', cwd, sessionB, [
      makeUserMessage(sessionB, cwd, 'Second session', 1_700_000_100_000),
      makeAiTitle(sessionB, cwd, 'Refactor the provider'),
    ]);

    const synchronizer = new WorkbuddySessionSynchronizer();
    const processed = await synchronizer.synchronize();
    assert.equal(processed, 2);

    assert.equal(sessionsDb.getSessionById(sessionA)?.custom_name, 'Debug the failing test');
    assert.equal(sessionsDb.getSessionById(sessionA)?.project_path, cwd);
    assert.equal(sessionsDb.getSessionById(sessionA)?.provider, 'workbuddy');
    assert.equal(sessionsDb.getSessionById(sessionB)?.custom_name, 'Refactor the provider');
  });
});

test('synchronizer skips subagent transcripts under session directories', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'project-b');
    const sessionId = 'wb-session-main';
    await writeSessionFile(homeDir, '.codebuddy', cwd, sessionId, [
      makeUserMessage(sessionId, cwd, 'Main session', 1_700_000_000_000),
      makeAiTitle(sessionId, cwd, 'Main title'),
    ]);

    const projectDir = path.join(homeDir, '.codebuddy', 'projects', encodeCwd(cwd), sessionId);
    await mkdir(path.join(projectDir, 'subagents'), { recursive: true });
    await writeFile(
      path.join(projectDir, 'subagents', 'agent-1.jsonl'),
      JSON.stringify(makeUserMessage(sessionId, cwd, 'Subagent prompt', 1_700_000_100_000)),
    );

    const synchronizer = new WorkbuddySessionSynchronizer();
    const processed = await synchronizer.synchronize();
    assert.equal(processed, 1);
    assert.equal(sessionsDb.getAllSessions().length, 1);
    assert.ok(sessionsDb.getSessionById(sessionId)?.jsonl_path?.endsWith(`${sessionId}.jsonl`));
  });
});

test('synchronizer keeps the app-assigned name and does not duplicate app sessions', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'project-c');
    const providerSessionId = 'wb-session-app';
    await writeSessionFile(homeDir, '.codebuddy', cwd, providerSessionId, [
      makeUserMessage(providerSessionId, cwd, 'Prompt', 1_700_000_000_000),
      makeAiTitle(providerSessionId, cwd, 'Engine generated title'),
    ]);

    sessionsDb.createAppSession('app-wb-1', 'workbuddy', cwd, 'CloudCLI title');
    sessionsDb.assignProviderSessionId('app-wb-1', providerSessionId);

    const synchronizer = new WorkbuddySessionSynchronizer();
    const processed = await synchronizer.synchronize();
    assert.equal(processed, 1);
    assert.equal(sessionsDb.getAllSessions().length, 1);
    assert.equal(sessionsDb.getSessionById('app-wb-1')?.custom_name, 'CloudCLI title');
    assert.equal(sessionsDb.getSessionById('app-wb-1')?.provider_session_id, providerSessionId);
  });
});

test('synchronizer does not recreate a session after a permanent delete removes the row and file', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'ghost-project');
    const sessionId = 'wb-session-ghost';
    await writeSessionFile(homeDir, '.codebuddy', cwd, sessionId, [
      makeUserMessage(sessionId, cwd, 'Gone', 1_700_000_000_000),
    ]);

    const synchronizer = new WorkbuddySessionSynchronizer();
    await synchronizer.synchronize();
    assert.ok(sessionsDb.getSessionById(sessionId));

    // Simulate a permanent delete: both the DB row and the transcript file are
    // removed. WorkBuddy's file-driven scan must not recreate the session.
    sessionsDb.deleteSessionById(sessionId);
    await rm(path.join(homeDir, '.codebuddy', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`));

    await synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById(sessionId), null);
  });
});

test('synchronizer does not resurrect archived sessions on a full re-scan', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'project-archived');
    const sessionId = 'wb-session-archived';
    await writeSessionFile(homeDir, '.codebuddy', cwd, sessionId, [
      makeUserMessage(sessionId, cwd, 'Keep hidden', 1_700_000_000_000),
      makeAiTitle(sessionId, cwd, 'Hidden title'),
    ]);

    const synchronizer = new WorkbuddySessionSynchronizer();
    await synchronizer.synchronize();
    sessionsDb.updateSessionIsArchived(sessionId, true);

    const processed = await synchronizer.synchronize();
    assert.equal(processed, 0);
    assert.equal(sessionsDb.getSessionById(sessionId)?.isArchived, 1);
    assert.deepEqual(sessionsDb.getAllSessions().map((s) => s.session_id), []);
  });
});

test('synchronizer uses a full scan once, then honors the incremental cursor', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'incremental-project');
    const sessionId = 'wb-session-incremental';
    await writeSessionFile(homeDir, '.codebuddy', cwd, sessionId, [
      makeUserMessage(sessionId, cwd, 'Backfill this session', 1_700_000_000_000),
    ]);

    const synchronizer = new WorkbuddySessionSynchronizer();
    assert.equal(await synchronizer.synchronize(), 1);

    // A cursor after the file's creation time must not cause a second full
    // scan to process the same transcript again.
    assert.equal(await synchronizer.synchronize(new Date(Date.now() + 60_000)), 0);
    assert.ok(sessionsDb.getSessionById(sessionId));
  });
});

test('synchronizer indexes appended transcript updates after the initial scan', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'incremental-update-project');
    const sessionId = 'wb-session-incremental-update';
    await writeSessionFile(homeDir, '.codebuddy', cwd, sessionId, [
      makeUserMessage(sessionId, cwd, 'Add a title later', 1_700_000_000_000),
    ]);

    const synchronizer = new WorkbuddySessionSynchronizer();
    await synchronizer.synchronize();
    const scanSince = new Date();
    const transcriptPath = path.join(homeDir, '.codebuddy', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
    await appendFile(transcriptPath, `\n${JSON.stringify(makeAiTitle(sessionId, cwd, 'Added after the initial scan'))}`);
    await utimes(transcriptPath, new Date(), new Date(scanSince.getTime() + 1_000));

    assert.equal(await synchronizer.synchronize(scanSince), 1);
    assert.equal(sessionsDb.getSessionById(sessionId)?.custom_name, 'Added after the initial scan');
  });
});

test('synchronizer keeps a real title when a later re-scan cannot derive a name', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'project-name');
    const sessionId = 'wb-session-name';
    await writeSessionFile(homeDir, '.codebuddy', cwd, sessionId, [
      makeUserMessage(sessionId, cwd, 'Prompt', 1_700_000_000_000),
      makeAiTitle(sessionId, cwd, 'Real title'),
    ]);

    const synchronizer = new WorkbuddySessionSynchronizer();
    await synchronizer.synchronize();
    assert.equal(sessionsDb.getSessionById(sessionId)?.custom_name, 'Real title');

    // Rewrite the transcript without an ai-title; a re-scan must not downgrade
    // the stored title to the placeholder.
    await writeSessionFile(homeDir, '.codebuddy', cwd, sessionId, [
      makeUserMessage(sessionId, cwd, 'Prompt', 1_700_000_000_000),
    ]);
    await synchronizer.synchronize();

    assert.equal(sessionsDb.getSessionById(sessionId)?.custom_name, 'Real title');
  });
});

test('resolveTranscriptPath resolves a transcript across both engine roots', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'resolve-project');
    const sessionId = 'wb-resolve-1';
    await writeSessionFile(homeDir, '.workbuddy', cwd, sessionId, [
      makeUserMessage(sessionId, cwd, 'Prompt', 1_700_000_000_000),
    ]);

    const synchronizer = new WorkbuddySessionSynchronizer();
    const resolved = await synchronizer.resolveTranscriptPath(sessionId, cwd);

    assert.ok(resolved?.endsWith(`${sessionId}.jsonl`));
    assert.ok(resolved?.includes('.workbuddy'));
  });
});

test('resolveTranscriptPath returns null when no transcript exists', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'resolve-missing');
    const synchronizer = new WorkbuddySessionSynchronizer();
    assert.equal(await synchronizer.resolveTranscriptPath('wb-missing-1', cwd), null);
  });
});

test('synchronizeFile indexes one transcript by path', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'project-d');
    const sessionId = 'wb-session-file';
    await writeSessionFile(homeDir, '.workbuddy', cwd, sessionId, [
      makeUserMessage(sessionId, cwd, 'File trigger', 1_700_000_000_000),
    ]);

    const filePath = path.join(homeDir, '.workbuddy', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
    const synchronizer = new WorkbuddySessionSynchronizer();
    const indexedSessionId = await synchronizer.synchronizeFile(filePath);

    assert.equal(indexedSessionId, sessionId);
    assert.equal(sessionsDb.getSessionById(sessionId)?.project_path, cwd);
  });
});

test('synchronizer skips transient WorkBuddy timestamp and automation workspaces and keeps others', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const transientCwd = path.join(homeDir, 'WorkBuddy', '2026-08-24-00-13-24');
    const transientId = 'wb-transient';
    await writeSessionFile(homeDir, '.workbuddy', transientCwd, transientId, [
      makeUserMessage(transientId, transientCwd, 'Transient prompt', 1_700_000_000_000),
      makeAiTitle(transientId, transientCwd, 'Transient title'),
    ]);

    const automationCwd = path.join(homeDir, 'WorkBuddy', 'automation-2026-08-24-00-13-24');
    const automationId = 'wb-automation';
    await writeSessionFile(homeDir, '.workbuddy', automationCwd, automationId, [
      makeUserMessage(automationId, automationCwd, 'Automation prompt', 1_700_000_050_000),
      makeAiTitle(automationId, automationCwd, 'Automation title'),
    ]);

    const clawCwd = path.join(homeDir, 'WorkBuddy', 'Claw');
    const clawId = 'wb-claw';
    await writeSessionFile(homeDir, '.workbuddy', clawCwd, clawId, [
      makeUserMessage(clawId, clawCwd, 'Claw prompt', 1_700_000_100_000),
      makeAiTitle(clawId, clawCwd, 'Claw title'),
    ]);

    const synchronizer = new WorkbuddySessionSynchronizer();
    const processed = await synchronizer.synchronize();

    assert.equal(processed, 1);
    assert.equal(sessionsDb.getSessionById(transientId), null);
    assert.equal(sessionsDb.getSessionById(automationId), null);
    assert.equal(sessionsDb.getSessionById(clawId)?.custom_name, 'Claw title');
  });
});

test('synchronizeFile ignores a transient WorkBuddy timestamp transcript', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const transientCwd = path.join(homeDir, 'WorkBuddy', '2026-08-24-00-13-24');
    const sessionId = 'wb-transient-file';
    await writeSessionFile(homeDir, '.workbuddy', transientCwd, sessionId, [
      makeUserMessage(sessionId, transientCwd, 'Transient prompt', 1_700_000_000_000),
    ]);

    const filePath = path.join(homeDir, '.workbuddy', 'projects', encodeCwd(transientCwd), `${sessionId}.jsonl`);
    const synchronizer = new WorkbuddySessionSynchronizer();
    const indexedSessionId = await synchronizer.synchronizeFile(filePath);

    assert.equal(indexedSessionId, null);
    assert.equal(sessionsDb.getSessionById(sessionId), null);
  });
});

test('synchronizeFile returns null for non-jsonl or subagent files', async () => {
  const synchronizer = new WorkbuddySessionSynchronizer();
  assert.equal(await synchronizer.synchronizeFile('/some/path/not-jsonl.txt'), null);
  assert.equal(await synchronizer.synchronizeFile('/some/path/subagents/agent-1.jsonl'), null);
});

test('fetchHistory decodes the engine transcript into user and assistant messages', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'history-project');
    const engineSessionId = 'wb-history-1';
    await writeSessionFile(homeDir, '.codebuddy', cwd, engineSessionId, [
      makeUserMessage(engineSessionId, cwd, 'Explain the codebase', 1_700_000_000_000),
      makeAssistantMessage(engineSessionId, cwd, [
        { type: 'reasoning_text', text: 'Let me think about this.' },
        { type: 'output_text', text: 'The codebase is structured around providers.' },
      ], 1_700_000_100_000),
      makeAiTitle(engineSessionId, cwd, 'History title'),
    ]);

    sessionsDb.createAppSession('app-wb-history', 'workbuddy', cwd, 'CloudCLI');
    sessionsDb.assignProviderSessionId('app-wb-history', engineSessionId);

    const provider = new WorkbuddySessionsProvider();
    const result = await provider.fetchHistory('app-wb-history');

    assert.equal(result.total, 3);
    assert.equal(result.messages[0]?.role, 'user');
    assert.equal(result.messages[0]?.content, 'Explain the codebase');
    assert.equal(result.messages[1]?.kind, 'thinking');
    assert.equal(result.messages[1]?.content, 'Let me think about this.');
    assert.equal(result.messages[2]?.kind, 'text');
    assert.equal(result.messages[2]?.role, 'assistant');
    assert.equal(result.messages[2]?.content, 'The codebase is structured around providers.');
    assert.equal(result.messages[2]?.provider, 'workbuddy');
  });
});

test('fetchHistory pairs WorkBuddy function calls with function results by callId', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'function-call-history');
    const engineSessionId = 'wb-function-history';
    await writeSessionFile(homeDir, '.workbuddy', cwd, engineSessionId, [
      makeUserMessage(engineSessionId, cwd, 'Search the configured tools', 1_700_000_000_000),
      {
        id: 'function-call-event',
        timestamp: 1_700_000_100_000,
        type: 'function_call',
        name: 'ToolSearch',
        callId: 'call-tool-search',
        arguments: '{"queries":["smoke"]}',
        sessionId: engineSessionId,
        cwd,
      },
      {
        id: 'function-result-event',
        timestamp: 1_700_000_200_000,
        type: 'function_call_result',
        name: 'ToolSearch',
        callId: 'call-tool-search',
        status: 'completed',
        output: { type: 'text', text: 'No matching tools found' },
        sessionId: engineSessionId,
        cwd,
      },
      makeAssistantMessage(engineSessionId, cwd, [
        { type: 'output_text', text: '没有找到可用工具。' },
      ], 1_700_000_300_000),
    ]);

    sessionsDb.createAppSession('app-wb-function-history', 'workbuddy', cwd, 'CloudCLI');
    sessionsDb.assignProviderSessionId('app-wb-function-history', engineSessionId);

    const result = await new WorkbuddySessionsProvider().fetchHistory('app-wb-function-history');
    assert.equal(result.total, 4);
    assert.equal(result.messages[1]?.kind, 'tool_use');
    assert.equal(result.messages[1]?.toolName, 'ToolSearch');
    assert.equal(result.messages[1]?.toolId, 'call-tool-search');
    assert.equal(result.messages[2]?.kind, 'tool_result');
    assert.equal(result.messages[2]?.toolId, 'call-tool-search');
    assert.equal(result.messages[2]?.content, 'No matching tools found');
  });
});

test('fetchHistory returns empty history when the engine session id is unknown', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'no-history');
    sessionsDb.createAppSession('app-wb-none', 'workbuddy', cwd, 'No history');

    const provider = new WorkbuddySessionsProvider();
    const result = await provider.fetchHistory('app-wb-none');
    assert.equal(result.total, 0);
    assert.deepEqual(result.messages, []);
  });
});

test('fetchHistory returns empty history when no transcript exists on disk', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'missing-file');
    sessionsDb.createAppSession('app-wb-missing', 'workbuddy', cwd, 'Missing');
    sessionsDb.assignProviderSessionId('app-wb-missing', 'wb-ghost');

    const provider = new WorkbuddySessionsProvider();
    const result = await provider.fetchHistory('app-wb-missing');
    assert.equal(result.total, 0);
    assert.deepEqual(result.messages, []);
  });
});

test('fetchHistory extracts the real prompt from a user-context-wrapped transcript', async () => {
  await withIsolatedEnvironment(async (homeDir) => {
    const cwd = path.join(homeDir, 'workspace', 'wrapped-prompt');
    const engineSessionId = 'wb-wrapped';
    const wrappedText = [
      '<system-reminder data-role="user-context">',
      '<additional_data><current_time>Monday, August 24, 2026</current_time></additional_data>',
      '</system-reminder>',
      '<user_query>export GALILEO_ENABLE=false\n 去掉吧，没啥软用</user_query>',
    ].join('\n');
    await writeSessionFile(homeDir, '.workbuddy', cwd, engineSessionId, [
      {
        id: 'msg-wrapped',
        timestamp: 1_700_000_000_000,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: wrappedText }],
        sessionId: engineSessionId,
        cwd,
      },
      makeAiTitle(engineSessionId, cwd, 'Wrapped title'),
    ]);

    sessionsDb.createAppSession('app-wb-wrapped', 'workbuddy', cwd, 'CloudCLI');
    sessionsDb.assignProviderSessionId('app-wb-wrapped', engineSessionId);

    const provider = new WorkbuddySessionsProvider();
    const result = await provider.fetchHistory('app-wb-wrapped');

    assert.equal(result.total, 1);
    assert.equal(result.messages[0]?.role, 'user');
    assert.equal(result.messages[0]?.content, 'export GALILEO_ENABLE=false\n 去掉吧，没啥软用');
  });
});
