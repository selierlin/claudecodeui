import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CursorSessionsProvider } from '@/modules/providers/list/cursor/cursor-sessions.provider.js';
import { cursorRuntime } from '@/modules/providers/list/cursor/cursor-runtime.provider.js';
import type { ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

const sessionsProvider = new CursorSessionsProvider();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const findEnvKey = (name: string) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

function makeContext(): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveProviderConfigDir: () => null,
    resolveSettingsFile: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
}

type Captured = { kind: string; sessionId?: string | null };

/**
 * Writes a fake `cursor-agent` that streams an assistant chunk every 30ms, and
 * on SIGTERM emits one final chunk and lingers 300ms before exiting.
 *
 * The late chunk lands past the coalescer's 50ms window but before the process
 * closes, so it exercises the sink guard rather than being swept up by the
 * teardown `dispose()`. That is exactly the abort race: the abort handler
 * publishes the terminal `complete` immediately, while the child is still
 * alive and flushing.
 */
async function createFakeCursorExecutable(binDir: string): Promise<void> {
  const script = `
const fs = require('node:fs');
const emit = () => fs.writeSync(1, JSON.stringify({
  type: 'assistant',
  message: { content: [{ text: 'chunk' }] },
}) + '\\n');
const timer = setInterval(emit, 30);
process.on('SIGTERM', () => {
  clearInterval(timer);
  emit();
  setTimeout(() => process.exit(0), 300);
});
emit();
`;
  const scriptPath = path.join(binDir, 'cursor-agent.js');
  await writeFile(scriptPath, script, 'utf8');

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, 'cursor-agent.cmd');
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0cursor-agent.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'cursor-agent');
  // `exec` so the node process replaces the shim and becomes the direct child
  // that receives SIGTERM; otherwise the kill would land on the shell only.
  await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/cursor-agent.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

// The regression depends on SIGTERM reaching the child and letting it emit one
// last chunk, which is POSIX-specific; Windows kill semantics would not.
test('an abort drops a delta that arrives after the terminal complete', { skip: process.platform === 'win32' }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cursor-runtime-guard-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const messages: Captured[] = [];
  const writer: ProviderRuntimeWriter = {
    send(message) {
      messages.push(message as Captured);
    },
    setSessionId() {},
    userId: null,
  };

  try {
    await createFakeCursorExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    const runPromise = cursorRuntime.run(
      'Hi',
      { sessionId: 'app-1', cwd: tempRoot },
      writer,
      makeContext(),
    );

    // Wait until the child is live and streaming, which also guarantees it has
    // installed its SIGTERM handler. Without this the kill could race the spawn
    // and the test would pass vacuously.
    const deadline = Date.now() + 5000;
    while (!messages.some((message) => message.kind === 'stream_delta')) {
      if (Date.now() > deadline) {
        assert.fail('timed out waiting for the fake CLI to stream');
      }
      await sleep(20);
    }

    const aborted = await cursorRuntime.abort('app-1');
    assert.equal(aborted, true);

    // `handleChatAbort` emits the terminal complete directly on the writer,
    // bypassing the runtime's coalescer — reproduce that here.
    writer.send({ kind: 'complete', provider: 'cursor', sessionId: 'app-1', aborted: true });

    await runPromise.catch(() => {});
    // Outlast both the coalescer window (50ms) and the child's 300ms linger.
    await sleep(400);

    const completeIndex = messages.findIndex((message) => message.kind === 'complete');
    assert.notEqual(completeIndex, -1);
    const lateDeltas = messages
      .slice(completeIndex + 1)
      .filter((message) => message.kind === 'stream_delta');
    assert.deepEqual(lateDeltas, [], `unexpected delta after complete: ${JSON.stringify(lateDeltas)}`);
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});
