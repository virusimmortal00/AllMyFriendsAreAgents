import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_SESSION_COOKIE, ControlPlaneStore } from "./control-plane.js";
import { registerProjectGitHubBindingRoutes } from "./project-github-binding-api.js";
import type { ConfigureProjectGitHubRepositoryInput, ProjectGitHubBindingService } from "./project-github-binding.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("project GitHub binding control API", () => {
  it("enforces project configuration authority and never forwards client-supplied secret references", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-project-github-binding-api-"));
    const control = await ControlPlaneStore.open(directory, "local-bootstrap-secret-with-32-characters");
    await control.bootstrap("local-bootstrap-secret-with-32-characters", "owner", "correct horse battery staple");
    const owner = await control.authenticate("owner", "correct horse battery staple"); if (!owner) throw new Error("owner login failed");
    const ownerCookie = `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(owner.token)}`;
    const ownerActor = control.require({ header: (name: string) => name.toLowerCase() === "cookie" ? ownerCookie : undefined } as express.Request).principal;
    await control.createPrincipal(ownerActor, { username: "viewer", password: "viewer password long", role: "MEMBER", capabilities: ["INTEGRATION_VIEW"] });
    const viewer = await control.authenticate("viewer", "viewer password long"); if (!viewer) throw new Error("viewer login failed");
    const viewerCookie = `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(viewer.token)}`;

    let received: ConfigureProjectGitHubRepositoryInput | undefined;
    const status = { binding: { projectId: "project-one", revision: 1, state: "ready" as const, connectionId: "github-server-one", installationId: 101,
      githubRepositoryId: 201, repository: "github.com/example/one", updatedAt: "2026-08-28T12:00:00.000Z" },
      repository: { configured: true, revision: 1, state: "verified" as const, repository: "github.com/example/one" } };
    const bindings = { inspect: () => status, configure: vi.fn(async (input: ConfigureProjectGitHubRepositoryInput) => { received = input; return { kind: "ok" as const, value: status }; }) };
    const app = express(); app.use(express.json()); registerProjectGitHubBindingRoutes({ app, control, bindings: bindings as unknown as ProjectGitHubBindingService,
      projectExists: async (projectId) => projectId === "project-one" });
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (route: string, init: RequestInit = {}, cookie = "", csrf = "") => fetch(`${base}${route}`, { ...init, headers: { "content-type": "application/json",
      ...(cookie ? { cookie } : {}), ...(csrf ? { "x-amfaa-csrf": csrf } : {}), ...(init.headers as Record<string, string> | undefined) } });

    expect((await call("/api/control/projects/project-one/repository")).status).toBe(401);
    expect((await call("/api/control/projects/project-one/repository", {}, viewerCookie)).status).toBe(200);
    expect((await call("/api/control/projects/project-other/repository", {}, viewerCookie)).status).toBe(404);
    const body = JSON.stringify({ githubConnectionId: "github-server-one", githubRepositoryId: 201, expectedBindingRevision: 0,
      expectedRepositoryRevision: 0, checkoutPath: "/srv/project-one", worktreeRoot: "/srv/worktrees/project-one", policyRevision: 7,
      credentialReference: "attacker-secret-reference", bindingId: "attacker-binding", installationId: 999, repository: "github.com/attacker/other",
      defaultBranch: "attacker-branch" });
    expect((await call("/api/control/projects/project-one/repository", { method: "PUT", body }, viewerCookie, viewer.csrfToken)).status).toBe(403);
    expect((await call("/api/control/projects/project-one/repository", { method: "PUT", body }, ownerCookie)).status).toBe(403);
    const configured = await call("/api/control/projects/project-one/repository", { method: "PUT", body }, ownerCookie, owner.csrfToken);
    expect(configured.status).toBe(200);
    expect(received).toEqual({ projectId: "project-one", githubConnectionId: "github-server-one", githubRepositoryId: 201,
      expectedBindingRevision: 0, expectedRepositoryRevision: 0, checkoutPath: "/srv/project-one", worktreeRoot: "/srv/worktrees/project-one",
      policyRevision: 7, protectedBranches: undefined, validationCommands: undefined, sensitivePaths: undefined });
    const responseText = await configured.text();
    expect(responseText).not.toMatch(/bindingId|credentialReference|attacker-secret|installationId":999|attacker\/other|attacker-branch/);
    const audit = JSON.stringify(await control.audit(ownerActor));
    expect(audit).toContain("PROJECT_REPOSITORY_CONFIGURED");
    expect(audit).not.toMatch(/attacker-secret|attacker-binding|attacker\/other|srv\/project-one/);
  });

  it("maps revision conflicts and audits only a stable failure category", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-project-github-binding-conflict-"));
    const control = await ControlPlaneStore.open(directory, "local-bootstrap-secret-with-32-characters");
    await control.bootstrap("local-bootstrap-secret-with-32-characters", "owner", "correct horse battery staple");
    const owner = await control.authenticate("owner", "correct horse battery staple"); if (!owner) throw new Error("owner login failed");
    const ownerCookie = `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(owner.token)}`;
    const bindings = { inspect: () => ({ repository: { configured: false } }), configure: async () => ({ kind: "conflict" as const, scope: "binding" as const, actualRevision: 3 }) };
    const app = express(); app.use(express.json()); registerProjectGitHubBindingRoutes({ app, control, bindings: bindings as unknown as ProjectGitHubBindingService });
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/control/projects/project-one/repository`, { method: "PUT",
      headers: { "content-type": "application/json", cookie: ownerCookie, "x-amfaa-csrf": owner.csrfToken }, body: "{}" });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ kind: "conflict", scope: "binding", actualRevision: 3 });
    const actor = control.require({ header: (name: string) => name.toLowerCase() === "cookie" ? ownerCookie : undefined } as express.Request).principal;
    expect(JSON.stringify(await control.audit(actor))).toContain("binding-revision-conflict");
  });
});
