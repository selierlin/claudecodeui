import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * Claude streams a reply as `stream_delta` frames and then, after
 * `message_stop` closes the stream, delivers the complete assistant message
 * carrying the same text. Both reach the store, so the reply only stays a
 * single bubble while the store collapses the live row with the echoed one.
 * These tests pin that collapse at the store seam: the user sees one reply.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const historyRow = (id: string, content: string, anchor?: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role: anchor ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: 'session-1',
  content,
  timestamp: `2026-01-01T00:00:0${id}.000Z`,
  ...(anchor ? { transcriptAnchorId: anchor } : {}),
} as NormalizedMessage);

const HISTORY = [
  historyRow('1', 'first prompt', 'u1'),
  historyRow('2', 'first answer'),
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

/** The complete assistant message the provider sends once the stream ended. */
const echoedReply = (content: string): NormalizedMessage => ({
  id: 'uuid-reply-1',
  kind: 'text',
  role: 'assistant',
  provider: 'claude',
  sessionId: 'session-1',
  content,
  timestamp: new Date(Date.now() + 1000).toISOString(),
} as NormalizedMessage);

describe('streamed reply echo', () => {
  it('keeps one reply when the full assistant message follows the finalized stream', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.updateStreaming('session-1', '正文X', 'claude', 'text');
      result.current.finalizeStreaming('session-1');
    });

    act(() => {
      result.current.appendRealtime('session-1', echoedReply('正文X'));
    });

    const replies = result.current
      .getMessages('session-1')
      .filter((message) => message.kind === 'text' && message.role === 'assistant' && message.content === '正文X');

    assert.equal(replies.length, 1, 'the echoed reply must collapse into the finalized stream row');
  });

  it('keeps one reply when the full assistant message overtakes the live stream row', async () => {
    const { result } = await loadedStore();

    // No `stream_end` yet: the placeholder is still a live `stream_delta` row
    // when the complete assistant message arrives (e.g. a provider that only
    // ends the run with `complete`).
    act(() => {
      result.current.updateStreaming('session-1', '正文Y', 'claude', 'text');
    });

    act(() => {
      result.current.appendRealtime('session-1', echoedReply('正文Y'));
    });

    const rows = result.current
      .getMessages('session-1')
      .filter((message) => message.content === '正文Y');

    assert.equal(rows.length, 1, 'the live row must be replaced by the echoed reply, not kept beside it');
  });
});
