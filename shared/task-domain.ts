export const TASK_TITLE_MAX_LENGTH = 160;
export const TASK_DESCRIPTION_MAX_LENGTH = 8_000;

export const TASK_LIFECYCLE_STATES = [
  "draft", "proposed", "approved", "active", "blocked", "completed", "abandoned", "archived",
] as const;
export type TaskLifecycleState = typeof TASK_LIFECYCLE_STATES[number];

export const TASK_PARTICIPANT_ROLES = ["owner", "coordinator", "assignee", "reviewer", "observer"] as const;
export type TaskParticipantRole = typeof TASK_PARTICIPANT_ROLES[number];

export interface TaskIdentity { readonly roomId: string; readonly taskId: string }
export interface TaskActor {
  readonly id: string;
  readonly roomRole?: "owner" | "coordinator";
  /** Immutable developer-team revision used to derive agent attribution. */
  readonly memberRevision?: number;
}
export interface TaskParticipant {
  readonly participantId: string;
  readonly role: TaskParticipantRole;
  readonly addedAt: string;
  readonly addedBy: string;
}

export type TaskReferenceKind =
  | "message" | "document_revision" | "improvement" | "assignment" | "evidence" | "disposition";

/** These are coordination pointers only. They convey no capability or authority. */
export interface TaskReference {
  readonly id: string;
  readonly kind: TaskReferenceKind;
  readonly targetId: string;
  readonly uri?: string;
  readonly contentHash?: string;
  readonly completionState?: "finished" | "unfinished";
  readonly dispositionFor?: string;
  readonly addedAt: string;
  readonly addedBy: string;
}

export interface TaskAttribution {
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
  readonly action: string;
  readonly memberRevision?: number;
}

export interface TaskLifecycleEvent {
  readonly revision: number;
  readonly from: TaskLifecycleState | null;
  readonly to: TaskLifecycleState;
  readonly actorId: string;
  readonly at: string;
  readonly operation: "create" | "transition" | "reopen";
}

export interface Task {
  readonly roomId: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly state: TaskLifecycleState;
  readonly participants: readonly TaskParticipant[];
  readonly dependencies: readonly TaskIdentity[];
  readonly blockers: readonly TaskIdentity[];
  readonly references: readonly TaskReference[];
  readonly forkedFrom: TaskIdentity | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attribution: readonly TaskAttribution[];
  readonly lifecycleHistory: readonly TaskLifecycleEvent[];
}

export type TaskChange =
  | { readonly kind: "set_title"; readonly title: string }
  | { readonly kind: "set_description"; readonly description: string }
  | { readonly kind: "add_participant"; readonly participantId: string; readonly role: TaskParticipantRole }
  | { readonly kind: "remove_participant"; readonly participantId: string; readonly role: TaskParticipantRole }
  | { readonly kind: "transition"; readonly to: TaskLifecycleState }
  | { readonly kind: "reopen"; readonly to?: "draft" | "proposed" }
  | { readonly kind: "add_dependency"; readonly task: TaskIdentity }
  | { readonly kind: "remove_dependency"; readonly task: TaskIdentity }
  | { readonly kind: "add_blocker"; readonly task: TaskIdentity }
  | { readonly kind: "remove_blocker"; readonly task: TaskIdentity }
  | { readonly kind: "append_reference"; readonly reference: Omit<TaskReference, "addedAt" | "addedBy"> };

export type TaskChangeResult =
  | { readonly kind: "accepted"; readonly task: Task }
  | { readonly kind: "conflict"; readonly expectedRevision: number; readonly actualRevision: number }
  | { readonly kind: "rejected"; readonly reason: string };

const TRANSITIONS: Record<TaskLifecycleState, readonly TaskLifecycleState[]> = {
  draft: ["proposed", "abandoned"],
  proposed: ["draft", "approved", "abandoned"],
  approved: ["active", "abandoned"],
  active: ["blocked", "completed", "abandoned"],
  blocked: ["active", "completed", "abandoned"],
  completed: ["archived"],
  abandoned: ["archived"],
  archived: [],
};

function cleanText(value: string, maximum: number, label: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > maximum) throw new Error(`${label} must be at most ${maximum} characters`);
  return normalized;
}

function actorRoles(task: Task, actor: TaskActor) {
  const roles = new Set(task.participants.filter(({ participantId }) => participantId === actor.id).map(({ role }) => role));
  if (actor.roomRole) roles.add(actor.roomRole);
  return roles;
}

