import type express from "express";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import { publicRepositoryConnectionStatus, type ProjectRepositoryConnectionService } from "./project-repository-connection.js";

function privateService(request: express.Request, developers: DeveloperTeamRegistry, service: ProjectRepositoryConnectionService) {
  return developers.authenticate(request.header("authorization"), "ASSIGNMENT_WRITE", "OPERATOR") ? service : undefined;
}

export function registerProjectRepositoryRoutes(input: { app: express.Express; developers: DeveloperTeamRegistry; service: ProjectRepositoryConnectionService }) {
  const { app, developers, service } = input;
  app.get("/api/developer/project/repository", (request, response) => {
    if (!developers.authenticate(request.header("authorization"), "IMPROVEMENT_READ")) return response.status(404).json({ error: "Not found." });
    return response.set("Cache-Control", "no-store").json(service.inspect());
  });
  app.post("/api/developer/project/repository/connect", async (request, response) => {
    const scoped = privateService(request, developers, service); if (!scoped) return response.status(404).json({ error: "Not found." });
    return send(response, await scoped.connect({ expectedRevision: request.body?.expectedRevision, checkoutPath: request.body?.checkoutPath,
      worktreeRoot: request.body?.worktreeRoot, defaultBranch: request.body?.defaultBranch, protectedBranches: request.body?.protectedBranches,
      policyRevision: request.body?.policyRevision, validationCommands: request.body?.validationCommands, sensitivePaths: request.body?.sensitivePaths,
      credentialReference: request.body?.credentialReference }));
  });
  app.post("/api/developer/project/repository/reconcile", async (request, response) => {
    const scoped = privateService(request, developers, service); if (!scoped) return response.status(404).json({ error: "Not found." });
    return send(response, await scoped.reconcile(request.body?.expectedRevision));
  });
  app.post("/api/developer/project/repository/disable", async (request, response) => {
    const scoped = privateService(request, developers, service); if (!scoped) return response.status(404).json({ error: "Not found." });
    return send(response, await scoped.disable(request.body?.expectedRevision));
  });
}

function send(response: express.Response, result: Awaited<ReturnType<ProjectRepositoryConnectionService["connect"]>>) {
  if (result.kind === "ok") return response.json({ connection: publicRepositoryConnectionStatus(result.connection) });
  return response.status(result.kind === "conflict" ? 409 : 403).json(result);
}
