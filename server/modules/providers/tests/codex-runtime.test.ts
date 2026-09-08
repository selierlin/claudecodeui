import assert from 'node:assert/strict';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import {
  codexRuntime,
  extractCodexTokenBudget,
  transformCodexEvent,
} from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedOptions: ThreadOptions | undefined;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      const start = t.mock.method(Codex.prototype, 'startThread', (options?: ThreadOptions) => {
        capturedOptions = options;
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', (id: string, options?: ThreadOptions) => {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveProviderConfigDir: () => null,
        resolveSettingsFile: () => null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      assert.equal(capturedOptions?.sandboxMode, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(capturedOptions?.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}

test('Codex runtime preserves native item ids for lifecycle updates', () => {
  const transformed = transformCodexEvent({
    type: 'item.updated',
    item: {
      id: 'command-live-1',
      type: 'command_execution',
      command: 'npm test',
      aggregated_output: 'running',
      status: 'in_progress',
    },
  });

  assert.deepEqual(transformed, {
    type: 'item',
    itemType: 'command_execution',
    itemId: 'command-live-1',
    command: 'npm test',
    output: 'running',
    exitCode: undefined,
    status: 'in_progress',
  });
});

test('Codex runtime reads current SDK reasoning usage fields', () => {
  assert.deepEqual(extractCodexTokenBudget({
    type: 'turn.completed',
    usage: {
      input_tokens: 120,
      cached_input_tokens: 30,
      cache_write_input_tokens: 10,
      output_tokens: 40,
      reasoning_output_tokens: 60,
    },
  }), {
    used: 220,
    total: 200000,
    inputTokens: 120,
    outputTokens: 40,
    reasoningTokens: 60,
    breakdown: {
      input: 120,
      output: 40,
      reasoning: 60,
    },
  });
});

