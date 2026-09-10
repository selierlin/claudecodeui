import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Activity, Archive, Check, ChevronDown, ChevronRight, Edit2, Folder, Loader2, MessageSquare, MoreHorizontal, Pin, PinOff, RotateCcw, Search, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Dialog, DialogContent, DialogTitle, LLMProviderLogo, ScrollArea } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { ArchivedProjectListItem, ArchivedSessionListItem, ConversationProjectResult, ConversationSearchResults, LLMProvider, Project, RecentConversationListItem, ReleaseInfo, SearchProgress, SessionTitleSearchResult, SidebarProjectListProps, SidebarSearchMode } from '@/shared/types';
import { formatCompactAge, getAllSessions } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { useCopyProviderSessionId } from '@/modules/sidebar/hooks/useCopyProviderSessionId';
import SidebarBatchSessionActions from '@/modules/sidebar/SidebarBatchSessionActions';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';
import SidebarHeader from '@/modules/sidebar/SidebarHeader';
import SidebarProjectList from '@/modules/sidebar/SidebarProjectList';
import SidebarRecentConversations from '@/modules/sidebar/SidebarRecentConversations';

function HighlightedSnippet({ snippet, highlights }: { snippet: string; highlights: { start: number; end: number }[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const h of highlights) {
    if (h.start > cursor) {
      parts.push(snippet.slice(cursor, h.start));
    }
    parts.push(
      <mark key={h.start} className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-800">
        {snippet.slice(h.start, h.end)}
      </mark>
    );
    cursor = h.end;
  }
  if (cursor < snippet.length) {
    parts.push(snippet.slice(cursor));
  }
  return (
    <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-muted-foreground">
      {parts}
    </span>
  );
}

const SEARCH_PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  dsh: 'DeepSeek Harness',
  workbuddy: 'WorkBuddy',
  pi: 'Pi',
};

/**
 * One session-title hit row, shared by the conversation-search title section
 * and the projects-mode id-lookup section. Clicking the body opens the
 * session; archived hits show a badge and a restore action.
 */
