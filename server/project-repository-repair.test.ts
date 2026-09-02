import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRepositoryConnectionService, ProjectRepositoryConnectionStore, type DurableRepositoryReference } from "./project-repository-connection.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(checkout: string, args: string[]) {
  await exec("git", ["-C", checkout, ...args], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "amfaa-repair-"))); roots.push(root);
  const checkout = path.join(root, "original"); await mkdir(checkout);
  await git(checkout, ["init", "-b", "main"]);
  await git(checkout, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Initial"]);
  await git(checkout, ["remote", "add", "origin", "https://github.com/example/repository.git"]);
  const data = path.join(root, "state"); const store = await ProjectRepositoryConnectionStore.open(data);
  let references: readonly DurableRepositoryReference[] = [];
  let credentialAvailable = true;
  const audit = vi.fn();
  const service = new ProjectRepositoryConnectionService("project-one", store, async () => references, undefined, audit, () => credentialAvailable);
  const connectInput = { expectedRevision: 0, checkoutPath: checkout, worktreeRoot: path.join(root, "old-assignments"),
    defaultBranch: "main", protectedBranches: ["main"], policyRevision: 7, validationCommands: ["pnpm test"], sensitivePaths: [".env"], credentialReference: "credential-one" };
  expect((await service.connect(connectInput)).kind).toBe("ok");
  const before = service.inspectServer()!;
  const replacement = path.join(root, "replacement"); await rename(checkout, replacement);
  const input = { expectedRevision: 1, checkoutPath: replacement, worktreeRoot: path.join(root, "new-assignments"), idempotencyKey: "repair-request-one" };
  return { root, data, store, service, before, input, audit, connectInput,
    references: (values: readonly DurableRepositoryReference[]) => { references = values; }, credentials: (value: boolean) => { credentialAvailable = value; } };
}

