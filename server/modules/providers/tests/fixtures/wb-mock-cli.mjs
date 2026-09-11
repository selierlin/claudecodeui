#!/usr/bin/env node
// Mock of the WorkBuddy (codebuddy) stream-json CLI for runtime tests.
// Behavior is selected by MOCK_MODE: success | streaming | error | error-event |
// function-events | task-events | task-failure | unknown-invalid |
// exit-nonzero | stderr-sensitive | error-sensitive | no-trailing-newline |
// hang | streaming-hang | interruptible | stdin-closed | error-event-hang |
// success-result-hang | error-result-hang | result-then-error-hang |
// assistant-complete-await-eof.
const mode = process.env.MOCK_MODE || 'success';
const args = process.argv.slice(2);
const readArg = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
};
const prompt = readArg('-p') || '';
const resumed = readArg('--resume');
const permMode = readArg('--permission-mode');
const model = readArg('--model');
const effort = readArg('--effort');
const sid = 'mock-session-123';

const useStreamInput = readArg('--input-format') === 'stream-json';

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const readFirstStdinLine = () => new Promise((resolve) => {
  let buffer = '';
  const cleanup = () => {
    process.stdin.removeListener('data', onData);
    process.stdin.removeListener('end', onEnd);
    process.stdin.pause();
  };
  const finish = () => {
    cleanup();
    const newlineIndex = buffer.search(/\r?\n/);
    resolve((newlineIndex >= 0 ? buffer.slice(0, newlineIndex) : buffer).trim());
  };
  const onData = (chunk) => {
    buffer += String(chunk);
    if (/\r?\n/.test(buffer)) finish();
  };
  const onEnd = () => finish();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdin.once('end', onEnd);
});

// When the runtime carries attachments it switches to stream-json input: the
// prompt text and any image/document content blocks arrive as one JSON user
// message on stdin instead of a `-p` argv prompt. Parse it so the echo below
// proves the runtime serialized the blocks correctly.
let effectivePrompt = prompt;
let stdinSummary = '';
if (useStreamInput) {
  const line = await readFirstStdinLine();
  try {
    const parsed = JSON.parse(line);
    const content = Array.isArray(parsed?.message?.content) ? parsed.message.content : [];
    effectivePrompt = content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const imageCount = content.filter((block) => block.type === 'image').length;
    const documentCount = content.filter((block) => block.type === 'document').length;
    stdinSummary = imageCount || documentCount ? ` STDIN:${imageCount}img:${documentCount}file` : '';
  } catch {
    effectivePrompt = '<unparseable stdin>';
  }
}

