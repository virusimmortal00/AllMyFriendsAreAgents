import type express from "express";
import { ControlError, controlRoute, type ControlPlaneStore } from "./control-plane.js";
import type { ProjectGitHubBindingService } from "./project-github-binding.js";

type ProjectBindings = Pick<ProjectGitHubBindingService, "inspect" | "configure" | "inspectRepair" | "repair">;

export function registerProjectGitHubBindingRoutes(input: {
  readonly app: express.Express;
  readonly control: ControlPlaneStore;
  readonly bindings: ProjectBindings;
  readonly projectExists?: (projectId: string) => boolean | Promise<boolean>;
  readonly currentProjectId?: string;
  readonly defaultsForProject?: (projectId: string) => { readonly checkoutPath: string; readonly worktreeRoot: string; readonly policyRevision: number } | undefined;
}) {
  const { app, control, bindings, projectExists = () => true, currentProjectId, defaultsForProject = () => undefined } = input;

  const inspect = async (request: express.Request, response: express.Response, projectId: string) => {
    control.require(request, "INTEGRATION_VIEW");
    if (!await projectExists(projectId)) throw new ControlError(404, "Project repository configuration was not found.");
    const status = bindings.inspect(projectId);
    if (!status) throw new ControlError(404, "Project repository configuration was not found.");
    const defaults = defaultsForProject(projectId);
    response.set("Cache-Control", "no-store").json({ ...status, ...(defaults ? { defaults } : {}),
      repair: { href: `/api/control/projects/${encodeURIComponent(projectId)}/repository/repair`, method: "POST",
        capability: "PROJECT_REPOSITORY_CONFIGURE", accountReauthorizationReplacesPaths: false } });
  };

  const inspectRepair = async (request: express.Request, response: express.Response, projectId: string) => {
    control.require(request, "INTEGRATION_VIEW");
    if (!await projectExists(projectId)) throw new ControlError(404, "Project repository configuration was not found.");
    const status = bindings.inspect(projectId);
    if (!status) throw new ControlError(404, "Project repository configuration was not found.");
    response.set("Cache-Control", "no-store").json({ ...status, repair: await bindings.inspectRepair(projectId) });
  };

  const repair = async (request: express.Request, response: express.Response, projectId: string) => {
    const actor = control.require(request, "PROJECT_REPOSITORY_CONFIGURE", true).principal;
    if (!await projectExists(projectId)) throw new ControlError(404, "Project repository configuration was not found.");
    // Deliberately accept no account, remote, branch, policy or credential overrides.
    const result = await bindings.repair({ projectId, expectedBindingRevision: request.body?.expectedBindingRevision,
      expectedRepositoryRevision: request.body?.expectedRepositoryRevision, idempotencyKey: request.body?.idempotencyKey,
      checkoutPath: request.body?.checkoutPath, worktreeRoot: request.body?.worktreeRoot });
    await control.recordAudit(actor.id, result.kind === "ok" ? "PROJECT_REPOSITORY_REPAIRED" : "PROJECT_REPOSITORY_REPAIR_FAILED", projectId, {
      state: result.kind,
      ...(result.kind === "ok" ? { nextRevision: result.value.repository.revision ?? 0 }
        : { reason: result.kind === "conflict" ? `${result.scope}-revision-conflict` : "repair-rejected" }),
    });
    response.set("Cache-Control", "no-store").status(result.kind === "ok" ? 200 : result.kind === "conflict" ? 409 : 422)
      .json(result.kind === "ok" ? result.value : result);
  };

  const configure = async (request: express.Request, response: express.Response, projectId: string) => {
    const actor = control.require(request, "PROJECT_REPOSITORY_CONFIGURE", true).principal;
    if (!await projectExists(projectId)) throw new ControlError(404, "Project repository configuration was not found.");
    const result = await bindings.configure({
      projectId,
      githubConnectionId: request.body?.githubConnectionId,
      githubRepositoryId: request.body?.githubRepositoryId,
      expectedBindingRevision: request.body?.expectedBindingRevision,
      expectedRepositoryRevision: request.body?.expectedRepositoryRevision,
      checkoutPath: request.body?.checkoutPath,
      worktreeRoot: request.body?.worktreeRoot,
      protectedBranches: request.body?.protectedBranches,
      policyRevision: request.body?.policyRevision,
      validationCommands: request.body?.validationCommands,
      sensitivePaths: request.body?.sensitivePaths,
    });
    if (result.kind !== "ok") {
      await control.recordAudit(actor.id, "PROJECT_REPOSITORY_CONFIGURATION_FAILED", undefined, {
        state: result.kind,
        reason: result.kind === "conflict" ? `${result.scope}-revision-conflict` : "configuration-rejected",
        ...(result.kind === "conflict" ? { nextRevision: result.actualRevision } : {}),
      });
      return response.status(result.kind === "conflict" ? 409 : 422).json(result);
    }
    await control.recordAudit(actor.id, "PROJECT_REPOSITORY_CONFIGURED", projectId, {
      state: result.value.repository.state ?? "verified",
      nextRevision: result.value.repository.revision ?? 0,
    });
    response.set("Cache-Control", "no-store").json(result.value);
  };

  app.get("/api/control/projects/current/repository", controlRoute(async (request, response) => {
    if (!currentProjectId) throw new ControlError(404, "Current project repository configuration is unavailable.");
    return inspect(request, response, currentProjectId);
  }));
  app.put("/api/control/projects/current/repository", controlRoute(async (request, response) => {
    if (!currentProjectId) throw new ControlError(404, "Current project repository configuration is unavailable.");
    return configure(request, response, currentProjectId);
  }));
  app.get("/api/control/projects/:projectId/repository", controlRoute((request, response) => inspect(request, response, String(request.params.projectId))));
  app.put("/api/control/projects/:projectId/repository", controlRoute((request, response) => configure(request, response, String(request.params.projectId))));
  app.get("/api/control/projects/current/repository/repair", controlRoute(async (request, response) => {
    if (!currentProjectId) throw new ControlError(404, "Current project repository configuration is unavailable.");
    return inspectRepair(request, response, currentProjectId);
  }));
  app.post("/api/control/projects/current/repository/repair", controlRoute(async (request, response) => {
    if (!currentProjectId) throw new ControlError(404, "Current project repository configuration is unavailable.");
    return repair(request, response, currentProjectId);
  }));
  app.get("/api/control/projects/:projectId/repository/repair", controlRoute((request, response) => inspectRepair(request, response, String(request.params.projectId))));
  app.post("/api/control/projects/:projectId/repository/repair", controlRoute((request, response) => repair(request, response, String(request.params.projectId))));
}
