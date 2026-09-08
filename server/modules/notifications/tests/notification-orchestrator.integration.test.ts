import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';

import {
  buildNotificationPayload,
} from '../services/notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('notification payload uses the app session id for a provider session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'claude-native-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });

    assert.equal(payload.data.sessionId, 'app-session-1');
    assert.match(payload.data.tag, /app-session-1/);
  });
});

test('notification payload renders a completed run with the Chinese completion message', () => {
  const payload = buildNotificationPayload({
    provider: 'claude',
    sessionId: null,
    kind: 'stop',
    code: 'run.stopped',
    meta: { stopReason: 'completed' },
  });

  assert.match(payload.body, /^Claude:/);
  assert.match(payload.body, /回复已完成/);
});

test('notification payload renders an aborted run with the Chinese interruption message', () => {
  const payload = buildNotificationPayload({
    provider: 'claude',
    sessionId: null,
    kind: 'stop',
    code: 'run.stopped',
    meta: { stopReason: 'aborted' },
  });

  assert.match(payload.body, /运行已中断/);
});

test('notification payload names WorkBuddy runs instead of falling back to Assistant', () => {
  const payload = buildNotificationPayload({
    provider: 'workbuddy',
    sessionId: null,
    kind: 'stop',
    code: 'run.stopped',
    meta: { stopReason: 'completed' },
    severity: 'info',
    requiresUserAction: false,
    dedupeKey: null,
    createdAt: '2026-08-29T01:00:00.000Z',
  });

  assert.match(payload.body, /^WorkBuddy:/);
});
