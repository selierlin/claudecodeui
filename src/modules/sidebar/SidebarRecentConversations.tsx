import { useEffect, useState } from 'react';
import { Check, ChevronRight, Edit2, Loader2, MessageSquare, MoreHorizontal, Pin, PinOff, Trash2, X } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { TFunction } from 'i18next';

import { ActionMenu, Button, Dialog, DialogContent, DialogTitle, LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, ProjectSession, RecentConversationListItem } from '@/shared/types';
import { formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { useCopyProviderSessionId } from '@/modules/sidebar/hooks/useCopyProviderSessionId';
import SidebarBatchSessionActions from '@/modules/sidebar/SidebarBatchSessionActions';

type SidebarRecentConversationsProps = {
  conversations: RecentConversationListItem[];
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasError: boolean;
  selectedSession: ProjectSession | null;
  activeSessions: ReadonlySet<string>;
  currentTime: Date;
  onConversationSelect: (
    projectId: string | null,
    sessionId: string,
    provider: string,
  ) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRenameSession: (sessionId: string, summary: string, provider: LLMProvider) => void;
  onTogglePinned: (sessionId: string, isPinned: boolean) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onRequestBatchArchive: (sessionIds: string[], onCompleted: (archivedSessionIds: string[]) => void) => void;
  t: TFunction;
};

const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  dsh: 'DeepSeek Harness',
  workbuddy: 'WorkBuddy',
  pi: 'Pi',
};

type RecentConversationRowProps = {
  conversation: RecentConversationListItem;
  isSelected: boolean;
  isProcessing: boolean;
  isManaging: boolean;
  isBatchSelected: boolean;
  currentTime: Date;
  editingSessionId: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (sessionId: string, summary: string, provider: LLMProvider) => void;
  onTogglePinned: (sessionId: string, isPinned: boolean) => void;
  onConversationSelect: (
    projectId: string | null,
    sessionId: string,
    provider: string,
  ) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onToggleBatchSelection: (sessionId: string) => void;
  t: TFunction;
};

