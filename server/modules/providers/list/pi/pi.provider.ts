import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { PiProviderAuth } from '@/modules/providers/list/pi/pi-auth.provider.js';
import { PiProviderModels } from '@/modules/providers/list/pi/pi-models.provider.js';
import { PiMcpProvider } from '@/modules/providers/list/pi/pi-mcp.provider.js';
import { piRuntime } from '@/modules/providers/list/pi/pi-runtime.provider.js';
import { PiSessionSynchronizer } from '@/modules/providers/list/pi/pi-session-synchronizer.provider.js';
import { PiSessionsProvider } from '@/modules/providers/list/pi/pi-sessions.provider.js';
import { PiSkillsProvider } from '@/modules/providers/list/pi/pi-skills.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class PiProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = piRuntime;
  readonly models: IProviderModels = new PiProviderModels();
  readonly mcp = new PiMcpProvider();
  readonly auth: IProviderAuth = new PiProviderAuth();
  readonly skills: IProviderSkills = new PiSkillsProvider();
  readonly sessions: IProviderSessions = new PiSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new PiSessionSynchronizer();

  constructor() {
    super('pi');
  }
}
