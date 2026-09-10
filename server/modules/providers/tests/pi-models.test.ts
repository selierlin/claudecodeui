import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PI_PREDEFINED_MODELS,
  PiProviderModels,
  getPiAgentDir,
  getPiSessionsRoot,
  loadPiModels,
} from '@/modules/providers/list/pi/pi-models.provider.js';

async function withPiAgentDir(
  files: Record<string, string>,
  runTest: (agentDir: string) => void | Promise<void>,
): Promise<void> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const previousPiModel = process.env.PI_MODEL;
  const agentDir = await mkdtemp(path.join(os.tmpdir(), 'pi-models-test-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  delete process.env.PI_MODEL;
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(agentDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }

  try {
    await runTest(agentDir);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (previousSessionDir === undefined) {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    } else {
      process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    }
    if (previousPiModel === undefined) {
      delete process.env.PI_MODEL;
    } else {
      process.env.PI_MODEL = previousPiModel;
    }
    await rm(agentDir, { recursive: true, force: true });
  }
}

test('loads the built-in catalog from models-store.json', async () => {
  await withPiAgentDir({
    'models-store.json': JSON.stringify({
      anthropic: {
        models: [
          { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: true },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        ],
      },
    }),
  }, async () => {
    const catalog = loadPiModels();
    assert.ok(catalog);
    assert.deepEqual(catalog?.OPTIONS.map((option) => option.value), [
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-haiku-4-5',
    ]);
    // Reasoning models expose effort options.
    const sonnet = catalog?.OPTIONS.find((option) => option.value === 'anthropic/claude-sonnet-4-5');
    assert.ok(sonnet?.effort?.values.some((entry) => entry.value === 'high'));
    const haiku = catalog?.OPTIONS.find((option) => option.value === 'anthropic/claude-haiku-4-5');
    assert.equal(haiku?.effort, undefined);
  });
});

test('user-configured models.json wins over the built-in store and settings drives the default', async () => {
  await withPiAgentDir({
    'models-store.json': JSON.stringify({
      deepseek: { models: [{ id: 'deepseek-v4-pro', name: 'Built-in V4 Pro' }] },
    }),
    'models.json': JSON.stringify({
      providers: {
        deepseek: {
          models: [
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true },
            { id: 'deepseek-v4-pro', name: 'User V4 Pro' },
          ],
        },
      },
    }),
    'settings.json': JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash' }),
  }, async () => {
    const catalog = loadPiModels();
    assert.ok(catalog);
    const pro = catalog?.OPTIONS.find((option) => option.value === 'deepseek/deepseek-v4-pro');
    assert.equal(pro?.label, 'User V4 Pro');
    assert.equal(catalog?.DEFAULT, 'deepseek/deepseek-v4-flash');
  });
});

test('falls back to the curated mirror when no catalog documents exist', async () => {
  await withPiAgentDir({}, async () => {
    assert.equal(loadPiModels(), null);
    const models = await new PiProviderModels().getSupportedModels();
    assert.equal(models.OPTIONS.length, PI_PREDEFINED_MODELS.OPTIONS.length);
  });
});

test('tolerates corrupt catalog JSON', async () => {
  await withPiAgentDir({
    'models-store.json': '{not valid json',
    'models.json': 'also broken',
  }, async () => {
    assert.equal(loadPiModels(), null);
  });
});

test('PI_MODEL overrides the picker default', async () => {
  await withPiAgentDir({
    'models-store.json': JSON.stringify({
      deepseek: { models: [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }] },
    }),
  }, async () => {
    process.env.PI_MODEL = 'deepseek/deepseek-v4-flash';
    const models = await new PiProviderModels().getSupportedModels();
    assert.equal(models.DEFAULT, 'deepseek/deepseek-v4-flash');
  });
});

test('session root honors PI_CODING_AGENT_SESSION_DIR over the agent dir', async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = path.join(os.tmpdir(), 'pi-agent-dir-test');
  const sessionDir = path.join(os.tmpdir(), 'pi-session-dir-test');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  try {
    assert.equal(getPiAgentDir(), agentDir);
    assert.equal(getPiSessionsRoot(), sessionDir);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (previousSessionDir === undefined) {
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
    } else {
      process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    }
  }
});

test('session root falls back to sessionDir in settings.json, then the default', async () => {
  await withPiAgentDir({
    'settings.json': JSON.stringify({ sessionDir: 'custom-sessions' }),
  }, async (agentDir) => {
    assert.equal(getPiSessionsRoot(), path.join(agentDir, 'custom-sessions'));
  });

  await withPiAgentDir({}, async (agentDir) => {
    assert.equal(getPiSessionsRoot(), path.join(agentDir, 'sessions'));
  });
});

test('sessionDir accepts absolute paths and ~ expansion', async () => {
  await withPiAgentDir({
    'settings.json': JSON.stringify({ sessionDir: '/abs/sessions' }),
  }, async () => {
    assert.equal(getPiSessionsRoot(), '/abs/sessions');
  });

  await withPiAgentDir({
    'settings.json': JSON.stringify({ sessionDir: '~/rel-sessions' }),
  }, async () => {
    assert.equal(getPiSessionsRoot(), path.join(os.homedir(), 'rel-sessions'));
  });
});

test('env session dir overrides sessionDir in settings.json', async () => {
  const override = path.join(os.tmpdir(), 'pi-env-override-test');
  await withPiAgentDir({
    'settings.json': JSON.stringify({ sessionDir: 'settings-sessions' }),
  }, async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = override;
    assert.equal(getPiSessionsRoot(), override);
  });
});
