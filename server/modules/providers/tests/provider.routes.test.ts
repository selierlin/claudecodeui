import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session creation route names a CloudCLI session from the initial message', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'codex',
        projectPath: workspacePath,
        initialMessage: 'abcd  efg\nhij klm nop',
      }),
    });
    const payload = await response.json() as {
      data: { sessionId: string; sessionName: string };
    };

    assert.equal(response.status, 201);
    assert.equal(payload.data.sessionName, 'abcd efg hij klm');
    assert.equal(
      sessionsDb.getSessionById(payload.data.sessionId)?.custom_name,
      'abcd efg hij klm',
    );
  });
});

test('session pin route persists the requested state and validates its body', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('pinned-session', 'codex', workspacePath, 'Pin me');

    const pinResponse = await fetch(`${baseUrl}/api/providers/sessions/pinned-session/pinned`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isPinned: true }),
    });
    const pinPayload = await pinResponse.json() as { data: { sessionId: string; isPinned: boolean } };

    assert.equal(pinResponse.status, 200);
    assert.deepEqual(pinPayload.data, { sessionId: 'pinned-session', isPinned: true });
    assert.equal(sessionsDb.getSessionById('pinned-session')?.isPinned, 1);

    const invalidResponse = await fetch(`${baseUrl}/api/providers/sessions/pinned-session/pinned`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isPinned: 'true' }),
    });
    const invalidPayload = await invalidResponse.json() as { error: { code: string } };

    assert.equal(invalidResponse.status, 400);
    assert.equal(invalidPayload.error.code, 'INVALID_SESSION_PINNED');
  });
});

test('archived session batch delete permanently removes only archived sessions', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('archived-first', 'codex', workspacePath, 'First archived');
    sessionsDb.createAppSession('archived-second', 'codex', workspacePath, 'Second archived');
    sessionsDb.createAppSession('active-session', 'codex', workspacePath, 'Active');
    sessionsDb.updateSessionIsArchived('archived-first', true);
    sessionsDb.updateSessionIsArchived('archived-second', true);

    const response = await fetch(`${baseUrl}/api/providers/sessions/archived`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['archived-first', 'archived-second'] }),
    });
    const payload = await response.json() as { data: { sessionIds: string[] } };

    assert.equal(response.status, 200);
    assert.deepEqual(payload.data.sessionIds, ['archived-first', 'archived-second']);
    assert.equal(sessionsDb.getSessionById('archived-first'), null);
    assert.equal(sessionsDb.getSessionById('archived-second'), null);
    assert.ok(sessionsDb.getSessionById('active-session'));
  });
});

test('archived session batch delete rejects active sessions before deleting the batch', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('archived-session', 'codex', workspacePath, 'Archived');
    sessionsDb.createAppSession('active-session', 'codex', workspacePath, 'Active');
    sessionsDb.updateSessionIsArchived('archived-session', true);

    const response = await fetch(`${baseUrl}/api/providers/sessions/archived`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['archived-session', 'active-session'] }),
    });
    const payload = await response.json() as { error: { code: string } };

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, 'SESSION_NOT_ARCHIVED');
    assert.ok(sessionsDb.getSessionById('archived-session'));
    assert.ok(sessionsDb.getSessionById('active-session'));
  });
});

test('archived session batch delete leaves archived projects and their sessions untouched', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('project-archived-session', 'codex', workspacePath, 'Archived session');
    sessionsDb.updateSessionIsArchived('project-archived-session', true);
    projectsDb.updateProjectIsArchived(workspacePath, true);

    const response = await fetch(`${baseUrl}/api/providers/sessions/archived`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['project-archived-session'] }),
    });
    const payload = await response.json() as { error: { code: string } };

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, 'SESSION_PROJECT_ARCHIVED');
    assert.ok(sessionsDb.getSessionById('project-archived-session'));
    assert.equal(projectsDb.getProjectPath(workspacePath)?.isArchived, 1);
  });
});

