import type express from "express";
import { ControlError, controlRoute, type ControlPlaneStore } from "./control-plane.js";
import { GitHubDeviceAuthorizationFailure, type GitHubDeviceAuthorizationCoordinator, type PublicGitHubDeviceAuthorization } from "./github-device-authorization.js";
import type { GitHubIntegrationStore } from "./github-integration-store.js";
import type { GitHubRepositoryCatalogService } from "./github-repository-catalog-service.js";

type DeviceAuthorizations = Pick<GitHubDeviceAuthorizationCoordinator, "start" | "status" | "poll">;
type IntegrationReader = Pick<GitHubIntegrationStore, "connections">;
type Catalogs = Pick<GitHubRepositoryCatalogService, "inspect" | "refresh">;

export function registerGitHubIntegrationRoutes(input: {
  readonly app: express.Express;
  readonly control: ControlPlaneStore;
  readonly integrations: IntegrationReader;
  readonly authorizations: DeviceAuthorizations;
  readonly catalogs: Catalogs;
}) {
  const { app, control, integrations, authorizations, catalogs } = input;
  const auditedTerminalStates = new Set<string>();

  app.get("/api/control/integrations/github", controlRoute((request, response) => {
    control.require(request, "INTEGRATION_VIEW");
    response.set("Cache-Control", "no-store").json({ connections: integrations.connections() });
  }));

  app.get("/api/control/integrations/github/repositories", controlRoute((request, response) => {
    control.require(request, "INTEGRATION_VIEW");
    const catalog = catalogs.inspect(String(request.query.connectionId ?? ""));
    if (!catalog) throw new ControlError(404, "GitHub repository catalog was not found.");
    response.set("Cache-Control", "no-store").json({ catalog });
  }));

  app.post("/api/control/integrations/github/catalog-refreshes", controlRoute(async (request, response) => {
    const actor = control.require(request, "INTEGRATION_CONFIGURE", true).principal;
    const connectionId = String(request.body?.connectionId ?? "");
    const result = await catalogs.refresh(connectionId, request.body?.expectedRevision);
    if (result.kind !== "ok") {
      await control.recordAudit(actor.id, "GITHUB_CATALOG_REFRESH_FAILED", undefined, { state: result.kind, reason: result.kind === "rejected" ? result.reason : "revision-conflict" });
      if (result.kind === "conflict") return response.status(409).json(result);
      return response.status(403).json(result);
    }
    await control.recordAudit(actor.id, "GITHUB_CATALOG_REFRESHED", connectionId, { state: "ready", repositoryCount: result.value.repositories.length,
      installationCount: result.value.installations.length, nextRevision: result.value.revision });
    response.set("Cache-Control", "no-store").json({ catalog: result.value });
  }));

  app.post("/api/control/integrations/github/device-authorizations", controlRoute(async (request, response) => {
    const actor = control.require(request, "INTEGRATION_CONFIGURE", true).principal;
    const authorization = await authorizations.start(actor.id);
    await control.recordAudit(actor.id, "GITHUB_AUTHORIZATION_STARTED", authorization.flowId, { state: authorization.state });
    response.set("Cache-Control", "no-store").status(201).json({ authorization });
  }));

  app.get("/api/control/integrations/github/device-authorizations/:flowId", controlRoute((request, response) => {
    const actor = control.require(request, "INTEGRATION_CONFIGURE").principal;
    response.set("Cache-Control", "no-store").json({ authorization: ownedStatus(authorizations, String(request.params.flowId), actor.id) });
  }));

  app.post("/api/control/integrations/github/device-authorizations/:flowId/poll", controlRoute(async (request, response) => {
    const actor = control.require(request, "INTEGRATION_CONFIGURE", true).principal;
    const authorization = await ownedPoll(authorizations, String(request.params.flowId), actor.id);
    const auditKey = `${authorization.flowId}:${authorization.state}`;
    if (["ready", "denied", "expired", "failed"].includes(authorization.state) && !auditedTerminalStates.has(auditKey)) {
      auditedTerminalStates.add(auditKey);
      await control.recordAudit(actor.id, authorization.state === "ready" ? "GITHUB_AUTHORIZATION_COMPLETED" : "GITHUB_AUTHORIZATION_FAILED",
        authorization.connection?.connectionId ?? authorization.flowId, { state: authorization.state, reason: authorization.failureReason ?? authorization.state });
    }
    response.set("Cache-Control", "no-store").json({ authorization });
  }));
}

function ownedStatus(authorizations: DeviceAuthorizations, flowId: string, principalId: string): PublicGitHubDeviceAuthorization {
  try { return authorizations.status(flowId, principalId); }
  catch (error) { throw mappedAuthorizationError(error); }
}

async function ownedPoll(authorizations: DeviceAuthorizations, flowId: string, principalId: string) {
  try { return await authorizations.poll(flowId, principalId); }
  catch (error) { throw mappedAuthorizationError(error); }
}

function mappedAuthorizationError(error: unknown) {
  return error instanceof GitHubDeviceAuthorizationFailure ? new ControlError(404, "GitHub device authorization was not found.") : error;
}
