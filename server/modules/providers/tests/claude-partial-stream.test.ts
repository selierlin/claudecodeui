import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import {
  createDeltaBatcher,
  isSubagentPartialEvent,
  mapCliOptionsToSDK,
  transformMessage,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

const SESSION_ID = 'claude-session-1';

const provider = new ClaudeSessionsProvider();

function withPartialMessagesEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.CLAUDE_PARTIAL_MESSAGES;
  if (value === undefined) {
    delete process.env.CLAUDE_PARTIAL_MESSAGES;
  } else {
    process.env.CLAUDE_PARTIAL_MESSAGES = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PARTIAL_MESSAGES;
    } else {
      process.env.CLAUDE_PARTIAL_MESSAGES = previous;
    }
  }
}

function baseOptions() {
  return { model: 'sonnet', effort: 'high', effortModels: CLAUDE_PREDEFINED_MODELS };
}

/**
 * Mirrors the realtime pipeline: the SDK wrapper is unwrapped by
 * `transformMessage`, then the adapter normalizes the inner event.
 */
function normalizeIncoming(rawMessage: Record<string, unknown>) {
  return provider.normalizeMessage(transformMessage(rawMessage), SESSION_ID);
}

test('mapCliOptionsToSDK enables partial messages by default', () => {
  withPartialMessagesEnv(undefined, () => {
    assert.equal(mapCliOptionsToSDK(baseOptions()).includePartialMessages, true);
  });
});

test('CLAUDE_PARTIAL_MESSAGES=0 disables partial messages', () => {
  withPartialMessagesEnv('0', () => {
    assert.equal(mapCliOptionsToSDK(baseOptions()).includePartialMessages, false);
  });
});

test('transformMessage unwraps a stream_event into the inner event', () => {
  const transformed = transformMessage({
    type: 'stream_event',
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: 'uuid-1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  });

  assert.deepEqual(transformed, {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  });
});

test('transformMessage keeps parent_tool_use_id across the unwrap', () => {
  // The field lives only on the wrapper; losing it would leak subagent deltas
  // into the main thread.
  const transformed = transformMessage({
    type: 'stream_event',
    parent_tool_use_id: 'toolu_agent_1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub' } },
  }) as Record<string, unknown>;

  assert.equal(transformed.parentToolUseId, 'toolu_agent_1');
  assert.equal(transformed.event, undefined);
});

test('a text_delta becomes exactly one text-channel stream_delta', () => {
  const messages = normalizeIncoming({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'chunk' } },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].streamChannel, 'text');
  assert.equal(messages[0].content, 'chunk');
});

test('a thinking_delta becomes a thinking-channel stream_delta', () => {
  const messages = normalizeIncoming({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].streamChannel, 'thinking');
  assert.equal(messages[0].content, 'reasoning');
});

test('non-text deltas (input_json_delta) produce no messages', () => {
  const inputJson = normalizeIncoming({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } },
  });

  assert.deepEqual(inputJson, []);
});

test('message_stop produces exactly one stream_end', () => {
  const messages = normalizeIncoming({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'message_stop' },
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_end');
});

test('content_block_stop no longer produces a stream_end', () => {
  // Regression guard: stream_end is a message-level boundary, not a block one.
  const messages = normalizeIncoming({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index: 0 },
  });

  assert.deepEqual(messages, []);
});

test('subagent stream_delta / stream_end are dropped', () => {
  assert.equal(isSubagentPartialEvent({ kind: 'stream_delta', parentToolUseId: 'toolu_1' }), true);
  // A subagent's reasoning rides the same kind, so it is covered too.
  assert.equal(isSubagentPartialEvent({ kind: 'stream_delta', streamChannel: 'thinking', parentToolUseId: 'toolu_1' }), true);
  assert.equal(isSubagentPartialEvent({ kind: 'stream_end', parentToolUseId: 'toolu_1' }), true);
  assert.equal(isSubagentPartialEvent({ kind: 'stream_delta' }), false);
});

test('subagent tool_use / tool_result are kept', () => {
  // A blanket parentToolUseId filter would break subagent grouping.
  assert.equal(isSubagentPartialEvent({ kind: 'tool_use', parentToolUseId: 'toolu_1' }), false);
  assert.equal(isSubagentPartialEvent({ kind: 'tool_result', parentToolUseId: 'toolu_1' }), false);
});

test('a text + tool_use message streams once and ends once', () => {
  const events = [
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_stop' },
  ];

  const messages = events.flatMap((event) => normalizeIncoming({
    type: 'stream_event',
    parent_tool_use_id: null,
    event,
  }));

  const deltas = messages.filter((message) => message.kind === 'stream_delta');
  const ends = messages.filter((message) => message.kind === 'stream_end');

  assert.equal(deltas.length, 2);
  assert.equal(ends.length, 1);
  assert.equal(deltas.map((message) => message.content).join(''), 'Let me check.');
});

const NEVER_FLUSH = { intervalMs: 1e9, maxChars: 1e9 };

function delta(text: string, streamChannel: 'text' | 'thinking') {
  return { kind: 'stream_delta', content: text, sessionId: 's1', provider: 'claude', streamChannel };
}

test('createDeltaBatcher coalesces consecutive same-channel deltas', () => {
  const sent: Array<Record<string, unknown>> = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), NEVER_FLUSH);

  batcher.send(delta('你', 'thinking'));
  batcher.send(delta('好', 'thinking'));
  assert.equal(sent.length, 0);

  batcher.send({ kind: 'stream_end', sessionId: 's1', provider: 'claude' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].content, '你好');
  assert.equal(sent[0].streamChannel, 'thinking');
  // A non-delta frame always lands after the batch it flushed.
  assert.equal(sent[1].kind, 'stream_end');
});

test('a channel change flushes the previous batch first', () => {
  const sent: Array<Record<string, unknown>> = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), NEVER_FLUSH);

  batcher.send(delta('想', 'thinking'));
  batcher.send(delta('答', 'text'));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '想');
  assert.equal(sent[0].streamChannel, 'thinking');

  batcher.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].content, '答');
  assert.equal(sent[1].streamChannel, 'text');
});

test('the flushed frame keeps the base delta shape, only content grows', () => {
  const sent: Array<Record<string, unknown>> = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), NEVER_FLUSH);

  batcher.send({ id: 'base-1', kind: 'stream_delta', content: 'a', sessionId: 's1', provider: 'claude', streamChannel: 'text' });
  batcher.send(delta('b', 'text'));
  batcher.flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'base-1');
  assert.equal(sent[0].content, 'ab');
});

test('maxChars flushes early without waiting for the interval', () => {
  const sent: Array<Record<string, unknown>> = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), { intervalMs: 1e9, maxChars: 4 });

  batcher.send(delta('ab', 'text'));
  assert.equal(sent.length, 0);
  batcher.send(delta('cd', 'text'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'abcd');
});

test('dispose discards a pending batch instead of flushing it', () => {
  const sent: Array<Record<string, unknown>> = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), NEVER_FLUSH);

  batcher.send(delta('dropped', 'text'));
  batcher.dispose();
  batcher.flush();

  assert.equal(sent.length, 0);
});

test('an interval flush fires without an explicit flush call', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sent: Array<Record<string, unknown>> = [];
    const batcher = createDeltaBatcher((message) => sent.push(message), { intervalMs: 50, maxChars: 1e9 });

    batcher.send(delta('tick', 'text'));
    assert.equal(sent.length, 0);

    mock.timers.tick(51);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, 'tick');
  } finally {
    mock.timers.reset();
  }
});