test('conversation search streams title matches before transcript results', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession(
      'title-only-session',
      'codex',
      workspacePath,
      'Release planning notes',
    );
    const transcriptPath = path.join(path.dirname(workspacePath), 'codex-search.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-12T09:00:00.000Z',
      payload: {
        type: 'user_message',
        kind: 'plain',
        message: 'Release planning also appears in this conversation.',
      },
    })}\n`);
    sessionsDb.createSession(
      'transcript-session',
      'codex',
      workspacePath,
      'Unrelated session',
      undefined,
      undefined,
      transcriptPath,
    );

    const response = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=release%20planning&limit=50`,
    );
    const eventStream = await response.text();
    const titleEventIndex = eventStream.indexOf('event: title-results');
    const conversationEventIndex = eventStream.indexOf('event: result');
    const doneEventIndex = eventStream.indexOf('event: done');

    assert.equal(response.status, 200);
    assert.ok(titleEventIndex >= 0);
    assert.ok(conversationEventIndex > titleEventIndex);
    assert.ok(doneEventIndex > titleEventIndex);

    const titleDataLine = eventStream
      .slice(titleEventIndex, conversationEventIndex)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(titleDataLine);

    const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
      titleResults: Array<{
        sessionId: string;
        sessionTitle: string;
        provider: string;
      }>;
    };
    assert.equal(titlePayload.titleResults.length, 1);
    assert.equal(titlePayload.titleResults[0]?.sessionId, 'title-only-session');
    assert.equal(titlePayload.titleResults[0]?.sessionTitle, 'Release planning notes');
    assert.equal(titlePayload.titleResults[0]?.provider, 'codex');
  });
});

test('conversation search finds renamed sessions by either session id column', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('renamed-app-session', 'codex', workspacePath, 'Renamed title');
    sessionsDb.assignProviderSessionId('renamed-app-session', 'provider-id-abc123');
    // An archived session is searchable too and comes back flagged, so the UI
    // can badge it instead of silently hiding it from the conversations tab.
    sessionsDb.createAppSession('archived-app-session', 'codex', workspacePath, 'Archived title');
    sessionsDb.assignProviderSessionId('archived-app-session', 'archived-id-def456');
    sessionsDb.updateSessionIsArchived('archived-app-session', true);

    const readTitleResults = async (query: string) => {
      const response = await fetch(
        `${baseUrl}/api/providers/search/sessions?q=${encodeURIComponent(query)}&limit=50`,
      );
      const eventStream = await response.text();
      const titleEventIndex = eventStream.indexOf('event: title-results');
      assert.ok(titleEventIndex >= 0);
      const titleDataLine = eventStream
        .slice(titleEventIndex)
        .split('\n')
        .find((line) => line.startsWith('data: '));
      assert.ok(titleDataLine);
      const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
        titleResults: Array<{ sessionId: string; sessionTitle: string; isArchived?: boolean }>;
      };
      return titlePayload.titleResults;
    };

    // Both the engine-side id and the app-facing id match; the displayed title
    // stays the custom name instead of leaking the id.
    const byProviderId = await readTitleResults('provider-id-abc123');
    assert.equal(byProviderId.length, 1);
    assert.equal(byProviderId[0]?.sessionId, 'renamed-app-session');
    assert.equal(byProviderId[0]?.sessionTitle, 'Renamed title');
    assert.equal(byProviderId[0]?.isArchived, false);

    const byAppId = await readTitleResults('renamed-app-session');
    assert.equal(byAppId.length, 1);
    assert.equal(byAppId[0]?.sessionTitle, 'Renamed title');

    // The archived session is returned flagged as archived.
    const byArchivedId = await readTitleResults('archived-id-def456');
    assert.equal(byArchivedId.length, 1);
    assert.equal(byArchivedId[0]?.sessionId, 'archived-app-session');
    assert.equal(byArchivedId[0]?.sessionTitle, 'Archived title');
    assert.equal(byArchivedId[0]?.isArchived, true);

    // An unrelated id must not match.
    const byUnrelatedId = await readTitleResults('provider-id-zzz');
    assert.equal(byUnrelatedId.length, 0);
  });
});

