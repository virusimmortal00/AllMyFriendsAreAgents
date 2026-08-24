import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createImprovement, type DomainActor } from "../shared/improvement-domain.js";
import { __testing as runnerTesting } from "./agent-runner.js";
import { ASSIGNMENT_LIFECYCLE_METADATA, type AssignmentRecord } from "./assignment-record.js";
import { AssignmentLifecycleService, __testing } from "./assignment-lifecycle.js";
import { DeveloperBridgeService } from "./developer-bridge.js";
import { DeveloperTeamRegistry, hashToken, type DeveloperTeamMemberRevision } from "./developer-team.js";
import { RoomStore } from "./room-store.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";

const exec = promisify(execFile);
const directories: string[] = [];
const token = "trusted-assignment-builder-token-over-thirty-two-characters";
const actor: DomainActor = { id: "human-author", role: "AUTHOR", human: true };
const member: DeveloperTeamMemberRevision = {
  memberId: "builder", revision: 3, displayName: "Builder", roles: ["AUTHOR", "OPERATOR"],
  capabilities: ["IMPROVEMENT_READ", "IMPROVEMENT_CLAIM", "ASSIGNMENT_WRITE"],
  tokenHash: hashToken(token), createdAt: "2026-08-21T11:00:00.000Z",
};

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function repositoryFixture(kind: "json" | "sqlite" = "json") {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-assignment-"));
  directories.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "base");
  const base = await git(root, "rev-parse", "HEAD");
  const state = path.join(root, ".state");
  const repository = kind === "json"
    ? await RoomStore.open(root, state)
    : await SqliteRoomRepository.open(root, path.join(state, "room.sqlite"));
  await repository.updateSettings({ writableAgent: "codex-sol" });
  await repository.createImprovement(createImprovement({ id: "imp-1", risk: "LOW", author: actor, now: "2099-01-01T00:00:00.000Z" }));
  const registry = new DeveloperTeamRegistry([member]);
  const bridge = new DeveloperBridgeService(repository, registry, () => "2099-01-01T00:01:00.000Z");
  await bridge.acquireClaim(`Bearer ${token}`, {
    improvementId: "imp-1", expectedRevision: 1, idempotencyKey: "claim:first", leaseExpiresAt: "2099-01-01T01:00:00.000Z",
    manifest: { model: "gpt-test", harness: "codex", promptReference: "prompt://assignment", effectiveToolGrants: ["read", "edit", "test"], policyRevision: 1, repositoryBaseCommit: base, environmentId: "assignment" },
  });
  const service = new AssignmentLifecycleService(repository, repository, registry, root, path.join(root, ".worktrees"), () => "2099-01-01T00:02:00.000Z");
  return { root, state, repository, service, base };
}

function assignmentRecord(workspacePath: string): AssignmentRecord {
  return {
    assignmentId: "persisted-1", improvementId: "imp-1", developerMemberId: "builder", developerMemberConfigRevision: 3,
    agent: "codex-sol", fencingToken: 1, manifestRevision: 1, pinnedBaseSha: "a".repeat(40), branch: "amfaa/assignment-persisted",
    observedHeadSha: "b".repeat(40), workspacePath, lifecycleStatus: "RECOVERABLE",
    lifecycleRevision: 1, cancelledAt: null, disposedAt: null, lastOperationKey: null,
    recovery: { classification: "dirty", reconciledAt: "2099-01-01T00:00:00.000Z", previousStatus: "ACTIVE", detail: "preserved" },
    createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z",
  };
}

describe("assignment record persistence", () => {
  it("migrates and reopens JSON assignment records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-assignment-json-")); directories.push(root);
    const state = path.join(root, "state");
    const store = await RoomStore.open(root, state);
    const record = assignmentRecord(path.join(root, "workspace"));
    await store.putAssignment(record);
    const reopened = await RoomStore.open(root, state);
    expect(await reopened.getAssignment(record.assignmentId)).toEqual(record);
    expect(JSON.parse(await readFile(path.join(state, "assignments.json"), "utf8"))).toMatchObject({ schemaVersion: 1, assignments: [record] });
    expect((await stat(path.join(state, "assignments.json"))).mode & 0o777).toBe(0o600);
  });

  it("migrates the legacy JSON assignment array on reopen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-assignment-json-migrate-")); directories.push(root);
    const state = path.join(root, "state"); await mkdir(state);
    const record = assignmentRecord(path.join(root, "workspace"));
    await writeFile(path.join(state, "assignments.json"), JSON.stringify([record]));
    const reopened = await RoomStore.open(root, state);
    expect(await reopened.listAssignments()).toEqual([record]);
  });

  it("migrates and reopens SQLite assignment records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-assignment-sqlite-")); directories.push(root);
    const database = path.join(root, "room.sqlite");
    const store = await SqliteRoomRepository.open(root, database);
    const record = assignmentRecord(path.join(root, "workspace"));
    await store.putAssignment(record); store.close();
    const reopened = await SqliteRoomRepository.open(root, database);
    expect(await reopened.getAssignment(record.assignmentId)).toEqual(record);
    reopened.close();
  });
});

