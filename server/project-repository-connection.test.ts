import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectRepositoryConnectionService,
  ProjectRepositoryConnectionStore,
  ProjectRepositoryServiceRegistry,
  ServerHeldRepositoryCredentials,
  publicRepositoryConnectionStatus,
  repositorySafeWorkerEnvironment,
  type DurableRepositoryReference,
} from "./project-repository-connection.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(name = "repo") {
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-repository-connection-"));
  const root = await realpath(createdRoot); roots.push(root);
  const checkout = path.join(root, name); const worktrees = path.join(root, `${name}-worktrees`); const data = path.join(root, "data");
  await mkdir(checkout); await git(checkout, ["init", "-b", "main"]); await git(checkout, ["config", "user.email", "tests@example.test"]);
  await git(checkout, ["config", "user.name", "Tests"]); await git(checkout, ["commit", "--allow-empty", "-m", "initial"]);
  await git(checkout, ["remote", "add", "origin", `git@github.com:example/${name}.git`]);
  return { root, checkout: await realpath(checkout), worktrees, data, store: await ProjectRepositoryConnectionStore.open(data) };
}

function input(repositoryFixture: Awaited<ReturnType<typeof fixture>>, credentialReference = "github-connection-one") {
  return { expectedRevision: 0, checkoutPath: repositoryFixture.checkout, worktreeRoot: repositoryFixture.worktrees, defaultBranch: "main", protectedBranches: ["main"],
    policyRevision: 7, validationCommands: ["pnpm test", "pnpm run build"], sensitivePaths: [".github/workflows"], credentialReference };
}

