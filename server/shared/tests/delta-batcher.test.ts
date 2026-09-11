import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';
import { createDeltaBatcher } from '@/shared/utils.js';

const NEVER_FLUSH = { intervalMs: 1e9, maxChars: 1e9 };

const TS = '2026-01-01T00:00:00.000Z';

function delta(
  text: string,
  streamChannel: 'text' | 'thinking',
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id: `delta-${text}`,
    sessionId: 's1',
    timestamp: TS,
    provider: 'claude',
    kind: 'stream_delta',
    content: text,
    streamChannel,
    ...overrides,
  };
}

function nonDelta(kind: NormalizedMessage['kind']): NormalizedMessage {
  return { id: `frame-${kind}`, sessionId: 's1', timestamp: TS, provider: 'claude', kind };
}

test('createDeltaBatcher coalesces consecutive same-channel deltas', () => {
  const sent: NormalizedMessage[] = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), NEVER_FLUSH);

  batcher.send(delta('你', 'thinking'));
  batcher.send(delta('好', 'thinking'));
  assert.equal(sent.length, 0);

  batcher.send(nonDelta('stream_end'));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].content, '你好');
  assert.equal(sent[0].streamChannel, 'thinking');
  // A non-delta frame always lands after the batch it flushed.
  assert.equal(sent[1].kind, 'stream_end');
});

test('a channel change flushes the previous batch first', () => {
  const sent: NormalizedMessage[] = [];
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

test('a provider change flushes the previous batch first', () => {
  const sent: NormalizedMessage[] = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), NEVER_FLUSH);

  batcher.send(delta('甲', 'text', { provider: 'claude' }));
  batcher.send(delta('乙', 'text', { provider: 'cursor' }));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].provider, 'claude');
  batcher.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].provider, 'cursor');
});

test('the flushed frame keeps the base delta shape, only content grows', () => {
  const sent: NormalizedMessage[] = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), NEVER_FLUSH);

  batcher.send(delta('a', 'text', { id: 'base-1' }));
  batcher.send(delta('b', 'text'));
  batcher.flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'base-1');
  assert.equal(sent[0].content, 'ab');
});

test('maxChars flushes early without waiting for the interval', () => {
  const sent: NormalizedMessage[] = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), { intervalMs: 1e9, maxChars: 4 });

  batcher.send(delta('ab', 'text'));
  assert.equal(sent.length, 0);
  batcher.send(delta('cd', 'text'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'abcd');
});

test('dispose discards a pending batch instead of flushing it', () => {
  const sent: NormalizedMessage[] = [];
  const batcher = createDeltaBatcher((message) => sent.push(message), NEVER_FLUSH);

  batcher.send(delta('dropped', 'text'));
  batcher.dispose();
  batcher.flush();

  assert.equal(sent.length, 0);
});

test('an interval flush fires without an explicit flush call', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sent: NormalizedMessage[] = [];
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
