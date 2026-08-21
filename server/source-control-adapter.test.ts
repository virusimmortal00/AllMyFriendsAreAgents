import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitReadonlySourceBackend,
  GovernedSourceExecutor,
  ReadonlySourceControlAdapter,
  type BoundSourceTarget,
  type ReadonlySourceBackend,
  type SourceBinding,
} from "./source-control-adapter.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function target() {
  return new GovernedSourceExecutor().createSourceTarget({ targetId: "target-1", improvementId: "source-control-adapter" });
}

function fakeBackend(): ReadonlySourceBackend {
  return {
    resolve: vi.fn(async (binding: SourceBinding) => ({
      repository: binding.repository,
      worktree: binding.kind === "worktree" ? binding.worktree : null,
      branch: binding.branch,
      base: { requested: binding.base, revision: "a".repeat(40) },
      head: { requested: binding.head, revision: "b".repeat(40) },
    })),
    capture: vi.fn(async () => ({
      diff: [{ path: "server/source.ts", previousPath: null, status: "modified" as const, additions: 2, deletions: 1, binary: false }],
      checks: [{ name: "git-diff-check", conclusion: "passed" as const, summary: "No whitespace errors detected" }],
    })),
  };
}

const branchBinding: SourceBinding = { kind: "branch", repository: "/repo", branch: "feature/read-only", base: "main", head: "feature/read-only" };