function authorized(task: Task, actor: TaskActor, change: TaskChange) {
  const roles = actorRoles(task, actor);
  if (roles.has("owner")) return true;
  if (change.kind === "add_participant" || change.kind === "remove_participant") return roles.has("coordinator");
  if (["add_dependency", "remove_dependency", "add_blocker", "remove_blocker"].includes(change.kind)) return roles.has("coordinator");
  if (change.kind === "reopen") return roles.has("coordinator") || roles.has("reviewer");
  if (change.kind === "set_title" || change.kind === "set_description") return roles.has("coordinator");
  if (change.kind === "append_reference") return roles.has("coordinator") || roles.has("assignee") || roles.has("reviewer");
  if (change.kind === "transition") {
    if (["approved", "completed", "archived"].includes(change.to)) return roles.has("coordinator") || roles.has("reviewer");
    return roles.has("coordinator") || roles.has("assignee") || roles.has("reviewer");
  }
  return false;
}

export function createTask(input: {
  readonly roomId: string; readonly taskId: string; readonly title: string; readonly description?: string;
  readonly actor: TaskActor; readonly now: string; readonly participants?: readonly Omit<TaskParticipant, "addedAt" | "addedBy">[];
  readonly forkedFrom?: TaskIdentity | null;
}): Task {
  const roomId = cleanText(input.roomId, 256, "Room ID");
  const taskId = cleanText(input.taskId, 256, "Task ID");
  const title = cleanText(input.title, TASK_TITLE_MAX_LENGTH, "Task title");
  const description = (input.description ?? "").trim();
  if (description.length > TASK_DESCRIPTION_MAX_LENGTH) throw new Error(`Task description must be at most ${TASK_DESCRIPTION_MAX_LENGTH} characters`);
  if (!input.actor.id.trim()) throw new Error("Actor ID must not be empty");
  const supplied = input.participants ?? [];
  const participants = supplied.map((participant) => ({ ...participant, addedAt: input.now, addedBy: input.actor.id }));
  if (!participants.some(({ participantId, role }) => participantId === input.actor.id && role === "owner")) {
    participants.unshift({ participantId: input.actor.id, role: "owner", addedAt: input.now, addedBy: input.actor.id });
  }
  return {
    roomId, taskId, title, description, state: "draft", participants, dependencies: [], blockers: [], references: [],
    forkedFrom: input.forkedFrom ?? null, revision: 1, createdAt: input.now, updatedAt: input.now,
    attribution: [{ revision: 1, actorId: input.actor.id, at: input.now, action: "create", ...(input.actor.memberRevision ? { memberRevision: input.actor.memberRevision } : {}) }],
    lifecycleHistory: [{ revision: 1, from: null, to: "draft", actorId: input.actor.id, at: input.now, operation: "create" }],
  };
}

