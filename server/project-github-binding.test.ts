import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundGitHubCredentialProvider, GitHubIntegrationStore, type SecretVaultReader } from "./github-integration-store.js";
import { ProjectGitHubBindingService } from "./project-github-binding.js";
import { ProjectRepositoryConnectionService, ProjectRepositoryConnectionStore } from "./project-repository-connection.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import { RoomBoundGitHubReadService } from "./room-bound-github-read.js";
import { CommandRuntime } from "./command-runtime.js";
import { RoomLifecycleStore } from "./room-lifecycle.js";

const exec = promisify(execFile);
const roots: string[] = [];
const timestamp = "2026-08-28T12:00:00.000Z";

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(repository = "one", projectId = "project-one") {
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
  const authority = new ProjectRepositoryConnectionService(projectId, repositoryStore, undefined, undefined, undefined,
    (reference) => provider.available(projectId, reference));
  return { root, checkout, worktreeRoot, projectId, integrations, repositoryStore, authority, service: new ProjectGitHubBindingService(integrations, () => authority) };
}

function input(f: Awaited<ReturnType<typeof fixture>>) {
  return { projectId: f.projectId, githubConnectionId: "github-server-one", githubRepositoryId: 201, expectedBindingRevision: 0,
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
      repair: vi.fn(f.authority.repair.bind(f.authority)), inspectRepair: vi.fn(f.authority.inspectRepair.bind(f.authority)),
      connect: async () => ({ kind: "rejected" as const, reason: "simulated repository rejection" }) };
    const service = new ProjectGitHubBindingService(f.integrations, () => rejectingAuthority);
    await expect(service.configure(input(f))).resolves.toEqual({ kind: "rejected", reason: "simulated repository rejection" });
    expect(f.integrations.bindingForProject("project-one")).toMatchObject({ revision: 2, state: "revoked" });
  });

  it("reports an incomplete rollback when repository persistence and binding revocation both fail", async () => {
    const f = await fixture();
    const rejectingAuthority = { inspect: () => ({ configured: false as const }), inspectServer: () => undefined,
      repair: vi.fn(f.authority.repair.bind(f.authority)), inspectRepair: vi.fn(f.authority.inspectRepair.bind(f.authority)),
      connect: async () => ({ kind: "rejected" as const, reason: "simulated repository rejection" }) };
    vi.spyOn(f.integrations, "revokeBinding").mockResolvedValueOnce({ kind: "conflict", actualRevision: 2 });
    const service = new ProjectGitHubBindingService(f.integrations, () => rejectingAuthority);
    await expect(service.configure(input(f))).resolves.toEqual({ kind: "rejected",
      reason: "Repository connection failed and the GitHub binding rollback did not complete. Reconfigure the project." });
    expect(f.integrations.bindingForProject("project-one")).toMatchObject({ revision: 1, state: "ready" });
  });

  it("keeps binding revision and credential scope authoritative during repair", async () => {
    const f = await fixture(); expect((await f.service.configure(input(f))).kind).toBe("ok");
    const request = { projectId: f.projectId, expectedBindingRevision: 1, expectedRepositoryRevision: 1,
      idempotencyKey: "repair-binding-one", checkoutPath: f.checkout, worktreeRoot: f.worktreeRoot };
    await expect(f.service.repair({ ...request, expectedBindingRevision: 0 })).resolves.toMatchObject({ kind: "rejected" });
    await expect(f.service.repair({ ...request, expectedBindingRevision: 2 })).resolves.toMatchObject({ kind: "conflict", scope: "binding", actualRevision: 1 });
    await expect(f.service.repair({ ...request, expectedRepositoryRevision: 2 })).resolves.toMatchObject({ kind: "conflict", scope: "repository", actualRevision: 1 });
    await expect(f.service.repair({ ...request, projectId: "project-other" })).resolves.toMatchObject({ kind: "conflict", scope: "binding", actualRevision: 0 });
    const original = f.authority.inspectServer();
    let inspections = 0;
    const authority = new ProjectRepositoryConnectionService(f.projectId, f.repositoryStore, async () => {
      if (++inspections === 2) await f.integrations.revokeBinding({ projectId: f.projectId, expectedRevision: 1 });
      return [];
    }, undefined, undefined, () => true);
    const service = new ProjectGitHubBindingService(f.integrations, () => authority);
    await expect(service.repair(request)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("unchanged") });
    expect(authority.inspectServer()).toEqual(original);
    await expect(service.inspectRepair(f.projectId)).resolves.toMatchObject({ state: "unavailable", reason: "matching-ready-binding-required" });
  });

  it("restores a real room-bound /gh command with a mocked upstream after relocation and restart", async () => {
    const stateRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "amfaa-repair-room-"))); roots.push(stateRoot);
    const databasePath = path.join(stateRoot, "room.sqlite");
    let room = await SqliteRoomRepository.open(stateRoot, databasePath);
    let runtime: CommandRuntime | undefined;
    try {
      const server = await room.getDurableServer();
      const projectId = randomUUID();
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        database.prepare("INSERT INTO durable_projects(project_id,server_id,revision,name,repository_capacity,repository_reference_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(projectId, server.serverId, 1, "Fixture project", 1, null, timestamp, timestamp);
      } finally { database.close(); }
      const lifecycle = await RoomLifecycleStore.open(databasePath, stateRoot);
      const attached = lifecycle.create("fixture-human", { name: "Fixture room", projectId });
      lifecycle.close(); room.close();
      room = await SqliteRoomRepository.open(stateRoot, databasePath, { roomId: attached.roomId });
      const scope = (await room.getStorageScope(room.roomId))!;
      const f = await fixture("one", scope.projectId!);
      expect((await f.service.configure(input(f))).kind).toBe("ok");
      await room.addMessage("you", "Preserve this conversation.", "chat", undefined, undefined, { id: "fixture-human", name: "Fixture" });
      const before = room.snapshot();
      const projectBefore = await room.getDurableProject(f.projectId);
      const integrationsBefore = await readFile(f.integrations.filePath, "utf8");
      const vaultRead = vi.fn<SecretVaultReader["read"]>().mockResolvedValue({ token: "fixture-token-not-a-real-credential", provider: "github-device-user", revision: "fixture:1" });
      const credentials = new BoundGitHubCredentialProvider(f.integrations, { available: () => true, read: vaultRead });
      const fetcher = vi.fn(async (url: string | URL, options?: RequestInit) => {
        expect(String(url)).toContain("https://api.github.com/repos/example/one/pulls/98");
        expect(options?.method).toBe("GET");
        return new Response(JSON.stringify({ number: 98, title: "Recovered repository read", state: "open", draft: false,
          user: { login: "fixture" }, updated_at: timestamp, base: { ref: "main" }, head: { ref: "feature", sha: "a".repeat(40) }, body: "Mocked upstream evidence." }),
        { status: 200, headers: { "content-type": "application/json" } });
      });
      let authority = f.authority;
      let github = new RoomBoundGitHubReadService(room, () => authority, credentials, { fetcher });
      const oldLease = await github.authorize(room.roomId);
      vaultRead.mockClear();
      const replacement = path.join(f.root, "relocated"); await rename(f.checkout, replacement);
      expect(f.authority.inspect()).toMatchObject({ state: "verified", revision: 1 });
      expect(f.integrations.bindingForProject(f.projectId)?.state).toBe("ready");
      await expect(github.execute(room.roomId, { kind: "pr", number: 98 })).rejects.toMatchObject({ kind: "connection-unverified" });
      expect(vaultRead).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
      runtime = commandRuntime(room, github);
      const invoker = { kind: "human" as const, id: "fixture-human", displayName: "Fixture" };
      await expect(runtime.submit("/gh pr 98", invoker, "before-repair-0001")).resolves.toMatchObject({ kind: "private-error" });
      expect(fetcher).not.toHaveBeenCalled();
      const request = { projectId: f.projectId, expectedBindingRevision: 1, expectedRepositoryRevision: 1,
        checkoutPath: replacement, worktreeRoot: path.join(f.root, "relocated-assignments"), idempotencyKey: "repair-room-one" };
      await expect(f.service.inspectRepair(f.projectId)).resolves.toMatchObject({ state: "available", authority: "unverified" });
      expect((await f.service.repair(request)).kind).toBe("ok");
      expect(room.snapshot().messages).toEqual(before.messages);
      expect(room.snapshot().roster).toEqual(before.roster);
      expect(room.snapshot().settings).toEqual(before.settings);
      expect(await room.getDurableProject(f.projectId)).toEqual(projectBefore);
      expect(await room.getStorageScope(room.roomId)).toEqual(scope);
      expect(await readFile(f.integrations.filePath, "utf8")).toBe(integrationsBefore);
      await expect(github.validateLease(room.roomId, oldLease)).rejects.toMatchObject({ kind: "connection-stale" });
      await expect(runtime.submit("/gh pr 98", invoker, "after-repair-0001")).resolves.toMatchObject({ kind: "accepted", resultText: expect.stringContaining("Recovered repository read") });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await runtime.close(); runtime = undefined; room.close();
      room = await SqliteRoomRepository.open(replacement, databasePath, { roomId: attached.roomId });
      const integrations = await GitHubIntegrationStore.open(path.join(f.root, "integrations"));
      const provider = new BoundGitHubCredentialProvider(integrations, { available: () => true, read: vaultRead });
      const store = await ProjectRepositoryConnectionStore.open(path.join(f.root, "repositories"));
      authority = new ProjectRepositoryConnectionService(f.projectId, store, undefined, undefined, undefined, (reference) => provider.available(f.projectId, reference));
      const restarted = new ProjectGitHubBindingService(integrations, () => authority);
      await expect(restarted.repair(request)).resolves.toMatchObject({ kind: "ok", value: { repository: { revision: 2 } } });
      github = new RoomBoundGitHubReadService(room, () => authority, provider, { fetcher });
      runtime = commandRuntime(room, github);
      await expect(runtime.submit("/gh pr 98", invoker, "restart-repair-0001")).resolves.toMatchObject({ kind: "accepted" });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(await room.getStorageScope(room.roomId)).toEqual(scope);
      expect(room.snapshot().roster).toEqual(before.roster);
      // Startup projects the deployment root; user-owned settings remain unchanged.
      expect(room.snapshot().settings).toEqual({ ...before.settings, projectPath: replacement });
      expect(room.snapshot().messages).toEqual(expect.arrayContaining(before.messages));
      expect(room.snapshot().messages.some(({ text }) => text === "/gh pr 98")).toBe(false);
    } finally { await runtime?.close(); room.close(); }
  }, 15_000);
});

function commandRuntime(room: SqliteRoomRepository, githubRead: RoomBoundGitHubReadService) {
  return new CommandRuntime({ store: room, roomId: room.roomId, ceiling: ["gh"], roster: () => room.snapshot().roster!, canLaunch: () => false,
    executeTask: async () => ({}), executePov: async () => ({}), deliverPov: async () => undefined, deliverTask: async () => undefined,
    publishStatus: async () => undefined, githubRead,
    publishGhResult: async (id, _summary, text) => { await room.addCommandDeliveryMessageOnce(id, 0, "system", text, undefined, { burstId: id, sequence: 0, kind: "command" }); } });
}

function vault(): SecretVaultReader {
  return { available: (reference) => reference === "vault-secret-one", read: async () => undefined };
}

async function git(repository: string, args: readonly string[]) {
  await exec("git", ["-C", repository, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
}
