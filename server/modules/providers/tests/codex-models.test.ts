import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CodexProviderModels,
  CODEX_PREDEFINED_MODELS,
} from '@/modules/providers/list/codex/codex-models.provider.js';

const writeTempCodexConfig = async (
  configBody: string,
  files: Record<string, string> = {},
): Promise<string> => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'codex-models-test-'));
  await writeFile(path.join(homeDir, 'config.toml'), configBody, 'utf8');
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(homeDir, name), content, 'utf8');
  }
  return path.join(homeDir, 'config.toml');
};

test('Codex falls back to the curated catalog when no config file exists', async () => {
  const configPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'codex-models-empty-')), 'config.toml');
  const adapter = new CodexProviderModels(configPath);

  assert.deepEqual(await adapter.getSupportedModels(), CODEX_PREDEFINED_MODELS);
  assert.equal(
    (await adapter.getCurrentActiveModel()).model,
    CODEX_PREDEFINED_MODELS.DEFAULT,
  );
});

test('Codex surfaces the CC Switch catalog models with the configured model first', async () => {
  const catalog = JSON.stringify({
    models: [
      {
        slug: 'deepseek-v4-flash',
        display_name: 'DeepSeek V4 Flash',
        description: 'DeepSeek V4 Flash',
        supported_reasoning_levels: [
          { description: 'Disable Thinking', effort: 'none' },
          { description: 'Enabled Thinking', effort: 'high' },
        ],
      },
      {
        slug: 'deepseek-v4-pro',
        display_name: 'DeepSeek V4 Pro',
        description: 'DeepSeek V4 Pro',
        supported_reasoning_levels: [
          { description: 'Disable Thinking', effort: 'none' },
          { description: 'Enabled Thinking', effort: 'high' },
        ],
      },
    ],
  });
  const configPath = await writeTempCodexConfig(
    [
      'model_provider = "custom"',
      'model = "deepseek-v4-flash"',
      'model_catalog_json = "cc-switch-model-catalog.json"',
      'model_reasoning_effort = "high"',
    ].join('\n'),
    { 'cc-switch-model-catalog.json': catalog },
  );
  const adapter = new CodexProviderModels(configPath);

  const models = await adapter.getSupportedModels();

  // The configured model leads the list and becomes the definition default.
  assert.equal(models.OPTIONS[0]?.value, 'deepseek-v4-flash');
  assert.equal(models.OPTIONS[0]?.label, 'DeepSeek V4 Flash');
  assert.deepEqual(
    models.OPTIONS[0]?.effort?.values.map((level) => level.value),
    ['none', 'high'],
  );
  assert.equal(models.OPTIONS[0]?.effort?.default, 'high');
  assert.equal(models.DEFAULT, 'deepseek-v4-flash');

  // The second catalog entry follows, then the curated GPT models (deduped).
  assert.equal(models.OPTIONS[1]?.value, 'deepseek-v4-pro');
  assert.ok(models.OPTIONS.some((option) => option.value === 'gpt-5.6-sol'));
  assert.equal(
    models.OPTIONS.filter((option) => option.value === 'deepseek-v4-flash').length,
    1,
  );

  assert.equal((await adapter.getCurrentActiveModel()).model, 'deepseek-v4-flash');
});

test('Codex keeps the curated label when the configured model is a predefined one', async () => {
  const configPath = await writeTempCodexConfig('model = "gpt-5.6-sol"\n');
  const adapter = new CodexProviderModels(configPath);

  const models = await adapter.getSupportedModels();

  assert.equal(models.DEFAULT, 'gpt-5.6-sol');
  const sol = models.OPTIONS.find((option) => option.value === 'gpt-5.6-sol');
  assert.ok(sol);
  assert.equal(sol.label, 'GPT-5.6 Sol');
  assert.equal(
    models.OPTIONS.filter((option) => option.value === 'gpt-5.6-sol').length,
    1,
  );
});