describe("read-only source-control adapter", () => {
  it("accepts only governed targets and binds branch metadata to immutable revisions", async () => {
    const backend = fakeBackend();
    const adapter = new ReadonlySourceControlAdapter(backend);
    const accepted = await adapter.bind(target(), branchBinding);
    expect(accepted).toMatchObject({ kind: "ok", value: {
      repository: "/repo", worktree: null, branch: "feature/read-only",
      base: { requested: "main", revision: "a".repeat(40) },
      head: { requested: "feature/read-only", revision: "b".repeat(40) },
    } });
    await expect(adapter.bind({ targetId: "forged", improvementId: "source-control-adapter" }, branchBinding))
      .resolves.toEqual({ kind: "rejected", reason: "Source target was not issued by the governed executor" });
    expect(Object.isFrozen(accepted.kind === "ok" ? accepted.value : null)).toBe(true);
  });

  it("coalesces equivalent binding and snapshot reads and returns one stable immutable capture", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const backend = fakeBackend();
    vi.mocked(backend.capture).mockImplementation(async () => {
      await gate;
      return { diff: [], checks: [] };
    });
    const adapter = new ReadonlySourceControlAdapter(backend, () => "2026-08-21T13:00:00.000Z");
    const governedTarget = target();
    const [firstBinding, secondBinding] = await Promise.all([adapter.bind(governedTarget, branchBinding), adapter.bind(governedTarget, branchBinding)]);
    expect(backend.resolve).toHaveBeenCalledTimes(1);
    if (firstBinding.kind !== "ok" || secondBinding.kind !== "ok") throw new Error("binding failed");
    const request = { item: { canonicalId: "source-control-adapter" }, binding: firstBinding.value, capabilities: ["SOURCE_PROVENANCE", "SOURCE_DIFF", "SOURCE_CHECKS"] as const };
    const first = adapter.readEvidence(request);
    const second = adapter.readEvidence({ ...request, binding: secondBinding.value });
    release();
    const [firstRead, secondRead] = await Promise.all([first, second]);
    expect(backend.capture).toHaveBeenCalledTimes(1);
    expect(firstRead).toEqual(secondRead);
    expect(firstRead).toMatchObject({ kind: "ok", value: { capturedAt: "2026-08-21T13:00:00.000Z", adapterRevision: "source-control-readonly/v1" } });
    if (firstRead.kind !== "ok") throw new Error("capture failed");
    expect(Object.isFrozen(firstRead.value)).toBe(true);
    expect(Object.isFrozen(firstRead.value.provenance)).toBe(true);
  });

  it("filters evidence to declared capabilities and rejects unrelated source context", async () => {
    const adapter = new ReadonlySourceControlAdapter(fakeBackend(), () => "2026-08-21T13:00:00.000Z");
    const binding = await adapter.bind(target(), branchBinding);
    if (binding.kind !== "ok") throw new Error("binding failed");
    const diffOnly = await adapter.readEvidence({
      item: { canonicalId: "source-control-adapter" }, binding: binding.value, capabilities: ["SOURCE_DIFF"],
    });
    expect(diffOnly).toMatchObject({ kind: "ok", value: { diff: [{ path: "server/source.ts" }] } });
    expect(diffOnly.kind === "ok" ? Object.keys(diffOnly.value).sort() : []).toEqual([
      "adapterRevision", "capturedAt", "diff", "improvementId", "snapshotId", "targetId",
    ]);
    await expect(adapter.readEvidence({ item: { canonicalId: "different-improvement" }, binding: binding.value, capabilities: ["SOURCE_DIFF"] }))
      .resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("unrelated") });
    const forgedBinding: BoundSourceTarget = { ...binding.value, repository: "/unrelated/repository" };
    await expect(adapter.readEvidence({ item: { canonicalId: "source-control-adapter" }, binding: forgedBinding, capabilities: ["SOURCE_DIFF"] }))
      .resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("not bound") });
  });

  it.each([
    { item: { canonicalId: "source-control-adapter", data: { operation: "commit" } }, label: "commit in item data" },
    { item: { canonicalId: "source-control-adapter", evidence: { request: "push" } }, label: "push in evidence" },
    { item: { canonicalId: "source-control-adapter", evidence: [{ capability: "merge" }] }, label: "merge capability" },
    { item: { canonicalId: "source-control-adapter", data: { tool: "deploy" } }, label: "deploy tool" },
    { item: { canonicalId: "source-control-adapter", data: { action: "create source target" } }, label: "target creation" },
    { item: { canonicalId: "source-control-adapter", evidence: { command: "shell" } }, label: "arbitrary command" },
  ])("rejects prohibited mutation/publication requests: $label", async ({ item }) => {
    const adapter = new ReadonlySourceControlAdapter(fakeBackend());
    const binding = await adapter.bind(target(), branchBinding);
    if (binding.kind !== "ok") throw new Error("binding failed");
    await expect(adapter.readEvidence({ item, binding: binding.value, capabilities: ["SOURCE_PROVENANCE"] }))
      .resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("prohibited") });
    expect(Object.getOwnPropertyNames(ReadonlySourceControlAdapter.prototype).sort()).toEqual(["bind", "constructor", "readEvidence"]);
  });

  it("binds real branches and worktrees, normalizes diffs/checks, and reports missing revisions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-source-adapter-"));
    const worktree = `${root}-worktree`;
    directories.push(root, worktree);
    await run(root, ["init", "-b", "main"]);
    await run(root, ["config", "user.name", "Test Author"]);
    await run(root, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(root, "first.txt"), "one\n", "utf8");
    await run(root, ["add", "first.txt"]);
    await run(root, ["commit", "-m", "base"]);
    const base = (await run(root, ["rev-parse", "HEAD"])).trim();
    await run(root, ["checkout", "-b", "feature/read-only"]);
    await writeFile(path.join(root, "first.txt"), "one\ntwo\n", "utf8");
    await writeFile(path.join(root, "second.txt"), "new\n", "utf8");
    await run(root, ["add", "."]);
    await run(root, ["commit", "-m", "head"]);
    const head = (await run(root, ["rev-parse", "HEAD"])).trim();
    await run(root, ["worktree", "add", "--detach", worktree, head]);

    const adapter = new ReadonlySourceControlAdapter(new GitReadonlySourceBackend(), () => "2026-08-21T14:00:00.000Z");
    const governedTarget = target();
    const branch = await adapter.bind(governedTarget, { kind: "branch", repository: root, branch: "feature/read-only", base, head });
    expect(branch).toMatchObject({ kind: "ok", value: { branch: "feature/read-only", worktree: null, base: { revision: base }, head: { revision: head } } });
    if (branch.kind !== "ok") throw new Error("branch binding failed");
    const snapshot = await adapter.readEvidence({ item: { canonicalId: "source-control-adapter" }, binding: branch.value, capabilities: ["SOURCE_DIFF", "SOURCE_CHECKS"] });
    expect(snapshot).toMatchObject({ kind: "ok", value: {
      diff: [
        { path: "first.txt", status: "modified", additions: 1, deletions: 0, binary: false },
        { path: "second.txt", status: "added", additions: 1, deletions: 0, binary: false },
      ],
      checks: [{ name: "git-diff-check", conclusion: "passed" }],
    } });

    const worktreeBinding = await adapter.bind(governedTarget, { kind: "worktree", repository: root, worktree, branch: null, base, head });
    expect(worktreeBinding).toMatchObject({ kind: "ok", value: { repository: await realpath(root), worktree: await realpath(worktree), branch: null } });
    await expect(adapter.bind(governedTarget, { kind: "branch", repository: root, branch: "missing", base: "not-a-revision", head }))
      .resolves.toEqual({ kind: "missing_revision", revision: "not-a-revision" });
  });
});

async function run(root: string, args: readonly string[]) {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout;
}