emit({ type: 'system', subtype: 'init', session_id: sid, tools: [] });
if (mode === 'hang') {
  // Stay alive until the test kills the process (abort coverage).
  setInterval(() => {}, 1000);
} else if (mode === 'stdin-closed') {
  // The real CLI can stop accepting control messages before its process exits.
  // Keep the fixture alive after closing stdin so the parent observes EPIPE
  // when it later sends an interrupt request.
  process.stdin.destroy();
  setInterval(() => {}, 1000);
} else if (mode === 'error') {
  emit({ type: 'result', subtype: 'error', is_error: true, session_id: sid, result: 'mock failure' });
} else if (mode === 'error-result-hang') {
  emit({ type: 'result', subtype: 'error', is_error: true, session_id: sid, result: 'mock failure' });
  setInterval(() => {}, 1000);
} else if (mode === 'success-result-hang') {
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
  setInterval(() => {}, 1000);
} else if (mode === 'assistant-complete-await-eof') {
  // The stream-json CLI writes its final assistant message before it receives
  // EOF. A one-shot caller must close stdin so the CLI can emit `result` and
  // exit instead of waiting indefinitely for another input message.
  emit({
    type: 'assistant',
    session_id: sid,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'assistant response finished' }],
    },
  });
  await new Promise((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.resume();
  });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
} else if (mode === 'result-then-error-hang') {
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
  emit({ type: 'error', error: 'fatal error after terminal result' });
  setInterval(() => {}, 1000);
} else if (mode === 'error-event') {
  // A fatal engine error surfaces as a single error event with no follow-up.
  emit({ type: 'error', error: 'No conversation found with session ID: mock-session' });
} else if (mode === 'error-event-hang') {
  // Keep the process alive after a fatal event to verify the parent reaps it
  // before sending its terminal completion message.
  emit({ type: 'error', error: 'No conversation found with session ID: mock-session' });
  emit({
    type: 'assistant',
    session_id: sid,
    message: { role: 'assistant', content: [{ type: 'text', text: 'must be ignored after fatal error' }] },
  });
  setInterval(() => {}, 1000);
} else if (mode === 'error-sensitive') {
  emit({ type: 'error', error: 'authorization: Bearer secret-value apiKey=another-secret' });
} else if (mode === 'reasoning-events') {
  // Model reasoning arrives as its own top-level event while the engine
  // thinks between tool calls. The runtime must surface it as a thinking
  // message rather than dropping it as an unsupported stream-json event.
  emit({
    type: 'reasoning',
    id: 'reasoning-1',
    rawContent: [{ type: 'reasoning_text', text: 'thinking about the problem' }],
  });
  emit({
    type: 'function_call',
    id: 'function-event-1',
    callId: 'call-reasoning-tool',
    name: 'Bash',
    arguments: '{"command":"echo hello"}',
  });
  emit({
    type: 'function_call_result',
    id: 'function-result-1',
    callId: 'call-reasoning-tool',
    name: 'Bash',
    status: 'completed',
    output: { type: 'text', text: 'hello' },
  });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
} else if (mode === 'function-events') {
  emit({
    type: 'function_call',
    id: 'function-event-1',
    callId: 'call-tool-search',
    name: 'ToolSearch',
    arguments: '{"queries":["smoke"]}',
  });
  emit({
    type: 'function_call_result',
    id: 'function-result-1',
    callId: 'call-tool-search',
    name: 'ToolSearch',
    status: 'completed',
    output: { type: 'text', text: 'No matching tools found' },
  });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
} else if (mode === 'task-events') {
  emit({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    uuid: 'task-event-started',
    description: 'Background task started',
    session_id: sid,
  });
  emit({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-1',
    uuid: 'task-event-progress',
    description: 'Background task in progress',
    progress: 50,
    session_id: sid,
  });
  emit({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task-1',
    uuid: 'task-event-updated',
    status: 'completed',
    description: 'Background task updated',
    session_id: sid,
  });
  emit({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    uuid: 'task-event-notification',
    status: 'completed',
    summary: 'Background task completed',
    session_id: sid,
  });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
  emit({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    uuid: 'task-event-final-notification',
    status: 'completed',
    summary: 'Background task final notification',
    session_id: sid,
  });
} else if (mode === 'task-failure') {
  emit({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-failure',
    uuid: 'task-failure-started',
    description: 'Failing task started',
    session_id: sid,
  });
  emit({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task-failure',
    uuid: 'task-failure-updated',
    status: 'failed',
    description: 'Failing task failed',
    session_id: sid,
  });
  emit({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-failure',
    uuid: 'task-failure-notification',
    status: 'failed',
    summary: 'Failing task failed',
    session_id: sid,
  });
  emit({ type: 'result', subtype: 'error', is_error: true, session_id: sid, result: 'task failed' });
} else if (mode === 'unknown-invalid') {
  process.stdout.write('{not valid json}\n');
  emit({ type: 'future_event', version: 2, payload: 'ignored by current adapter' });
  emit({
    type: 'assistant',
    session_id: sid,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'unknown event ignored' }],
    },
  });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
} else if (mode === 'exit-nonzero') {
  emit({
    type: 'assistant',
    session_id: sid,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'process will exit with code 7' }],
    },
  });
} else if (mode === 'stderr-sensitive') {
  process.stderr.write('authorization: Bearer secret-value apiKey=another-secret\n');
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
} else if (mode === 'interruptible') {
  emit({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-interrupt',
    uuid: 'task-interrupt-started',
    description: 'Interruptible task started',
    session_id: sid,
  });

  let interrupted = false;
  const keepAlive = setInterval(() => {}, 1000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        if (request.type === 'control_request' && request.request?.subtype === 'interrupt') {
          interrupted = true;
          emit({ type: 'control_response', request_id: request.request_id, response: { subtype: 'success' } });
          emit({
            type: 'system',
            subtype: 'task_updated',
            task_id: 'task-interrupt',
            uuid: 'task-interrupt-updated',
            status: 'killed',
            description: 'Interruptible task killed',
            session_id: sid,
          });
          emit({
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-interrupt',
            uuid: 'task-interrupt-notification',
            status: 'stopped',
            summary: 'Interruptible task stopped',
            session_id: sid,
          });
          clearInterval(keepAlive);
          setTimeout(() => process.exit(0), 10);
        }
      } catch {
        // Ignore non-JSON input in the fixture.
      }
    }
  });
  process.stdin.on('end', () => {
    if (!interrupted) {
      // Keep the mock alive so the test can distinguish EOF from interrupt.
      process.stdin.pause();
    }
  });
  process.stdin.resume();
} else if (mode === 'no-trailing-newline') {
  emit({
    type: 'assistant',
    session_id: sid,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'final line without newline' }],
    },
  });
  // The terminal result event is written without a trailing newline; the
  // runtime must flush the partial line on process close.
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sid,
    result: 'ok',
  }));
} else if (mode === 'streaming') {
  // Mirrors the real partial-message wire: token-level `stream_event` deltas,
  // then the full assistant events that repeat the same blocks.
  const thinkingText = 'mock thinking';
  const replyText = `OK:${effectivePrompt}:perm=${permMode ?? 'none'}`;
  const splitAt = Math.ceil(replyText.length / 2);
  emit({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinkingText } } });
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: replyText.slice(0, splitAt) } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: replyText.slice(splitAt) } } });
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
  emit({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'thinking', thinking: thinkingText }] } });
  emit({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: replyText }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
} else if (mode === 'streaming-hang') {
  // Streams deltas indefinitely so a test can abort mid-stream and verify a
  // buffered/final delta cannot land after the terminal complete.
  emit({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
  const emitDelta = () => emit({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'x' } },
  });
  const timer = setInterval(emitDelta, 30);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    emitDelta();
    setTimeout(() => process.exit(0), 300);
  });
  emitDelta();
} else {
  emit({
    type: 'assistant',
    session_id: sid,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'mock thinking' },
        {
          type: 'text',
          text: (
            resumed
              ? `RESUMED:${resumed}:${effectivePrompt}`
              : `OK:${effectivePrompt}:perm=${permMode ?? 'none'}`
          ) + (model ? ` MODEL:${model}` : '') + (effort ? ` EFFORT:${effort}` : '') + (process.env.CODEBUDDY_CONFIG_DIR ? ` CFG:${process.env.CODEBUDDY_CONFIG_DIR}` : '') + stdinSummary,
        },
      ],
    },
  });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
}

// The real print-mode CLI exits after its terminal result. Keeping stdin open
// is only necessary for the long-running modes that test cancellation.
if (
  mode !== 'hang'
  && mode !== 'streaming-hang'
  && mode !== 'interruptible'
  && mode !== 'stdin-closed'
  && mode !== 'error-event-hang'
  && mode !== 'success-result-hang'
  && mode !== 'error-result-hang'
  && mode !== 'result-then-error-hang'
) {
  process.exit(mode === 'exit-nonzero' ? 7 : 0);
}
