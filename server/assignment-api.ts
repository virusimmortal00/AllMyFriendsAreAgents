import type express from "express";
import type { AssignmentLifecycleService } from "./assignment-lifecycle.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";

async function send(response: express.Response, result: { readonly kind: string; readonly [key: string]: unknown }, onChanged?: () => void | Promise<void>) {
  if (result.kind === "ok") await onChanged?.();
  if (result.kind === "ok") return response.json(result.value);
  if (result.kind === "unauthorized") return response.status(404).json({ error: "Not found." });
  if (result.kind === "not_found") return response.status(404).json({ error: "Assignment not found." });
  if (result.kind === "conflict") return response.status(409).json(result);
  return response.status(403).json(result);
}

export function registerAssignmentRoutes(input: { app: express.Express; service: AssignmentLifecycleService; developers: DeveloperTeamRegistry; onChanged?: () => void | Promise<void> }) {
  const { app, service, developers, onChanged } = input;
  app.get("/api/developer/assignments", async (request, response) => {
    if (!developers.authenticate(request.header("authorization"), "IMPROVEMENT_READ")) return response.status(404).json({ error: "Not found." });
    response.set("Cache-Control", "no-store").json({ metadata: service.metadata, assignments: await service.list() });
  });
  app.post("/api/developer/assignments", async (request, response) => send(response, await service.create(request.header("authorization"), {
    assignmentId: request.body?.assignmentId, improvementId: request.body?.improvementId, agent: request.body?.agent,
    baseRef: request.body?.baseRef, fencingToken: request.body?.fencingToken, manifestRevision: request.body?.manifestRevision,
  }), onChanged));
  app.post("/api/developer/assignments/reconcile", async (request, response) => {
    if (!developers.authenticate(request.header("authorization"), "ASSIGNMENT_WRITE")) return response.status(404).json({ error: "Not found." });
    const assignments = await service.reconcile();
    await onChanged?.();
    response.json({ metadata: service.metadata, assignments });
  });
  app.post("/api/developer/assignments/cleanup", async (request, response) => {
    if (!developers.authenticate(request.header("authorization"), "ASSIGNMENT_WRITE")) return response.status(404).json({ error: "Not found." });
    const assignments = await service.cleanup();
    await onChanged?.();
    response.json({ metadata: service.metadata, assignments });
  });
  app.post("/api/developer/assignments/:id/cancel", async (request, response) => send(response, await service.cancel(request.header("authorization"), {
    assignmentId: String(request.params.id), expectedRevision: request.body?.expectedRevision, idempotencyKey: request.body?.idempotencyKey,
  }), onChanged));
  app.post("/api/developer/assignments/:id/dispose", async (request, response) => send(response, await service.dispose(request.header("authorization"), {
    assignmentId: String(request.params.id), expectedRevision: request.body?.expectedRevision, idempotencyKey: request.body?.idempotencyKey,
    confirmDisposable: request.body?.confirmDisposable,
  }), onChanged));
}
