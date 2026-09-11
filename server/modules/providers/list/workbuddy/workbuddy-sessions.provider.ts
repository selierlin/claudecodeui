import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

import { getWorkbuddySessionRoots } from './workbuddy-storage.provider.js';

/** Mirrors the engine's directory encoding: strip the leading slash, `/` → `-`. */
function encodeCwd(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/\//g, '-');
}

/** Resolves the transcript path for one engine session id across both roots. */
function resolveTranscriptPath(engineSessionId: string, cwd: string): string | null {
  const encodedCwd = encodeCwd(cwd);
  for (const root of getWorkbuddySessionRoots()) {
    const candidate = path.join(root, encodedCwd, `${engineSessionId}.jsonl`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Reads the first `text` field of one content block type in a message. */
function extractBlockText(blocks: unknown[], type: string): string | undefined {
  for (const block of blocks) {
    const record = block as AnyRecord | null;
    if (record?.type === type && typeof record.text === 'string' && record.text.trim()) {
      return record.text;
    }
  }
  return undefined;
}

/**
 * Recovers the actual user prompt from a WorkBuddy user-turn transcript.
 *
 * The engine wraps every user turn's real input in a `<user_query>…</user_query>`
 * tag that sits after a `<system-reminder data-role="user-context">` block
 * (injected current time, memory/skill reminders, …). Without this, history
 * shows that injected context instead of what the user typed. Older transcripts
 * that stored plain text are returned unchanged.
 */
function extractUserPrompt(inputText: string): string {
  const match = inputText.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }
  return inputText.trim();
}

function extractFunctionResultText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((item) => {
        const record = readObjectRecord(item);
        return typeof record?.text === 'string' ? record.text : '';
      })
      .filter(Boolean)
      .join('');
  }
  const record = output as AnyRecord | null;
  if (record && typeof record.text === 'string') {
    return record.text;
  }
  if (record && typeof record.content === 'string') {
    return record.content;
  }
  return output === undefined || output === null ? '' : JSON.stringify(output);
}

function normalizeWorkbuddyTodoItems(record: AnyRecord): unknown[] | null {
  const metadata = readObjectRecord(record._meta);
  const rawResponse = readObjectRecord(metadata?.rawResponse);
  const todos = rawResponse?.todos;
  if (Array.isArray(todos) && todos.length > 0) {
    return todos;
  }

  // CodeBuddy removes completed tasks from `todos`. Preserve the just-updated
  // task so the final UI state still shows a completed row instead of making
  // the task list disappear immediately.
  const task = readObjectRecord(rawResponse?.task);
  if (!task) {
    return null;
  }
  const content = readNonEmptyString(task.subject, task.content);
  const id = readNonEmptyString(task.id);
  const status = readNonEmptyString(task.status);
  if (!content || !id || !status) {
    return null;
  }

  return [{
    id,
    content,
    status,
    activeForm: task.activeForm,
  }];
}

function normalizeWorkbuddyTodoResult(
  record: AnyRecord,
  sessionId: string | null,
  timestamp?: string,
): NormalizedMessage | null {
  const items = normalizeWorkbuddyTodoItems(record);
  if (!items) {
    return null;
  }

  const id = `workbuddy-todo-${sessionId || 'session'}`;
  return createNormalizedMessage({
    id,
    kind: 'tool_use',
    role: 'assistant',
    provider: 'workbuddy',
    sessionId,
    timestamp,
    toolName: 'TodoList',
    toolInput: { items },
    toolId: id,
  });
}

function readNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Reads a stable event timestamp so normalized messages keep the same
 * timestamp across repeated transcript reads.
 *
 * Transcript readers merge an ISO timestamp into every non-`message` event and
 * live runtime events may carry epoch milliseconds. Without this, the fallback
 * "now" stamp in `createNormalizedMessage` makes each history read produce a
 * different timestamp for the same row, which breaks the frontend's persisted
 * row comparison during scroll-up pagination.
 */
function readEventTimestamp(event: AnyRecord): string | undefined {
  if (typeof event.timestamp === 'string' && event.timestamp.trim()) {
    return event.timestamp;
  }
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) {
    return new Date(event.timestamp).toISOString();
  }
  return undefined;
}

