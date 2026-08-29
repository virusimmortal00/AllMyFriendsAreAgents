import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_SESSION_COOKIE, ControlPlaneStore } from "./control-plane.js";
import { EncryptedGitHubCredentialVault } from "./github-credential-vault.js";
import { GitHubDeviceAuthorizationCoordinator } from "./github-device-authorization.js";
import type { GitHubDeviceFlowTransport } from "./github-device-flow.js";
import { registerGitHubIntegrationRoutes } from "./github-integration-api.js";
import { GitHubIntegrationStore } from "./github-integration-store.js";
import { GitHubRepositoryCatalogClient } from "./github-repository-catalog.js";
import { GitHubRepositoryCatalogService } from "./github-repository-catalog-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("GitHub integration control-plane API", () => {
  it("separates view/configure capabilities, enforces CSRF, binds flows to principals, and audits redacted outcomes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-github-integration-api-"));
    const control = await ControlPlaneStore.open(path.join(directory, "control"), "local-bootstrap-secret-with-32-characters");
    const integrations = await GitHubIntegrationStore.open(path.join(directory, "data"));
    const vault = await EncryptedGitHubCredentialVault.open({ vaultPath: path.join(directory, "data", "credentials.enc"), keyPath: path.join(directory, "keys", "credentials.key") });
    let now = Date.parse("2026-08-28T14:00:00.000Z");
    const flow: GitHubDeviceFlowTransport = {
      start: async () => ({ deviceCode: "device_code_1234567890", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresInSeconds: 900, intervalSeconds: 5 }),
      poll: async () => ({ kind: "authorized", credential: { accessToken: "ghu_access_token_1234567890", tokenType: "bearer", expiresInSeconds: 28_800,
        refreshToken: "ghr_refresh_token_1234567890", refreshTokenExpiresInSeconds: 15_897_600 } }),
      refresh: async () => { throw new Error("unused"); },
    };
    const authorizations = new GitHubDeviceAuthorizationCoordinator(flow, integrations, vault,
      async () => new Response(JSON.stringify({ id: 7, login: "octocat" }), { status: 200 }), () => now);
    const catalogClient = new GitHubRepositoryCatalogClient(async (input) => {
      const url = new URL(input);
      if (url.pathname === "/user/installations") return new Response(JSON.stringify({ total_count: 1, installations: [{ id: 101,
        account: { id: 501, login: "Example", type: "Organization" }, repository_selection: "selected" }] }), { status: 200 });
      return new Response(JSON.stringify({ total_count: 1, repositories: [{ id: 201, name: "One", full_name: "Example/One", owner: { login: "Example" },
        visibility: "private", default_branch: "main" }] }), { status: 200 });
    }, () => new Date(now).toISOString());
    const catalogs = new GitHubRepositoryCatalogService(integrations, vault, catalogClient);
    const app = express(); app.use(express.json()); registerGitHubIntegrationRoutes({ app, control, integrations, authorizations, catalogs,
      configuration: { schemaVersion: 1, appName: "All My Friends Are Agents", appSlug: "all-my-friends-are-agents", clientId: "Iv1.1234567890abcdef" } });
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (route: string, init: RequestInit = {}, cookie = "", csrf = "") => fetch(`${base}${route}`, { ...init, headers: { "content-type": "application/json",
      ...(cookie ? { cookie } : {}), ...(csrf ? { "x-amfaa-csrf": csrf } : {}), ...(init.headers as Record<string, string> | undefined) } });

    expect((await call("/api/control/integrations/github")).status).toBe(401);
    await control.bootstrap("local-bootstrap-secret-with-32-characters", "owner", "correct horse battery staple");
    const owner = await control.authenticate("owner", "correct horse battery staple");
    if (!owner) throw new Error("owner authentication failed");
    const ownerCookie = `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(owner.token)}`;
    const ownerActor = control.require({ header: (name: string) => name.toLowerCase() === "cookie" ? ownerCookie : undefined } as express.Request).principal;
    await control.createPrincipal(ownerActor, { username: "viewer", password: "viewer password long", role: "MEMBER", capabilities: ["INTEGRATION_VIEW"] });
    const viewer = await control.authenticate("viewer", "viewer password long"); if (!viewer) throw new Error("viewer authentication failed");
    const viewerCookie = `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(viewer.token)}`;

    const viewed = await call("/api/control/integrations/github", {}, viewerCookie);
    expect(viewed.status).toBe(200); expect(await viewed.json()).toMatchObject({ app: { name: "All My Friends Are Agents",
      slug: "all-my-friends-are-agents", clientId: "Iv1.1234567890abcdef" }, connections: [] });
    expect((await call("/api/control/integrations/github/device-authorizations", { method: "POST", body: "{}" }, viewerCookie, viewer.csrfToken)).status).toBe(403);
    expect((await call("/api/control/integrations/github/device-authorizations", { method: "POST", body: "{}" }, ownerCookie)).status).toBe(403);
    const startedResponse = await call("/api/control/integrations/github/device-authorizations", { method: "POST", body: "{}" }, ownerCookie, owner.csrfToken);
    expect(startedResponse.status).toBe(201);
    const started = await startedResponse.json() as { authorization: { flowId: string; state: string } };
    expect(JSON.stringify(started)).not.toMatch(/device_code|ghu_|ghr_|github-secret/);
    expect((await call(`/api/control/integrations/github/device-authorizations/${started.authorization.flowId}`, {}, viewerCookie)).status).toBe(403);

    now += 5_000;
    const completedResponse = await call(`/api/control/integrations/github/device-authorizations/${started.authorization.flowId}/poll`, { method: "POST", body: "{}" }, ownerCookie, owner.csrfToken);
    expect(completedResponse.status).toBe(200);
    expect(await completedResponse.json()).toMatchObject({ authorization: { state: "ready", connection: { githubUser: { login: "octocat" } } } });
    const listed = await (await call("/api/control/integrations/github", {}, ownerCookie)).text();
    expect(listed).toContain("octocat"); expect(listed).not.toMatch(/ghu_|ghr_|github-secret/);
    const connectionId = (JSON.parse(listed) as { connections: Array<{ connectionId: string }> }).connections[0]!.connectionId;
    expect((await call("/api/control/integrations/github/catalog-refreshes", { method: "POST", body: JSON.stringify({ connectionId, expectedRevision: 0 }) }, ownerCookie)).status).toBe(403);
    expect((await call("/api/control/integrations/github/catalog-refreshes", { method: "POST", body: JSON.stringify({ connectionId: "missing", expectedRevision: 0 }) }, ownerCookie, owner.csrfToken)).status).toBe(422);
    const refreshed = await call("/api/control/integrations/github/catalog-refreshes", { method: "POST", body: JSON.stringify({ connectionId, expectedRevision: 0 }) }, ownerCookie, owner.csrfToken);
    expect(refreshed.status).toBe(200); expect(await refreshed.json()).toMatchObject({ catalog: { revision: 1, repositories: [{ canonical: "github.com/example/one" }] } });
    const repositories = await (await call(`/api/control/integrations/github/repositories?connectionId=${encodeURIComponent(connectionId)}`, {}, viewerCookie)).text();
    expect(repositories).toContain("github.com/example/one"); expect(repositories).not.toMatch(/ghu_|ghr_|github-secret/);
    for (let activeFlow = 0; activeFlow < 3; activeFlow += 1) {
      expect((await call("/api/control/integrations/github/device-authorizations", { method: "POST", body: "{}" }, ownerCookie, owner.csrfToken)).status).toBe(201);
    }
    expect((await call("/api/control/integrations/github/device-authorizations", { method: "POST", body: "{}" }, ownerCookie, owner.csrfToken)).status).toBe(429);
    const audit = JSON.stringify(await control.audit(ownerActor));
    expect(audit).toContain("GITHUB_AUTHORIZATION_STARTED"); expect(audit).toContain("GITHUB_AUTHORIZATION_COMPLETED");
    expect(audit).toContain("GITHUB_CATALOG_REFRESHED");
    expect(audit).not.toMatch(/device_code|ghu_|ghr_|github-secret|ABCD-EFGH/);
  });
});
