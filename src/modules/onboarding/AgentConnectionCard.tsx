import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { LLMProviderLogo } from '@/shared/ui';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types';

type AgentConnectionCardProps = {
  provider: LLMProvider;
  title: string;
  status: ProviderAuthStatus;
  connectedClassName: string;
  iconContainerClassName: string;
  loginButtonClassName: string;
  onLogin: () => void;
};

/** Rendered by onboarding's AgentConnectionsStep to show one CLI provider's connection state. */
export default function AgentConnectionCard({
  provider,
  title,
  status,
  connectedClassName,
  iconContainerClassName,
  loginButtonClassName,
  onLogin,
}: AgentConnectionCardProps) {
  const { t } = useTranslation('settings');
  // WorkBuddy Desktop manages its CLI auth out-of-band, so its own agent
  // (and the desktop CLIs it provisions, e.g. DeepSeek Harness / Codex)
  // count as available without an in-app login button.
  const externallyManaged = status.authVerified === false
    && status.installed === true
    && status.method === 'workbuddy_desktop';
  const available = status.authenticated || externallyManaged;
  // Pi's credentials live in its own `pi auth` flow, so the in-app login
  // button is only useful for the CLIs that accept an interactive login here.
  const canLogin = provider !== 'workbuddy' && provider !== 'pi' && !available && !status.loading;
  const containerClassName = available ? connectedClassName : 'border-border bg-card';

  const statusText = status.loading
    ? t('agents.authStatus.checking')
    : externallyManaged
      ? `${t('agents.externalAuth.available')} (${t('agents.externalAuth.managedByDesktop')})`
      : provider === 'workbuddy'
        ? t('agents.externalAuth.description', { agent: title })
        : provider === 'pi'
          ? t('agents.externalAuth.description', { agent: title })
          : status.authenticated
          ? status.email || t('agents.authStatus.connected')
          : status.error === 'Cursor CLI not found or not installed' || status.error === 'Cursor CLI is not installed'
            ? t('agents.errors.cursorCliNotFound')
            : status.error || t('agents.authStatus.notConnected');

  return (
    <div className={`rounded-xl border px-3 py-2.5 transition-colors ${containerClassName}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${iconContainerClassName}`}>
            <LLMProviderLogo provider={provider} className="h-5 w-5" />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {title}
              {available && <Check className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />}
            </div>
            <div className="truncate text-xs text-muted-foreground" title={statusText}>{statusText}</div>
          </div>
        </div>

        {canLogin && (
          <button
            onClick={onLogin}
            className={`${loginButtonClassName} flex-shrink-0 rounded-lg px-4 py-1.5 text-sm font-medium text-white transition-colors`}
          >
            {t('agents.login.button')}
          </button>
        )}
      </div>
    </div>
  );
}
