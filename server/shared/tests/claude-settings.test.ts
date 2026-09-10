import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readClaudeSettingsEnv } from '@/shared/claude-settings.js';

test('readClaudeSettingsEnv reads the env block from an explicit settings file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-settings-'));
  const settingsPath = path.join(directory, 'settings-relay.json');
  await writeFile(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: '  doubao-seed-2.1-turbo  ',
      ANTHROPIC_BASE_URL: 'https://relay.example',
      NUMBER_LIKE: 42,
      EMPTY: '',
    },
  }), 'utf8');

  const env = await readClaudeSettingsEnv(settingsPath);

  assert.deepEqual(env, {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'doubao-seed-2.1-turbo',
    ANTHROPIC_BASE_URL: 'https://relay.example',
  });
});

test('readClaudeSettingsEnv yields an empty record for a missing or malformed file', async () => {
  const missingPath = path.join(os.tmpdir(), 'claude-settings-does-not-exist.json');
  assert.deepEqual(await readClaudeSettingsEnv(missingPath), {});
  // Whitespace-padded paths resolve to the trimmed target, not the default.
  assert.deepEqual(await readClaudeSettingsEnv(`   ${missingPath}   `), {});

  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-settings-'));
  const settingsPath = path.join(directory, 'settings-broken.json');
  await writeFile(settingsPath, '{ not json', 'utf8');
  assert.deepEqual(await readClaudeSettingsEnv(settingsPath), {});
});