test('conversation search finds archived sessions by transcript content and flags them', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    // Standalone archived session: the owning project stays active.
    const standaloneTranscriptPath = path.join(path.dirname(workspacePath), 'archived-standalone.jsonl');
    await writeFile(standaloneTranscriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-12T09:00:00.000Z',
      payload: { type: 'user_message', kind: 'plain', message: 'The real peak load reached 9000.' },
    })}\n`);
    sessionsDb.createSession('archived-standalone', 'codex', workspacePath, 'Archived standalone', undefined, undefined, standaloneTranscriptPath);
    sessionsDb.updateSessionIsArchived('archived-standalone', true);

    // Session whose owning project is itself archived.
    const archivedProjectPath = path.join(path.dirname(workspacePath), 'archived-project');
    const archivedProjectTranscriptPath = path.join(path.dirname(workspacePath), 'archived-project-session.jsonl');
    await writeFile(archivedProjectTranscriptPath, `${JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-08-12T10:00:00.000Z',
      payload: { type: 'user_message', kind: 'plain', message: 'Real peak usage in the archived project.' },
    })}\n`);
    sessionsDb.createSession('archived-project-session', 'codex', archivedProjectPath, 'Archived project session', undefined, undefined, archivedProjectTranscriptPath);
    projectsDb.updateProjectIsArchived(archivedProjectPath, true);

    const contentResponse = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=${encodeURIComponent('real peak')}&limit=50`,
    );
    const contentStream = await contentResponse.text();
    assert.equal(contentResponse.status, 200);

    const contentSessionsById = new Map<string, { isArchived?: boolean }>();
    const contentLines = contentStream.split('\n');
    for (let idx = 0; idx < contentLines.length; idx += 1) {
      if (contentLines[idx] !== 'event: result') continue;
      const dataLine = contentLines[idx + 1];
      if (!dataLine || !dataLine.startsWith('data: ')) continue;
      try {
        const payload = JSON.parse(dataLine.slice('data: '.length)) as {
          projectResult: { sessions: Array<{ sessionId: string; isArchived?: boolean }> };
        };
        for (const session of payload.projectResult.sessions) {
          contentSessionsById.set(session.sessionId, session);
        }
      } catch {
        // Ignore malformed lines.
      }
    }

    const standaloneHit = contentSessionsById.get('archived-standalone');
    const projectHit = contentSessionsById.get('archived-project-session');
    assert.ok(standaloneHit, 'standalone archived session should be found by content');
    assert.equal(standaloneHit?.isArchived, true);
    assert.ok(projectHit, 'session under an archived project should be found by content');
    assert.equal(projectHit?.isArchived, true);

    // Title search also surfaces the archived-project session with the flag.
    const titleResponse = await fetch(
      `${baseUrl}/api/providers/search/sessions?q=${encodeURIComponent('Archived project session')}&limit=50`,
    );
    const titleStream = await titleResponse.text();
    const titleEventIndex = titleStream.indexOf('event: title-results');
    assert.ok(titleEventIndex >= 0);
    const titleDataLine = titleStream
      .slice(titleEventIndex)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    assert.ok(titleDataLine);
    const titlePayload = JSON.parse(titleDataLine.slice('data: '.length)) as {
      titleResults: Array<{ sessionId: string; isArchived?: boolean }>;
    };
    const projectTitleHit = titlePayload.titleResults.find(
      (result) => result.sessionId === 'archived-project-session',
    );
    assert.ok(projectTitleHit, 'session under an archived project should be found by title');
    assert.equal(projectTitleHit?.isArchived, true);
  });
});

test('reasoning effort is persisted and returned with the active session model', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('effort-session', 'codex', workspacePath);

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'ultra' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { effort: string; sessionId: string };
    };

    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.effort, 'ultra');
    assert.equal(sessionsDb.getSessionById('effort-session')?.effort, 'ultra');

    const readResponse = await fetch(
      `${baseUrl}/api/providers/codex/sessions/effort-session/active-model`,
    );
    const readPayload = await readResponse.json() as {
      data: { effort: string | null; sessionId: string };
    };

    assert.equal(readResponse.status, 200);
    assert.equal(readPayload.data.sessionId, 'effort-session');
    assert.equal(readPayload.data.effort, 'ultra');
  });
});

