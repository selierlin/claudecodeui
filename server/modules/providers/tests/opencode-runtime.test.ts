import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { opencodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import type { ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

const sessionsProvider = new OpenCodeSessionsProvider();
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

type Captured = { kind: string; content?: unknown; sessionId?: string | null };

/**
 * Writes a fake `opencode` that streams a text event every 30ms, and on SIGTERM
 * emits one final event and lingers 300ms before exiting.
 *
 * The late event lands past the coalescer's 50ms window but before the process
 * closes, so it exercises the sink guard rather than being swept up by the
 * teardown `dispose()`. That is the abort race: the abort handler publishes the
 * terminal `complete` immediately, while the child is still alive and flushing.
 */
async function createFakeOpenCodeExecutable(binDir: string): Promise<void> {
  const script = `
const fs = require('node:fs');
const emit = () => fs.writeSync(1, JSON.stringify({
  type: 'text',
  sessionID: 'open-live-1',
  text: 'chunk',
}) + '\\n');
const timer = setInterval(emit, 30);
process.on('SIGTERM', () => {
  clearInterval(timer);
  emit();
  setTimeout(() => process.exit(0), 300);
});
emit();
`;
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, script, 'utf8');

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, 'opencode.cmd');
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0opencode.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  // `exec` so the node process replaces the shim and becomes the direct child
  // that receives SIGTERM; otherwise the kill would land on the shell only.
  await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

// The regression depends on SIGTERM reaching the child and letting it emit one
// last event, which is POSIX-specific; Windows kill semantics would not.
test('an abort drops a delta that arrives after the terminal complete', { skip: process.platform === 'win32' }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-guard-'));
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
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    const runPromise = opencodeRuntime.run(
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

    const aborted = await opencodeRuntime.abort('app-1');
    assert.equal(aborted, true);

    // `handleChatAbort` emits the terminal complete directly on the writer,
    // bypassing the runtime's coalescer — reproduce that here.
    writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'app-1', aborted: true });

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
