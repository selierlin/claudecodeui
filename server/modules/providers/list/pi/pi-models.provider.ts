import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/**
 * Curated Pi fallback catalog. The authoritative catalog lives in the user's
 * `~/.pi/agent/models-store.json` (Pi's built-in mirror) plus
 * `~/.pi/agent/models.json` (user-configured providers); this tiny mirror keeps
 * the picker usable before those documents exist and as a last-resort fallback
 * when both are unreadable.
 */
export const PI_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      description: 'Fast and affordable DeepSeek coding model.',
    },
    {
      value: 'deepseek/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      description: 'Frontier DeepSeek model for complex coding and research.',
    },
  ],
  DEFAULT: 'deepseek/deepseek-v4-pro',
};

/** Pi's per-user agent state directory (`~/.pi/agent` by default). */
export const getPiAgentDir = (): string =>
  process.env.PI_CODING_AGENT_DIR?.trim()
  || path.join(os.homedir(), '.pi', 'agent');

/**
 * Root where Pi persists sessions (`~/.pi/agent/sessions` by default), matching
 * what the CLI itself writes so the synchronizer, history, and watcher read the
 * same files. Resolution mirrors Pi's own precedence for the sources CloudCLI
 * can observe:
 *   `PI_CODING_AGENT_SESSION_DIR` (env) > `sessionDir` (settings.json) > `<agentDir>/sessions`.
 * `--session-dir` is a per-run CLI flag and is not observable here, so it is
 * left out. Per Pi's settings.md, `sessionDir` accepts absolute paths, `~`, or
 * a path relative to the agent dir.
 */
export const getPiSessionsRoot = (): string => {
  const override = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (override) {
    return override;
  }

  const agentDir = getPiAgentDir();
  const settings = readJsonFile(path.join(agentDir, 'settings.json'));
  const sessionDir = typeof settings?.sessionDir === 'string' ? settings.sessionDir.trim() : '';
  if (sessionDir) {
    const expanded = sessionDir.startsWith('~')
      ? path.join(os.homedir(), sessionDir.slice(1))
      : sessionDir;
    return path.isAbsolute(expanded) ? expanded : path.resolve(agentDir, expanded);
  }

  return path.join(agentDir, 'sessions');
};

/** Model value shared by the picker and the runtime's `--model` flag. */
const modelValue = (provider: string, model: string): string => `${provider}/${model}`;

/** Pi `--thinking` levels exposed as reasoning effort options. */
const REASONING_EFFORT = {
  default: 'medium',
  values: [
    { value: 'off' },
    { value: 'low' },
    { value: 'medium' },
    { value: 'high' },
  ],
};

type PiModelEntry = {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
};

type PiStoredProvider = {
  models?: unknown;
};

const readJsonFile = (filePath: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const collectProviderModels = (
  providerId: string,
  models: unknown,
  options: Map<string, ProviderModelOption>,
): void => {
  if (!Array.isArray(models)) {
    return;
  }
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as PiModelEntry;
    const modelId = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!modelId) {
      continue;
    }
    const value = modelValue(providerId, modelId);
    const label = typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : modelId;
    // The user's own models.json wins over the built-in store entry.
    options.set(value, {
      value,
      label,
      ...(entry.reasoning === true ? { effort: REASONING_EFFORT } : {}),
    });
  }
};

/**
 * Reads the model catalog from Pi's own state: the built-in mirror in
 * `models-store.json` merged with user-configured providers in `models.json`
 * (user entries replace built-in ones with the same `<provider>/<model>` value).
 *
 * Returns `null` when neither document yields a model, so callers fall back to
 * the curated mirror instead of surfacing an empty picker.
 */
export function loadPiModels(): ProviderModelsDefinition | null {
  const agentDir = getPiAgentDir();

  // Built-in catalog first so user configuration can override it.
  const options = new Map<string, ProviderModelOption>();
  const store = readJsonFile(path.join(agentDir, 'models-store.json'));
  if (store) {
    for (const [providerId, raw] of Object.entries(store)) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      collectProviderModels(providerId, (raw as PiStoredProvider).models, options);
    }
  }

  const userModels = readJsonFile(path.join(agentDir, 'models.json'));
  const userProviders = userModels?.providers;
  if (userProviders && typeof userProviders === 'object') {
    for (const [providerId, raw] of Object.entries(userProviders as Record<string, PiStoredProvider>)) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      collectProviderModels(providerId, raw.models, options);
    }
  }

  if (options.size === 0) {
    return null;
  }

  // `settings.json` carries the default route the CLI itself uses.
  let defaultValue = '';
  const settings = readJsonFile(path.join(agentDir, 'settings.json'));
  const defaultProvider = typeof settings?.defaultProvider === 'string' ? settings.defaultProvider : '';
  const defaultModel = typeof settings?.defaultModel === 'string' ? settings.defaultModel : '';
  if (defaultProvider && defaultModel) {
    const candidate = modelValue(defaultProvider, defaultModel);
    if (options.has(candidate)) {
      defaultValue = candidate;
    }
  }

  const ordered = [...options.values()];
  return {
    OPTIONS: ordered,
    DEFAULT: defaultValue || ordered[0].value,
  };
}

/** Provider registry model adapter for Pi models from agent state and the curated fallback. */
export class PiProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const catalog = loadPiModels() ?? PI_PREDEFINED_MODELS;

    // `PI_MODEL` overrides the picker default, keeping the env escape hatch
    // aligned with what the CLI runs when no model is configured.
    const configuredModel = process.env.PI_MODEL?.trim();
    if (!configuredModel) {
      return catalog;
    }

    return {
      OPTIONS: catalog.OPTIONS.some((option) => option.value === configuredModel)
        ? catalog.OPTIONS
        : [{ value: configuredModel, label: configuredModel }, ...catalog.OPTIONS],
      DEFAULT: configuredModel,
    };
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