export function applyTaskChange(task: Task, expectedRevision: number, change: TaskChange, actor: TaskActor, now: string): TaskChangeResult {
  if (expectedRevision !== task.revision) return { kind: "conflict", expectedRevision, actualRevision: task.revision };
  if (!actor.id.trim()) return { kind: "rejected", reason: "Actor ID must not be empty" };
  if (!authorized(task, actor, change)) return { kind: "rejected", reason: `Actor ${actor.id} is not authorized for ${change.kind}` };
  let patch: Partial<Task> = {};
  let lifecycle: TaskLifecycleEvent | undefined;
  try {
    switch (change.kind) {
      case "set_title": patch = { title: cleanText(change.title, TASK_TITLE_MAX_LENGTH, "Task title") }; break;
      case "set_description": {
        const description = change.description.trim();
        if (description.length > TASK_DESCRIPTION_MAX_LENGTH) throw new Error(`Task description must be at most ${TASK_DESCRIPTION_MAX_LENGTH} characters`);
        patch = { description }; break;
      }
      case "add_participant": {
        if (!change.participantId.trim()) throw new Error("Participant ID must not be empty");
        if (task.participants.some((value) => value.participantId === change.participantId && value.role === change.role)) throw new Error("Participant role already exists");
        patch = { participants: [...task.participants, { participantId: change.participantId, role: change.role, addedAt: now, addedBy: actor.id }] }; break;
      }
      case "remove_participant": {
        const next = task.participants.filter((value) => !(value.participantId === change.participantId && value.role === change.role));
        if (next.length === task.participants.length) throw new Error("Participant role does not exist");
        if (change.role === "owner" && !next.some(({ role }) => role === "owner")) throw new Error("A task must retain an owner");
        patch = { participants: next }; break;
      }
      case "transition": {
        if (!TRANSITIONS[task.state].includes(change.to)) throw new Error(`Transition ${task.state} -> ${change.to} is not allowed`);
        if (change.to === "completed") validateCompletion(task);
        patch = { state: change.to };
        lifecycle = { revision: task.revision + 1, from: task.state, to: change.to, actorId: actor.id, at: now, operation: "transition" };
        break;
      }
      case "reopen": {
        if (!["completed", "abandoned", "archived"].includes(task.state)) throw new Error("Only terminal or archived tasks can be explicitly reopened");
        const to = change.to ?? "draft";
        patch = { state: to };
        lifecycle = { revision: task.revision + 1, from: task.state, to, actorId: actor.id, at: now, operation: "reopen" };
        break;
      }
      case "add_dependency": patch = { dependencies: addLink(task, task.dependencies, change.task) }; break;
      case "remove_dependency": patch = { dependencies: removeLink(task.dependencies, change.task) }; break;
      case "add_blocker": patch = { blockers: addLink(task, task.blockers, change.task) }; break;
      case "remove_blocker": patch = { blockers: removeLink(task.blockers, change.task) }; break;
      case "append_reference": {
        if (!change.reference.id.trim() || !change.reference.targetId.trim()) throw new Error("Reference ID and target ID are required");
        if (task.references.some(({ id }) => id === change.reference.id)) throw new Error("Reference IDs are immutable and unique");
        if (change.reference.kind === "document_revision" && !change.reference.contentHash?.trim()) throw new Error("Document revision references require a content hash");
        if (change.reference.kind === "disposition" && !change.reference.dispositionFor?.trim()) throw new Error("Disposition references require dispositionFor");
        patch = { references: [...task.references, { ...change.reference, addedAt: now, addedBy: actor.id }] }; break;
      }
    }
  } catch (error) {
    return { kind: "rejected", reason: (error as Error).message };
  }
  const revision = task.revision + 1;
  const next: Task = {
    ...task, ...patch, revision, updatedAt: now,
    attribution: [...task.attribution, { revision, actorId: actor.id, at: now, action: change.kind, ...(actor.memberRevision ? { memberRevision: actor.memberRevision } : {}) }],
    lifecycleHistory: lifecycle ? [...task.lifecycleHistory, lifecycle] : task.lifecycleHistory,
  };
  return { kind: "accepted", task: next };
}

function addLink(task: Task, links: readonly TaskIdentity[], target: TaskIdentity) {
  if (target.roomId !== task.roomId) throw new Error("Cross-room task links are not allowed");
  if (target.taskId === task.taskId) throw new Error("A task cannot link to itself");
  if (links.some((value) => value.roomId === target.roomId && value.taskId === target.taskId)) throw new Error("Task link already exists");
  return [...links, target];
}

function removeLink(links: readonly TaskIdentity[], target: TaskIdentity) {
  const next = links.filter((value) => value.roomId !== target.roomId || value.taskId !== target.taskId);
  if (next.length === links.length) throw new Error("Task link does not exist");
  return next;
}

function validateCompletion(task: Task) {
  if (!task.references.some(({ kind }) => kind === "evidence")) throw new Error("Completion requires immutable evidence");
  const dispositionTargets = new Set(task.references.filter(({ kind }) => kind === "disposition").map(({ dispositionFor }) => dispositionFor));
  const unfinished = task.references.filter((reference) =>
    (reference.kind === "assignment" || reference.completionState === "unfinished") && !dispositionTargets.has(reference.id));
  if (unfinished.length) throw new Error("Completion requires an explicit disposition for unfinished artifacts or assignment links");
}

export function forkTask(source: Task, expectedRevision: number, input: { readonly taskId: string; readonly title?: string; readonly actor: TaskActor; readonly now: string }): TaskChangeResult {
  if (expectedRevision !== source.revision) return { kind: "conflict", expectedRevision, actualRevision: source.revision };
  if (!["completed", "abandoned", "archived"].includes(source.state)) return { kind: "rejected", reason: "Only terminal or archived tasks can be forked" };
  if (!actorRoles(source, input.actor).has("owner") && !actorRoles(source, input.actor).has("coordinator")) return { kind: "rejected", reason: "Actor is not authorized to fork this task" };
  try {
    return { kind: "accepted", task: createTask({ roomId: source.roomId, taskId: input.taskId, title: input.title ?? source.title, description: source.description, actor: input.actor, now: input.now, forkedFrom: { roomId: source.roomId, taskId: source.taskId } }) };
  } catch (error) {
    return { kind: "rejected", reason: (error as Error).message };
  }
}