/** Parses a WorkBuddy task tool payload stored as a JSON string or object. */
function parseTaskArguments(value: unknown): AnyRecord | null {
  if (typeof value === 'string') {
    try {
      return readObjectRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return readObjectRecord(value);
}

/** Recovers the engine-assigned task id from a TaskCreate result sentence. */
function extractTaskIdFromCreateResult(output: unknown): string | undefined {
  const text = extractFunctionResultText(output);
  return text.match(/Task\s*#(\d+)/i)?.[1];
}

/** Reads a WorkBuddy image blob into a data URL, returning null when it is gone. */
async function readBlobAsDataUrl(blobPath: string, mime: string): Promise<string | null> {
  try {
    const bytes = await fsp.readFile(blobPath);
    return `data:${mime || 'application/octet-stream'};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

type WorkbuddyTodoEntry = {
  id: string;
  content: string;
  status: string;
  activeForm?: string;
};

/**
 * Replays one WorkBuddy `TaskCreate`/`TaskUpdate` stream event into the
 * reader's running checklist and emits a TodoList snapshot when it changes.
 *
 * Unlike CodeBuddy's `rawResponse.todos`, these calls never state the full
 * list: `TaskCreate` returns the engine-assigned id in its result sentence and
 * later `TaskUpdate` calls land on that id. The generic tool row is folded away
 * so the conversation draws the single checklist instead of a wall of task
 * bookkeeping cards.
 */
function collectWorkbuddyTaskEvent(
  event: AnyRecord,
  todoEntries: Map<string, WorkbuddyTodoEntry>,
  pendingCreates: Map<string, { content: string; activeForm?: string }>,
  emit: (timestamp?: string) => void,
): boolean {
  if (event.type !== 'function_call' && event.type !== 'function_call_result') {
    return false;
  }
  const name = typeof event.name === 'string' ? event.name : '';
  if (name !== 'TaskCreate' && name !== 'TaskUpdate') {
    return false;
  }

  const timestamp = readEventTimestamp(event);

  if (event.type === 'function_call' && name === 'TaskCreate') {
    const input = parseTaskArguments(event.arguments);
    const content = readNonEmptyString(input?.subject, input?.description);
    const activeForm = readNonEmptyString(input?.activeForm);
    const callId = readNonEmptyString(event.callId, event.id);
    if (callId && content) {
      pendingCreates.set(callId, { content, activeForm });
    }
    return true;
  }

  if (event.type === 'function_call_result' && name === 'TaskCreate') {
    const taskId = extractTaskIdFromCreateResult(event.output);
    const callId = readNonEmptyString(event.callId, event.id);
    const pending = callId ? pendingCreates.get(callId) : undefined;
    if (taskId) {
      todoEntries.set(taskId, {
        id: taskId,
        content: pending?.content || taskId,
        status: 'pending',
        ...(pending?.activeForm ? { activeForm: pending.activeForm } : {}),
      });
      if (callId) {
        pendingCreates.delete(callId);
      }
      emit(timestamp);
    }
    return true;
  }

  if (event.type === 'function_call' && name === 'TaskUpdate') {
    const input = parseTaskArguments(event.arguments);
    const taskId = readNonEmptyString(input?.taskId);
    if (taskId) {
      const existing = todoEntries.get(taskId);
      todoEntries.set(taskId, {
        id: taskId,
        content: existing?.content || taskId,
        status: readNonEmptyString(input?.status) || existing?.status || 'pending',
        ...(existing?.activeForm ? { activeForm: existing.activeForm } : {}),
      });
      emit(timestamp);
    }
    return true;
  }

  // A TaskUpdate result only echoes the id the call already applied.
  return true;
}

function normalizeTaskStatus(subtype: string, status: unknown): string {
  const value = readNonEmptyString(status)?.toLowerCase();
  if (value) {
    switch (value) {
      case 'pending':
      case 'queued':
      case 'started':
      case 'running':
      case 'in_progress':
      case 'progress':
        return 'running';
      case 'success':
      case 'succeeded':
      case 'complete':
      case 'completed':
        return 'completed';
      case 'error':
      case 'failed':
        return 'failed';
      case 'cancelled':
      case 'canceled':
        return 'cancelled';
      case 'stopped':
        return 'stopped';
      case 'killed':
        return 'killed';
      default:
        return value;
    }
  }

  return subtype === 'task_notification' ? 'completed' : 'running';
}

/**
 * Maps CodeBuddy's system task events onto the existing CloudCLI task
 * notification contract. All updates for one native task share one id so the
 * realtime store replaces the previous snapshot instead of rendering a new
 * row for every progress event.
 */
function normalizeTaskEvent(event: AnyRecord, sessionId: string | null): NormalizedMessage | null {
  if (event.type !== 'system' || typeof event.subtype !== 'string' || !event.subtype.startsWith('task_')) {
    return null;
  }

  const taskId = readNonEmptyString(event.task_id, event.taskId, event.tool_use_id, event.toolUseId);
  const eventId = readNonEmptyString(event.uuid, event.id);
  const id = taskId
    ? `workbuddy-task-${taskId}`
    : eventId
      ? `workbuddy-task-event-${eventId}`
      : undefined;
  const summary = readNonEmptyString(
    event.summary,
    event.description,
    event.note,
    event.message,
    event.result,
    event.output,
  ) || 'WorkBuddy background task update';
  const status = normalizeTaskStatus(event.subtype, event.status);
  const isFinal = ['completed', 'failed', 'cancelled', 'stopped', 'killed'].includes(status)
    || event.subtype === 'task_notification';

  return createNormalizedMessage({
    id,
    kind: 'task_notification',
    role: 'assistant',
    sessionId,
    provider: 'workbuddy',
    summary,
    status,
    taskId,
    taskType: readNonEmptyString(event.task_type, event.taskType),
    toolUseId: readNonEmptyString(event.tool_use_id, event.toolUseId),
    progress: event.progress,
    isFinal,
    timestamp: readEventTimestamp(event),
  });
}

type StoredHistoryMessage = {
  sequence: number;
  message: NormalizedMessage;
};

type TranscriptReadResult = {
  messages: NormalizedMessage[];
  total: number;
};

/**
 * Keeps only the tail needed by a paginated history request. Task/Todo
 * snapshots are merged while they remain in the requested window; an update
 * after eviction becomes the new tail snapshot, which is the only state a
 * finite page can render.
 */
class TranscriptMessageCollector {
  private nextSequence = 0;
  private readonly retainedMessages = new Map<number, StoredHistoryMessage>();
  private readonly specialSequences = new Map<string, number>();

  constructor(private readonly maxMessages: number | null) {}

  add(message: NormalizedMessage): void {
    if (message.kind === 'task_notification' || message.toolName === 'TodoList') {
      const key = `${message.id}\u0000${message.kind}`;
      const sequence = this.specialSequences.get(key);
      if (sequence !== undefined) {
        const previous = this.retainedMessages.get(sequence);
        if (previous) {
          this.retainedMessages.set(sequence, {
            sequence,
            message: { ...previous.message, ...message },
          });
          return;
        }
        this.specialSequences.delete(key);
      }

      this.addRetainedMessage(message, key);
      return;
    }

    this.addRetainedMessage(message);
  }

  toResult(): TranscriptReadResult {
    return {
      messages: [...this.retainedMessages.values()].map(({ message }) => message),
      total: this.nextSequence,
    };
  }

  private addRetainedMessage(message: NormalizedMessage, specialKey?: string): void {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    if (this.maxMessages === 0) {
      return;
    }

    this.retainedMessages.set(sequence, { sequence, message });
    if (specialKey) {
      this.specialSequences.set(specialKey, sequence);
    }

    if (this.maxMessages === null || this.retainedMessages.size <= this.maxMessages) {
      return;
    }

    const oldestSequence = this.retainedMessages.keys().next().value;
    if (oldestSequence === undefined) {
      return;
    }
    const oldest = this.retainedMessages.get(oldestSequence);
    this.retainedMessages.delete(oldestSequence);
    if (oldest && (oldest.message.kind === 'task_notification' || oldest.message.toolName === 'TodoList')) {
      this.specialSequences.delete(`${oldest.message.id}\u0000${oldest.message.kind}`);
    }
  }
}

/** Applies the shared tail-page contract to a retained tail window. */
function sliceRetainedTailPage<T>(
  retainedMessages: T[],
  total: number,
  limit: number | null,
  offset: number,
): { page: T[]; hasMore: boolean } {
  if (limit === null) {
    return sliceTailPage(retainedMessages, limit, offset);
  }

  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - Math.max(0, limit));
  const firstRetainedIndex = Math.max(0, total - retainedMessages.length);
  return {
    page: retainedMessages.slice(
      Math.max(0, start - firstRetainedIndex),
      Math.max(0, end - firstRetainedIndex),
    ),
    hasMore: start > 0,
  };
}

const EMPTY_HISTORY: FetchHistoryResult = {
  messages: [],
  total: 0,
  hasMore: false,
  offset: 0,
  limit: null,
};

/**
 * Provider registry session adapter for WorkBuddy.
 *
 * `normalizeMessage` translates the stream-json assistant/user events emitted
 * by the WorkBuddy runtime into app messages: thinking/text blocks become
 * matching messages and tool calls/results remain visible as tool events.
 */
export class WorkbuddySessionsProvider implements IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const event = raw as AnyRecord | null;
    const taskMessage = event ? normalizeTaskEvent(event, sessionId) : null;
    if (taskMessage) {
      return [taskMessage];
    }
    if (event?.type === 'reasoning') {
      const rawContent = Array.isArray(event.rawContent) ? event.rawContent : [];
      const messages: NormalizedMessage[] = [];
      for (const block of rawContent) {
        const record = block as AnyRecord | null;
        if (record?.type === 'reasoning_text' && typeof record.text === 'string' && record.text.trim()) {
          messages.push(createNormalizedMessage({
            kind: 'thinking',
            role: 'assistant',
            content: record.text,
            sessionId,
            provider: 'workbuddy',
            timestamp: readEventTimestamp(event),
          }));
        }
      }
      return messages;
    }
    // Token-level deltas the runtime unwraps from `stream_event`. Two channels
    // share the `stream_delta` kind: the visible reply (`text_delta`) and the
    // reasoning trace (`thinking_delta`). The channel travels with the frame so
    // the client buffers them into separate rows.
    if (event?.type === 'content_block_delta') {
      const deltaRecord = readObjectRecord(event.delta);
      const deltaType = typeof deltaRecord?.type === 'string' ? deltaRecord.type : '';
      if (deltaType === 'thinking_delta' && typeof deltaRecord?.thinking === 'string' && deltaRecord.thinking) {
        return [createNormalizedMessage({
          kind: 'stream_delta',
          streamChannel: 'thinking',
          content: deltaRecord.thinking,
          sessionId,
          provider: 'workbuddy',
          timestamp: readEventTimestamp(event),
        })];
      }
      if (deltaType === 'text_delta' && typeof deltaRecord?.text === 'string' && deltaRecord.text) {
        return [createNormalizedMessage({
          kind: 'stream_delta',
          streamChannel: 'text',
          content: deltaRecord.text,
          sessionId,
          provider: 'workbuddy',
          timestamp: readEventTimestamp(event),
        })];
      }
      return [];
    }
    // `message_stop` closes one assistant message's streamed deltas; the
    // client finalizes its placeholder rows on this frame.
    if (event?.type === 'message_stop') {
      return [createNormalizedMessage({
        kind: 'stream_end',
        sessionId,
        provider: 'workbuddy',
        timestamp: readEventTimestamp(event),
      })];
    }
    if (event?.type !== 'assistant' && event?.type !== 'user') {
      if (event?.type === 'function_call' && typeof event.name === 'string' && event.name.trim()) {
        const toolId = typeof event.callId === 'string' ? event.callId : typeof event.id === 'string' ? event.id : undefined;
        return [createNormalizedMessage({
          kind: 'tool_use',
          role: 'assistant',
          toolName: event.name,
          toolInput: event.arguments,
          toolId,
          id: typeof event.id === 'string' ? event.id : undefined,
          sessionId,
          provider: 'workbuddy',
          timestamp: readEventTimestamp(event),
        })];
      }
      if (event?.type === 'function_call_result') {
        const toolId = typeof event.callId === 'string' ? event.callId : undefined;
        const status = typeof event.status === 'string' ? event.status : '';
        return [createNormalizedMessage({
          kind: 'tool_result',
          role: 'user',
          content: extractFunctionResultText(event.output),
          toolId,
          isError: status !== '' && status !== 'completed',
          status: status || undefined,
          id: typeof event.id === 'string' ? event.id : undefined,
          sessionId,
          provider: 'workbuddy',
          timestamp: readEventTimestamp(event),
        })];
      }
      return [];
    }

    const message = event.message as AnyRecord | null;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const messages: NormalizedMessage[] = [];

    for (const block of blocks) {
      const record = block as AnyRecord | null;
      if (!record) {
        continue;
      }
      const timestamp = readEventTimestamp(event);
      if (event.type === 'assistant' && record.type === 'thinking' && typeof record.thinking === 'string' && record.thinking.trim()) {
        messages.push(createNormalizedMessage({
          kind: 'thinking',
          role: 'assistant',
          content: record.thinking,
          sessionId,
          provider: 'workbuddy',
          timestamp,
        }));
      } else if (event.type === 'assistant' && record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
        messages.push(createNormalizedMessage({
          kind: 'text',
          role: 'assistant',
          content: record.text,
          sessionId,
          provider: 'workbuddy',
          timestamp,
        }));
      } else if (event.type === 'assistant' && record.type === 'tool_use' && typeof record.name === 'string' && record.name.trim()) {
        messages.push(createNormalizedMessage({
          kind: 'tool_use',
          role: 'assistant',
          toolName: record.name,
          toolInput: record.input,
          toolId: typeof record.id === 'string' ? record.id : undefined,
          sessionId,
          provider: 'workbuddy',
          timestamp,
        }));
      } else if (record.type === 'tool_result') {
        messages.push(createNormalizedMessage({
          kind: 'tool_result',
          role: 'user',
          content: extractFunctionResultText(record.content),
          toolId: typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined,
          isError: Boolean(record.is_error),
          status: typeof record.status === 'string' ? record.status : undefined,
          sessionId,
          provider: 'workbuddy',
          timestamp,
        }));
        const todoMessage = normalizeWorkbuddyTodoResult(record, sessionId, timestamp);
        if (todoMessage) {
          messages.push(todoMessage);
        }
      }
    }

    return messages;
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const row = sessionsDb.getSessionById(sessionId);
    const engineSessionId = row?.provider_session_id?.trim();
    if (!row?.project_path || !engineSessionId) {
      return EMPTY_HISTORY;
    }

    const filePath = resolveTranscriptPath(engineSessionId, row.project_path);
    if (!filePath) {
      return EMPTY_HISTORY;
    }

    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const retention = normalizedLimit === null ? null : normalizedOffset + normalizedLimit;
    const { messages: retainedMessages, total } = await this.readTranscript(filePath, sessionId, retention);
    const { page, hasMore } = sliceRetainedTailPage(
      retainedMessages,
      total,
      normalizedLimit,
      normalizedOffset,
    );

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }

  /**
   * Decodes a persisted engine transcript into app messages, oldest first.
   *
   * Only `message` events carry content: user turns use `input_text` blocks,
   * assistant turns use `output_text` (text), `reasoning_text` (thinking), and
   * tool blocks. Top-level `reasoning` events become thinking, and the
   * incremental `TaskCreate`/`TaskUpdate` calls are folded into one TodoList
   * snapshot. `ai-title` and `file-history-snapshot` are skipped. A finite page
   * passes its required tail window to the collector so a large transcript is
   * not retained in full.
   */
  private async readTranscript(
    filePath: string,
    appSessionId: string,
    maxMessages: number | null,
  ): Promise<TranscriptReadResult> {
    const collector = new TranscriptMessageCollector(maxMessages);
    const todoEntries = new Map<string, WorkbuddyTodoEntry>();
    const pendingCreates = new Map<string, { content: string; activeForm?: string }>();
    const todoId = `workbuddy-todo-${appSessionId}`;
    const emitTodoSnapshot = (snapshotTimestamp?: string) => {
      if (todoEntries.size === 0) {
        return;
      }
      const items = [...todoEntries.values()].map((entry) => {
        const item: AnyRecord = { id: entry.id, content: entry.content, status: entry.status };
        if (entry.activeForm) {
          item.activeForm = entry.activeForm;
        }
        return item;
      });
      collector.add(createNormalizedMessage({
        id: todoId,
        kind: 'tool_use',
        role: 'assistant',
        provider: 'workbuddy',
        sessionId: appSessionId,
        toolName: 'TodoList',
        toolInput: { items },
        toolId: todoId,
        timestamp: snapshotTimestamp,
      }));
    };

    let fileContent: string;
    try {
      fileContent = await fsp.readFile(filePath, 'utf8');
    } catch {
      return collector.toResult();
    }

    const lines = fileContent.split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let event: AnyRecord;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const timestamp = typeof event.timestamp === 'number'
        ? new Date(event.timestamp).toISOString()
        : undefined;
      const timestampField = timestamp ? { timestamp } : {};
      if (event.type !== 'message') {
        if (collectWorkbuddyTaskEvent(event, todoEntries, pendingCreates, emitTodoSnapshot)) {
          continue;
        }
        const normalizedMessages = this.normalizeMessage(
          timestampField.timestamp ? { ...event, ...timestampField } : event,
          appSessionId,
        );
        for (const message of normalizedMessages) {
          collector.add(message);
        }
        continue;
      }

      const blocks = Array.isArray(event.content) ? event.content : [];

      if (event.role === 'user') {
        const text = extractBlockText(blocks, 'input_text');
        const images: Array<{ data: string; name?: string }> = [];
        for (const block of blocks) {
          const record = block as AnyRecord | null;
          if (record?.type === 'image_blob_ref' && typeof record.blob_path === 'string') {
            const mime = typeof record.mime === 'string' && record.mime ? record.mime : 'image/png';
            const dataUrl = await readBlobAsDataUrl(record.blob_path, mime);
            if (dataUrl) {
              images.push({
                data: dataUrl,
                ...(typeof record.original_filename === 'string'
                  ? { name: record.original_filename }
                  : {}),
              });
            }
          }
        }
        if (text || images.length > 0) {
          collector.add(createNormalizedMessage({
            kind: 'text',
            role: 'user',
            content: text ? extractUserPrompt(text) : '',
            images: images.length > 0 ? images : undefined,
            sessionId: appSessionId,
            provider: 'workbuddy',
            ...timestampField,
          }));
        }
        for (const block of blocks) {
          const record = block as AnyRecord | null;
          if (record?.type !== 'tool_result') {
            continue;
          }
          collector.add(createNormalizedMessage({
            kind: 'tool_result',
            role: 'user',
            content: extractFunctionResultText(record.content),
            toolId: typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined,
            isError: Boolean(record.is_error),
            status: typeof record.status === 'string' ? record.status : undefined,
            sessionId: appSessionId,
            provider: 'workbuddy',
            ...timestampField,
          }));
          const todoMessage = normalizeWorkbuddyTodoResult(record, appSessionId, timestamp);
          if (todoMessage) {
            collector.add(todoMessage);
          }
        }
      } else if (event.role === 'assistant') {
        // Emit blocks in transcript order so reasoning reads as thinking before
        // the final answer, matching how the live stream normalizes them.
        for (const block of blocks) {
          const record = block as AnyRecord | null;
          if (!record) {
            continue;
          }
          if (record.type === 'reasoning_text' && typeof record.text === 'string' && record.text.trim()) {
            collector.add(createNormalizedMessage({
              kind: 'thinking',
              role: 'assistant',
              content: record.text,
              sessionId: appSessionId,
              provider: 'workbuddy',
              ...timestampField,
            }));
          } else if (record.type === 'output_text' && typeof record.text === 'string' && record.text.trim()) {
            collector.add(createNormalizedMessage({
              kind: 'text',
              role: 'assistant',
              content: record.text,
              sessionId: appSessionId,
              provider: 'workbuddy',
              ...timestampField,
            }));
          } else if (record.type === 'tool_use' && typeof record.name === 'string' && record.name.trim()) {
            collector.add(createNormalizedMessage({
              kind: 'tool_use',
              role: 'assistant',
              toolName: record.name,
              toolInput: record.input,
              toolId: typeof record.id === 'string' ? record.id : undefined,
              sessionId: appSessionId,
              provider: 'workbuddy',
              ...timestampField,
            }));
          }
        }
        }
    }

    return collector.toResult();
  }
}
