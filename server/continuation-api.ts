import type express from "express";
import { isAgentId } from "../shared/participants.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import { sessionHuman, type HumanSessions } from "./human-session.js";
import type { ContinuationProgressChannel, ContinuationService } from "./continuation-service.js";
import { redactContinuationText } from "./continuation-record.js";
import type { RoomContinuationWorkRequest } from "../shared/protocol.js";

export function projectContinuationJob(job: Awaited<ReturnType<ContinuationService["list"]>>[number]) {
  return { jobId: job.jobId, jobRevision: job.jobRevision, owner: job.owner, task: job.task, taskRevision: job.taskRevision,
    assignmentId: job.authority.assignmentId, objective: redactContinuationText(job.objective), trigger: redactContinuationText(job.trigger), status: job.status, budget: job.budget,
    usage: job.usage, cancellationRequested: job.cancellationRequested, resultDisposition: job.resultDisposition,
    resultSummary: job.resultSummary ? redactContinuationText(job.resultSummary) : null, blocker: job.blocker ? redactContinuationText(job.blocker) : null, nextEligibilityAt: job.nextEligibilityAt, createdAt: job.createdAt,
    startedAt: job.startedAt, updatedAt: job.updatedAt, completedAt: job.completedAt };
}
export function projectContinuationAudit(event: Awaited<ReturnType<ContinuationService["audit"]>>[number]) { return { eventId: event.eventId, jobId: event.jobId, jobRevision: event.jobRevision, attempt: event.attempt, trigger: redactContinuationText(event.trigger), policyRevision: event.policyRevision, at: event.at, action: event.action, fromStatus: event.fromStatus, toStatus: event.toStatus, usage: event.usage, attemptUsage: event.attemptUsage, result: event.result ? redactContinuationText(event.result) : null, nextEligibilityAt: event.nextEligibilityAt }; }
export function continuationCreateValidationError(body: unknown) { const value = body as Record<string, unknown> | null; if (!value || typeof value !== "object" || !isAgentId(value.owner) || typeof value.taskId !== "string" || !value.taskId.trim() || typeof value.assignmentReferenceId !== "string" || !value.assignmentReferenceId.trim() || !Number.isSafeInteger(value.taskRevision) || Number(value.taskRevision) < 1 || typeof value.objective !== "string" || !value.objective.trim() || value.objective.length > 4_000 || typeof value.trigger !== "string" || !value.trigger.trim() || value.trigger.length > 500 || !validBudgetShape(value.budget)) return "Bounded owner, task, assignment reference, objective, trigger, revision, and budget fields are required."; return null; }
export function roomContinuationRequestValidationError(body: unknown) {
  const value = body as Partial<RoomContinuationWorkRequest> | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["taskId", "taskRevision", "assignmentReferenceId", "objective", "budget"].includes(key))
    || typeof value.taskId !== "string" || !value.taskId.trim() || !Number.isSafeInteger(value.taskRevision) || Number(value.taskRevision) < 1
    || typeof value.assignmentReferenceId !== "string" || !value.assignmentReferenceId.trim() || typeof value.objective !== "string" || !value.objective.trim()
    || value.objective.length > 4_000 || !validBudgetShape(value.budget)) return "A bounded objective with exact task revision and assignment reference is required.";
  return null;
}
export function roomContinuationRequestsMatch(left: RoomContinuationWorkRequest | undefined, right: RoomContinuationWorkRequest | undefined) {
  if (!left || !right) return left === right;
  const budgetKeys = ["timeMs", "tokenLimit", "toolCallLimit", "retryLimit"] as const;
  return left.taskId === right.taskId && left.taskRevision === right.taskRevision && left.assignmentReferenceId === right.assignmentReferenceId
    && left.objective === right.objective && budgetKeys.every((key) => left.budget?.[key] === right.budget?.[key]);
}
function send(response: express.Response, result: { kind: string; [key: string]: unknown }) {
  if (result.kind === "ok") return response.json(result.value);
  if (result.kind === "not_found") return response.status(404).json({ error: "Continuation not found." });
  if (result.kind === "conflict") return response.status(409).json(result);
  return response.status(403).json(result);
}
export function registerContinuationRoutes(input: { app: express.Express; service: ContinuationService; progressChannel?: ContinuationProgressChannel; humans: HumanPresenceRegistry; sessions: HumanSessions; developers: DeveloperTeamRegistry; broadcast: () => void }) {
  const { app, service, progressChannel, humans, sessions, developers, broadcast } = input;
  const human = (request: express.Request) => sessionHuman(request, humans, sessions)?.id;
  app.post("/api/continuation-executor/progress/:jobId/:attempt", async (request, response) => { if (!progressChannel) return response.status(404).json({ error: "Not found." }); const attempt = Number(request.params.attempt); if (!Number.isSafeInteger(attempt) || attempt < 1) return response.status(400).json({ error: "Valid continuation attempt required." }); const result = await progressChannel.handleProgress(String(request.params.jobId), attempt, request.header("authorization"), request.body); return result === "accepted" ? response.status(202).json({ accepted: true }) : result === "unauthorized" ? response.status(401).json({ error: "Invalid progress authorization." }) : result === "invalid" ? response.status(400).json({ error: "Valid bounded progress state required." }) : response.status(409).json({ error: "Continuation attempt is stale." }); });
  app.use("/api/continuations", (request, response, next) => { const actor = human(request); if (!actor) return response.status(401).json({ error: "Join the room before managing continuations." }); response.locals.continuationActor = actor; next(); });
  app.get("/api/continuations", async (_request, response) => response.set("Cache-Control", "no-store").json({ policy: await service.policy(), jobs: (await service.list()).map(projectContinuationJob) }));
  app.patch("/api/continuations/policy", async (request, response) => { const revision = Number(request.body?.expectedRevision); if (!Number.isSafeInteger(revision) || typeof request.body?.enabled !== "boolean") return response.status(400).json({ error: "expectedRevision and enabled are required." }); const result = await service.updatePolicy(revision, { enabled: request.body.enabled }, response.locals.continuationActor); if (result.kind === "accepted") { broadcast(); return response.json(result.value); } return response.status(result.kind === "not_found" ? 404 : 409).json(result); });
  app.post("/api/continuations/:jobId/cancel", async (request, response) => { const result = await service.cancel(String(request.params.jobId)); broadcast(); return send(response, result); });
  app.post("/api/continuations/:jobId/resume", async (request, response) => { const result = await service.resume(String(request.params.jobId)); broadcast(); return send(response, result); });
  app.get("/api/continuations/:jobId/audit", async (request, response) => response.json((await service.audit(String(request.params.jobId))).map(projectContinuationAudit)));
  app.get("/api/continuations/inbox/:owner", async (request, response) => { const owner = String(request.params.owner); if (!isAgentId(owner)) return response.status(400).json({ error: "Valid agent owner required." }); return response.json(await service.inbox(owner)); });
  app.post("/api/continuations/inbox/:entryId/acknowledge", async (request, response) => { const result = await service.acknowledgeInbox(String(request.params.entryId), request.body?.close === true); broadcast(); return send(response, result); });

  app.post("/api/developer/continuations", async (request, response) => {
    const authenticated = developers.authenticate(request.header("authorization"), "CONTINUATION_RUN"); if (!authenticated) return response.status(404).json({ error: "Not found." });
    const validationError = continuationCreateValidationError(request.body); if (validationError) return response.status(400).json({ error: validationError });
    const result = await service.create({ owner: request.body.owner, developerMemberId: authenticated.member.memberId, developerMemberConfigRevision: authenticated.member.revision, taskId: request.body?.taskId, taskRevision: request.body?.taskRevision,
      assignmentReferenceId: request.body?.assignmentReferenceId, objective: request.body?.objective, trigger: request.body?.trigger, budget: request.body?.budget });
    broadcast(); return send(response, result);
  });
  app.get("/api/developer/continuations/context/:owner", async (request, response) => {
    const authenticated = developers.authenticate(request.header("authorization"), "CONTINUATION_RUN"); if (!authenticated) return response.status(404).json({ error: "Not found." });
    const owner = String(request.params.owner); if (!isAgentId(owner)) return response.status(400).json({ error: "Valid owner is required." });
    const taskId = typeof request.query.taskId === "string" ? request.query.taskId : ""; const assignmentId = typeof request.query.assignmentId === "string" ? request.query.assignmentId : ""; const assignmentReferenceId = typeof request.query.assignmentReferenceId === "string" ? request.query.assignmentReferenceId : "";
    if (!taskId || !assignmentId || !assignmentReferenceId) return response.status(400).json({ error: "Exact taskId, assignmentId, and assignmentReferenceId provenance is required." });
    const context = await service.contextForDeveloper(owner, { taskId, assignmentId, assignmentReferenceId, developerMemberId: authenticated.member.memberId, developerMemberConfigRevision: authenticated.member.revision, characterBudget: Number(request.query.characterBudget) || undefined, limit: Number(request.query.limit) || undefined });
    if (!context.length) return response.status(403).json({ error: "No current continuation authority matches this exact provenance." });
    response.json(context);
  });
}
function validBudgetShape(value: unknown) { if (value === undefined) return true; if (!value || typeof value !== "object" || Array.isArray(value)) return false; const budget = value as Record<string, unknown>; return Object.keys(budget).every((key) => ["timeMs", "tokenLimit", "toolCallLimit", "retryLimit"].includes(key)) && Object.values(budget).every((item) => Number.isSafeInteger(item) && Number(item) >= 0); }
