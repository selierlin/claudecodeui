import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { createStreamingBufferRegistry } from '@/modules/chat/utils/streamingBufferRegistry';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ProjectSession, ServerEvent, StreamChannel } from '@/shared/types';

/**
 * The pane-wide streaming buffer used to be two global refs, so two sessions
 * streaming at once wrote into the same placeholder. These tests drive the
 * handler with a session-keyed registry and pin the resulting per-session
 * behaviour: isolated slots, correct providers, per-session teardown, the
 * reply/reasoning channel split, and the multi-cycle path where a dropped
 * buffer must restart from empty.
 */

type UpdateCall = [sessionId: string, channel: StreamChannel, text: string, provider: string];

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const updateStreaming: UpdateCall[] = [];
  const finalizeStreaming: string[] = [];
  const appendRealtime: Array<[string, unknown]> = [];

  const sessionStore = {
    finalizeStreaming: (sessionId: string) => {
      finalizeStreaming.push(sessionId);
    },
    appendRealtime: (sessionId: string, msg: unknown) => {
      appendRealtime.push([sessionId, msg]);
    },
  } as unknown as SessionStore;

  // Deltas now reach the store through the registry's flush callback rather
  // than the handler calling `updateStreaming` directly.
  const streamBuffers = createStreamingBufferRegistry((sessionId, text, provider, channel) => {
    updateStreaming.push([sessionId, channel, text, provider]);
  });

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed' } as ProjectSession,
    currentSessionId: 'viewed',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamBuffers,
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore,
  }));

  return {
    updateStreaming,
    finalizeStreaming,
    appendRealtime,
    dispatch: (event: ServerEvent) => listener?.(event),
  };
};

const delta = (
  sessionId: string,
  text: string,
  provider = 'claude',
  channel: StreamChannel = 'text',
): ServerEvent => ({
  kind: 'stream_delta',
  sessionId,
  content: text,
  provider,
  streamChannel: channel,
} as unknown as ServerEvent);

const streamEnd = (sessionId: string): ServerEvent => ({
  kind: 'stream_end',
  sessionId,
} as unknown as ServerEvent);

// `success: false` keeps `complete` from triggering the completion indicator
// and sound, which are irrelevant here.
const complete = (sessionId: string): ServerEvent => ({
  kind: 'complete',
  sessionId,
  success: false,
} as unknown as ServerEvent);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('two sessions stream into their own slot, each stamped with its own provider', () => {
  const { updateStreaming, appendRealtime, dispatch } = renderHandlers();

  dispatch(delta('viewed', '你好', 'claude'));
  dispatch(delta('background', 'hello', 'cursor'));
  vi.advanceTimersByTime(100);

  assert.deepEqual(updateStreaming, [
    ['viewed', 'text', '你好', 'claude'],
    ['background', 'text', 'hello', 'cursor'],
  ]);
  assert.deepEqual(appendRealtime, [], 'background deltas must not bypass into per-delta rows');
});

test('a thinking delta buffers on the thinking channel, not the reply', () => {
  const { updateStreaming, dispatch } = renderHandlers();

  dispatch(delta('s', '推理', 'claude', 'thinking'));
  dispatch(delta('s', '正文', 'claude', 'text'));
  vi.advanceTimersByTime(100);

  // The trace flushes before the reply so the store can order it above.
  assert.deepEqual(updateStreaming, [
    ['s', 'thinking', '推理', 'claude'],
    ['s', 'text', '正文', 'claude'],
  ]);
});

test("a session's stream_end tears down only that session", () => {
  const { updateStreaming, finalizeStreaming, dispatch } = renderHandlers();

  dispatch(delta('a', 'A', 'claude'));
  dispatch(delta('b', 'B', 'claude'));
  dispatch(streamEnd('a'));

  assert.deepEqual(updateStreaming, [['a', 'text', 'A', 'claude']], 'stream_end flushes only a');
  assert.deepEqual(finalizeStreaming, ['a']);

  vi.advanceTimersByTime(100);
  assert.deepEqual(updateStreaming, [
    ['a', 'text', 'A', 'claude'],
    ['b', 'text', 'B', 'claude'],
  ]);
});

test('stream_end flushes both channels before finalizing', () => {
  const { updateStreaming, finalizeStreaming, dispatch } = renderHandlers();

  dispatch(delta('s', '推理', 'claude', 'thinking'));
  dispatch(delta('s', '正文', 'claude', 'text'));
  dispatch(streamEnd('s'));

  assert.deepEqual(updateStreaming, [
    ['s', 'thinking', '推理', 'claude'],
    ['s', 'text', '正文', 'claude'],
  ]);
  assert.deepEqual(finalizeStreaming, ['s']);
});

test('complete without stream_end (Cursor) finalizes only its own buffer', () => {
  const { updateStreaming, finalizeStreaming, dispatch } = renderHandlers();

  dispatch(delta('cursor-session', 'chunk', 'cursor'));
  dispatch(delta('other', 'x', 'claude'));
  dispatch(complete('cursor-session'));

  assert.deepEqual(finalizeStreaming, ['cursor-session']);
  assert.deepEqual(updateStreaming, [['cursor-session', 'text', 'chunk', 'cursor']]);

  vi.advanceTimersByTime(100);
  assert.deepEqual(updateStreaming, [
    ['cursor-session', 'text', 'chunk', 'cursor'],
    ['other', 'text', 'x', 'claude'],
  ]);
});

test('a delta-less stream_end writes no row but still finalizes', () => {
  const { updateStreaming, finalizeStreaming, dispatch } = renderHandlers();

  dispatch(streamEnd('tool-only'));
  vi.advanceTimersByTime(100);

  assert.deepEqual(updateStreaming, [], 'an empty flush must not create a stub row');
  assert.deepEqual(finalizeStreaming, ['tool-only']);
});

test('a second cycle in the same session starts from empty text', () => {
  const { updateStreaming, finalizeStreaming, dispatch } = renderHandlers();

  dispatch(delta('s', 'first', 'claude'));
  dispatch(streamEnd('s'));
  dispatch(delta('s', 'second', 'claude'));
  dispatch(streamEnd('s'));

  assert.deepEqual(updateStreaming, [
    ['s', 'text', 'first', 'claude'],
    ['s', 'text', 'second', 'claude'],
  ]);
  assert.deepEqual(finalizeStreaming, ['s', 's']);
});
