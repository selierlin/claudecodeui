import { LLMProviderLogo, PillBar, Pill } from '@/shared/ui';
import type { AgentContextByProvider, AgentProvider } from '@/shared/types';

type AgentSelectorSectionProps = {
  agents: AgentProvider[];
  selectedAgent: AgentProvider;
  onSelectAgent: (agent: AgentProvider) => void;
  agentContextById: AgentContextByProvider;
};

const AGENT_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  dsh: 'DeepSeek Harness',
  workbuddy: 'WorkBuddy',
  pi: 'Pi',
};

/** Rendered by AgentsSettingsTab to pick which agent provider the tab is configuring. */
export default function AgentSelectorSection({
  agents,
  selectedAgent,
  onSelectAgent,
  agentContextById,
}: AgentSelectorSectionProps) {
  return (
    <div className="flex-shrink-0 border-b border-border px-3 py-2 md:px-4 md:py-3">
      {/* Wraps instead of scrolling horizontally so every agent stays visible on both mobile and desktop */}
      <PillBar className="w-full flex-wrap">
        {agents.map((agent) => {
          const dotColor =
            agent === 'claude' ? 'bg-blue-500' :
            agent === 'cursor' ? 'bg-purple-500' :
            agent === 'opencode' ? 'bg-zinc-500' : 'bg-foreground/60';

          return (
            <Pill
              key={agent}
              isActive={selectedAgent === agent}
              onClick={() => onSelectAgent(agent)}
              className="flex-shrink-0"
            >
              <LLMProviderLogo provider={agent} className="h-4 w-4 flex-shrink-0" />
              <span>{AGENT_NAMES[agent]}</span>
              {(agentContextById[agent].authStatus.authenticated
                || (agentContextById[agent].authStatus.authVerified === false
                  && agentContextById[agent].authStatus.installed === true
                  && agentContextById[agent].authStatus.method === 'workbuddy_desktop')) && (
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotColor}`} />
              )}
            </Pill>
          );
        })}
      </PillBar>
    </div>
  );
}
