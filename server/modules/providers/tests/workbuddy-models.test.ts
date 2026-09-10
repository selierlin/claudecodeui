import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WorkbuddyProviderModels,
  WORKBUDDY_PREDEFINED_MODELS,
} from '@/modules/providers/list/workbuddy/workbuddy-models.provider.js';

const NOISE_IDS = [
  'default-1.1', // Claude-3.7-Sonnet
  'default-1.2', // Claude-4.0-Sonnet
  'hunyuan-chat',
  'hunyuan-2.0-instruct',
  'codewise-completions',
  'completion-gf',
  'hunyuan-image-v3.0-art',
];

test('WorkBuddy returns the curated model list, independent of any engine cache', async () => {
  const adapter = new WorkbuddyProviderModels();

  const models = await adapter.getSupportedModels();

  assert.deepEqual(models, WORKBUDDY_PREDEFINED_MODELS);
  // Exactly the fifteen surfaced models, no full routing catalog leakage.
  assert.equal(models.OPTIONS.length, 15);
  assert.equal(models.DEFAULT, 'auto');
});

test('WorkBuddy never surfaces non-WorkBuddy models (Claude, Hunyuan, Codewise, image)', async () => {
  const adapter = new WorkbuddyProviderModels();
  const models = await adapter.getSupportedModels();
  const values = models.OPTIONS.map((option) => option.value);

  for (const noise of NOISE_IDS) {
    assert.ok(!values.includes(noise), `unexpected model leaked into picker: ${noise}`);
  }
});

test('WorkBuddy carries reasoning effort metadata for supported models', async () => {
  const adapter = new WorkbuddyProviderModels();
  const models = await adapter.getSupportedModels();
  const byValue = new Map(models.OPTIONS.map((option) => [option.value, option]));

  assert.deepEqual(byValue.get('glm-5.3')?.effort?.values.map((level) => level.value), [
    'low',
    'high',
    'xhigh',
  ]);
  assert.equal(byValue.get('glm-5.3')?.effort?.default, 'high');

  // Models without selectable efforts expose no effort selector.
  assert.equal(byValue.get('glm-5.1')?.effort, undefined);
});