describe("trusted single-writer assignment lifecycle", () => {
  it("accepts a clean assignment owned by a repository that is itself a linked worktree", async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), "amfaa-linked-repository-")); directories.push(container);
    const source = path.join(container, "source"); const repository = path.join(container, "repository"); const worktrees = path.join(container, "worktrees");
    await mkdir(source); await git(source, "init", "-b", "main"); await git(source, "config", "user.email", "test@example.com"); await git(source, "config", "user.name", "Test");
    await writeFile(path.join(source, "tracked.txt"), "base\n"); await git(source, "add", "tracked.txt"); await git(source, "commit", "-m", "base");
    await git(source, "worktree", "add", "-b", "candidate", repository, "HEAD"); await mkdir(worktrees);
    const workspace = path.join(worktrees, "assignment"); await git(repository, "worktree", "add", "-b", "assignment-branch", workspace, "HEAD");
    const record = { ...assignmentRecord(await realpath(workspace)), branch: "assignment-branch" };
    expect(await __testing.disposableWorkspace(repository, await realpath(worktrees), record)).toEqual({ kind: "ok", value: true });
  });

  it("pins a base, creates a unique branch/worktree, and rejects a second writer", async () => {
    const { service, base } = await repositoryFixture();
    const created = await service.create(`Bearer ${token}`, { assignmentId: "assignment-1", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 });
    expect(created).toMatchObject({ kind: "ok", value: { pinnedBaseSha: base, observedHeadSha: base, lifecycleStatus: "ACTIVE", recovery: { classification: "clean" } } });
    if (created.kind !== "ok") throw new Error(created.kind);
    expect(await git(created.value.workspacePath, "branch", "--show-current")).toBe(created.value.branch);
    expect((await service.create(`Bearer ${token}`, { assignmentId: "assignment-2", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 })).kind).toBe("conflict");
  });

  it("serializes concurrent creation requests under the single-writer gate", async () => {
    const { service } = await repositoryFixture();
    const results = await Promise.all([
      service.create(`Bearer ${token}`, { assignmentId: "racing-1", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 }),
      service.create(`Bearer ${token}`, { assignmentId: "racing-2", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 }),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["conflict", "ok"]);
    expect(await service.list()).toHaveLength(1);
  });

  it("recovers dirty and missing work without cleanup deletion", async () => {
    const { service } = await repositoryFixture();
    const created = await service.create(`Bearer ${token}`, { assignmentId: "assignment-dirty", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 });
    if (created.kind !== "ok") throw new Error(created.kind);
    await writeFile(path.join(created.value.workspacePath, "local.txt"), "do not delete\n");
    expect((await service.reconcile())[0]).toMatchObject({ lifecycleStatus: "RECOVERABLE", recovery: { classification: "dirty" }, workspacePath: created.value.workspacePath });
    expect((await service.cleanup())[0]).toMatchObject({ lifecycleStatus: "RECOVERABLE", recovery: { classification: "dirty" }, workspacePath: created.value.workspacePath });
    expect(await stat(path.join(created.value.workspacePath, "local.txt"))).toBeTruthy();
    await rm(created.value.workspacePath, { recursive: true });
    expect((await service.reconcile())[0]).toMatchObject({ lifecycleStatus: "MISSING", recovery: { classification: "missing" }, workspacePath: created.value.workspacePath });
    expect((await service.cleanup())[0].workspacePath).toBe(created.value.workspacePath);
  });

  it("classifies unmerged work and preserves its canonical path", async () => {
    const { root, service } = await repositoryFixture();
    const created = await service.create(`Bearer ${token}`, { assignmentId: "assignment-conflict", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 });
    if (created.kind !== "ok") throw new Error(created.kind);
    await writeFile(path.join(created.value.workspacePath, "tracked.txt"), "assignment\n");
    await git(created.value.workspacePath, "add", "tracked.txt"); await git(created.value.workspacePath, "commit", "-m", "assignment");
    await writeFile(path.join(root, "tracked.txt"), "main\n"); await git(root, "add", "tracked.txt"); await git(root, "commit", "-m", "main");
    await expect(git(created.value.workspacePath, "merge", "main")).rejects.toBeTruthy();
    expect((await service.cleanup())[0]).toMatchObject({ lifecycleStatus: "RECOVERABLE", recovery: { classification: "unmerged" }, workspacePath: created.value.workspacePath });
    expect(await stat(created.value.workspacePath)).toBeTruthy();
  });

  it("classifies a clean integrated assignment head as merged", async () => {
    const { root, service } = await repositoryFixture();
    const created = await service.create(`Bearer ${token}`, { assignmentId: "assignment-merged", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 });
    if (created.kind !== "ok") throw new Error(created.kind);
    await writeFile(path.join(created.value.workspacePath, "done.txt"), "done\n"); await git(created.value.workspacePath, "add", "done.txt"); await git(created.value.workspacePath, "commit", "-m", "done");
    await git(root, "merge", "--ff-only", created.value.branch);
    expect((await service.reconcile())[0]).toMatchObject({ lifecycleStatus: "COMPLETED", recovery: { classification: "merged" } });
  });

  it("cancels authority before process cleanup, preserves dirty work, and releases the writer gate", async () => {
    const { service } = await repositoryFixture();
    const created = await service.create(`Bearer ${token}`, { assignmentId: "assignment-cancel", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 });
    if (created.kind !== "ok") throw new Error(created.kind);
    await writeFile(path.join(created.value.workspacePath, "keep.txt"), "preserve\n");
    const cancelled = await service.cancel(`Bearer ${token}`, { assignmentId: created.value.assignmentId, expectedRevision: 1, idempotencyKey: "cancel-one" });
    expect(cancelled).toMatchObject({ kind: "ok", value: { lifecycleStatus: "CANCELLED", lifecycleRevision: 2, lastOperationKey: "cancel-one" } });
    expect((await service.cancel(`Bearer ${token}`, { assignmentId: created.value.assignmentId, expectedRevision: 2, idempotencyKey: "cancel-conflict" })).kind).toBe("conflict");
    expect(await stat(path.join(created.value.workspacePath, "keep.txt"))).toBeTruthy();
    expect((await service.dispose(`Bearer ${token}`, { assignmentId: created.value.assignmentId, expectedRevision: 2, idempotencyKey: "dispose-dirty", confirmDisposable: true })).kind).toBe("rejected");
    expect((await service.create(`Bearer ${token}`, { assignmentId: "assignment-next", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 })).kind).toBe("ok");
  });

  it("disposes only an explicitly confirmed clean cancelled worktree and is idempotent", async () => {
    const { service } = await repositoryFixture();
    const created = await service.create(`Bearer ${token}`, { assignmentId: "assignment-dispose", improvementId: "imp-1", agent: "codex-sol", fencingToken: 1, manifestRevision: 1 });
    if (created.kind !== "ok") throw new Error(created.kind);
    await service.cancel(`Bearer ${token}`, { assignmentId: created.value.assignmentId, expectedRevision: 1, idempotencyKey: "cancel-dispose" });
    const disposed = await service.dispose(`Bearer ${token}`, { assignmentId: created.value.assignmentId, expectedRevision: 2, idempotencyKey: "dispose-one", confirmDisposable: true });
    expect(disposed).toMatchObject({ kind: "ok", value: { lifecycleStatus: "DISPOSED", lifecycleRevision: 3 } });
    await expect(stat(created.value.workspacePath)).rejects.toBeTruthy();
    expect(await service.dispose(`Bearer ${token}`, { assignmentId: created.value.assignmentId, expectedRevision: 2, idempotencyKey: "dispose-one", confirmDisposable: true })).toEqual(disposed);
  });

  it("exposes prototype metadata without publication operations and scopes writable cwd only", () => {
    expect(ASSIGNMENT_LIFECYCLE_METADATA).toMatchObject({ trustModel: "trusted", writerMode: "single-writer", excludedOperations: ["push", "merge", "deploy"] });
    expect(ASSIGNMENT_LIFECYCLE_METADATA.operations).not.toEqual(expect.arrayContaining(["push", "merge", "deploy"]));
    expect(runnerTesting.resolveExecutionProjectPath("writable", "/source", "/assignment")).toBe("/assignment");
    expect(() => runnerTesting.resolveExecutionProjectPath("writable", "/source")).toThrow("trusted assignment workspace");
    expect(runnerTesting.resolveExecutionProjectPath("read-only", "/source", "/assignment")).toBe("/source");
  });
});
