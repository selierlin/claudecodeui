import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import { PROVIDER_MODELS_CHANGED_EVENT } from '@/shared/constants';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

const providerModelsResponse = vi.hoisted(() => vi.fn());

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: (provider: string) => providerModelsResponse(provider),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async () => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
};

beforeEach(() => {
  localStorage.clear();
  providerModelsResponse.mockReset();
  providerModelsResponse.mockImplementation(() => okJson({ success: true, data: null }));
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

afterEach(() => {
  vi.resetModules();
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('a fresh provider adopts the config-driven catalog default instead of its startup fallback', async () => {
  providerModelsResponse.mockImplementation((provider: string) => okJson({
    success: true,
    data: provider === 'codex'
      ? {
          models: {
            OPTIONS: [
              { value: 'configured-codex', label: 'Configured Codex' },
              { value: 'gpt-5.4', label: 'Startup fallback' },
            ],
            DEFAULT: 'configured-codex',
          },
        }
      : null,
  }));

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.codex, 'configured-codex');
  });
  assert.equal(localStorage.getItem('codex-model'), 'configured-codex');
});

test('the provider models changed event re-fetches the catalog the composer cached at mount', async () => {
  const claudeCatalog = (label: string) => ({
    success: true,
    data: {
      models: {
        OPTIONS: [{ value: 'sonnet', label }],
        DEFAULT: 'sonnet',
      },
    },
  });

  providerModelsResponse.mockImplementation((provider: string) => (
    okJson(provider === 'claude' ? claudeCatalog('Sonnet') : { success: true, data: null })
  ));

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModelCatalog.claude?.OPTIONS[0]?.label, 'Sonnet');
  });
  const callsAfterMount = providerModelsResponse.mock.calls.length;

  // The settings panel saved a new active settings file, so the backend now
  // folds a different alias mapping into Claude's catalog.
  providerModelsResponse.mockImplementation((provider: string) => (
    okJson(provider === 'claude' ? claudeCatalog('Sonnet → doubao-seed-2.1-turbo') : { success: true, data: null })
  ));

  act(() => {
    window.dispatchEvent(new Event(PROVIDER_MODELS_CHANGED_EVENT));
  });

  await waitFor(() => {
    assert.equal(
      result.current.providerModelCatalog.claude?.OPTIONS[0]?.label,
      'Sonnet → doubao-seed-2.1-turbo',
    );
  });
  assert.ok(
    providerModelsResponse.mock.calls.length > callsAfterMount,
    'the announcement must trigger a fresh catalog request',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'cursor');
  });
  assert.equal(result.current.currentProviderModel, 'cursor-active');
});