test('Codex does not hoist a curated configured model above the curated order', async () => {
  const configPath = await writeTempCodexConfig('model = "gpt-5.5"\n');
  const adapter = new CodexProviderModels(configPath);

  const models = await adapter.getSupportedModels();

  // gpt-5.5 stays at its curated slot; the curated order is left untouched.
  assert.deepEqual(
    models.OPTIONS.map((option) => option.value),
    CODEX_PREDEFINED_MODELS.OPTIONS.map((option) => option.value),
  );
  assert.equal(models.OPTIONS[0]?.value, 'gpt-6-astra');
  assert.equal(models.DEFAULT, 'gpt-5.5');
  assert.equal((await adapter.getCurrentActiveModel()).model, 'gpt-5.5');
});

test('Codex renders a curated model in place when the catalog JSON also lists it', async () => {
  const catalog = JSON.stringify({
    models: [
      {
        slug: 'deepseek-v4-pro',
        display_name: 'DeepSeek V4 Pro',
      },
      {
        slug: 'gpt-5.6-sol',
        display_name: 'gpt-5.6-sol',
        description: 'raw catalog copy',
      },
    ],
  });
  const configPath = await writeTempCodexConfig(
    [
      'model = "gpt-5.6-sol"',
      'model_catalog_json = "cc-switch-model-catalog.json"',
    ].join('\n'),
    { 'cc-switch-model-catalog.json': catalog },
  );
  const adapter = new CodexProviderModels(configPath);

  const models = await adapter.getSupportedModels();

  // The configured model is not hoisted above the catalog order, and its entry
  // keeps the curated metadata instead of the raw catalog copy.
  assert.equal(models.OPTIONS[0]?.value, 'deepseek-v4-pro');
  const sol = models.OPTIONS.find((option) => option.value === 'gpt-5.6-sol');
  assert.ok(sol);
  assert.equal(sol.label, 'GPT-5.6 Sol');
  assert.notEqual(sol.description, 'raw catalog copy');
  assert.equal(
    models.OPTIONS.filter((option) => option.value === 'gpt-5.6-sol').length,
    1,
  );
  assert.equal(models.DEFAULT, 'gpt-5.6-sol');
});

test('Codex mirrors model_reasoning_effort onto a curated configured model', async () => {
  const configPath = await writeTempCodexConfig(
    ['model = "gpt-5.6-sol"', 'model_reasoning_effort = "xhigh"'].join('\n'),
  );
  const adapter = new CodexProviderModels(configPath);

  const models = await adapter.getSupportedModels();

  const sol = models.OPTIONS.find((option) => option.value === 'gpt-5.6-sol');
  assert.equal(sol?.effort?.default, 'xhigh');
});

test('Codex still lists a configured model that is missing from the catalog JSON', async () => {
  const configPath = await writeTempCodexConfig(
    [
      'model_provider = "custom"',
      'model = "deepseek-v4-flash"',
      'model_catalog_json = "missing-catalog.json"',
    ].join('\n'),
  );
  const adapter = new CodexProviderModels(configPath);

  const models = await adapter.getSupportedModels();

  assert.equal(models.OPTIONS[0]?.value, 'deepseek-v4-flash');
  assert.equal(models.OPTIONS[0]?.label, 'deepseek-v4-flash');
  assert.equal(models.OPTIONS[0]?.description, 'Configured in ~/.codex/config.toml');
  assert.equal(models.DEFAULT, 'deepseek-v4-flash');
  assert.ok(models.OPTIONS.some((option) => option.value === 'gpt-5.6-sol'));
});

test('Codex keeps the curated default when the config sets no model', async () => {
  const configPath = await writeTempCodexConfig('model_provider = "custom"\n');
  const adapter = new CodexProviderModels(configPath);

  const models = await adapter.getSupportedModels();

  assert.deepEqual(models, CODEX_PREDEFINED_MODELS);
  assert.equal((await adapter.getCurrentActiveModel()).model, CODEX_PREDEFINED_MODELS.DEFAULT);
});

test('Codex ignores malformed catalog JSON without breaking the model list', async () => {
  const configPath = await writeTempCodexConfig(
    [
      'model = "deepseek-v4-flash"',
      'model_catalog_json = "cc-switch-model-catalog.json"',
    ].join('\n'),
    { 'cc-switch-model-catalog.json': '{ not valid json' },
  );
  const adapter = new CodexProviderModels(configPath);

  const models = await adapter.getSupportedModels();

  assert.equal(models.OPTIONS[0]?.value, 'deepseek-v4-flash');
  assert.equal(models.DEFAULT, 'deepseek-v4-flash');
});
