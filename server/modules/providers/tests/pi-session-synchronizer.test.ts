import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { PiSessionSynchronizer } from '@/modules/providers/list/pi/pi-session-synchronizer.provider.js';

async function withIsolatedEnvironment(
  runTest: (env: { sessionsRoot: string; cwd: string }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousSessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'pi-session-sync-'));
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

/** Mirrors Pi's directory encoding. */
function encodePiCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

async function writeTranscript(
  sessionsRoot: string,
  cwd: string,
  uuid: string,
  entries: unknown[],
): Promise<string> {
  const dir = path.join(sessionsRoot, encodePiCwd(cwd));
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `2026-09-09T08-00-00-000Z_${uuid}.jsonl`);
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

const userMessage = (id: string, parentId: string | null, content: unknown) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-09-09T08:00:01.000Z',
  message: { role: 'user', content, timestamp: 1788942863000 },
});

const sessionInfo = (id: string, parentId: string | null, name: string) => ({
  type: 'session_info',
  id,
  parentId,
  timestamp: '2026-09-09T09:00:00.000Z',
  name,
});

test('synchronizer indexes a Pi transcript from its header', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, 'Hello'),
    ]);

    const processed = await new PiSessionSynchronizer().synchronize();
    assert.equal(processed, 1);

    const session = sessionsDb.getSessionById(uuid);
    assert.ok(session);
    assert.equal(session.provider, 'pi');
    assert.equal(session.project_path, cwd);
    assert.equal(session.jsonl_path, path.join(sessionsRoot, encodePiCwd(cwd), `2026-09-09T08-00-00-000Z_${uuid}.jsonl`));
  });
});

test('synchronizer prefers an explicit session_info name over the first prompt', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, 'First prompt'),
      sessionInfo('a2', 'a1', 'Refactor auth module'),
    ]);

    const processed = await new PiSessionSynchronizer().synchronize();
    assert.equal(processed, 1);
    assert.equal(sessionsDb.getSessionById(uuid)?.custom_name, 'Refactor auth module');
  });
});

test('synchronizer falls back to the first user prompt for unnamed sessions', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, [{ type: 'text', text: 'Describe this bug' }]),
    ]);

    await new PiSessionSynchronizer().synchronize();
    assert.equal(sessionsDb.getSessionById(uuid)?.custom_name, 'Describe this bug');
  });
});

test('synchronizer tolerates malformed transcript lines', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    const dir = path.join(sessionsRoot, encodePiCwd(cwd));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `2026-09-09T08-00-00-000Z_${uuid}.jsonl`),
      `${JSON.stringify(header(uuid, cwd))}\nnot-json\n${JSON.stringify(userMessage('a1', null, 'ok'))}\n`,
    );

    const processed = await new PiSessionSynchronizer().synchronize();
    assert.equal(processed, 1);
    assert.ok(sessionsDb.getSessionById(uuid));
  });
});

test('synchronizer does not resurrect archived sessions on a full re-scan', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, 'Keep hidden'),
    ]);

    const synchronizer = new PiSessionSynchronizer();
    await synchronizer.synchronize();
    sessionsDb.updateSessionIsArchived(uuid, true);

    const processed = await synchronizer.synchronize();
    assert.equal(processed, 0);
    assert.equal(sessionsDb.getSessionById(uuid)?.isArchived, 1);
  });
});

test('resolveTranscriptPath finds the file via encoded dir and uuid fallback', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    const oddCwd = path.join(sessionsRoot, 'space dir', '项目-名');
    await mkdir(oddCwd, { recursive: true });
    // Write under a directory whose encoding Pi does not derive this way.
    const oddDir = path.join(sessionsRoot, 'some-other-location');
    await mkdir(oddDir, { recursive: true });
    const filePath = path.join(oddDir, `2026-09-09T08-00-00-000Z_${uuid}.jsonl`);
    await writeFile(filePath, `${JSON.stringify(header(uuid, oddCwd))}\n`);

    const resolved = await new PiSessionSynchronizer().resolveTranscriptPath(uuid, oddCwd);
    assert.equal(resolved, filePath);
  });
});

test('synchronizer uses a full scan once, then honors the incremental cursor', async () => {
  await withIsolatedEnvironment(async ({ sessionsRoot, cwd }) => {
    const uuid = '01a0854d-c915-701f-b114-06ddbce5b14f';
    await writeTranscript(sessionsRoot, cwd, uuid, [
      header(uuid, cwd),
      userMessage('a1', null, 'Backfill this session'),
    ]);

    const synchronizer = new PiSessionSynchronizer();
    assert.equal(await synchronizer.synchronize(), 1);

    // A second scan with a cursor far in the future must not re-walk files.
    const processed = await synchronizer.synchronize(new Date('2030-01-01T00:00:00Z'));
    assert.equal(processed, 0);

    // A new file inside the cursor window is picked up. utimes only rewrites
    // atime/mtime (not birthtime), so stamp mtime clearly past the cursor to
    // avoid same-millisecond flakiness on APFS.
    const cursor = new Date();
    const uuid2 = '11a0854d-c915-701f-b114-06ddbce5b14f';
    const filePath = await writeTranscript(sessionsRoot, cwd, uuid2, [
      header(uuid2, cwd),
      userMessage('b1', null, 'Fresh session'),
    ]);
    const stamped = new Date(Date.now() + 1_000);
    await utimes(filePath, stamped, stamped);
    assert.equal(await synchronizer.synchronize(cursor), 1);
    assert.ok(sessionsDb.getSessionById(uuid2));
  });
});
