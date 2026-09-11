import type { LLMProvider } from '@/shared/types';

/**
 * Debounce window for coalescing incoming deltas into one store write. Kept in
 * sync with `StreamingMarkdown`, whose split logic assumes this cadence.
 */
const STREAMING_FLUSH_INTERVAL_MS = 100;

/**
 * One session's in-flight reply. Text and provider are stored per session so
 * two sessions streaming at once never share state; `timer` is the debounce
 * handle that publishes the accumulated text.
 */
type StreamBuffer = {
  text: string;
  provider: LLMProvider;
  timer: number | null;
};

/**
 * Session-keyed streaming buffer owned by the chat pane. `ChatInterface`
 * creates it and hands it to `useChatRealtimeHandlers`, which appends deltas
 * and flushes on `stream_end` / `complete`. The narrow interface lets the
 * 100ms coalescing rule be unit-tested without rendering React.
 */
export type StreamingBufferRegistry = {
  /**
   * Appends a delta, arming the debounce timer on the first one. No-ops on an
   * empty session id or empty text, so a delta-less frame cannot create a stub
   * row later.
   */
  append: (sessionId: string, text: string, provider: LLMProvider) => void;
  /**
   * Cancels the debounce and publishes the accumulated text immediately.
   * No-ops when the session has no buffer or the buffer is empty — this is what
   * keeps a tool-only `stream_end` from writing an empty placeholder row.
   */
  flushNow: (sessionId: string) => void;
  /** Cancels the debounce and discards the buffer without publishing. */
  drop: (sessionId: string) => void;
  /** Cancels every timer and discards every buffer. Used on unmount. */
  dropAll: () => void;
  /** Whether the session currently holds a buffer. */
  has: (sessionId: string) => boolean;
};

/**
 * Creates the session-keyed streaming buffer used by `ChatInterface` and
 * `useChatRealtimeHandlers`.
 *
 * `flush` receives the accumulated text together with the provider recorded at
 * append time. The provider must travel with the message rather than being
 * captured from a hook-scope closure: a background session running a different
 * provider would otherwise stamp its row with the viewed session's provider.
 */
export function createStreamingBufferRegistry(
  flush: (sessionId: string, text: string, provider: LLMProvider) => void,
): StreamingBufferRegistry {
  const buffers = new Map<string, StreamBuffer>();

  const clearTimer = (buffer: StreamBuffer): void => {
    if (buffer.timer !== null) {
      window.clearTimeout(buffer.timer);
      buffer.timer = null;
    }
  };

  const append = (sessionId: string, text: string, provider: LLMProvider): void => {
    if (!sessionId || !text) {
      return;
    }

    let buffer = buffers.get(sessionId);
    if (!buffer) {
      buffer = { text: '', provider, timer: null };
      buffers.set(sessionId, buffer);
    }

    buffer.provider = provider;
    buffer.text += text;

    if (buffer.timer === null) {
      const target = buffer;
      target.timer = window.setTimeout(() => {
        target.timer = null;
        flush(sessionId, target.text, target.provider);
      }, STREAMING_FLUSH_INTERVAL_MS);
    }
  };

  const flushNow = (sessionId: string): void => {
    const buffer = buffers.get(sessionId);
    if (!buffer) {
      return;
    }

    clearTimer(buffer);
    if (buffer.text) {
      flush(sessionId, buffer.text, buffer.provider);
    }
  };

  const drop = (sessionId: string): void => {
    const buffer = buffers.get(sessionId);
    if (!buffer) {
      return;
    }

    clearTimer(buffer);
    buffers.delete(sessionId);
  };

  const dropAll = (): void => {
    buffers.forEach(clearTimer);
    buffers.clear();
  };

  const has = (sessionId: string): boolean => buffers.has(sessionId);

  return { append, flushNow, drop, dropAll, has };
}
