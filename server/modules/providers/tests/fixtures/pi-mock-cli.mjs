#!/usr/bin/env node
// Mock of the Pi CLI in `--mode json -p` one-shot mode for runtime tests.
// Behavior is selected by MOCK_MODE: success | streaming | error-message-exit0 |
// error-then-success | startup-error | no-trailing-newline | hang.
// When PI_MOCK_ARGS_FILE is set, the full argv (excluding node/script) is
// written there so tests can assert the spawn arguments precisely.
import fs from 'node:fs';

const mode = process.env.MOCK_MODE || 'success';
const args = process.argv.slice(2);
const readArg = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
};
const resumed = readArg('--session');
const model = readArg('--model');
const thinking = readArg('--thinking');
const doubleDashIndex = args.indexOf('--');
const prompt = doubleDashIndex >= 0 ? args.slice(doubleDashIndex + 1).join(' ') : '';
const attachments = args.filter((arg) => arg.startsWith('@'));
const sid = resumed || 'mock-session-uuid';

if (process.env.PI_MOCK_ARGS_FILE) {
  fs.writeFileSync(process.env.PI_MOCK_ARGS_FILE, JSON.stringify(args, null, 2));
}

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const emitHeader = () => emit({
  type: 'session',
  version: 3,
  id: sid,
  timestamp: '2026-09-09T08:00:00.000Z',
  cwd: process.cwd(),
});

const assistantMessage = (extra = {}) => ({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'mock thinking' },
    {
      type: 'text',
      text: (resumed ? `RESUMED:${resumed}:` : 'OK:') + prompt
        + (model ? ` MODEL:${model}` : '')
        + (thinking ? ` THINKING:${thinking}` : '')
        + (attachments.length ? ` ATTACH:${attachments.join(',')}` : ''),
    },
  ],
  api: 'anthropic-messages',
  provider: 'ark',
  model: 'deepseek-v4-flash',
  stopReason: 'stop',
  usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  timestamp: Date.now(),
  ...extra,
});

const emitTail = () => {
  emit({ type: 'agent_end', messages: [] });
  emit({ type: 'agent_settled' });
};

emitHeader();
if (mode === 'hang') {
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({
    type: 'message_end',
    message: { role: 'user', content: prompt, timestamp: Date.now() },
  });
  setInterval(() => {}, 1000);
} else if (mode === 'error-message-exit0') {
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'API error 401, api key: sk-12345 invalid',
      timestamp: Date.now(),
    },
  });
  emitTail();
} else if (mode === 'error-then-success') {
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'retrying after transient failure',
      timestamp: Date.now(),
    },
  });
  emit({ type: 'message_end', message: assistantMessage() });
  emitTail();
} else if (mode === 'streaming') {
  // Mirrors a real run: the user echo, then an assistant message whose thinking
  // and reply arrive as token-level `message_update` deltas before the full
  // `message_end` copy.
  const full = assistantMessage();
  const thinkingText = full.content[0].thinking;
  const replyText = full.content[1].text;
  const splitAt = Math.ceil(replyText.length / 2);
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({ type: 'message_start', message: { role: 'user', content: prompt, timestamp: Date.now() } });
  emit({ type: 'message_end', message: { role: 'user', content: prompt, timestamp: Date.now() } });
  emit({ type: 'message_start', message: { role: 'assistant' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: thinkingText } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: thinkingText } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: replyText.slice(0, splitAt) } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: replyText.slice(splitAt) } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: replyText } });
  emit({ type: 'message_end', message: full });
  emitTail();
} else if (mode === 'streaming-hang') {
  // Streams deltas indefinitely so a test can abort mid-stream and verify a
  // buffered/final delta cannot land after the terminal complete.
  emit({ type: 'message_start', message: { role: 'assistant' } });
  const emitDelta = () => emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'x' },
  });
  const timer = setInterval(emitDelta, 30);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    emitDelta();
    setTimeout(() => process.exit(0), 300);
  });
  emitDelta();
} else if (mode === 'startup-error') {
  process.stderr.write('Error: Unknown provider definitely-missing\n');
  process.exit(1);
} else if (mode === 'no-trailing-newline') {
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({
    type: 'message_end',
    message: { role: 'user', content: prompt, timestamp: Date.now() },
  });
  emit({ type: 'message_end', message: assistantMessage() });
  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [] }));
} else {
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  emit({
    type: 'message_end',
    message: { role: 'user', content: prompt, timestamp: Date.now() },
  });
  emit({ type: 'message_end', message: assistantMessage() });
  emitTail();
}

if (mode !== 'hang' && mode !== 'streaming-hang') {
  process.exit(0);
}