function ConversationTitleResultRow({
  session,
  currentTime,
  t,
  onOpen,
  onRestore,
  onRename,
  onTogglePinned,
  onDelete,
}: {
  session: SessionTitleSearchResult;
  currentTime: Date;
  t: TFunction;
  onOpen: (projectId: string | null, sessionId: string, provider: string, isArchived?: boolean) => void;
  onRestore?: (session: SessionTitleSearchResult) => void;
  onRename?: (sessionId: string, summary: string, provider: LLMProvider) => void;
  onTogglePinned?: (sessionId: string, isPinned: boolean) => void;
  onDelete?: (sessionId: string, sessionTitle: string, options?: { isArchived?: boolean }) => void;
}) {
  const age = formatCompactAge(session.lastActivity, currentTime);
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingName, setEditingName] = useState('');
  const providerLabel = SEARCH_PROVIDER_LABELS[session.provider] ?? session.provider;
  const {
    copyLabel,
    isCopyPending,
    CopyStateIcon,
    handleCopyAction,
    onOptionsOpen,
  } = useCopyProviderSessionId({ sessionId: session.sessionId, providerLabel, t });

  const startRename = () => {
    setIsEditing(true);
    setEditingName(session.sessionTitle);
  };

  const saveRename = () => {
    onRename?.(session.sessionId, editingName, session.provider as LLMProvider);
    setIsEditing(false);
    setEditingName('');
    setIsMobileOptionsOpen(false);
  };

  const cancelRename = () => {
    setIsEditing(false);
    setEditingName('');
  };

  const setMobileOpen = (open: boolean) => {
    setIsMobileOptionsOpen(open);
    onOptionsOpen(open);
    if (!open && isEditing) {
      cancelRename();
    }
  };

  const menuItems = session.isArchived
    ? [
        {
          key: 'copy',
          label: copyLabel,
          icon: CopyStateIcon,
          loading: isCopyPending,
          closeOnSelect: false,
          onSelect: handleCopyAction,
        },
        {
          key: 'restore',
          label: t('archived.restore', 'Restore session'),
          icon: RotateCcw,
          onSelect: () => onRestore?.(session),
        },
        ...(onDelete
          ? [{
              key: 'delete',
              label: t('sessions.deleteSession'),
              icon: Trash2,
              isDanger: true,
              showDividerBefore: true,
              onSelect: () => onDelete(session.sessionId, session.sessionTitle, { isArchived: true }),
            }]
          : []),
      ]
    : [
        ...(onTogglePinned
          ? [{
              key: 'pin',
              label: session.isPinned ? t('sessions.unpinSession') : t('sessions.pinSession'),
              icon: session.isPinned ? PinOff : Pin,
              onSelect: () => onTogglePinned(session.sessionId, !session.isPinned),
            }]
          : []),
        ...(onRename
          ? [{
              key: 'rename',
              label: t('sessions.renameSession'),
              icon: Edit2,
              onSelect: startRename,
            }]
          : []),
        {
          key: 'copy',
          label: copyLabel,
          icon: CopyStateIcon,
          loading: isCopyPending,
          closeOnSelect: false,
          onSelect: handleCopyAction,
        },
        ...(onDelete
          ? [{
              key: 'delete',
              label: t('sessions.archiveOrDeleteSession'),
              icon: Trash2,
              isDanger: true,
              showDividerBefore: true,
              onSelect: () => onDelete(session.sessionId, session.sessionTitle),
            }]
          : []),
      ];

  return (
    <div className="group relative">
      {/* Mobile */}
      <div className="md:hidden">
        <div className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent/60">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => onOpen(session.projectId, session.sessionId, session.provider, session.isArchived)}
          >
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-muted/60">
              <LLMProviderLogo provider={session.provider} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate text-[13px] font-normal leading-4 text-foreground">
                  {session.sessionTitle}
                </span>
                {session.isArchived && (
                  <span className="flex-shrink-0 rounded bg-muted px-1 py-px text-[9px] font-normal leading-3 text-muted-foreground">
                    {t('search.archivedBadge', 'Archived')}
                  </span>
                )}
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-3 text-muted-foreground">
                <span className="truncate">{session.projectDisplayName}</span>
                {age && (
                  <>
                    <span className="flex-shrink-0 text-muted-foreground/40">·</span>
                    <time className="flex-shrink-0 tabular-nums" dateTime={session.lastActivity ?? undefined}>
                      {age}
                    </time>
                  </>
                )}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label={t('sessions.sessionOptionsFor', { name: session.sessionTitle })}
            className="ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted active:scale-95"
            onClick={() => setMobileOpen(true)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>

        <Dialog open={isMobileOptionsOpen} onOpenChange={setMobileOpen}>
          <DialogContent
            aria-describedby="mobile-search-session-options-description"
            wrapperClassName="md:hidden"
            style={{ bottom: 'var(--keyboard-height, 0px)' }}
            animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
            className="bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
          >
            <DialogTitle>{t('sessions.sessionOptions')}</DialogTitle>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

            <div className="mb-4 flex items-center gap-3 px-1">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <LLMProviderLogo provider={session.provider} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground" title={session.sessionTitle}>
                  {session.sessionTitle}
                </p>
                <p id="mobile-search-session-options-description" className="text-xs text-muted-foreground">
                  {t('sessions.providerSession', { provider: providerLabel })}
                </p>
              </div>
            </div>

            {isEditing ? (
              <div className="mb-3 space-y-2">
                <label htmlFor={`mobile-search-rename-${session.sessionId}`} className="block px-1 text-xs font-medium text-muted-foreground">
                  {t('sessions.sessionName')}
                </label>
                <input
                  id={`mobile-search-rename-${session.sessionId}`}
                  type="text"
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') saveRename();
                  }}
                  className="w-full rounded-xl border-2 border-primary/40 bg-background px-3 py-3 text-foreground shadow-sm focus:border-primary focus:outline-none"
                  autoFocus
                  autoComplete="off"
                  style={{ fontSize: '16px' }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveRename}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-transform active:scale-95"
                  >
                    <Check className="h-5 w-5 flex-shrink-0" />
                    {t('actions.save')}
                  </button>
                  <button
                    type="button"
                    onClick={cancelRename}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-muted/35 px-4 py-3 text-sm font-medium text-foreground transition-colors active:bg-muted"
                  >
                    <X className="h-5 w-5 flex-shrink-0" />
                    {t('actions.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {!session.isArchived && (
                  <>
                    {onTogglePinned && (
                      <button
                        type="button"
                        onClick={() => onTogglePinned(session.sessionId, !session.isPinned)}
                        className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                      >
                        {session.isPinned ? <PinOff className="h-5 w-5 flex-shrink-0" /> : <Pin className="h-5 w-5 flex-shrink-0" />}
                        <span className="text-sm font-medium">
                          {session.isPinned ? t('sessions.unpinSession') : t('sessions.pinSession')}
                        </span>
                      </button>
                    )}
                    {onRename && (
                      <button
                        type="button"
                        onClick={startRename}
                        className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                      >
                        <Edit2 className="h-5 w-5 flex-shrink-0" />
                        <span className="text-sm font-medium">{t('sessions.renameSession')}</span>
                      </button>
                    )}
                  </>
                )}

                <button
                  type="button"
                  onClick={handleCopyAction}
                  disabled={isCopyPending}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                >
                  {isCopyPending ? (
                    <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <CopyStateIcon className="h-5 w-5 flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium">{copyLabel}</span>
                </button>

                {session.isArchived && onRestore && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOpen(false);
                      onRestore(session);
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-emerald-700 transition-colors active:bg-emerald-500/10 dark:text-emerald-300"
                  >
                    <RotateCcw className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">{t('archived.restore', 'Restore session')}</span>
                  </button>
                )}

                {session.isArchived && onDelete && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOpen(false);
                      onDelete(session.sessionId, session.sessionTitle, { isArchived: true });
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-red-600 transition-colors active:bg-red-500/10 dark:text-red-400"
                  >
                    <Trash2 className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">{t('sessions.deleteSession')}</span>
                  </button>
                )}

                {!session.isArchived && onDelete && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOpen(false);
                      onDelete(session.sessionId, session.sessionTitle);
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-red-600 transition-colors active:bg-red-500/10 dark:text-red-400"
                  >
                    <Trash2 className="h-5 w-5 flex-shrink-0" />
                    <span className="text-sm font-medium">{t('sessions.archiveOrDeleteSession')}</span>
                  </button>
                )}
              </div>
            )}

            {!isEditing && (
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="mb-3 mt-2 min-h-11 w-full rounded-xl text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
              >
                {t('actions.cancel')}
              </button>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Desktop */}
      <div className="hidden md:block">
        <div className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 pr-10 transition-colors hover:bg-accent/60">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpen(session.projectId, session.sessionId, session.provider, session.isArchived)}
          >
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-muted/60">
              <LLMProviderLogo provider={session.provider} className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate text-[13px] font-normal leading-4 text-foreground">
                  {session.sessionTitle}
                </span>
                {session.isArchived && (
                  <span className="flex-shrink-0 rounded bg-muted px-1 py-px text-[9px] font-normal leading-3 text-muted-foreground">
                    {t('search.archivedBadge', 'Archived')}
                  </span>
                )}
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-3 text-muted-foreground">
                <span className="truncate">{session.projectDisplayName}</span>
                {age && (
                  <>
                    <span className="flex-shrink-0 text-muted-foreground/40">·</span>
                    <time className="flex-shrink-0 tabular-nums" dateTime={session.lastActivity ?? undefined}>
                      {age}
                    </time>
                  </>
                )}
              </span>
            </span>
          </button>
        </div>

        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 transform items-center gap-1">
          {isEditing ? (
            <>
              <input
                type="text"
                value={editingName}
                onChange={(event) => setEditingName(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') saveRename();
                  else if (event.key === 'Escape') cancelRename();
                }}
                onClick={(event) => event.stopPropagation()}
                className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
              <button
                className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
                onClick={saveRename}
                title={t('tooltips.save')}
              >
                <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
              </button>
              <button
                className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                onClick={cancelRename}
                title={t('tooltips.cancel')}
              >
                <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
              </button>
            </>
          ) : (
            <ActionMenu
              label={t('sessions.sessionOptions')}
              ariaLabel={t('sessions.sessionOptionsFor', { name: session.sessionTitle })}
              icon={MoreHorizontal}
              iconOnly
              portal
              variant="ghost"
              size="icon"
              onOpenChange={onOptionsOpen}
              triggerClassName="h-7 w-7 text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100"
              menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
              header={(
                <div className="mb-1 border-b border-border px-3 py-2">
                  <p className="truncate text-xs font-medium text-foreground" title={session.sessionTitle}>
                    {session.sessionTitle}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t('sessions.providerSession', { provider: providerLabel })}
                  </p>
                </div>
              )}
              items={menuItems}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One conversation-content hit row: the summary plus matching message
 * snippets. The whole body opens the session, while the trailing "..." menu
 * offers copy/restore/delete so hits can be acted on in place.
 */
function ConversationContentResultRow({
  session,
  t,
  onOpen,
  onRestore,
  onDelete,
}: {
  session: ConversationProjectResult['sessions'][number];
  t: TFunction;
  onOpen: () => void;
  onRestore?: (sessionId: string) => void;
  onDelete?: (sessionId: string, sessionTitle: string, options?: { isArchived?: boolean }) => void;
}) {
  const provider = session.provider || session.matches[0]?.provider || 'claude';
  const providerLabel = SEARCH_PROVIDER_LABELS[provider] ?? provider;
  const {
    copyLabel,
    isCopyPending,
    CopyStateIcon,
    handleCopyAction,
    onOptionsOpen,
  } = useCopyProviderSessionId({ sessionId: session.sessionId, providerLabel, t });
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);

  const menuItems = session.isArchived
    ? [
        {
          key: 'copy',
          label: copyLabel,
          icon: CopyStateIcon,
          loading: isCopyPending,
          closeOnSelect: false,
          onSelect: handleCopyAction,
        },
        ...(onRestore
          ? [{
              key: 'restore',
              label: t('archived.restore', 'Restore session'),
              icon: RotateCcw,
              onSelect: () => onRestore(session.sessionId),
            }]
          : []),
        ...(onDelete
          ? [{
              key: 'delete',
              label: t('sessions.deleteSession'),
              icon: Trash2,
              isDanger: true,
              showDividerBefore: true,
              onSelect: () => onDelete(session.sessionId, session.sessionSummary, { isArchived: true }),
            }]
          : []),
      ]
    : [
        {
          key: 'copy',
          label: copyLabel,
          icon: CopyStateIcon,
          loading: isCopyPending,
          closeOnSelect: false,
          onSelect: handleCopyAction,
        },
        ...(onDelete
          ? [{
              key: 'delete',
              label: t('sessions.archiveOrDeleteSession'),
              icon: Trash2,
              isDanger: true,
              showDividerBefore: true,
              onSelect: () => onDelete(session.sessionId, session.sessionSummary),
            }]
          : []),
      ];

  const snippetBody = (
    <>
      <div className="mb-1 flex items-center gap-1.5">
        <MessageSquare className="h-3 w-3 flex-shrink-0 text-primary" />
        <span className="truncate text-xs font-normal text-foreground">
          {session.sessionSummary}
        </span>
        {session.isArchived && (
          <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-normal leading-3 text-muted-foreground">
            {t('search.archivedBadge', 'Archived')}
          </span>
        )}
        {session.provider && session.provider !== 'claude' && (
          <span className="flex-shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase text-muted-foreground">
            {session.provider}
          </span>
        )}
      </div>
      <div className="space-y-1 pl-4">
        {session.matches.map((match, idx) => (
          <div key={idx} className="flex items-start gap-1">
            <span className="mt-0.5 flex-shrink-0 text-[10px] font-normal uppercase text-muted-foreground/60">
              {match.role === 'user' ? 'U' : 'A'}
            </span>
            <HighlightedSnippet
              snippet={match.snippet}
              highlights={match.highlights}
            />
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div className="group relative">
      {/* Mobile */}
      <div className="md:hidden">
        <div className="flex items-start gap-1 rounded-lg px-2 py-2 hover:bg-accent/60">
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col text-left"
            onClick={onOpen}
          >
            {snippetBody}
          </button>
          <button
            type="button"
            aria-label={t('sessions.sessionOptionsFor', { name: session.sessionSummary })}
            className="ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted active:scale-95"
            onClick={() => setIsMobileOptionsOpen(true)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>

        <Dialog open={isMobileOptionsOpen} onOpenChange={setIsMobileOptionsOpen}>
          <DialogContent
            aria-describedby="mobile-search-content-options-description"
            wrapperClassName="md:hidden"
            style={{ bottom: 'var(--keyboard-height, 0px)' }}
            animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
            className="bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
          >
            <DialogTitle>{t('sessions.sessionOptions')}</DialogTitle>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

            <div className="mb-4 flex items-center gap-3 px-1">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <LLMProviderLogo provider={provider} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground" title={session.sessionSummary}>
                  {session.sessionSummary}
                </p>
                <p id="mobile-search-content-options-description" className="text-xs text-muted-foreground">
                  {t('sessions.providerSession', { provider: providerLabel })}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={handleCopyAction}
                disabled={isCopyPending}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
              >
                {isCopyPending ? (
                  <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
                ) : (
                  <CopyStateIcon className="h-5 w-5 flex-shrink-0" />
                )}
                <span className="text-sm font-medium">{copyLabel}</span>
              </button>

              {session.isArchived && onRestore && (
                <button
                  type="button"
                  onClick={() => {
                    setIsMobileOptionsOpen(false);
                    onRestore(session.sessionId);
                  }}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-emerald-700 transition-colors active:bg-emerald-500/10 dark:text-emerald-300"
                >
                  <RotateCcw className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">{t('archived.restore', 'Restore session')}</span>
                </button>
              )}

              {onDelete && (
                <button
                  type="button"
                  onClick={() => {
                    setIsMobileOptionsOpen(false);
                    onDelete(
                      session.sessionId,
                      session.sessionSummary,
                      session.isArchived ? { isArchived: true } : undefined,
                    );
                  }}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-red-600 transition-colors active:bg-red-500/10 dark:text-red-400"
                >
                  <Trash2 className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">
                    {session.isArchived ? t('sessions.deleteSession') : t('sessions.archiveOrDeleteSession')}
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setIsMobileOptionsOpen(false)}
                className="mb-3 mt-2 min-h-11 w-full rounded-xl text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
              >
                {t('actions.cancel')}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Desktop */}
      <div className="hidden md:block">
        <div className="flex items-start gap-1 rounded-md px-2 py-2 transition-colors hover:bg-accent/50">
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col text-left"
            onClick={onOpen}
          >
            {snippetBody}
          </button>
          <ActionMenu
            label={t('sessions.sessionOptions')}
            ariaLabel={t('sessions.sessionOptionsFor', { name: session.sessionSummary })}
            icon={MoreHorizontal}
            iconOnly
            portal
            variant="ghost"
            size="icon"
            onOpenChange={onOptionsOpen}
            triggerClassName="h-7 w-7 text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100"
            menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
            header={(
              <div className="mb-1 border-b border-border px-3 py-2">
                <p className="truncate text-xs font-medium text-foreground" title={session.sessionSummary}>
                  {session.sessionSummary}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t('sessions.providerSession', { provider: providerLabel })}
                </p>
              </div>
            )}
            items={menuItems}
          />
        </div>
      </div>
    </div>
  );
}

type ArchivedSessionGroup = {
  key: string;
  projectId: string | null;
  projectDisplayName: string;
  projectPath: string | null;
  isProjectArchived: boolean;
  sessions: ArchivedSessionListItem[];
  latestActivity: string | null;
};

/**
 * Groups archived sessions by project metadata so the archive view preserves
 * the same mental model as the active sidebar: projects first, then sessions.
 */
function groupArchivedSessionsByProject(sessions: ArchivedSessionListItem[]): ArchivedSessionGroup[] {
  const groups = new Map<string, ArchivedSessionGroup>();

  for (const session of sessions) {
    const key = session.projectId ?? session.projectPath ?? `session:${session.sessionId}`;
    const existingGroup = groups.get(key);

    if (existingGroup) {
      existingGroup.sessions.push(session);
      if (!existingGroup.latestActivity || (session.lastActivity && session.lastActivity > existingGroup.latestActivity)) {
        existingGroup.latestActivity = session.lastActivity;
      }
      continue;
    }

    groups.set(key, {
      key,
      projectId: session.projectId,
      projectDisplayName: session.projectDisplayName,
      projectPath: session.projectPath,
      isProjectArchived: session.isProjectArchived,
      sessions: [session],
      latestActivity: session.lastActivity,
    });
  }

  return [...groups.values()].sort((groupA, groupB) => {
    const a = groupA.latestActivity ?? '';
    const b = groupB.latestActivity ?? '';
    return b.localeCompare(a);
  });
}

// New searches start with every project group collapsed so a broad query does
// not dump every match on screen; the user expands a group to see its hits.
const DEFAULT_SEARCH_GROUPS_EXPANDED = false;

type SidebarContentProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projects: Project[];
  runningSessionsCount: number;
  archivedProjects: ArchivedProjectListItem[];
  archivedSessions: ArchivedSessionListItem[];
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  recentConversations: RecentConversationListItem[];
  recentConversationsTotal: number;
  recentConversationsHasMore: boolean;
  isRecentConversationsLoading: boolean;
  isLoadingMoreRecentConversations: boolean;
  recentConversationsError: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  conversationResults: ConversationSearchResults | null;
  isSearching: boolean;
  searchProgress: SearchProgress | null;
  onRestoreArchivedProject: (projectId: string) => void;
  onLoadMoreRecentConversations: () => void;
  onRetryRecentConversations: () => void;
  onArchivedSessionClick: (session: ArchivedSessionListItem) => void;
  onRestoreArchivedSession: (sessionId: string) => void;
  onDeleteArchivedSession: (session: ArchivedSessionListItem) => void;
  // Conversation result clicks pass back the DB projectId (or null when the
  // server couldn't resolve it). Consumers must handle the null case.
  onConversationResultClick: (projectId: string | null, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null, isArchived?: boolean) => void;
  /** Renames a session reached from the recent-conversations list. */
  onRenameRecentSession: (sessionId: string, summary: string, provider: LLMProvider) => void;
  onToggleSessionPinned: (sessionId: string, isPinned: boolean) => void;
  onRequestBatchArchive: (sessionIds: string[], onCompleted: (archivedSessionIds: string[]) => void) => void;
  onRequestBatchPermanentDelete: (sessionIds: string[], onCompleted: (deletedSessionIds: string[]) => void) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  projectListProps: SidebarProjectListProps;
  t: TFunction;
};

/** Rendered by Sidebar as the expanded panel body: header, project list, conversation/archive search results, recent conversations and footer. */
export default function SidebarContent({
  isPWA,
  isMobile,
  isLoading,
  projects,
  runningSessionsCount,
  archivedProjects,
  archivedSessions,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  recentConversations,
  recentConversationsTotal,
  recentConversationsHasMore,
  isRecentConversationsLoading,
  isLoadingMoreRecentConversations,
  recentConversationsError,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  conversationResults,
  isSearching,
  searchProgress,
  onRestoreArchivedProject,
  onLoadMoreRecentConversations,
  onRetryRecentConversations,
  onArchivedSessionClick,
  onRestoreArchivedSession,
  onDeleteArchivedSession,
  onConversationResultClick,
  onRenameRecentSession,
  onToggleSessionPinned,
  onRequestBatchArchive,
  onRequestBatchPermanentDelete,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  onShowSettings,
  updateAvailable,
  restartRequired,
  releaseInfo,
  latestVersion,
  onShowVersionModal,
  projectListProps,
  t,
}: SidebarContentProps) {
  const showConversationSearch = searchMode === 'conversations' && searchFilter.trim().length >= 2;

  // Conversation search results stay frozen until the next query lands. Track
  // sessions restored from the results list so their rows drop out immediately
  // instead of lingering with a stale archived badge.
  const [restoredSearchSessionIds, setRestoredSearchSessionIds] = useState<Set<string>>(new Set());
  const visibleTitleResults = conversationResults
    ? conversationResults.titleResults.filter((session) => !restoredSearchSessionIds.has(session.sessionId))
    : [];
  // Restored hits drop out of both search-hit sections (conversation titles
  // and content groups) locally; the restore callback refreshes the active and
  // archived lists behind the scenes.
  const visibleResults = conversationResults
    ? conversationResults.results
        .map((project) => ({
          ...project,
          sessions: project.sessions.filter((session) => !restoredSearchSessionIds.has(session.sessionId)),
        }))
        .filter((project) => project.sessions.length > 0)
    : [];
  // Shared by both search-hit sections (conversation titles and the
  // projects-mode id lookup): the row drops out locally and the restore
  // callback refreshes the active and archived lists.
  const restoreSearchHit = useCallback((session: SessionTitleSearchResult) => {
    setRestoredSearchSessionIds((previous) => new Set(previous).add(session.sessionId));
    onRestoreArchivedSession(session.sessionId);
  }, [onRestoreArchivedSession]);
  const restoreContentSearchHit = useCallback((sessionId: string) => {
    setRestoredSearchSessionIds((previous) => new Set(previous).add(sessionId));
    onRestoreArchivedSession(sessionId);
  }, [onRestoreArchivedSession]);

  const hasSearchResults = Boolean(
    conversationResults
      && ((visibleTitleResults.length > 0) || visibleResults.length > 0),
  );
  const groupedArchivedSessions = groupArchivedSessionsByProject(archivedSessions);
  const visibleArchivedItemsCount = archivedProjects.length + archivedSessions.length;
  const isRenamingOnMobile = isMobile && projectListProps.activeRename !== null;

  // Manage mode for the archive lets the user permanently delete a selection of
  // standalone archived sessions (those whose project is not itself archived,
  // i.e. the ones rendered as per-session rows rather than project cards).
  const [isManagingArchivedSessions, setIsManagingArchivedSessions] = useState(false);
  const [selectedArchivedSessionIds, setSelectedArchivedSessionIds] = useState<Set<string>>(new Set());
  const batchDeletableArchivedSessionIds = archivedSessions
    .filter((session) => !session.isProjectArchived)
    .map((session) => session.sessionId);
  const areAllArchivedSessionsSelected = batchDeletableArchivedSessionIds.length > 0
    && batchDeletableArchivedSessionIds.every((sessionId) => selectedArchivedSessionIds.has(sessionId));

  // Permanent deletes remove the on-disk history, so drop ids the moment the
  // backing list no longer offers them (e.g. a restore lands while in manage).
  // Returning `current` untouched when nothing changed lets React skip a render.
  useEffect(() => {
    setSelectedArchivedSessionIds((current) => {
      if (current.size === 0) {
        return current;
      }
      const deletableSessionIdSet = new Set(
        archivedSessions
          .filter((session) => !session.isProjectArchived)
          .map((session) => session.sessionId),
      );
      const next = new Set([...current].filter((sessionId) => deletableSessionIdSet.has(sessionId)));
      return next.size === current.size ? current : next;
    });
  }, [archivedSessions]);

  const toggleArchivedSessionSelection = (sessionId: string) => {
    setSelectedArchivedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const toggleAllArchivedSessionSelections = () => {
    setSelectedArchivedSessionIds(
      areAllArchivedSessionsSelected ? new Set() : new Set(batchDeletableArchivedSessionIds),
    );
  };

  const exitArchivedSessionManagement = () => {
    setIsManagingArchivedSessions(false);
    setSelectedArchivedSessionIds(new Set());
  };

  const requestBatchPermanentDelete = () => {
    onRequestBatchPermanentDelete([...selectedArchivedSessionIds], (deletedSessionIds) => {
      const deletedSessionIdSet = new Set(deletedSessionIds);
      setSelectedArchivedSessionIds((current) => new Set(
        [...current].filter((sessionId) => !deletedSessionIdSet.has(sessionId)),
      ));
      if (deletedSessionIds.length === selectedArchivedSessionIds.size) {
        setIsManagingArchivedSessions(false);
      }
    });
  };

  // Expand/collapse for the conversation-content search results. The overrides
  // set records only the project groups the user flipped against the default;
  // it resets on every new query or search-mode change.
  const [searchGroupOverrides, setSearchGroupOverrides] = useState<Set<string>>(new Set());
  const [expandedArchivedGroupKeys, setExpandedArchivedGroupKeys] = useState<Set<string>>(new Set());
  const searchProjectKeys = visibleResults.map(
    (projectResult) => projectResult.projectId ?? projectResult.projectName,
  );
  const isSearchGroupExpanded = (projectKey: string): boolean => (
    DEFAULT_SEARCH_GROUPS_EXPANDED
      ? !searchGroupOverrides.has(projectKey)
      : searchGroupOverrides.has(projectKey)
  );
  const allSearchGroupsExpanded = searchProjectKeys.length > 0
    && searchProjectKeys.every((projectKey) => isSearchGroupExpanded(projectKey));

  useEffect(() => {
    setSearchGroupOverrides(new Set());
  }, [conversationResults?.query, searchMode]);

  const toggleSearchGroup = (projectKey: string) => {
    setSearchGroupOverrides((previous) => {
      const next = new Set(previous);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  };
  const expandAllSearchGroups = () => {
    setSearchGroupOverrides(DEFAULT_SEARCH_GROUPS_EXPANDED ? new Set() : new Set(searchProjectKeys));
  };
  const collapseAllSearchGroups = () => {
    setSearchGroupOverrides(DEFAULT_SEARCH_GROUPS_EXPANDED ? new Set(searchProjectKeys) : new Set());
  };

  // Expand/collapse for the archive cards. Each archived project or standalone
  // group of archived sessions is one key; they start collapsed.
  const archivedGroupKeys = [
    ...archivedProjects.map((project) => `project:${project.projectId}`),
    ...groupedArchivedSessions.map((group) => `sessions:${group.key}`),
  ];
  const areAllArchivedGroupsExpanded = archivedGroupKeys.length > 0
    && archivedGroupKeys.every((groupKey) => expandedArchivedGroupKeys.has(groupKey));
  const toggleArchivedGroup = (groupKey: string) => {
    setExpandedArchivedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };
  const toggleAllArchivedGroups = () => {
    setExpandedArchivedGroupKeys(
      areAllArchivedGroupsExpanded ? new Set() : new Set(archivedGroupKeys),
    );
  };

  return (
    <div
      className="flex h-full flex-col bg-background/80 backdrop-blur-sm md:w-72 md:select-none"
      style={{}}
    >
      <SidebarHeader
        isPWA={isPWA}
        isMobile={isMobile}
        isLoading={isLoading}
        projectsCount={projects.length}
        runningSessionsCount={runningSessionsCount}
        archivedSessionsCount={archivedSessionsCount}
        isArchivedSessionsLoading={isArchivedSessionsLoading}
        searchFilter={searchFilter}
        onSearchFilterChange={onSearchFilterChange}
        onClearSearchFilter={onClearSearchFilter}
        searchMode={searchMode}
        onSearchModeChange={onSearchModeChange}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onCreateProject={onCreateProject}
        onCollapseSidebar={onCollapseSidebar}
        onShowSettings={onShowSettings}
        t={t}
      />

      <ScrollArea className="flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2">
        {showConversationSearch ? (
          isSearching && !conversationResults ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              </div>
              <p className="text-sm text-muted-foreground">{t('search.searching')}</p>
              {searchProgress && (
                <p className="mt-1 text-xs text-muted-foreground/60">
                  {t('search.projectsScanned', { count: searchProgress.scannedProjects })}/{searchProgress.totalProjects}
                </p>
              )}
            </div>
          ) : !isSearching && conversationResults && !hasSearchResults ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('search.noResults')}</h3>
              <p className="text-sm text-muted-foreground">{t('search.tryDifferentQuery')}</p>
            </div>
          ) : conversationResults && (hasSearchResults || isSearching) ? (
            <div className="space-y-4 px-2" aria-live="polite">
              {visibleTitleResults.length > 0 && (
                <section className="space-y-1" aria-labelledby="session-title-results-heading">
                  <div className="flex items-center justify-between px-1 py-0.5">
                    <h3
                      id="session-title-results-heading"
                      className="text-[11px] font-medium text-muted-foreground"
                    >
                      {t('search.sessionTitles', 'Session')}
                    </h3>
                    <span className="text-[10px] tabular-nums text-muted-foreground/70">
                      {visibleTitleResults.length}
                    </span>
                  </div>

                  {visibleTitleResults.map((session) => (
                    <ConversationTitleResultRow
                      key={`${session.provider}-${session.sessionId}`}
                      session={session}
                      currentTime={projectListProps.currentTime}
                      t={t}
                      onOpen={(projectId, sessionId, provider, isArchived) =>
                        onConversationResultClick(projectId, sessionId, provider, undefined, undefined, isArchived)
                      }
                      onRestore={restoreSearchHit}
                      onRename={onRenameRecentSession}
                      onTogglePinned={onToggleSessionPinned}
                      onDelete={projectListProps.onDeleteSession}
                    />
                  ))}
                </section>
              )}

              {(visibleResults.length > 0 || isSearching) && (
                <section className="space-y-3" aria-labelledby="conversation-content-results-heading">
                  <div className="flex items-center justify-between px-1 py-0.5">
                    <h3
                      id="conversation-content-results-heading"
                      className="text-[11px] font-medium text-muted-foreground"
                    >
                      {t('search.conversationContents', 'Conversation contents')}
                    </h3>
                    <div className="flex items-center gap-2">
                      {searchProjectKeys.length > 0 && (
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
                          onClick={() => (
                            allSearchGroupsExpanded
                              ? collapseAllSearchGroups()
                              : expandAllSearchGroups()
                          )}
                        >
                          {allSearchGroupsExpanded
                            ? t('search.collapseAll', 'Collapse all')
                            : t('search.expandAll', 'Expand all')}
                        </button>
                      )}
                      <span className="text-[10px] tabular-nums text-muted-foreground/70">
                        {t('search.matches', { count: conversationResults.totalMatches })}
                      </span>
                    </div>
                  </div>

                  {isSearching && searchProgress && (
                    <div className="space-y-1.5 px-1">
                      <div className="flex items-center justify-end gap-1.5">
                        <div className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-primary" />
                        <p className="text-[10px] text-muted-foreground/60">
                          {searchProgress.scannedProjects}/{searchProgress.totalProjects}
                        </p>
                      </div>
                      <div className="h-0.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/60 transition-all duration-300"
                          style={{
                            width: `${searchProgress.totalProjects > 0
                              ? Math.round((searchProgress.scannedProjects / searchProgress.totalProjects) * 100)
                              : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {visibleResults.map((projectResult) => {
                    const projectKey = projectResult.projectId ?? projectResult.projectName;
                    const groupExpanded = isSearchGroupExpanded(projectKey);

                    return (
                      <div key={projectResult.projectName} className="space-y-1">
                        <button
                          type="button"
                          className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/40"
                          onClick={() => toggleSearchGroup(projectKey)}
                          aria-expanded={groupExpanded}
                        >
                          {groupExpanded ? (
                            <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                          )}
                          <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs font-normal text-foreground">
                            {projectResult.projectDisplayName}
                          </span>
                          <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                            {projectResult.sessions.length}
                          </span>
                        </button>

                        {groupExpanded && projectResult.sessions.map((session) => (
                          <ConversationContentResultRow
                            key={`${projectResult.projectId ?? projectResult.projectName}-${session.sessionId}`}
                            session={session}
                            t={t}
                            onOpen={() => onConversationResultClick(
                              // Pass the DB projectId (preferred) so the parent can
                              // cross-reference with the loaded projects list.
                              projectResult.projectId,
                              session.sessionId,
                              session.provider || session.matches[0]?.provider || 'claude',
                              session.matches[0]?.timestamp,
                              session.matches[0]?.snippet,
                              session.isArchived
                            )}
                            onRestore={restoreContentSearchHit}
                            onDelete={projectListProps.onDeleteSession}
                          />
                        ))}
                      </div>
                    );
                  })}
                </section>
              )}
            </div>
          ) : null
        ) : searchMode === 'conversations' ? (
          <SidebarRecentConversations
            conversations={recentConversations}
            total={recentConversationsTotal}
            hasMore={recentConversationsHasMore}
            isLoading={isRecentConversationsLoading}
            isLoadingMore={isLoadingMoreRecentConversations}
            hasError={recentConversationsError}
            selectedSession={projectListProps.selectedSession}
            activeSessions={projectListProps.activeSessions}
            currentTime={projectListProps.currentTime}
            onConversationSelect={onConversationResultClick}
            onLoadMore={onLoadMoreRecentConversations}
            onRetry={onRetryRecentConversations}
            onRenameSession={onRenameRecentSession}
            onTogglePinned={onToggleSessionPinned}
            onDeleteSession={projectListProps.onDeleteSession}
            onRequestBatchArchive={onRequestBatchArchive}
            t={t}
          />
        ) : searchMode === 'running' ? (
          projectListProps.filteredProjects.length === 0 ? (
            <div className="px-4 py-12 text-center md:py-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border/70 bg-muted/50 md:mb-3">
                <Activity className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
                {t('running.emptyTitle', 'No sessions running')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {runningSessionsCount > 0
                  ? t('running.noMatchingSessions', 'No running sessions match this search.')
                  : t('running.emptyDescription', 'Active work will appear here while a provider is processing.')}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="mx-2 flex items-center justify-between rounded-lg border border-border/60 bg-card/50 px-3 py-2 shadow-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <Activity className="h-3.5 w-3.5" />
                  </span>
                  <span className="truncate text-xs font-normal text-foreground">
                    {t('running.title', 'Running now')}
                  </span>
                </div>
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-normal text-emerald-700 dark:text-emerald-300">
                  {runningSessionsCount}
                </span>
              </div>
              <SidebarProjectList {...projectListProps} />
            </div>
          )
        ) : searchMode === 'archived' ? (
          isArchivedSessionsLoading ? (
            <div className="space-y-2 px-2 py-1" aria-live="polite" aria-busy="true">
              <div className="flex items-center gap-2 px-1 py-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted/70">
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/40 border-t-muted-foreground" />
                </div>
                <div>
                  <h3 className="text-xs font-medium text-foreground">
                    {t('archived.loadingTitle', 'Loading archive...')}
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {t('archived.loadingDescription', 'Fetching hidden workspaces and sessions you can restore later.')}
                  </p>
                </div>
              </div>
              {[0, 1].map((skeleton) => (
                <div key={skeleton} className="animate-pulse rounded-xl border border-border/50 bg-card/40 p-3">
                  <div className="flex items-center gap-2.5">
                    <div className="h-8 w-8 rounded-lg bg-muted" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="h-3 w-2/3 rounded bg-muted" />
                      <div className="h-2.5 w-5/6 rounded bg-muted/70" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : archivedProjects.length === 0 && groupedArchivedSessions.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <div className="mx-auto max-w-[240px] rounded-2xl border border-dashed border-border/80 bg-muted/20 px-5 py-7">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-background shadow-sm">
                  <Archive className="h-[18px] w-[18px] text-muted-foreground" />
                </div>
                <h3 className="text-sm font-medium text-foreground">
                  {archivedSessionsCount > 0
                    ? t('archived.noMatchingSessions', 'No matching archived items')
                    : t('archived.emptyTitle', 'No archived items')}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {archivedSessionsCount > 0
                    ? t('archived.tryDifferentSearch', 'Try a different search term.')
                    : t('archived.emptyDescription', 'Archived workspaces and sessions will appear here when you hide them from the active list.')}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5 px-2 pb-3">
              <div className="flex items-center justify-between px-1 pb-0.5 pt-0.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                    <Archive className="h-3.5 w-3.5" />
                  </span>
                  <div>
                    <h2 className="text-xs font-medium leading-none text-foreground">
                      {t('archived.title', 'Archive')}
                    </h2>
                    <p className="mt-1 text-[10px] leading-none text-muted-foreground">
                      {t('archived.restoreHint', 'Restore items whenever you need them')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground"
                    title={visibleArchivedItemsCount !== archivedSessionsCount
                      ? `${visibleArchivedItemsCount} of ${archivedSessionsCount}`
                      : undefined}
                  >
                    {visibleArchivedItemsCount !== archivedSessionsCount
                      ? `${visibleArchivedItemsCount}/${archivedSessionsCount}`
                      : archivedSessionsCount}
                  </span>
                  {archivedGroupKeys.length > 1 && (
                    <button
                      type="button"
                      className="h-7 rounded-md px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={toggleAllArchivedGroups}
                    >
                      {areAllArchivedGroupsExpanded ? t('archived.collapseAll') : t('archived.expandAll')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="h-7 rounded-md px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={batchDeletableArchivedSessionIds.length === 0 && !isManagingArchivedSessions}
                    onClick={() => (
                      isManagingArchivedSessions
                        ? exitArchivedSessionManagement()
                        : setIsManagingArchivedSessions(true)
                    )}
                  >
                    {isManagingArchivedSessions ? t('actions.cancel') : t('archived.manageSessions')}
                  </button>
                </div>
              </div>
              {archivedProjects.map((project) => {
                const projectSessions = getAllSessions(project);
                const groupKey = `project:${project.projectId}`;
                const isExpanded = expandedArchivedGroupKeys.has(groupKey);

                return (
                  <section
                    key={project.projectId}
                    className="group/archive overflow-hidden rounded-xl border border-border/70 bg-card/45 shadow-[0_1px_0_hsl(var(--border)/0.2)] transition-colors hover:border-border"
                  >
                    <div className="flex items-center gap-1.5 px-1.5 py-1.5">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => toggleArchivedGroup(groupKey)}
                        aria-expanded={isExpanded}
                        aria-label={isExpanded
                          ? t('archived.collapseSessions', 'Collapse sessions')
                          : t('archived.expandSessions', 'Expand sessions')}
                      >
                        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/45 text-muted-foreground">
                          <Folder className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium text-foreground">
                              {project.displayName}
                            </span>
                            {projectSessions.length > 0 && (
                              <span className="flex-shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[9px] tabular-nums text-muted-foreground">
                                {projectSessions.length}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/70" title={project.fullPath}>
                            {project.fullPath}
                          </span>
                        </span>
                        <span aria-hidden className="flex flex-shrink-0 items-center justify-center text-muted-foreground">
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </span>
                      </button>
                      <button
                        className="flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg border border-emerald-600/15 bg-emerald-500/10 px-2 text-[10px] font-medium text-emerald-700 transition-all hover:border-emerald-600/25 hover:bg-emerald-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:text-emerald-300"
                        onClick={() => onRestoreArchivedProject(project.projectId)}
                        title={t('archived.restoreProject', 'Restore workspace')}
                        aria-label={`${t('archived.restoreProject', 'Restore workspace')}: ${project.displayName}`}
                      >
                        <RotateCcw className="h-3 w-3" />
                        {t('archived.restoreAction', 'Restore')}
                      </button>
                    </div>
                    {isExpanded && projectSessions.length > 0 && (
                      <div className="border-t border-border/45 bg-muted/[0.08]">
                        {projectSessions.map((session) => (
                          <button
                            key={String(session.id)}
                            className="flex w-full items-center gap-2.5 border-b border-border/35 px-2.5 py-2 text-left transition-colors last:border-b-0 hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            onClick={() => onArchivedSessionClick({
                              sessionId: String(session.id),
                              provider: session.__provider,
                              projectId: project.projectId,
                              projectPath: project.fullPath,
                              projectDisplayName: project.displayName,
                              sessionTitle:
                                (typeof session.summary === 'string' && session.summary.trim().length > 0
                                  ? session.summary
                                  : typeof session.name === 'string' && session.name.trim().length > 0
                                    ? session.name
                                    : String(session.id)),
                              createdAt: typeof session.created_at === 'string' ? session.created_at : null,
                              updatedAt: typeof session.updated_at === 'string' ? session.updated_at : null,
                              lastActivity:
                                typeof session.lastActivity === 'string'
                                  ? session.lastActivity
                                  : typeof session.updated_at === 'string'
                                    ? session.updated_at
                                    : typeof session.created_at === 'string'
                                      ? session.created_at
                                      : null,
                              isProjectArchived: true,
                            })}
                          >
                            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-background/70">
                              <LLMProviderLogo provider={session.__provider} className="h-3.5 w-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs text-foreground">
                                {(typeof session.summary === 'string' && session.summary.trim().length > 0
                                  ? session.summary
                                  : typeof session.name === 'string' && session.name.trim().length > 0
                                    ? session.name
                                    : String(session.id))}
                              </p>
                              <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                                <span className="uppercase tracking-wide">{session.__provider}</span>
                                <span aria-hidden>·</span>
                                <span className="tabular-nums">
                                  {formatCompactAge(
                                    typeof session.lastActivity === 'string'
                                      ? session.lastActivity
                                      : typeof session.updated_at === 'string'
                                        ? session.updated_at
                                        : typeof session.created_at === 'string'
                                          ? session.created_at
                                          : null,
                                    projectListProps.currentTime,
                                  )}
                                </span>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              {groupedArchivedSessions.map((group) => {
                const groupKey = `sessions:${group.key}`;
                const isExpanded = expandedArchivedGroupKeys.has(groupKey);

                return (
                <section
                  key={group.key}
                  className="group/archive overflow-hidden rounded-xl border border-border/70 bg-card/45 shadow-[0_1px_0_hsl(var(--border)/0.2)] transition-colors hover:border-border"
                >
                  <div className="flex items-center gap-1.5 px-1.5 py-1.5">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => toggleArchivedGroup(groupKey)}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded
                        ? t('archived.collapseSessions', 'Collapse sessions')
                        : t('archived.expandSessions', 'Expand sessions')}
                    >
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/45 text-muted-foreground">
                        <Archive className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-foreground">
                            {group.projectDisplayName}
                          </span>
                          <span className="flex-shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[9px] tabular-nums text-muted-foreground">
                            {t('archived.sessionCount', { count: group.sessions.length })}
                          </span>
                        </span>
                        {group.projectPath && (
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/70" title={group.projectPath}>
                            {group.projectPath}
                          </span>
                        )}
                      </span>
                      <span aria-hidden className="flex flex-shrink-0 items-center justify-center text-muted-foreground">
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </span>
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-border/45 bg-muted/[0.08]">
                      {group.sessions.map((session) => {
                      const canBatchDelete = !session.isProjectArchived;
                      const isBatchSelected = selectedArchivedSessionIds.has(session.sessionId);

                      return (
                        <div
                          key={session.sessionId}
                          className={cn(
                            'group/session flex items-center gap-1 border-b border-border/35 px-2.5 py-2 last:border-b-0 hover:bg-accent/35',
                            isManagingArchivedSessions && canBatchDelete && 'cursor-pointer',
                          )}
                        >
                          <button
                            className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => {
                              if (isManagingArchivedSessions && canBatchDelete) {
                                toggleArchivedSessionSelection(session.sessionId);
                                return;
                              }
                              onArchivedSessionClick(session);
                            }}
                          >
                            {isManagingArchivedSessions && canBatchDelete && (
                              <span
                                role="checkbox"
                                aria-checked={isBatchSelected}
                                aria-label={t('sessions.selectSession', { name: session.sessionTitle })}
                                className={cn(
                                  'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors',
                                  isBatchSelected
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-muted-foreground/40 bg-background',
                                )}
                              >
                                {isBatchSelected && <Check className="h-3 w-3" />}
                              </span>
                            )}
                            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-background/70">
                              <LLMProviderLogo provider={session.provider} className="h-3.5 w-3.5" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs text-foreground">
                                {session.sessionTitle}
                              </p>
                              <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                                <span className="uppercase tracking-wide">{session.provider}</span>
                                {session.lastActivity && (
                                  <>
                                    <span aria-hidden>·</span>
                                    <span className="tabular-nums">
                                      {formatCompactAge(session.lastActivity, projectListProps.currentTime)}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          </button>
                          {!isManagingArchivedSessions && (
                            <div className="flex flex-shrink-0 items-center gap-0.5">
                              <button
                                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-emerald-500/10 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:hover:text-emerald-300"
                                onClick={() => onRestoreArchivedSession(session.sessionId)}
                                title={t('archived.restore', 'Restore session')}
                                aria-label={`${t('archived.restore', 'Restore session')}: ${session.sessionTitle}`}
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                              <button
                                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
                                onClick={() => onDeleteArchivedSession(session)}
                                title={t('archived.deletePermanently', 'Delete permanently')}
                                aria-label={`${t('archived.deletePermanently', 'Delete permanently')}: ${session.sessionTitle}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    </div>
                  )}
                </section>
              );})}
              {isManagingArchivedSessions && (
                <SidebarBatchSessionActions
                  selectedCount={selectedArchivedSessionIds.size}
                  selectableCount={batchDeletableArchivedSessionIds.length}
                  areAllSelected={areAllArchivedSessionsSelected}
                  onToggleSelectAll={toggleAllArchivedSessionSelections}
                  onArchive={requestBatchPermanentDelete}
                  onCancel={exitArchivedSessionManagement}
                  permanentDelete
                  t={t}
                />
              )}
            </div>
          )
        ) : (
          <SidebarProjectList {...projectListProps} />
        )}
      </ScrollArea>

      {!isRenamingOnMobile && (
        <SidebarFooter
          updateAvailable={updateAvailable}
          restartRequired={restartRequired}
          releaseInfo={releaseInfo}
          latestVersion={latestVersion}
          onShowVersionModal={onShowVersionModal}
          t={t}
        />
      )}
    </div>
  );
}
