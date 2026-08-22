import type { Task } from "../../shared/task-domain.js";
import type { TaskEvent, TaskListQuery, TaskPage } from "./room-repository.js";

export interface JsonTaskState {
  readonly schemaVersion: 1;
  readonly tasks: Record<string, Task>;
  readonly events: readonly TaskEvent[];
}

export function emptyJsonTaskState(): JsonTaskState {
  return { schemaVersion: 1, tasks: {}, events: [] };
}

export function normalizeJsonTaskState(value: unknown): JsonTaskState {
  if (!value || typeof value !== "object") return emptyJsonTaskState();
  const stored = value as Partial<JsonTaskState>;
  const tasks = stored.tasks && typeof stored.tasks === "object" ? stored.tasks : {};
  const events = Array.isArray(stored.events) ? stored.events : [];
  return { schemaVersion: 1, tasks: structuredClone(tasks), events: structuredClone(events) };
}

export function paginateTasks(tasks: readonly Task[], query: TaskListQuery = {}): TaskPage {
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 50)));
  const offsetValue = Number.parseInt(query.cursor ?? "0", 10);
  const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
  const filtered = tasks
    .filter((task) => !query.roomId || task.roomId === query.roomId)
    .filter((task) => !query.states?.length || query.states.includes(task.state))
    .filter((task) => !query.participantId || task.participants.some(({ participantId }) => participantId === query.participantId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.taskId.localeCompare(right.taskId));
  const items = filtered.slice(offset, offset + limit);
  return { items: structuredClone(items), nextCursor: offset + items.length < filtered.length ? String(offset + items.length) : null };
}