describe("verified project repository connections", () => {
  it("connects one canonical checkout with revisioned, private authority metadata and a sanitized status", async () => {
    const f = await fixture(); const service = connectionService("project-one", f.store);
    const result = await service.connect(input(f));
    expect(result).toMatchObject({ kind: "ok", connection: { revision: 1, state: "verified", remote: { canonical: "github.com/example/repo" },
      checkoutMode: "existing-local", defaultBranch: "main", protectedBranches: ["main"], policyRevision: 7 } });
    const privateJson = JSON.stringify(service.inspectServer()); const publicJson = JSON.stringify(service.inspect());
    expect(privateJson).toContain("github-connection-one"); expect(privateJson).toContain(f.checkout);
    expect(publicJson).not.toContain("github-connection-one"); expect(publicJson).not.toContain(f.checkout); expect(publicJson).not.toContain(f.worktrees);
    expect(publicRepositoryConnectionStatus(service.inspectServer())).toEqual(service.inspect());
    await expect(service.connect(input(f))).resolves.toMatchObject({ kind: "conflict", actualRevision: 1 });
  });

  it("accepts only credentials registered server-side for the owning project", async () => {
    const f = await fixture(); const credentials = new ServerHeldRepositoryCredentials();
    credentials.register("project-one", "github-connection-one", "github_pat_private_secret");
    const service = new ProjectRepositoryConnectionService("project-one", f.store, undefined, undefined, undefined,
      (reference) => credentials.available("project-one", reference));
    await expect(service.connect({ ...input(f), credentialReference: "missing-reference" })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("unavailable") });
    await expect(service.connect(input(f))).resolves.toMatchObject({ kind: "ok" });
    expect(JSON.stringify(service.inspect())).not.toMatch(/github_pat|private_secret|credential/);
    expect(credentials.forServerOperation("project-one", "github-connection-one")).toBe("github_pat_private_secret");
    expect(credentials.forServerOperation("project-two", "github-connection-one")).toBeUndefined();
  });

  it("fails closed when persisted nested remote or policy metadata is corrupt", async () => {
    const f = await fixture(); const service = connectionService("project-one", f.store);
    await service.connect(input(f)); const valid = service.inspectServer()!;
    for (const corrupt of [{ ...valid, remote: { ...valid.remote, canonical: "github.com/attacker/other" } },
      { ...valid, protectedBranches: "main" }, { ...valid, validationCommands: ["pnpm test", 7] }, { ...valid, sensitivePaths: ["../secret"] }]) {
      await writeFile(f.store.filePath, JSON.stringify({ schemaVersion: 1, connections: [corrupt] }));
      await expect(ProjectRepositoryConnectionStore.open(f.data)).rejects.toThrow(/invalid or duplicate project record/);
    }
  });

  it("rejects noncanonical, ambiguous, linked-common-directory, and overlapping paths", async () => {
    const f = await fixture(); const service = connectionService("project-one", f.store);
    await expect(service.connect({ ...input(f), checkoutPath: `${f.checkout}/.` })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("canonical") });
    await git(f.checkout, ["remote", "add", "upstream", "https://github.com/example/other.git"]);
    await expect(service.connect(input(f))).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("exactly one") });
    await git(f.checkout, ["remote", "remove", "upstream"]);
    await expect(service.connect({ ...input(f), worktreeRoot: path.join(f.checkout, "worktrees") })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("overlap") });
    const linked = path.join(f.root, "linked"); await git(f.checkout, ["worktree", "add", "-b", "linked", linked]);
    const linkedService = connectionService("project-linked", f.store);
    await expect(linkedService.connect({ ...input(f), checkoutPath: linked, worktreeRoot: path.join(f.root, "linked-slots") })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("common Git directory") });
  });

  it("fails closed on stale revisions and identity drift before mutations", async () => {
    const f = await fixture(); const service = connectionService("project-one", f.store);
    await expect(service.connect(input(f))).resolves.toMatchObject({ kind: "ok" });
    await expect(service.revalidateAuthority(2)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("stale") });
    await git(f.checkout, ["remote", "set-url", "origin", "git@github.com:example/drift.git"]);
    await expect(service.revalidateAuthority(1)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("remote identity") });
    await expect(service.reconcile(1)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("identity drift") });
    expect(service.inspect()).toMatchObject({ revision: 2, state: "identity-drift" });
  });

  it("blocks disable and rebind while durable references remain", async () => {
    const f = await fixture(); let references: readonly DurableRepositoryReference[] = [];
    const service = new ProjectRepositoryConnectionService("project-one", f.store, async () => references, undefined, undefined, () => true);
    await service.connect(input(f));
    references = [{ kind: "assignment", id: "assignment-one", terminal: false, reconciled: true }];
    await expect(service.disable(1)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("durable reference") });
    references = [{ kind: "deployment", id: "deployment-one", terminal: true, reconciled: false }];
    await expect(service.disable(1)).resolves.toMatchObject({ kind: "rejected" });
    references = [{ kind: "assignment", id: "assignment-one", terminal: true, reconciled: true }];
    await expect(service.disable(1)).resolves.toMatchObject({ kind: "ok", connection: { revision: 2, state: "disabled" } });
    references = [{ kind: "merge", id: "merge-one", terminal: false, reconciled: false }];
    await expect(service.connect({ ...input(f), expectedRevision: 2 })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("rebind") });
  });

  it("does not allow two projects to share checkout, worktree root, credential reference, capacity, audit, or policy state", async () => {
    const first = await fixture("one"); const secondCheckout = path.join(first.root, "two"); await mkdir(secondCheckout);
    await git(secondCheckout, ["init", "-b", "main"]); await git(secondCheckout, ["config", "user.email", "tests@example.test"]);
    await git(secondCheckout, ["config", "user.name", "Tests"]); await git(secondCheckout, ["commit", "--allow-empty", "-m", "initial"]);
    await git(secondCheckout, ["remote", "add", "origin", "https://github.com/example/two.git"]);
    const registry = new ProjectRepositoryServiceRegistry(first.store, (projectId) => ({ policy: new Map<string, number>([[projectId, 1]]) }), undefined, () => true);
    const one = registry.forProject("project-one"); const two = registry.forProject("project-two");
    expect(registry.forProject("project-one")).toBe(one); expect(two).not.toBe(one); expect(two.writerSlot).not.toBe(one.writerSlot);
    one.writerSlot.add("assignment-one"); expect(two.writerSlot.size).toBe(0); expect(two.services.policy).not.toBe(one.services.policy); expect(two.brokerAudit).not.toBe(one.brokerAudit);
    await one.connection.connect(input(first, "credential-one"));
    await expect(two.connection.connect({ ...input(first, "credential-two") })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("another project") });
    await expect(two.connection.connect({ ...input(first, "credential-one"), checkoutPath: await realpath(secondCheckout), worktreeRoot: path.join(first.root, "two-worktrees") }))
      .resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("Credential reference") });
  });

  it("shares one project scope across rooms without granting repository authority through attachment", async () => {
    const f = await fixture(); const registry = new ProjectRepositoryServiceRegistry(f.store, () => ({ rooms: new Set<string>() }), undefined, () => true);
    const fromRoomA = registry.forProject("project-one"); const fromRoomB = registry.forProject("project-one");
    fromRoomA.services.rooms.add("room-a"); fromRoomB.services.rooms.add("room-b"); fromRoomA.writerSlot.add("assignment-a");
    expect(fromRoomB.connection.inspect()).toEqual({ configured: false }); expect(fromRoomB.writerSlot).toEqual(new Set(["assignment-a"]));
    expect(fromRoomB.services.rooms).toEqual(new Set(["room-a", "room-b"]));
    await fromRoomA.connection.connect(input(f)); expect(fromRoomB.connection.inspect()).toMatchObject({ revision: 1, policyRevision: 7 });
  });

  it("strips credentials and repository authority from worker environments", () => {
    const safe = repositorySafeWorkerEnvironment({ PATH: "/bin", HOME: "/private/home", GITHUB_TOKEN: "secret", GIT_ASKPASS: "secret-helper", GIT_CONFIG_NOSYSTEM: "attacker",
      ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: "/private/repo", REPOSITORY_CREDENTIAL: "secret" });
    expect(safe).toEqual({ PATH: "/bin", HOME: "/private/home" }); expect(JSON.stringify(safe)).not.toMatch(/secret|private\/repo/);
  });
});

async function git(repository: string, args: readonly string[]) {
  await exec("git", ["-C", repository, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
}

function connectionService(projectId: string, store: ProjectRepositoryConnectionStore) {
  return new ProjectRepositoryConnectionService(projectId, store, undefined, undefined, undefined, () => true);
}
