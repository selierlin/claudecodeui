import type { TFunction } from 'i18next';

import type {
  LLMProvider,
  Project,
  ProjectSession,
  ProjectSortOrder,
  RecentConversationListItem,
  SessionWithProvider,
  SettingsProject,
} from '@/shared/types';

// Presentation data the sidebar derives from a session before rendering its row.
type SessionViewModel = {
  isActive: boolean;
  sessionName: string;
  sessionTime: string;
  messageCount: number;
};

// 绿点“最近活跃”的时间窗口（分钟）：会话最后活动距今超过该值就不再高亮。
const RECENTLY_ACTIVE_WINDOW_MINUTES = 2;

export const formatCompactAge = (
  dateString: string | null | undefined,
  currentTime: Date,
): string => {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  const minutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}hr` : `${Math.floor(hours / 24)}d`;
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isActive: diffInMinutes < RECENTLY_ACTIVE_WINDOW_MINUTES,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

/**
 * Cached against the project object, not its id.
 *
 * Every sidebar render asks for each project's sessions, and this builds a new
 * array of new session objects. Without the cache the array is a different
 * reference each time, which is enough on its own to defeat the memo boundary
 * on every project and session row. `useProjectsState` always replaces a
 * project rather than mutating it, so a stale entry is unreachable: a changed
 * project is a different key.
 */
const sortedSessionsByProject = new WeakMap<Project, SessionWithProvider[]>();

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  const cached = sortedSessionsByProject.get(project);
  if (cached) {
    return cached;
  }

  const sessions = (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => {
      if (Boolean(a.isPinned) !== Boolean(b.isPinned)) {
        return Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
      }

      return getSessionDate(b).getTime() - getSessionDate(a).getTime();
    },
  );

  sortedSessionsByProject.set(project, sessions);
  return sessions;
};

const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

/** True when one project's display name or path contains the given pre-normalized search text. */
export const projectMatchesNameOrPath = (project: Project, normalizedSearch: string): boolean => {
  const displayName = (project.displayName || project.projectId).toLowerCase();
  // `project.path`/`fullPath` is the most useful search target now that the
  // folder-derived name is gone; fall back to displayName above.
  const searchPath = (project.path || project.fullPath || '').toLowerCase();
  return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
};

/**
 * True when one loaded session's title or provider contains the given
 * pre-normalized (lowercased) search text. Only the already-loaded session
 * pages participate; transcripts are not searched.
 */
export const sessionMatchesSearchFilter = (
  session: SessionWithProvider,
  normalizedSearch: string,
): boolean => {
  if (!normalizedSearch) {
    return false;
  }

  const summary = session.summary || session.name || '';
  return summary.toLowerCase().includes(normalizedSearch)
    || getSessionProvider(session).toLowerCase().includes(normalizedSearch);
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    if (projectMatchesNameOrPath(project, normalizedSearch)) {
      return true;
    }

    // A title word or provider name (claude/codex/workbuddy, …) in any loaded
    // session surfaces the owning project.
    return getAllSessions(project).some((session) => sessionMatchesSearchFilter(session, normalizedSearch));
  });
};

/**
 * Sessions of one project shown while a search is active. A project that
 * matched by name/path keeps its full session list; one that survived through
 * a session match shows only the matching sessions. With no query this returns
 * the full list.
 */
export const filterSessionsForProject = (
  project: Project,
  projectMatchedByNameOrPath: boolean,
  searchFilter: string,
): SessionWithProvider[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch || projectMatchedByNameOrPath) {
    return getAllSessions(project);
  }

  return getAllSessions(project).filter((session) => sessionMatchesSearchFilter(session, normalizedSearch));
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

/**
 * Overlays optimistic per-session pin flags on the fetched project list.
 *
 * Only projects that actually contain an overridden session are rebuilt, so
 * untouched projects keep their identity — and with it the
 * `sortedSessionsByProject` cache that keeps session-row memoization intact.
 * An empty override map returns the input unchanged.
 */
export const applyOptimisticSessionPinState = (
  projects: Project[],
  optimisticPins: ReadonlyMap<string, boolean>,
): Project[] => {
  if (optimisticPins.size === 0) {
    return projects;
  }

  return projects.map((project) => {
    const sessions = project.sessions;
    if (!sessions || sessions.length === 0) {
      return project;
    }

    let changed = false;
    const nextSessions = sessions.map((session) => {
      const optimisticPin = optimisticPins.get(session.id);
      if (optimisticPin === undefined) {
        return session;
      }
      if (Boolean(session.isPinned) === optimisticPin) {
        return session;
      }
      changed = true;
      return { ...session, isPinned: optimisticPin };
    });

    return changed ? { ...project, sessions: nextSessions } : project;
  });
};

/**
 * Flips one conversation to the requested pin state and stable-partitions the
 * list so pinned rows render above unpinned ones, mirroring the server's
 * recent-conversations ordering. Used to preview a pin before the refetch lands.
 * Returns the input unchanged when the session is not in the list.
 */
export const reorderRecentConversationsForPin = (
  conversations: RecentConversationListItem[],
  sessionId: string,
  isPinned: boolean,
): RecentConversationListItem[] => {
  if (!conversations.some((conversation) => conversation.sessionId === sessionId)) {
    return conversations;
  }

  const updated = conversations.map((conversation) =>
    conversation.sessionId === sessionId ? { ...conversation, isPinned } : conversation,
  );

  return [
    ...updated.filter((conversation) => conversation.isPinned),
    ...updated.filter((conversation) => !conversation.isPinned),
  ];
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};
