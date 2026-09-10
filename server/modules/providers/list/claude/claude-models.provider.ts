import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { providerSettingsSourceService } from '@/modules/providers/services/provider-settings-source.service.js';
import { readClaudeSettingsEnv } from '@/shared/claude-settings.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};

/**
 * Claude alias a model-mapping environment variable overrides, keyed the way
 * the predefined catalog names it. `default` follows `ANTHROPIC_MODEL`, the
 * others follow the `ANTHROPIC_DEFAULT_*_MODEL` variables Claude Code itself
 * consumes to translate aliases at run time.
 */
export type ClaudeModelAlias = 'default' | 'opus' | 'sonnet' | 'haiku';

/** Effective alias → concrete model id mapping read from configuration. */
export type ClaudeModelMappings = Partial<Record<ClaudeModelAlias, string>>;

const CLAUDE_MODEL_ENV_KEYS: Record<ClaudeModelAlias, string> = {
  default: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

/** Catalog options sharing an alias: the `[1m]` variants map to the same model. */
const CLAUDE_MAPPED_OPTION_ALIASES: Record<string, ClaudeModelAlias> = {
  default: 'default',
  opus: 'opus',
  'opus[1m]': 'opus',
  sonnet: 'sonnet',
  'sonnet[1m]': 'sonnet',
  haiku: 'haiku',
};

/** Short display names used when a mapped option's label is rewritten. */
const CLAUDE_MAPPED_OPTION_LABELS: Record<string, string> = {
  default: 'Default',
  opus: 'Opus',
  'opus[1m]': 'Opus (1M context)',
  sonnet: 'Sonnet',
  'sonnet[1m]': 'Sonnet (1M context)',
  haiku: 'Haiku',
  opusplan: 'Opus Plan',
};

/**
 * Picks the effective alias → model mapping from settings `env` sources given
 * in priority order: the first source that defines an alias's environment
 * variable wins. Pure and exported for tests.
 */
export const pickClaudeModelMappings = (
  ...sources: Record<string, unknown>[]
): ClaudeModelMappings => {
  const mappings: ClaudeModelMappings = {};

  for (const [alias, envKey] of Object.entries(CLAUDE_MODEL_ENV_KEYS) as [ClaudeModelAlias, string][]) {
    for (const source of sources) {
      const value = source[envKey];
      const normalized = typeof value === 'string' ? value.trim() : '';
      if (normalized) {
        mappings[alias] = normalized;
        break;
      }
    }
  }

  return mappings;
};

/**
 * Resolves the effective alias → model mapping from host configuration.
 *
 * Sources in priority order, matching how the claude runtime feeds Claude Code:
 *   1. real environment variables of the server process;
 *   2. the per-provider custom settings file configured in CloudCLI settings
 *      (forwarded to every run as `--settings`);
 *   3. the host user settings (`~/.claude/settings.json`), which Claude Code
 *      always loads.
 * Unset aliases are omitted so the predefined catalog copy stays
 * authoritative for them.
 */
const resolveClaudeModelMappings = async (): Promise<ClaudeModelMappings> => {
  const activeSettingsFile = providerSettingsSourceService.resolveActiveSettingsFile('claude');
  const [activeFileEnv, userSettingsEnv] = await Promise.all([
    activeSettingsFile ? readClaudeSettingsEnv(activeSettingsFile) : Promise.resolve({}),
    readClaudeSettingsEnv(),
  ]);

  return pickClaudeModelMappings(process.env, activeFileEnv, userSettingsEnv);
};

/**
 * Rewrites the predefined catalog's display strings for aliases that the host
 * configuration maps to a concrete model, e.g. `Sonnet → doubao-seed-2.1-turbo`.
 *
 * Only `label` and `description` change. `value` keeps the alias because the
 * Claude runtime resolves aliases through the same environment variables, and
 * downstream lookups (session restore, custom-model uniqueness, effort
 * options) are all built on the alias set. Effort levels are kept as-is.
 *
 * Exported for tests.
 */
export const applyClaudeModelMappings = (
  definition: ProviderModelsDefinition,
  mappings: ClaudeModelMappings,
): ProviderModelsDefinition => {
  const annotate = (
    option: ProviderModelOption,
    label: string,
    mappedModels: string[],
    envKeys: string[],
  ): ProviderModelOption => ({
    ...option,
    label: `${label} → ${mappedModels.join(' / ')}`,
    description: option.description
      ? `${option.description} Mapped via ${envKeys.join(' + ')}.`
      : `Mapped via ${envKeys.join(' + ')}.`,
  });

  return {
    OPTIONS: definition.OPTIONS.map((option) => {
      // `opusplan` plans with Opus and executes with Sonnet, so it shows every
      // one of the two aliases that has a configured mapping.
      if (option.value === 'opusplan') {
        const mappedModels = [mappings.opus, mappings.sonnet].filter(
          (model): model is string => Boolean(model),
        );
        const envKeys = [
          mappings.opus ? CLAUDE_MODEL_ENV_KEYS.opus : null,
          mappings.sonnet ? CLAUDE_MODEL_ENV_KEYS.sonnet : null,
        ].filter((key): key is string => Boolean(key));

        if (mappedModels.length > 0) {
          return annotate(option, CLAUDE_MAPPED_OPTION_LABELS.opusplan, mappedModels, envKeys);
        }

        return option;
      }

      const alias = CLAUDE_MAPPED_OPTION_ALIASES[option.value];
      const mappedModel = alias ? mappings[alias] : undefined;
      if (!alias || !mappedModel) {
        return option;
      }

      return annotate(
        option,
        CLAUDE_MAPPED_OPTION_LABELS[option.value] ?? option.label,
        [mappedModel],
        [CLAUDE_MODEL_ENV_KEYS[alias]],
      );
    }),
    DEFAULT: definition.DEFAULT,
  };
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

/**
 * Claude Code stamps locally-synthesized rows (API-error placeholders and the
 * like) with `model: "<synthetic>"`. Angle-bracketed values are placeholders,
 * never real model ids, and must not be surfaced as the session's model.
 */
const isPlaceholderModel = (model: string): boolean => model.startsWith('<') && model.endsWith('>');

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderModel(messageModel) ? messageModel : null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // The catalog starts from the predefined aliases and is annotated with the
    // alias → model mappings configured on the host (ANTHROPIC_MODEL and
    // ANTHROPIC_DEFAULT_*_MODEL). Querying the SDK instead would start a real
    // Claude Code session and leave a stray jsonl session file behind, so the
    // predefined set is never replaced, only relabelled.
    return applyClaudeModelMappings(CLAUDE_PREDEFINED_MODELS, await resolveClaudeModelMappings());
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
