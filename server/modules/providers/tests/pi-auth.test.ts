import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test, { afterEach, beforeEach } from 'node:test';

import {
  PiProviderAuth,
  resetPiCommandForTests,
} from '@/modules/providers/list/pi/pi-auth.provider.js';

const MOCK_CLI = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi-auth-mock-cli.mjs'),
);
const MISSING_CLI = path.join('/nonexistent', 'pi-missing');

beforeEach(() => {
  resetPiCommandForTests();
  delete process.env.PI_COMMAND;
  delete process.env.MOCK_AUTH;
});

afterEach(() => {
  resetPiCommandForTests();
  delete process.env.PI_COMMAND;
  delete process.env.MOCK_AUTH;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
});

async function withIsolatedAgentDir(runTest: () => void | Promise<void>): Promise<void> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(path.join(os.tmpdir(), 'pi-auth-test-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(agentDir, { recursive: true });
  try {
    await runTest();
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(agentDir, { recursive: true, force: true });
  }
}

test('getStatus reports authenticated when pi auth check is ready', async () => {
  await withIsolatedAgentDir(async () => {
    await writeFile(path.join(process.env.PI_CODING_AGENT_DIR!, 'settings.json'), JSON.stringify({ defaultProvider: 'ark' }), 'utf8');
    process.env.PI_COMMAND = MOCK_CLI;
    process.env.MOCK_AUTH = 'ready';

    const status = await new PiProviderAuth().getStatus();
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.authVerified, true);
    assert.equal(status.method, 'pi_auth');
    assert.equal(status.error, undefined);
  });
});

test('getStatus reports unauthenticated when pi auth check is not ready', async () => {
  await withIsolatedAgentDir(async () => {
    await writeFile(path.join(process.env.PI_CODING_AGENT_DIR!, 'settings.json'), JSON.stringify({ defaultProvider: 'missing' }), 'utf8');
    process.env.PI_COMMAND = MOCK_CLI;
    process.env.MOCK_AUTH = 'not_ready';

    const status = await new PiProviderAuth().getStatus();
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, false);
    assert.equal(status.authVerified, false);
    assert.equal(status.method, null);
    assert.ok(status.error?.includes('not authenticated'));
  });
});

test('getStatus reports installed but unauthenticated when the command cannot run', async () => {
  process.env.PI_COMMAND = MISSING_CLI;

  const status = await new PiProviderAuth().getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.method, null);
  assert.equal(status.error, 'pi CLI is present but failed to run');
});

test('getStatus reports not installed when neither PI_COMMAND nor PATH resolves', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-empty-'));
  try {
    const originalPath = process.env.PATH;
    process.env.PATH = `${emptyDir}:/usr/bin:/bin`;

    const status = await new PiProviderAuth().getStatus();
    assert.equal(status.installed, false);
    assert.equal(status.authenticated, false);
    assert.equal(status.method, null);
    assert.ok(status.error?.includes('not found'), `error: ${status.error}`);

    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});
