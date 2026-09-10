import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel } from '@/shared/utils.js';

/**
 * Curated list of models WorkBuddy exposes in its chat model picker.
 *
 * WorkBuddy's engine caches a full multi-vendor routing catalog locally, but
 * that catalog is unfiltered (it also lists Claude, Hunyuan, Codewise, image
 * and completion models) and carries no flag marking which models are actually
 * surfaced to users. The desktop client obtains its curated list from a
 * different server layer, not from that cache. So, like every other provider in
 * this repo, WorkBuddy uses a static curated list as the single source of truth
 * for the model picker.
 *
 * Keep this in sync with the models WorkBuddy actually exposes: add or remove an
 * entry here whenever WorkBuddy's lineup changes.
 */
export const WORKBUDDY_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'auto',
      label: 'Auto (recommended)',
      description: '平衡效果与速度。自动为每个任务匹配最优模型，积分倍率随之浮动。',
    },
    {
      value: 'hy4',
      label: 'Hy4 preview',
      description: '混元思考模型预览版，具有增强的推理能力。',
      effort: { values: [{ value: 'low' }, { value: 'high' }], default: 'high' },
    },
    {
      value: 'hy3',
      label: 'Hy3',
      description: '混元思考模型，具有增强的推理能力。',
      effort: { values: [{ value: 'low' }, { value: 'high' }], default: 'high' },
    },
    {
      value: 'glm-5.3',
      label: 'GLM-5.3',
      description: '能力均衡，适合日常使用。',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }],
        default: 'high',
      },
    },
    {
      value: 'glm-5.3-flash',
      label: 'GLM-5.3-Flash',
      description: 'GLM-5.3 快速版，低延迟，适合日常使用。',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }],
        default: 'high',
      },
    },
    {
      value: 'glm-5.2',
      label: 'GLM-5.2',
      description: '1M 上下文，擅长长程任务。',
      effort: { values: [{ value: 'high' }, { value: 'xhigh' }], default: 'high' },
    },
    {
      value: 'glm-5.1',
      label: 'GLM-5.1',
      description: '能力均衡，适合日常使用。',
    },
    {
      value: 'glm-5v-turbo',
      label: 'GLM-5v-Turbo',
      description: '原生多模态模型。',
    },
    {
      value: 'minimax-m3',
      label: 'MiniMax-M3',
      description: '原生多模态，擅长代码、智能体任务。',
    },
    {
      value: 'kimi-k3-1',
      label: 'Kimi-K3',
      description:
        '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }],
        default: 'high',
      },
    },
    {
      value: 'kimi-k2.7',
      label: 'Kimi-K2.7-Code',
      description: '多模态模型，适合日常任务。',
    },
    {
      value: 'kimi-k2.6',
      label: 'Kimi-K2.6',
      description: '多模态模型，适合日常任务。',
    },
    {
      value: 'deepseek-v4.1-flash',
      label: 'Deepseek-V4.1-Flash',
      description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口。',
      effort: { values: [{ value: 'high' }, { value: 'xhigh' }], default: 'high' },
    },
    {
      value: 'deepseek-v4-flash',
      label: 'Deepseek-V4-Flash',
      description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口。',
      effort: { values: [{ value: 'high' }, { value: 'xhigh' }], default: 'high' },
    },
    {
      value: 'deepseek-v4-pro',
      label: 'Deepseek-V4-Pro',
      description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口。',
      effort: { values: [{ value: 'high' }, { value: 'xhigh' }], default: 'high' },
    },
  ],
  DEFAULT: 'auto',
};

/** Provider registry model adapter for WorkBuddy, sourced from a curated static list. */
export class WorkbuddyProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return WORKBUDDY_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
