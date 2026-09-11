import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { createStreamingBufferRegistry } from '@/modules/chat/utils/streamingBufferRegistry';
import type { LLMProvider } from '@/shared/types';

/**
 * The streaming buffer coalesces each session's deltas into a single store
 * write every 100ms. These tests pin the coalescing window, the per-session
 * isolation, and the no-op rules that stop delta-less frames from creating
 * stub rows.
 */

type FlushCall = { sessionId: string; text: string; provider: LLMProvider };

const flushCalls: FlushCall[] = [];

const create = () => {
  flushCalls.length = 0;
  return createStreamingBufferRegistry((sessionId, text, provider) => {
    flushCalls.push({ sessionId, text, provider });
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('coalesces deltas inside the 100ms window into one flush', () => {
  const registry = create();

  registry.append('s1', '你', 'claude');
  registry.append('s1', '好', 'claude');

  assert.deepEqual(flushCalls, [], 'nothing flushes before the window elapses');

  vi.advanceTimersByTime(100);

  assert.deepEqual(flushCalls, [{ sessionId: 's1', text: '你好', provider: 'claude' }]);
});

test('keeps an independent buffer and provider per session', () => {
  const registry = create();

  registry.append('s1', 'A', 'claude');
  registry.append('s2', 'B', 'cursor');
  vi.advanceTimersByTime(100);

  assert.deepEqual(flushCalls, [
    { sessionId: 's1', text: 'A', provider: 'claude' },
    { sessionId: 's2', text: 'B', provider: 'cursor' },
  ]);
});

test('flushNow cancels the debounce and publishes immediately', () => {
  const registry = create();

  registry.append('s1', 'partial', 'claude');
  registry.flushNow('s1');

  assert.deepEqual(flushCalls, [{ sessionId: 's1', text: 'partial', provider: 'claude' }]);

  vi.advanceTimersByTime(100);
  assert.equal(flushCalls.length, 1, 'the cancelled timer must not flush a second time');
});

test('append and flushNow ignore empty text so no stub row is written', () => {
  const registry = create();

  registry.append('s1', '', 'claude');
  assert.equal(registry.has('s1'), false);

  registry.flushNow('s1');
  vi.advanceTimersByTime(100);

  assert.deepEqual(flushCalls, []);
});

test('drop cancels the pending flush without publishing', () => {
  const registry = create();

  registry.append('s1', 'abandoned', 'claude');
  registry.drop('s1');

  assert.equal(registry.has('s1'), false);

  vi.advanceTimersByTime(100);
  assert.deepEqual(flushCalls, []);
});

test('dropAll clears every session and pending timer', () => {
  const registry = create();

  registry.append('s1', 'A', 'claude');
  registry.append('s2', 'B', 'cursor');
  registry.dropAll();

  assert.equal(registry.has('s1'), false);
  assert.equal(registry.has('s2'), false);

  vi.advanceTimersByTime(100);
  assert.deepEqual(flushCalls, []);
});

test('a dropped session starts its next cycle from empty text', () => {
  const registry = create();

  registry.append('s1', 'first', 'claude');
  registry.flushNow('s1');
  registry.drop('s1');

  registry.append('s1', 'second', 'claude');
  vi.advanceTimersByTime(100);

  assert.deepEqual(flushCalls, [
    { sessionId: 's1', text: 'first', provider: 'claude' },
    { sessionId: 's1', text: 'second', provider: 'claude' },
  ]);
});
