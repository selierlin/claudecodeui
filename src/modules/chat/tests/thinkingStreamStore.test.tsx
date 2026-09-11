import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * Reasoning traces stream on their own channel and finalize into `thinking`
 * rows. These tests pin the store end of that contract: the reply and the
 * trace become two distinct rows, and a live thinking row is pruned once the
 * persisted transcript owns it (otherwise a refresh doubles the trace).
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const row = (id: string, content: string, anchor?: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role: anchor ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: 'session-1',
  content,
  timestamp: `2026-01-01T00:00:0${id}.000Z`,
  ...(anchor ? { transcriptAnchorId: anchor } : {}),
} as NormalizedMessage);

const thinkingRow = (id: string, content: string): NormalizedMessage => ({
  id,
  kind: 'thinking',
  provider: 'claude',
  sessionId: 'session-1',
  content,
  timestamp: '2026-01-01T00:00:09.000Z',
} as NormalizedMessage);

const HISTORY = [
  row('1', 'first prompt', 'u1'),
  row('2', 'first answer'),
  row('3', 'second prompt', 'u2'),
  row('4', 'second answer'),
];

const mockHistory = (messages: NormalizedMessage[]) => {
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
  });
};

beforeEach(() => {
  sessionMessages.mockReset();
  mockHistory(HISTORY);
});

afterEach(() => {
  vi.resetModules();
});

async function loadedStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
  });
  return view;
}

describe('thinking stream channel', () => {
  it('keeps the reply and the reasoning trace as two rows', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.updateStreaming('session-1', '推理中', 'claude', 'thinking');
      result.current.updateStreaming('session-1', '正文中', 'claude', 'text');
    });

    const streamed = result.current
      .getMessages('session-1')
      .filter((message) => message.kind === 'stream_delta');

    assert.deepEqual(
      streamed.map((message) => [message.streamChannel, message.content]),
      [['thinking', '推理中'], ['text', '正文中']],
    );
  });

  it('finalizes the trace into a thinking row and the reply into a text row', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.updateStreaming('session-1', '推理中', 'claude', 'thinking');
      result.current.updateStreaming('session-1', '正文中', 'claude', 'text');
      result.current.finalizeStreaming('session-1');
    });

    const tail = result.current.getMessages('session-1').slice(-2);
    assert.deepEqual(
      tail.map((message) => [message.kind, message.role, message.content]),
      [['thinking', undefined, '推理中'], ['text', 'assistant', '正文中']],
    );
  });

  it('does not double the trace when the server already persisted it', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.updateStreaming('session-1', '推理X', 'claude', 'thinking');
      result.current.finalizeStreaming('session-1');
    });
    assert.equal(result.current.getMessages('session-1').length, 5);

    // The persisted transcript now owns the trace in the same turn.
    mockHistory([...HISTORY, thinkingRow('uuid-think-1', '推理X')]);
    await act(async () => {
      await result.current.refreshLatestFromServer('session-1');
    });

    const traces = result.current
      .getMessages('session-1')
      .filter((message) => message.kind === 'thinking');
    assert.equal(traces.length, 1, 'the live trace must be superseded, not duplicated');
    assert.equal(traces[0].timestamp, '2026-01-01T00:00:09.000Z');
  });

  it('keeps a live trace the server has not persisted yet', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.updateStreaming('session-1', '推理Y', 'claude', 'thinking');
      result.current.finalizeStreaming('session-1');
    });

    // The trace has not reached disk yet, so the refresh still returns the
    // history without any thinking row; dropping the live one would blank the
    // panel until the next refresh.
    await act(async () => {
      await result.current.refreshLatestFromServer('session-1');
    });

    const traces = result.current
      .getMessages('session-1')
      .filter((message) => message.kind === 'thinking');
    assert.deepEqual(traces.map((message) => message.content), ['推理Y']);
  });
});