describe("atomic repository relocation", () => {
  it("reproduces absent saved paths, repairs only path authority, and replays once across restart", async () => {
    const f = await fixture();
    expect(f.service.inspect()).toMatchObject({ state: "verified", revision: 1 });
    await expect(f.service.revalidateAuthority(1)).resolves.toMatchObject({ kind: "rejected" });
    await expect(f.service.inspectRepair()).resolves.toMatchObject({ state: "available", authority: "unverified" });
    expect((await f.service.repair(f.input)).kind).toBe("ok");
    const after = f.service.inspectServer()!;
    expect(after).toMatchObject({ ...f.before, checkoutPath: f.input.checkoutPath, commonDirectory: path.join(f.input.checkoutPath, ".git"),
      worktreeRoot: f.input.worktreeRoot, revision: 2, identityDigest: expect.any(String), validatedAt: expect.any(String), updatedAt: expect.any(String) });
    expect(after.identityDigest).not.toBe(f.before.identityDigest);
    await expect(f.service.revalidateAuthority(2)).resolves.toMatchObject({ kind: "ok" });
    await expect(f.service.inspectRepair()).resolves.toMatchObject({ authority: "verified" });
    expect((await stat(f.store.filePath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(f.service.inspect())).not.toMatch(/credential|Receipt|Digest|assignments|replacement|repair-request/);
    const reopened = await ProjectRepositoryConnectionStore.open(f.data);
    const restarted = new ProjectRepositoryConnectionService("project-one", reopened, undefined, undefined, undefined, () => true);
    expect(restarted.inspectServer()).toEqual(after);
    await expect(restarted.repair(f.input)).resolves.toEqual({ kind: "ok", connection: after });
    expect(restarted.inspect().revision).toBe(2);
    await expect(restarted.repair({ ...f.input, idempotencyKey: "different-key" })).resolves.toMatchObject({ kind: "conflict", actualRevision: 2 });
    await expect(restarted.repair({ ...f.input, worktreeRoot: path.join(f.root, "different") })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("different request") });
    expect(f.audit.mock.calls.filter(([event]) => event.operation === "repair")).toHaveLength(1);
  });

  it.each(["assignment", "job", "operation", "contribution", "merge", "deployment"] as const)("blocks active and unreconciled %s references without changing authority", async (kind) => {
    const f = await fixture();
    for (const flags of [{ terminal: false, reconciled: true }, { terminal: true, reconciled: false }]) {
      f.references([{ kind, id: "durable-reference", ...flags }]);
      await expect(f.service.repair(f.input)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("durable reference") });
      expect(f.service.inspectServer()).toEqual(f.before);
      expect((await ProjectRepositoryConnectionStore.open(f.data)).get("project-one")).toEqual(f.before);
    }
    f.references([{ kind, id: "durable-reference", terminal: true, reconciled: true }]);
    expect((await f.service.repair(f.input)).kind).toBe("ok");
  });

  it("fails closed if durable-reference inspection or credential availability fails", async () => {
    const f = await fixture(); f.credentials(false);
    await expect(f.service.repair(f.input)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("Credential") });
    const service = new ProjectRepositoryConnectionService("project-one", f.store, async () => { throw new Error("Reference state unavailable."); }, undefined, undefined, () => true);
    await expect(service.repair(f.input)).resolves.toMatchObject({ kind: "rejected" });
    expect(service.inspectServer()).toEqual(f.before);
  });

  it("rejects changed remote and branch, malformed input, disabled state, and stale revisions", async () => {
    const f = await fixture();
    for (const patch of [{ expectedRevision: 0 }, { expectedRevision: 1.5 }, { idempotencyKey: "" }, { checkoutPath: null }, { worktreeRoot: {} }]) {
      await expect(f.service.repair({ ...f.input, ...patch } as typeof f.input)).resolves.toMatchObject({ kind: "rejected" });
    }
    await expect(f.service.repair({ ...f.input, expectedRevision: 2 })).resolves.toMatchObject({ kind: "conflict", actualRevision: 1 });
    await git(f.input.checkoutPath, ["remote", "set-url", "origin", "https://github.com/example/wrong.git"]);
    await expect(f.service.repair(f.input)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("saved repository") });
    await git(f.input.checkoutPath, ["remote", "set-url", "origin", "https://github.com/example/repository.git"]);
    await git(f.input.checkoutPath, ["checkout", "-b", "other"]);
    await expect(f.service.repair(f.input)).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("default branch") });
    expect(f.service.inspectServer()).toEqual(f.before);
    await f.service.disable(1);
    await expect(f.service.repair({ ...f.input, expectedRevision: 2 })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("enabled") });
  });

  it("repairs a reconciled identity-drift record without changing remote or policy", async () => {
    const f = await fixture(); await f.service.reconcile(1);
    expect(f.service.inspect()).toMatchObject({ revision: 2, state: "identity-drift" });
    await expect(f.service.repair({ ...f.input, expectedRevision: 2 })).resolves.toMatchObject({ kind: "ok", connection: { revision: 3, state: "verified", policyRevision: 7 } });
  });

  it.each(["linked", "symlink", "separate", "invalid"])("rejects %s Git metadata", async (kind) => {
    const f = await fixture();
    let checkoutPath = f.input.checkoutPath;
    if (kind === "linked") {
      checkoutPath = path.join(f.root, "linked");
      await git(f.input.checkoutPath, ["worktree", "add", "-b", "linked", checkoutPath]);
    } else {
      const metadata = path.join(f.root, "metadata");
      await rename(path.join(checkoutPath, ".git"), metadata);
      if (kind === "symlink") await symlink(metadata, path.join(checkoutPath, ".git"));
      if (kind === "separate") await writeFile(path.join(checkoutPath, ".git"), `gitdir: ${metadata}\n`);
      if (kind === "invalid") await mkdir(path.join(checkoutPath, ".git"));
    }
    const result = await f.service.repair({ ...f.input, checkoutPath });
    expect(result.kind).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain(f.root);
    expect(f.service.inspectServer()).toEqual(f.before);
  });

  it("requires canonical, separate directory paths and does not change read-only permissions", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "file"), "fixture");
    for (const worktreeRoot of [f.input.checkoutPath, path.join(f.input.checkoutPath, "assignments"), f.root, path.join(f.root, "file"), path.join(f.root, "file", "child")]) {
      await expect(f.service.repair({ ...f.input, worktreeRoot })).resolves.toMatchObject({ kind: "rejected" });
    }
    const alias = path.join(f.root, "alias"); await symlink(f.input.checkoutPath, alias);
    await expect(f.service.repair({ ...f.input, checkoutPath: alias })).resolves.toMatchObject({ kind: "rejected" });
    await chmod(f.input.checkoutPath, 0o555); await chmod(path.join(f.input.checkoutPath, ".git"), 0o555);
    try {
      expect((await f.service.repair(f.input)).kind).toBe("ok");
      expect((await lstat(f.input.checkoutPath)).mode & 0o777).toBe(0o555);
      expect((await lstat(path.join(f.input.checkoutPath, ".git"))).mode & 0o777).toBe(0o555);
      await expect(stat(f.input.worktreeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await chmod(f.input.checkoutPath, 0o755); await chmod(path.join(f.input.checkoutPath, ".git"), 0o755); }
  });

  it("serializes cross-project path ownership at commit, including checkout/assignment cross-overlap", async () => {
    const f = await fixture();
    const otherCheckout = path.join(f.root, "other"); await cp(f.input.checkoutPath, otherCheckout, { recursive: true });
    const other = new ProjectRepositoryConnectionService("project-two", f.store, undefined, undefined, undefined, () => true);
    expect((await other.connect({ ...f.connectInput, checkoutPath: otherCheckout, worktreeRoot: path.join(f.root, "other-assignments"), credentialReference: "credential-two" })).kind).toBe("ok");
    await expect(f.service.repair({ ...f.input, worktreeRoot: path.join(otherCheckout, "nested") })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("another project") });
    const results = await Promise.all([f.service.repair(f.input), other.repair(f.input)]);
    expect(results.filter(({ kind }) => kind === "ok")).toHaveLength(1);
    expect(results.filter(({ kind }) => kind === "rejected")).toHaveLength(1);
    expect((await ProjectRepositoryConnectionStore.open(f.data)).list().map(({ revision }) => revision).sort()).toEqual([1, 2]);
  });

  it("keeps old memory and disk authority on interruption before commit, then retries cleanly", async () => {
    const f = await fixture(); const previousFile = await readFile(f.store.filePath, "utf8");
    let inspections = 0;
    const service = new ProjectRepositoryConnectionService("project-one", f.store, async () => {
      if (++inspections === 2) throw new Error("Interrupted before authority commit.");
      return [];
    }, undefined, undefined, () => true);
    await expect(service.repair(f.input)).resolves.toMatchObject({ kind: "rejected" });
    expect(service.inspectServer()).toEqual(f.before);
    expect(await readFile(f.store.filePath, "utf8")).toBe(previousFile);
    expect((await readdir(f.data)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await service.repair(f.input)).kind).toBe("ok");
  });

  it("recovers an interrupted response after commit from its durable receipt without another mutation", async () => {
    const f = await fixture(); f.audit.mockRejectedValueOnce(new Error("Interrupted after commit."));
    await expect(f.service.repair(f.input)).resolves.toMatchObject({ kind: "rejected" });
    const reopened = await ProjectRepositoryConnectionStore.open(f.data);
    expect(reopened.get("project-one")?.revision).toBe(2);
    const restarted = new ProjectRepositoryConnectionService("project-one", reopened, undefined, undefined, undefined, () => true);
    await expect(restarted.repair(f.input)).resolves.toMatchObject({ kind: "ok", connection: { revision: 2 } });
    await git(f.input.checkoutPath, ["remote", "set-url", "origin", "https://github.com/example/drift.git"]);
    await expect(restarted.repair(f.input)).resolves.toMatchObject({ kind: "rejected" });
  });

  it("does not publish repaired memory authority when the filesystem cannot persist it", async () => {
    const f = await fixture(); const previousFile = await readFile(f.store.filePath, "utf8");
    const backup = path.join(f.root, "state-backup"); await rename(f.data, backup);
    // A non-directory ancestor produces a deterministic I/O failure, including as root.
    await writeFile(f.data, "temporary fixture obstruction");
    try {
      const result = await f.service.repair(f.input);
      expect(result.kind).toBe("rejected");
      expect(JSON.stringify(result)).not.toContain(f.root);
      expect(f.service.inspectServer()).toEqual(f.before);
    } finally { await unlink(f.data); await rename(backup, f.data); }
    expect(await readFile(f.store.filePath, "utf8")).toBe(previousFile);
    expect((await ProjectRepositoryConnectionStore.open(f.data)).get("project-one")).toEqual(f.before);
    expect((await f.service.repair(f.input)).kind).toBe("ok");
  });

  it("loads legacy v1 records and rejects corrupt repair receipts", async () => {
    const f = await fixture();
    expect((await ProjectRepositoryConnectionStore.open(f.data)).get("project-one")?.repairReceipt).toBeUndefined();
    for (const repairReceipt of [null, {}, { keyDigest: "a".repeat(64), requestDigest: "b".repeat(64), revision: 99 }]) {
      await writeFile(f.store.filePath, JSON.stringify({ schemaVersion: 1, connections: [{ ...f.before, repairReceipt }] }));
      await expect(ProjectRepositoryConnectionStore.open(f.data)).rejects.toThrow("invalid or duplicate");
    }
  });
});