function RecentConversationRow({
  conversation,
  isSelected,
  isProcessing,
  isManaging,
  isBatchSelected,
  currentTime,
  editingSessionId,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onTogglePinned,
  onConversationSelect,
  onDeleteSession,
  onToggleBatchSelection,
  t,
}: RecentConversationRowProps) {
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);
  const isEditing = editingSessionId === conversation.sessionId;
  const providerLabel = PROVIDER_LABELS[conversation.provider];
  const age = formatCompactAge(conversation.lastActivity, currentTime);
  const {
    copyState,
    copyLabel,
    isCopyPending,
    CopyStateIcon,
    handleCopyAction,
    onOptionsOpen,
  } = useCopyProviderSessionId({ sessionId: conversation.sessionId, providerLabel, t });

  const selectConversation = () => {
    if (isManaging) {
      if (!isProcessing) {
        onToggleBatchSelection(conversation.sessionId);
      }
      return;
    }

    onConversationSelect(conversation.projectId, conversation.sessionId, conversation.provider);
  };

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isManaging) {
      event.preventDefault();
      selectConversation();
      return;
    }

    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    selectConversation();
  };

  const saveEditedSession = () => {
    onSaveEditingSession(conversation.sessionId, editingSessionName, conversation.provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(conversation.sessionId, conversation.sessionTitle);
  };

  const startMobileRename = () => {
    onStartEditingSession(conversation.sessionId, conversation.sessionTitle);
  };

  const saveMobileRename = () => {
    saveEditedSession();
    setIsMobileOptionsOpen(false);
  };

  const setMobileOptionsOpen = (open: boolean) => {
    setIsMobileOptionsOpen(open);
    onOptionsOpen(open);
    if (!open && isEditing) {
      onCancelEditingSession();
    }
  };

  const rowBody = (
    <>
      {isManaging && (
        <span
          role="checkbox"
          aria-checked={isBatchSelected}
          aria-label={isProcessing
            ? t('sessions.runningSessionCannotBeArchived')
            : t('sessions.selectSession', { name: conversation.sessionTitle })}
          className={cn(
            'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors',
            isBatchSelected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/40 bg-background',
            isProcessing && 'opacity-40',
          )}
        >
          {isBatchSelected && <Check className="h-3 w-3" />}
        </span>
      )}
      <span
        className={cn(
          'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
          isSelected ? 'bg-primary/10' : 'bg-muted/60',
        )}
      >
        <LLMProviderLogo provider={conversation.provider} className="h-3.5 w-3.5" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="block truncate text-[13px] font-normal leading-4">
            {conversation.sessionTitle}
          </span>
          {conversation.isPinned && (
            <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-muted-foreground">
              <Pin className="h-3 w-3 fill-current" aria-hidden="true" />
            </span>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-3 text-muted-foreground">
          <span className="truncate">{conversation.projectDisplayName}</span>
          {age && (
            <>
              <span className="flex-shrink-0 text-muted-foreground/40">·</span>
              <time className="flex-shrink-0 tabular-nums" dateTime={conversation.lastActivity ?? undefined}>
                {age}
              </time>
            </>
          )}
        </span>
      </span>
    </>
  );

  return (
    <div className="group relative">
      <div className="md:hidden">
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg px-2 py-2',
            isSelected ? 'bg-primary/10' : 'bg-card border border-border/30',
          )}
        >
          <div className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" onClick={selectConversation}>
            {rowBody}
          </div>
          {isProcessing && (
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center text-muted-foreground" aria-label={t('tooltips.processingSessionIndicator', 'Processing session')}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </span>
          )}
          {!isManaging && <button
            type="button"
            aria-label={t('sessions.sessionOptionsFor', { name: conversation.sessionTitle })}
            aria-haspopup="dialog"
            aria-expanded={isMobileOptionsOpen}
            className="ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted active:scale-95"
            onClick={(event) => {
              event.stopPropagation();
              setMobileOptionsOpen(true);
            }}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>}
        </div>

        <Dialog open={isMobileOptionsOpen} onOpenChange={setMobileOptionsOpen}>
          <DialogContent
            aria-describedby="mobile-recent-session-options-description"
            wrapperClassName="md:hidden"
            style={{ bottom: 'var(--keyboard-height, 0px)' }}
            animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
            className="bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
          >
            <DialogTitle>{t('sessions.sessionOptions')}</DialogTitle>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />

            <div className="mb-4 flex items-center gap-3 px-1">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-muted">
                <LLMProviderLogo provider={conversation.provider} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground" title={conversation.sessionTitle}>
                  {conversation.sessionTitle}
                </p>
                <p id="mobile-recent-session-options-description" className="text-xs text-muted-foreground">
                  {t('sessions.providerSession', { provider: providerLabel })}
                </p>
              </div>
            </div>

            {isEditing ? (
              <div className="mb-3 space-y-2">
                <label htmlFor={`mobile-recent-session-rename-${conversation.sessionId}`} className="block px-1 text-xs font-medium text-muted-foreground">
                  {t('sessions.sessionName')}
                </label>
                <input
                  id={`mobile-recent-session-rename-${conversation.sessionId}`}
                  type="text"
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveMobileRename();
                    }
                  }}
                  className="w-full rounded-xl border-2 border-primary/40 bg-background px-3 py-3 text-foreground shadow-sm focus:border-primary focus:outline-none"
                  autoFocus
                  autoComplete="off"
                  style={{ fontSize: '16px' }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveMobileRename}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-transform active:scale-95"
                  >
                    <Check className="h-5 w-5 flex-shrink-0" />
                    {t('actions.save')}
                  </button>
                  <button
                    type="button"
                    onClick={onCancelEditingSession}
                    className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-border bg-muted/35 px-4 py-3 text-sm font-medium text-foreground transition-colors active:bg-muted"
                  >
                    <X className="h-5 w-5 flex-shrink-0" />
                    {t('actions.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => onTogglePinned(conversation.sessionId, !conversation.isPinned)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                >
                  {conversation.isPinned ? <PinOff className="h-5 w-5 flex-shrink-0" /> : <Pin className="h-5 w-5 flex-shrink-0" />}
                  <span className="text-sm font-medium">
                    {conversation.isPinned ? t('sessions.unpinSession') : t('sessions.pinSession')}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={startMobileRename}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-muted/35 px-4 py-3 text-left text-foreground transition-colors active:bg-muted"
                >
                  <Edit2 className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">{t('sessions.renameSession')}</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopyAction}
                  disabled={isCopyPending}
                  className={cn(
                    'flex min-h-12 w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                    copyState === 'copied'
                      ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
                      : copyState === 'error'
                        ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                        : 'border-border bg-muted/35 text-foreground active:bg-muted',
                  )}
                >
                  {isCopyPending ? (
                    <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <CopyStateIcon className="h-5 w-5 flex-shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{copyLabel}</span>
                    {copyState === 'error' && (
                      <span className="mt-0.5 block text-xs">{t('sessions.tapToTryAgain')}</span>
                    )}
                  </span>
                </button>

                {!isProcessing && (
                  <button
                    type="button"
                    onClick={() => {
                      setMobileOptionsOpen(false);
                      requestDeleteSession();
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
                onClick={() => setMobileOptionsOpen(false)}
                className="mb-3 mt-2 min-h-11 w-full rounded-xl text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
              >
                {t('actions.cancel')}
              </button>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <div className="hidden md:block">
        <a
          href={`/session/${conversation.sessionId}`}
          onClick={handleClick}
          data-testid="recent-conversation-row"
          className={cn(
            'group flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 pr-10 text-left transition-colors',
            isSelected
              ? 'bg-primary/10 text-foreground'
              : 'text-foreground hover:bg-accent/60',
            isManaging && isProcessing && 'cursor-not-allowed opacity-60',
          )}
        >
          {rowBody}

          {isProcessing && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" aria-label={t('tooltips.processingSessionIndicator', 'Processing session')} />}
          {!isManaging && <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />}
        </a>

        {!isManaging && <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 transform items-center gap-1">
          {isEditing ? (
            <>
              <input
                type="text"
                value={editingSessionName}
                onChange={(event) => onEditingSessionNameChange(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    saveEditedSession();
                  } else if (event.key === 'Escape') {
                    onCancelEditingSession();
                  }
                }}
                onClick={(event) => event.stopPropagation()}
                className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
              <button
                className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
                onClick={(event) => {
                  event.stopPropagation();
                  saveEditedSession();
                }}
                title={t('tooltips.save')}
              >
                <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
              </button>
              <button
                className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                onClick={(event) => {
                  event.stopPropagation();
                  onCancelEditingSession();
                }}
                title={t('tooltips.cancel')}
              >
                <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
              </button>
            </>
          ) : (
            <ActionMenu
              label={t('sessions.sessionOptions')}
              ariaLabel={t('sessions.sessionOptionsFor', { name: conversation.sessionTitle })}
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
                  <p className="truncate text-xs font-medium text-foreground" title={conversation.sessionTitle}>
                    {conversation.sessionTitle}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t('sessions.providerSession', { provider: providerLabel })}
                  </p>
                </div>
              )}
              items={[
                {
                  key: 'rename',
                  label: t('sessions.renameSession'),
                  icon: Edit2,
                  onSelect: () => onStartEditingSession(conversation.sessionId, conversation.sessionTitle),
                },
                {
                  key: 'pin',
                  label: conversation.isPinned ? t('sessions.unpinSession') : t('sessions.pinSession'),
                  icon: conversation.isPinned ? PinOff : Pin,
                  onSelect: () => onTogglePinned(conversation.sessionId, !conversation.isPinned),
                },
                {
                  key: 'copy',
                  label: copyLabel,
                  description: copyState === 'error' ? t('sessions.clickToTryAgain') : undefined,
                  icon: CopyStateIcon,
                  loading: isCopyPending,
                  closeOnSelect: false,
                  onSelect: handleCopyAction,
                },
                {
                  key: 'delete',
                  label: t('sessions.archiveOrDeleteSession'),
                  icon: Trash2,
                  isDanger: true,
                  showDividerBefore: true,
                  onSelect: requestDeleteSession,
                },
              ]}
            />
          )}
        </div>}
      </div>
    </div>
  );
}

function RecentConversationSkeleton() {
  return (
    <div className="space-y-1 px-1" aria-label="Loading recent conversations">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-2 rounded-lg px-2 py-2.5">
          <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${72 - index * 3}%` }} />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Rendered by SidebarContent in the recents search mode to list recently active sessions across all projects. */
export default function SidebarRecentConversations({
  conversations,
  total,
  hasMore,
  isLoading,
  isLoadingMore,
  hasError,
  selectedSession,
  activeSessions,
  currentTime,
  onConversationSelect,
  onLoadMore,
  onRetry,
  onRenameSession,
  onTogglePinned,
  onDeleteSession,
  onRequestBatchArchive,
  t,
}: SidebarRecentConversationsProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [isManaging, setIsManaging] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());

  // Running sessions can never be archived in bulk, so prune the selection as
  // sessions come and go (e.g. a session starts while manage mode is open).
  useEffect(() => {
    setSelectedSessionIds((current) => {
      const availableSessionIds = new Set(
        conversations
          .filter((conversation) => !activeSessions.has(conversation.sessionId))
          .map((conversation) => conversation.sessionId),
      );
      return new Set([...current].filter((sessionId) => availableSessionIds.has(sessionId)));
    });
  }, [activeSessions, conversations]);

  const startEditingSession = (sessionId: string, initialName: string) => {
    setEditingSessionId(sessionId);
    setEditingSessionName(initialName);
  };

  const cancelEditingSession = () => {
    setEditingSessionId(null);
    setEditingSessionName('');
  };

  const saveEditingSession = (sessionId: string, summary: string, provider: LLMProvider) => {
    onRenameSession(sessionId, summary, provider);
    setEditingSessionId(null);
    setEditingSessionName('');
  };

  const pinnedConversations = conversations.filter((conversation) => conversation.isPinned);
  const unpinnedConversations = conversations.filter((conversation) => !conversation.isPinned);
  const selectableSessionIds = conversations
    .filter((conversation) => !activeSessions.has(conversation.sessionId))
    .map((conversation) => conversation.sessionId);
  const areAllSelectableSessionsSelected = selectableSessionIds.length > 0
    && selectableSessionIds.every((sessionId) => selectedSessionIds.has(sessionId));

  const toggleBatchSelection = (sessionId: string) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedSessionIds(
      areAllSelectableSessionsSelected ? new Set() : new Set(selectableSessionIds),
    );
  };

  const exitManaging = () => {
    setIsManaging(false);
    setSelectedSessionIds(new Set());
  };

  const requestBatchArchive = () => {
    onRequestBatchArchive([...selectedSessionIds], (archivedSessionIds) => {
      const archivedSessionIdSet = new Set(archivedSessionIds);
      setSelectedSessionIds((current) => new Set(
        [...current].filter((sessionId) => !archivedSessionIdSet.has(sessionId)),
      ));
      if (archivedSessionIds.length === selectedSessionIds.size) {
        setIsManaging(false);
      }
    });
  };

  const renderConversationRow = (conversation: RecentConversationListItem) => {
    const isSelected = String(selectedSession?.id ?? '') === conversation.sessionId;

    return (
      <RecentConversationRow
        key={conversation.sessionId}
        conversation={conversation}
        isSelected={isSelected}
        isProcessing={activeSessions.has(conversation.sessionId)}
        isManaging={isManaging}
        isBatchSelected={selectedSessionIds.has(conversation.sessionId)}
        currentTime={currentTime}
        editingSessionId={editingSessionId}
        editingSessionName={editingSessionName}
        onEditingSessionNameChange={setEditingSessionName}
        onStartEditingSession={startEditingSession}
        onCancelEditingSession={cancelEditingSession}
        onSaveEditingSession={saveEditingSession}
        onTogglePinned={onTogglePinned}
        onConversationSelect={onConversationSelect}
        onDeleteSession={onDeleteSession}
        onToggleBatchSelection={toggleBatchSelection}
        t={t}
      />
    );
  };

  if (isLoading && conversations.length === 0) {
    return <RecentConversationSkeleton />;
  }

  if (hasError && conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.loadFailed', 'Could not load recent conversations')}
        </p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
          {t('buttons.retry', { ns: 'common', defaultValue: 'Try again' })}
        </Button>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.emptyTitle', 'No conversations yet')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('recent.emptyDescription', 'Your most recently updated conversations will appear here.')}
        </p>
      </div>
    );
  }

  return (
    <div className="px-1" data-testid="recent-conversations-list">
      <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('recent.title', 'Recent conversations')}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] tabular-nums text-muted-foreground/70">{total}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => (isManaging ? exitManaging() : setIsManaging(true))}
          >
            {isManaging ? t('actions.cancel') : t('sessions.manageSessions')}
          </Button>
        </div>
      </div>

      {pinnedConversations.length > 0 && (
        <div className="mb-2">
          <div className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
            <Pin className="h-3 w-3" />
            {t('recent.pinnedTitle', 'Pinned conversations')}
          </div>
          <div className="space-y-0.5">
            {pinnedConversations.map(renderConversationRow)}
          </div>
        </div>
      )}

      {unpinnedConversations.length > 0 && (
        <div>
          {pinnedConversations.length > 0 && (
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
              {t('recent.unpinnedTitle', 'Recent conversations')}
            </div>
          )}
          <div className="space-y-0.5">
            {unpinnedConversations.map(renderConversationRow)}
          </div>
        </div>
      )}

      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-8 w-full text-xs text-muted-foreground"
          onClick={onLoadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore
            ? t('recent.loadingMore', 'Loading more...')
            : t('recent.loadMore', 'Load older conversations')}
        </Button>
      )}

      {isManaging && (
        <SidebarBatchSessionActions
          selectedCount={selectedSessionIds.size}
          selectableCount={selectableSessionIds.length}
          areAllSelected={areAllSelectableSessionsSelected}
          onToggleSelectAll={toggleSelectAll}
          onArchive={requestBatchArchive}
          onCancel={exitManaging}
          t={t}
        />
      )}
    </div>
  );
}