test('model routes expose immutable defaults and full custom model CRUD', async () => {
  await withProviderServer(async (baseUrl) => {
    const initialResponse = await fetch(`${baseUrl}/api/providers/codex/models`);
    const initialPayload = await initialResponse.json() as {
      data: {
        cache?: unknown;
        models: {
          OPTIONS: Array<{ recordId?: number; value: string; isCustom: boolean }>;
        };
      };
    };
    assert.equal(initialResponse.status, 200);
    assert.equal('cache' in initialPayload.data, false);
    const predefined = initialPayload.data.models.OPTIONS[0];
    assert.equal(predefined.isCustom, false);
    assert.equal(predefined.recordId, undefined);

    const createResponse = await fetch(`${baseUrl}/api/providers/codex/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'Gateway GPT', id: 'gateway/gpt' }),
    });
    const createPayload = await createResponse.json() as {
      data: { model: { recordId: number; value: string; label: string; isCustom: boolean } };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.data.model.isCustom, true);
    const customRecordId = createPayload.data.model.recordId;

    const updateResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Gateway GPT Updated', id: 'gateway/gpt-v2' }),
      },
    );
    const updatePayload = await updateResponse.json() as {
      data: { model: { value: string; label: string } };
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.data.model.value, 'gateway/gpt-v2');
    assert.equal(updatePayload.data.model.label, 'Gateway GPT Updated');

    const immutableResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/999999`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'Changed', id: 'changed' }),
      },
    );
    const immutablePayload = await immutableResponse.json() as { error: { code: string } };
    assert.equal(immutableResponse.status, 404);
    assert.equal(immutablePayload.error.code, 'MODEL_NOT_FOUND');

    const deleteResponse = await fetch(
      `${baseUrl}/api/providers/codex/models/${customRecordId}`,
      { method: 'DELETE' },
    );
    const deletePayload = await deleteResponse.json() as {
      data: { models: { OPTIONS: Array<{ recordId: number }> } };
    };
    assert.equal(deleteResponse.status, 200);
    assert.equal(
      deletePayload.data.models.OPTIONS.some((option) => option.recordId === customRecordId),
      false,
    );
  });
});

test('session outline route returns lightweight user summaries', async (t) => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('outline-route-session', 'claude', workspacePath);
    sessionsDb.assignProviderSessionId('outline-route-session', 'claude-native-outline');

    mock.method(providerRegistry, 'resolveProvider', (() => ({
      sessions: {
        fetchHistory: async () => ({
          messages: [
            { id: 'r1', sessionId: 'outline-route-session', timestamp: '2026-08-26T10:00:00.000Z', provider: 'claude', kind: 'text', role: 'user', content: 'Outline first question\nline two' },
            { id: 'r2', sessionId: 'outline-route-session', timestamp: '2026-08-26T10:01:00.000Z', provider: 'claude', kind: 'text', role: 'assistant', content: 'A reply' },
          ],
          total: 2, hasMore: false, offset: 0, limit: null,
        }),
      },
    })) as unknown as typeof providerRegistry.resolveProvider);
    t.after(() => mock.reset());

    const response = await fetch(`${baseUrl}/api/providers/sessions/outline-route-session/outline`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      data: Array<{ timestamp: string; snippet: string }>;
    };
    assert.deepEqual(payload.data, [
      { timestamp: '2026-08-26T10:00:00.000Z', snippet: 'Outline first question' },
    ]);
  });
});

test('session messages route compresses large history responses', async (t) => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('compressed-history-session', 'claude', workspacePath);
    sessionsDb.assignProviderSessionId('compressed-history-session', 'claude-native-history');

    const content = 'large history payload '.repeat(300);
    mock.method(providerRegistry, 'resolveProvider', (() => ({
      sessions: {
        fetchHistory: async () => ({
          messages: [
            {
              id: 'history-message',
              sessionId: 'claude-native-history',
              timestamp: '2026-08-26T10:00:00.000Z',
              provider: 'claude',
              kind: 'text',
              role: 'assistant',
              content,
            },
          ],
          total: 1,
          hasMore: false,
          offset: 0,
          limit: null,
        }),
      },
    })) as unknown as typeof providerRegistry.resolveProvider);
    t.after(() => mock.reset());

    const response = await fetch(
      `${baseUrl}/api/providers/sessions/compressed-history-session/messages`,
      { headers: { 'accept-encoding': 'gzip' } },
    );
    const payload = await response.json() as {
      data: { messages: Array<{ content: string }> };
    };

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(payload.data.messages[0]?.content, content);
  });
});

test('session outline route reports unknown sessions as 404', async () => {
  await withProviderServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/sessions/nope/outline`);
    assert.equal(response.status, 404);
  });
});

test('session branch route rejects a URL provider other than Claude', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createAppSession('claude-branch-session', 'claude', workspacePath);

    const response = await fetch(
      `${baseUrl}/api/providers/codex/sessions/claude-branch-session/branch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'message-1_text_0' }),
      },
    );
    const payload = await response.json() as { error: { code: string } };

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'BRANCH_UNSUPPORTED_PROVIDER');
  });
});
