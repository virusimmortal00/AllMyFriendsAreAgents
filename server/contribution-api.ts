import type express from "express";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import type { ContributionService, CreateHandoffInput } from "./contribution-service.js";
import type { HumanTaskSessions } from "./task-api.js";

export function registerContributionRoutes(input: { app: express.Express; service?: ContributionService; developers: DeveloperTeamRegistry; humans: HumanPresenceRegistry; sessions: HumanTaskSessions }) {
  const { app, service, developers, humans, sessions } = input;
  const human = (request: express.Request) => { const id = sessions.humanId(request.header("cookie")); return id && humans.get(id) ? id : null; };
  const send = (response: express.Response, result: Awaited<ReturnType<ContributionService["approve"]>>) => {
    if (result.kind === "ok") return response.json(result.value); if (result.kind === "not_found") return response.status(404).json({ error: "Contribution not found." });
    if (result.kind === "conflict") return response.status(409).json(result); if (result.kind === "failed") return response.status(result.retryable ? 503 : 502).json(result); return response.status(422).json(result);
  };
  app.get("/api/contributions", (request, response) => { if (!service || !human(request)) return response.status(404).json({ error: "Not found." }); return response.set("Cache-Control", "no-store").json({ items: service.list() }); });
  app.get("/api/contributions/:id", (request, response) => { if (!service || !human(request)) return response.status(404).json({ error: "Not found." }); const record = service.get(String(request.params.id)); return record ? response.set("Cache-Control", "no-store").json({ contribution: record, audit: service.audit(record.contributionId) }) : response.status(404).json({ error: "Contribution not found." }); });
  app.post("/api/contributions/:id/approve/:kind", async (request, response) => { const actor = human(request); if (!service || !actor) return response.status(404).json({ error: "Not found." }); const kind = parseKind(request.params.kind); if (!kind || !positive(request.body?.expectedRevision)) return response.status(400).json({ error: "A valid gate and expectedRevision are required." }); return send(response, await service.approve(actor, String(request.params.id), request.body.expectedRevision, kind, request.body || {})); });
  app.post("/api/contributions/:id/execute/:kind", async (request, response) => { const actor = human(request); if (!service || !actor) return response.status(404).json({ error: "Not found." }); const kind = parseKind(request.params.kind); if (!kind || !positive(request.body?.expectedRevision)) return response.status(400).json({ error: "A valid gate and expectedRevision are required." }); return send(response, await service.execute(actor, String(request.params.id), request.body.expectedRevision, kind)); });

  const developerRead = (request: express.Request) => developers.authenticate(request.header("authorization"), "CONTRIBUTION_HANDOFF") || developers.authenticate(request.header("authorization"), "CONTRIBUTION_REVIEW", "REVIEWER");
  app.get("/api/developer/contributions", (request, response) => { if (!service || !developerRead(request)) return response.status(404).json({ error: "Not found." }); return response.json({ items: service.list() }); });
  app.get("/api/developer/contributions/:id", (request, response) => { if (!service || !developerRead(request)) return response.status(404).json({ error: "Not found." }); const record = service.get(String(request.params.id)); return record ? response.json({ contribution: record, audit: service.audit(record.contributionId) }) : response.status(404).json({ error: "Contribution not found." }); });
  app.post("/api/developer/contributions", async (request, response) => { const auth = developers.authenticate(request.header("authorization"), "CONTRIBUTION_HANDOFF"); if (!service || !auth) return response.status(404).json({ error: "Not found." }); const result = await service.create(auth, request.body as CreateHandoffInput); if (result.kind === "ok") return response.status(201).json(result.value); return send(response, result); });
  app.post("/api/developer/contributions/:id/review", async (request, response) => { const auth = developers.authenticate(request.header("authorization"), "CONTRIBUTION_REVIEW", "REVIEWER"); if (!service || !auth) return response.status(404).json({ error: "Not found." }); if (!positive(request.body?.expectedRevision) || !["ACCEPTED", "REJECTED"].includes(request.body?.decision)) return response.status(400).json({ error: "Expected revision and review decision are required." }); return send(response, await service.review(auth, String(request.params.id), request.body.expectedRevision, request.body.decision, request.body.summary)); });
}

function positive(value: unknown) { return Number.isSafeInteger(value) && Number(value) > 0; }
function parseKind(value: unknown) { const upper = String(value).toUpperCase(); return ["PUBLICATION", "MERGE", "DEPLOYMENT"].includes(upper) ? upper as "PUBLICATION" | "MERGE" | "DEPLOYMENT" : null; }
