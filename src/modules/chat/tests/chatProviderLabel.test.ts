import assert from 'node:assert/strict';

import { test } from 'vitest';

import { getChatProviderLabel } from '@/modules/chat/utils/chatProviderLabel';

const translate = (key: string, options?: { defaultValue?: string }): string =>
  options?.defaultValue ?? key;

test('chat provider labels include DSH, WorkBuddy and Pi', () => {
  assert.equal(getChatProviderLabel('dsh', translate), 'DeepSeek Harness');
  assert.equal(getChatProviderLabel('workbuddy', translate), 'WorkBuddy');
  assert.equal(getChatProviderLabel('pi', translate), 'Pi');
});

test('unknown chat providers keep the Claude fallback', () => {
  assert.equal(getChatProviderLabel('unknown', translate), 'messageTypes.claude');
});
