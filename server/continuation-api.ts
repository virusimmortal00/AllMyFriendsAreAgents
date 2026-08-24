import type express from "express";
import { isAgentId } from "../shared/participants.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import type { HumanTaskSessions } from "./task-api.js";
import type { ContinuationService } from "./continuation-service.js";

export function projectContinuationJob(job: Awaited<ReturnType<ContinuationService["list"]>>[number]) {
  return { jobId: job.jobId, jobRevision: job.jobRevision, owner: job.owner, task: job.task, taskRevision: job.taskRevision,
    assignmentId: job.authority.assignmentId, objective: job.objective, trigger: job.trigger, status: job.status, budget: job.budget,
    usage: job.usage, cancellationRequested: job.cancellationRequested, resultDisposition: job.resultDisposition,
    resultSummary: job.resultSummary, blocker: job.blocker, nextEligibilityAt: job.nextEligibilityAt, createdAt: job.createdAt,
    startedAt: job.startedAt, updatedAt: job.updatedAt, completedAt: job.completedAt };
}
function send(response: express.Response, result: { kind: string; [key: string]: unknown }) {
  if (result.kind === "ok") return response.json(result.value);
  if (result.kind === "not_found") return response.status(404).json({ error: "Continuation not found." });
  if (result.kind === "conflict") return response.status(409).json(result);
  return response.status(403).json(result);
}
export function registerContinuationRoutes(input: { app: express.Express; service: ContinuationService; humans: HumanPresenceRegistry; sessions: HumanTaskSessions; developers: DeveloperTeamRegistry; broadcast: () => void }) {
  const { app, service, humans, sessions, developers, broadcast } = input;
  const human = (request: express.Request) => { const id = sessions.humanId(request.header("cookie")); return id && humans.get(id) ? id : undefined; };
  app.use("/api/continuations", (request, response, next) => { const actor = human(request); if (!actor) return response.status(401).json({ error: "Join the room before managing continuations." }); response.locals.continuationActor = actor; next(); });
  app.get("/api/continuations", async (_request, response) => response.set("Cache-Control", "no-store").json({ policy: await service.policy(), jobs: (await service.list()).map(projectContinuationJob) }));
  app.patch("/api/continuations/policy", async (request, response) => { const revision = Number(request.body?.expectedRevision); if (!Number.isSafeInteger(revision) || typeof request.body?.enabled !== "boolean") return response.status(400).json({ error: "expectedRevision and enabled are required." }); const result = await service.updatePolicy(revision, { enabled: request.body.enabled }, response.locals.continuationActor); if (result.kind === "accepted") { broadcast(); return response.json(result.value); } return response.status(result.kind === "not_found" ? 404 : 409).json(result); });
  app.post("/api/continuations/:jobId/cancel", async (request, response) => { const result = await service.cancel(String(request.params.jobId)); broadcast(); return send(response, result); });
  app.post("/api/continuations/:jobId/resume", async (request, response) => { const result = await service.resume(String(request.params.jobId)); broadcast(); return send(response, result); });
  app.get("/api/continuations/inbox/:owner", async (request, response) => { const owner = String(request.params.owner); if (!isAgentId(owner)) return response.status(400).json({ error: "Valid agent owner required." }); return response.json(await service.inbox(owner)); });
  app.post("/api/continuations/inbox/:entryId/acknowledge", async (request, response) => { const result = await service.acknowledgeInbox(String(request.params.entryId), request.body?.close === true); broadcast(); return send(response, result); });

  app.post("/api/developer/continuations", async (request, response) => {
    const authenticated = developers.authenticate(request.header("authorization"), "CONTINUATION_RUN"); if (!authenticated) return response.status(404).json({ error: "Not found." });
    if (!isAgentId(request.body?.owner)) return response.status(400).json({ error: "Valid owner is required." });
    const result = await service.create({ owner: request.body.owner, developerMemberId: authenticated.member.memberId, developerMemberConfigRevision: authenticated.member.revision, taskId: request.body?.taskId, taskRevision: request.body?.taskRevision,
      assignmentReferenceId: request.body?.assignmentReferenceId, objective: request.body?.objective, trigger: request.body?.trigger, budget: request.body?.budget });
    broadcast(); return send(response, result);
  });
  app.get("/api/developer/continuations/context/:owner", async (request, response) => {
    const authenticated = developers.authenticate(request.header("authorization"), "CONTINUATION_RUN"); if (!authenticated) return response.status(404).json({ error: "Not found." });
    const owner = String(request.params.owner); if (!isAgentId(owner)) return response.status(400).json({ error: "Valid owner is required." });
    if (!(await service.list(owner)).some((job) => job.authority.developerMemberId === authenticated.member.memberId && job.authority.developerMemberConfigRevision === authenticated.member.revision)) return response.status(403).json({ error: "Developer identity does not own this agent's continuation authority." });
    response.json(await service.contextForAgent(owner, { taskId: typeof request.query.taskId === "string" ? request.query.taskId : undefined,
      assignmentId: typeof request.query.assignmentId === "string" ? request.query.assignmentId : undefined, characterBudget: Number(request.query.characterBudget) || undefined,
      limit: Number(request.query.limit) || undefined }));
  });
}
