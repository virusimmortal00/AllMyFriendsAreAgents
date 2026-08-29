import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundGitHubCredentialProvider, GitHubIntegrationStore, type SecretVaultReader } from "./github-integration-store.js";
import { ProjectGitHubBindingService } from "./project-github-binding.js";
import { ProjectRepositoryConnectionService, ProjectRepositoryConnectionStore } from "./project-repository-connection.js";

const exec = promisify(execFile);
const roots: string[] = [];
const timestamp = "2026-08-28T12:00:00.000Z";

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(repository = "one") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "amfaa-project-github-binding-")));
  roots.push(root);
  const checkout = path.join(root, repository); const worktreeRoot = path.join(root, "worktrees");
  await mkdir(checkout); await git(checkout, ["init", "-b", "main"]); await git(checkout, ["config", "user.email", "tests@example.test"]);
  await git(checkout, ["config", "user.name", "Tests"]); await git(checkout, ["commit", "--allow-empty", "-m", "initial"]);
  await git(checkout, ["remote", "add", "origin", `git@github.com:example/${repository}.git`]);
  const integrations = await GitHubIntegrationStore.open(path.join(root, "integrations"));
  await integrations.saveConnection({ expectedRevision: 0, connectionId: "github-server-one", authMode: "github-device-user", state: "ready",
    githubUser: { id: 7, login: "octocat" }, secretReference: "vault-secret-one", connectedAt: timestamp, lastValidatedAt: timestamp });
  await integrations.replaceCatalog({ expectedRevision: 0, connectionId: "github-server-one", connectionRevision: 1, discovery: { observedAt: timestamp,
    installations: [{ installationId: 101, account: { id: 501, login: "Example", type: "Organization" }, repositorySelection: "selected" }],
    repositories: [{ githubRepositoryId: 201, installationId: 101, owner: "example", name: "one", canonical: "github.com/example/one",
      visibility: "private", defaultBranch: "main" }] } });
  const repositoryStore = await ProjectRepositoryConnectionStore.open(path.join(root, "repositories"));
  const provider = new BoundGitHubCredentialProvider(integrations, vault());
  const authority = new ProjectRepositoryConnectionService("project-one", repositoryStore, undefined, undefined, undefined,
    (reference) => provider.available("project-one", reference));
  return { root, checkout, worktreeRoot, integrations, authority, service: new ProjectGitHubBindingService(integrations, () => authority) };
}

function input(f: Awaited<ReturnType<typeof fixture>>) {
  return { projectId: "project-one", githubConnectionId: "github-server-one", githubRepositoryId: 201, expectedBindingRevision: 0,
    expectedRepositoryRevision: 0, checkoutPath: f.checkout, worktreeRoot: f.worktreeRoot, protectedBranches: ["main"], policyRevision: 7,
    validationCommands: ["pnpm test"], sensitivePaths: [".github/workflows"] };
}

describe("project GitHub binding workflow", () => {
  it("derives repository authority from the server catalog and returns no credential or binding reference", async () => {
    const f = await fixture();
    const result = await f.service.configure(input(f));
    expect(result).toMatchObject({ kind: "ok", value: { binding: { revision: 1, state: "ready", installationId: 101,
      githubRepositoryId: 201, repository: "github.com/example/one" }, repository: { configured: true, revision: 1, state: "verified",
      repository: "github.com/example/one", defaultBranch: "main" } } });
    expect(JSON.stringify(result)).not.toMatch(/bindingId|credential|vault-secret|checkoutPath|worktreeRoot/);
    expect(f.authority.inspectServer()).toMatchObject({ credentialReference: expect.stringMatching(/^github-binding:/), remote: { canonical: "github.com/example/one" } });
  });

  it("rejects a checkout mismatch before creating project authority", async () => {
    const f = await fixture("other");
    await expect(f.service.configure(input(f))).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("does not match") });
    expect(f.integrations.bindingForProject("project-one")).toBeUndefined();
    expect(f.authority.inspect()).toEqual({ configured: false });
  });

  it("revokes the newly-created binding when repository persistence rejects", async () => {
    const f = await fixture();
    const rejectingAuthority = { inspect: () => ({ configured: false as const }), inspectServer: () => undefined,
      connect: async () => ({ kind: "rejected" as const, reason: "simulated repository rejection" }) };
    const service = new ProjectGitHubBindingService(f.integrations, () => rejectingAuthority);
    await expect(service.configure(input(f))).resolves.toEqual({ kind: "rejected", reason: "simulated repository rejection" });
    expect(f.integrations.bindingForProject("project-one")).toMatchObject({ revision: 2, state: "revoked" });
  });

  it("reports an incomplete rollback when repository persistence and binding revocation both fail", async () => {
    const f = await fixture();
    const rejectingAuthority = { inspect: () => ({ configured: false as const }), inspectServer: () => undefined,
      connect: async () => ({ kind: "rejected" as const, reason: "simulated repository rejection" }) };
    vi.spyOn(f.integrations, "revokeBinding").mockResolvedValueOnce({ kind: "conflict", actualRevision: 2 });
    const service = new ProjectGitHubBindingService(f.integrations, () => rejectingAuthority);
    await expect(service.configure(input(f))).resolves.toEqual({ kind: "rejected",
      reason: "Repository connection failed and the GitHub binding rollback did not complete. Reconfigure the project." });
    expect(f.integrations.bindingForProject("project-one")).toMatchObject({ revision: 1, state: "ready" });
  });
});

function vault(): SecretVaultReader {
  return { available: (reference) => reference === "vault-secret-one", read: async () => undefined };
}

async function git(repository: string, args: readonly string[]) {
  await exec("git", ["-C", repository, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
}
