import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import SidebarBatchSessionActions from '@/modules/sidebar/SidebarBatchSessionActions';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onTogglePinned?: (sessionId: string, isPinned: boolean) => void;
  onRequestBatchArchive?: (sessionIds: string[], onCompleted: (archivedSessionIds: string[]) => void) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  t: TFunction;
};

// Stable stand-in for a missing onTogglePinned so every row is handed the same
// callback identity and its memo boundary can bail (see sidebarRowProps.test.tsx).
const NOOP_TOGGLE_PINNED = () => {};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/** Rendered by SidebarProjectItem to show an expanded project's sessions, delegating each row to SidebarSessionItem. */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  attentionSessionIds,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onTogglePinned,
  onRequestBatchArchive,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  onNewSession,
  t,
}: SidebarProjectSessionsProps) {
  const isCompact = useCompactSidebar();
  const [isManaging, setIsManaging] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());

  // Running sessions can never be archived in bulk, so prune the selection as
  // sessions come and go (e.g. a session starts while manage mode is open).
  // Returning `current` untouched when nothing changed lets React skip the
  // re-render, keeping the row render count stable (see sidebarRowProps.test.tsx).
  useEffect(() => {
    setSelectedSessionIds((current) => {
      if (current.size === 0) {
        return current;
      }
      const availableSessionIds = new Set(
        sessions
          .filter((session) => !activeSessions.has(session.id))
          .map((session) => session.id),
      );
      const next = new Set([...current].filter((sessionId) => availableSessionIds.has(sessionId)));
      return next.size === current.size ? current : next;
    });
  }, [activeSessions, sessions]);

  const hasSessions = sessions.length > 0;
  const selectableSessionIds = sessions
    .filter((session) => !activeSessions.has(session.id))
    .map((session) => session.id);
  const areAllSelectableSessionsSelected = selectableSessionIds.length > 0
    && selectableSessionIds.every((sessionId) => selectedSessionIds.has(sessionId));

  const toggleBatchSelection = useCallback((sessionId: string) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

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
    onRequestBatchArchive?.([...selectedSessionIds], (archivedSessionIds) => {
      const archivedSessionIdSet = new Set(archivedSessionIds);
      setSelectedSessionIds((current) => new Set(
        [...current].filter((sessionId) => !archivedSessionIdSet.has(sessionId)),
      ));
      if (archivedSessionIds.length === selectedSessionIds.size) {
        setIsManaging(false);
      }
    });
  };

  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out',
        isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
    <div className="overflow-hidden">
    <div className="ml-3 space-y-1 border-l border-border pl-3">
      {isCompact ? (
        <div className="grid grid-cols-2 gap-1 px-3 pb-1 pt-1">
          {!isManaging && (
            <button
              className="flex h-8 items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
              onClick={() => {
                onProjectSelect(project);
                onNewSession(project);
              }}
            >
              <Plus className="h-3 w-3" />
              {t('sessions.newSession')}
            </button>
          )}
          <Button
            variant="outline"
            size="sm"
            className={isManaging ? 'col-span-2 h-8 text-xs' : 'h-8 text-xs'}
            onClick={() => (isManaging ? exitManaging() : setIsManaging(true))}
            disabled={!hasSessions && !isManaging}
          >
            {isManaging ? t('actions.cancel') : t('sessions.manageSessions')}
          </Button>
        </div>
      ) : (
        <div className="flex gap-1">
          {!isManaging && (
            <Button
              variant="default"
              size="sm"
              className="h-8 flex-1 justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              onClick={() => onNewSession(project)}
            >
              <Plus className="h-3 w-3" />
              {t('sessions.newSession')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => (isManaging ? exitManaging() : setIsManaging(true))}
            disabled={!hasSessions && !isManaging}
          >
            {isManaging ? t('actions.cancel') : t('sessions.manageSessions')}
          </Button>
        </div>
      )}

      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          {sessions.map((session) => (
            <SidebarSessionItem
              key={session.id}
              project={project}
              session={session}
              selectedSession={selectedSession}
              isProcessing={activeSessions.has(session.id)}
              isManaging={isManaging}
              isBatchSelected={selectedSessionIds.has(session.id)}
              needsAttention={attentionSessionIds.has(session.id)}
              currentTime={currentTime}
              onRenameDraftChange={onRenameDraftChange}
              isEditing={session.id === sessionRenameId}
              renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              onProjectSelect={onProjectSelect}
              onSessionSelect={onSessionSelect}
              onTogglePinned={onTogglePinned ?? NOOP_TOGGLE_PINNED}
              onToggleBatchSelection={toggleBatchSelection}
              onDeleteSession={onDeleteSession}
              onForkSession={onForkSession}
              t={t}
            />
          ))}

          {hasMoreSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : 'Load more sessions'}
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
        </>
      )}
    </div>
    </div>
    </div>
  );
}
