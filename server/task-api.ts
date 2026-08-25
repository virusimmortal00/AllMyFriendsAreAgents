import { randomUUID } from "node:crypto";
import type express from "express";
import { isActiveAgentId } from "../shared/participants.js";
import { createTask, TASK_LIFECYCLE_STATES, TASK_PARTICIPANT_ROLES, type TaskActor, type TaskChange, type TaskReference } from "../shared/task-domain.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import { sessionHuman, type HumanSessions } from "./human-session.js";
import { CANONICAL_ROOM_ID, type RoomRepository } from "./storage/room-repository.js";

const forbiddenKeys = new Set(["roomId", "actorId", "addedBy", "developerRole", "memberId", "memberRevision"]);

function containsForbiddenIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => forbiddenKeys.has(key) || containsForbiddenIdentity(nested));
}

function sendResult(response: express.Response, result: Awaited<ReturnType<RoomRepository["applyTaskChange"]>>, broadcast: () => void) {
  if (result.kind === "accepted") { broadcast(); return response.json(result.task); }
  if (result.kind === "conflict") return response.status(409).json({ error: "Task changed since it was loaded.", ...result });
  return response.status(422).json({ error: result.reason, kind: result.kind });
}

function expectedRevision(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function validParticipant(value: unknown, humans: HumanPresenceRegistry) {
  return typeof value === "string" && (Boolean(humans.get(value)) || value === "you" || isActiveAgentId(value));
}

export function registerTaskRoutes(input: {
  app: express.Express;
  store: RoomRepository;
  humans: HumanPresenceRegistry;
  sessions: HumanSessions;
  developerTeam: DeveloperTeamRegistry;
  broadcast: () => void;
}) {
  const { app, store, humans, sessions, developerTeam, broadcast } = input;
  const identity = (taskId: string) => ({ roomId: CANONICAL_ROOM_ID, taskId });
  const humanActor = (request: express.Request): TaskActor | null => {
    const human = sessionHuman(request, humans, sessions);
    return human ? { id: human.id, roomRole: "owner" } : null;
  };
  const requireHuman = (request: express.Request, response: express.Response) => {
    const actor = response.locals.taskActor as TaskActor | undefined || humanActor(request);
    if (!actor) response.status(401).json({ error: "Join the room before managing tasks." });
    return actor;
  };
  app.use("/api/tasks", (request, response, next) => {
    const actor = humanActor(request);
    if (!actor) return response.status(401).json({ error: "Join the room before managing tasks." });
    response.locals.taskActor = actor;
    next();
  });
  const rejectIdentity = (request: express.Request, response: express.Response) => {
    if (!containsForbiddenIdentity(request.body)) return false;
    response.status(400).json({ error: "Room, actor, attribution, and developer-role identity are server-derived." });
    return true;
  };
  const mutate = async (request: express.Request, response: express.Response, change: TaskChange) => {
    const actor = requireHuman(request, response); if (!actor || rejectIdentity(request, response)) return;
    const revision = expectedRevision(request.body?.expectedRevision);
    if (!revision) return response.status(400).json({ error: "A positive expectedRevision is required." });
    return sendResult(response, await store.applyTaskChange(identity(String(request.params.taskId)), revision, change, actor, new Date().toISOString()), broadcast);
  };

  app.get("/api/tasks", async (request, response) => {
    if (!requireHuman(request, response)) return;
    const states = typeof request.query.state === "string" ? request.query.state.split(",").filter((state): state is typeof TASK_LIFECYCLE_STATES[number] => TASK_LIFECYCLE_STATES.includes(state as never)) : undefined;
    response.set("Cache-Control", "no-store").json(await store.listTasks({ roomId: CANONICAL_ROOM_ID, states, cursor: typeof request.query.cursor === "string" ? request.query.cursor : undefined, limit: Number(request.query.limit) || 50 }));
  });
  app.post("/api/tasks", async (request, response) => {
    const actor = requireHuman(request, response); if (!actor || rejectIdentity(request, response)) return;
    try {
      const task = createTask({ roomId: CANONICAL_ROOM_ID, taskId: randomUUID(), title: request.body?.title, description: request.body?.description, actor, now: new Date().toISOString() });
      const result = await store.createTask(task);
      if (result.kind === "created") { broadcast(); return response.status(201).json(result.task); }
      return response.status(result.kind === "conflict" ? 409 : 422).json({ error: result.kind === "rejected" ? result.reason : "Task ID conflict." });
    } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "Invalid task." }); }
  });
  app.get("/api/tasks/:taskId", async (request, response) => {
    if (!requireHuman(request, response)) return;
    const task = await store.getTask(identity(String(request.params.taskId)));
    if (!task) return response.status(404).json({ error: "Task not found." });
    response.set("Cache-Control", "no-store").json({ task, history: await store.listTaskEvents(identity(String(request.params.taskId))), relationships: await store.getTaskDependencies(identity(String(request.params.taskId))) });
  });
  app.patch("/api/tasks/:taskId", (request, response) => {
    const fields = Object.keys(request.body || {}).filter((key) => key !== "expectedRevision");
    if (fields.length !== 1 || !["title", "description"].includes(fields[0]!)) return response.status(400).json({ error: "Change exactly one editable field." });
    return mutate(request, response, fields[0] === "title" ? { kind: "set_title", title: request.body.title } : { kind: "set_description", description: request.body.description });
  });
  const transition = (to: typeof TASK_LIFECYCLE_STATES[number]) => (request: express.Request, response: express.Response) => mutate(request, response, { kind: "transition", to });
  app.post("/api/tasks/:taskId/approve", transition("approved"));
  app.post("/api/tasks/:taskId/start", transition("active"));
  app.post("/api/tasks/:taskId/block", transition("blocked"));
  app.post("/api/tasks/:taskId/unblock", transition("active"));
  app.post("/api/tasks/:taskId/abandon", transition("abandoned"));
  app.post("/api/tasks/:taskId/archive", transition("archived"));
  app.post("/api/tasks/:taskId/propose", transition("proposed"));
  app.post("/api/tasks/:taskId/reopen", (request, response) => mutate(request, response, { kind: "reopen", to: request.body?.to === "proposed" ? "proposed" : "draft" }));
  app.post("/api/tasks/:taskId/participants", (request, response) => {
    if (!validParticipant(request.body?.participantId, humans) || !TASK_PARTICIPANT_ROLES.includes(request.body?.role)) return response.status(400).json({ error: "A current room participant and valid task role are required." });
    return mutate(request, response, { kind: request.body?.operation === "remove" ? "remove_participant" : "add_participant", participantId: request.body.participantId, role: request.body.role });
  });
  app.post("/api/tasks/:taskId/dependencies", (request, response) => {
    if (typeof request.body?.taskId !== "string") return response.status(400).json({ error: "A taskId is required." });
    const prefix = request.body?.operation === "remove" ? "remove" : "add";
    const relation = request.body?.relation === "blocker" ? "blocker" : "dependency";
    return mutate(request, response, { kind: `${prefix}_${relation}` as TaskChange["kind"], task: identity(request.body.taskId) } as TaskChange);
  });
  app.post("/api/tasks/:taskId/references", (request, response) => {
    const reference = request.body?.reference as Omit<TaskReference, "addedAt" | "addedBy">;
    if (!reference || typeof reference !== "object") return response.status(400).json({ error: "An immutable reference is required." });
    return mutate(request, response, { kind: "append_reference", reference });
  });
  app.post("/api/tasks/:taskId/assign", async (request, response) => {
    if (typeof request.body?.assignmentId !== "string") return response.status(400).json({ error: "An existing assignmentId is required." });
    if (!await store.getAssignment(request.body.assignmentId)) return response.status(404).json({ error: "Assignment not found." });
    return mutate(request, response, { kind: "append_reference", reference: { id: randomUUID(), kind: "assignment", targetId: request.body.assignmentId, completionState: request.body?.completionState === "finished" ? "finished" : "unfinished" } });
  });
  app.post("/api/tasks/:taskId/complete", async (request, response) => {
    const actor = requireHuman(request, response); if (!actor || rejectIdentity(request, response)) return;
    const revision = expectedRevision(request.body?.expectedRevision);
    if (!revision) return response.status(400).json({ error: "A positive expectedRevision is required." });
    const evidence = request.body?.evidence;
    if (!evidence || typeof evidence.targetId !== "string") return response.status(400).json({ error: "Completion evidence is required." });
    const current = await store.getTask(identity(String(request.params.taskId)));
    if (!current) return response.status(404).json({ error: "Task not found." });
    if (current.revision !== revision) return response.status(409).json({ error: "Task changed since it was loaded.", kind: "conflict", expectedRevision: revision, actualRevision: current.revision });
    if (current.state !== "active" && current.state !== "blocked") return response.status(422).json({ error: "Only active or blocked tasks can be completed." });
    const dispositions = (Array.isArray(request.body?.dispositions) ? request.body.dispositions : []) as Array<{ id?: string; targetId: string; dispositionFor: string }>;
    if (dispositions.some((value) => !value || typeof value.targetId !== "string" || typeof value.dispositionFor !== "string")) return response.status(400).json({ error: "Every disposition requires targetId and dispositionFor." });
    const disposed = new Set([...current.references.filter(({ kind }) => kind === "disposition").map(({ dispositionFor }) => dispositionFor), ...dispositions.map((value) => value.dispositionFor)]);
    const unresolved = current.references.filter((reference) => (reference.kind === "assignment" || reference.completionState === "unfinished") && !disposed.has(reference.id));
    if (unresolved.length) return response.status(422).json({ error: "Completion requires a disposition for every unfinished assignment or artifact.", unresolved: unresolved.map(({ id }) => id) });
    const changes: TaskChange[] = [{ kind: "append_reference", reference: { id: evidence.id || randomUUID(), kind: "evidence", targetId: evidence.targetId, uri: evidence.uri, contentHash: evidence.contentHash } }];
    for (const disposition of dispositions) changes.push({ kind: "append_reference", reference: { id: disposition.id || randomUUID(), kind: "disposition", targetId: disposition.targetId, dispositionFor: disposition.dispositionFor } });
    changes.push({ kind: "transition", to: "completed" });
    return sendResult(response, await store.applyTaskChanges(identity(String(request.params.taskId)), revision, changes, actor, new Date().toISOString()), broadcast);
  });
  app.post("/api/tasks/:taskId/fork", async (request, response) => {
    const actor = requireHuman(request, response); if (!actor || rejectIdentity(request, response)) return;
    const revision = expectedRevision(request.body?.expectedRevision);
    if (!revision) return response.status(400).json({ error: "A positive expectedRevision is required." });
    return sendResult(response, await store.forkTask(identity(String(request.params.taskId)), revision, randomUUID(), actor, new Date().toISOString(), request.body?.title), broadcast);
  });

  const developerActor = (request: express.Request, capability: "TASK_READ" | "TASK_PROPOSE" | "TASK_UPDATE") => {
    const auth = developerTeam.authenticate(request.header("authorization"), capability);
    return auth ? { auth, actor: { id: auth.member.memberId, memberRevision: auth.member.revision } satisfies TaskActor } : null;
  };
  app.get("/api/developer/tasks", async (request, response) => {
    if (!developerActor(request, "TASK_READ")) return response.status(404).json({ error: "Not found." });
    response.json(await store.listTasks({ roomId: CANONICAL_ROOM_ID, limit: Math.min(100, Number(request.query.limit) || 50) }));
  });
  app.get("/api/developer/tasks/:taskId", async (request, response) => {
    if (!developerActor(request, "TASK_READ")) return response.status(404).json({ error: "Not found." });
    const task = await store.getTask(identity(String(request.params.taskId)));
    return task ? response.json(task) : response.status(404).json({ error: "Task not found." });
  });
  app.post("/api/developer/tasks", async (request, response) => {
    const context = developerActor(request, "TASK_PROPOSE"); if (!context) return response.status(404).json({ error: "Not found." });
    if (rejectIdentity(request, response)) return;
    try {
      const now = new Date().toISOString();
      const task = createTask({ roomId: CANONICAL_ROOM_ID, taskId: randomUUID(), title: request.body?.title, description: request.body?.description, actor: context.actor, now });
      const proposed = await store.createTaskWithChanges(task, [{ kind: "transition", to: "proposed" }], context.actor, now);
      if (proposed.kind !== "created") return response.status(proposed.kind === "conflict" ? 409 : 422).json({ error: proposed.kind === "rejected" ? proposed.reason : "Task conflict." });
      broadcast(); return response.status(201).json(proposed.task);
    } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "Invalid task." }); }
  });
  app.patch("/api/developer/tasks/:taskId", async (request, response) => {
    const context = developerActor(request, "TASK_UPDATE"); if (!context) return response.status(404).json({ error: "Not found." });
    if (rejectIdentity(request, response)) return;
    const revision = expectedRevision(request.body?.expectedRevision);
    const change = request.body?.change as TaskChange;
    if (!revision || !change || !["set_title", "set_description", "append_reference"].includes(change.kind)) return response.status(400).json({ error: "Developers may update only task text and immutable references with expectedRevision." });
    if (change.kind === "append_reference" && !["message", "document_revision", "evidence"].includes(change.reference?.kind)) return response.status(403).json({ error: "This reference kind is outside developer task scope." });
    return sendResult(response, await store.applyTaskChange(identity(String(request.params.taskId)), revision, change, context.actor, new Date().toISOString()), broadcast);
  });
}
