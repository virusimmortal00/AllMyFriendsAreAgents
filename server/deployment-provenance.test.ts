import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { deploymentPromptContext, deriveDeploymentProvenance, normalizeDeploymentProvenance } from "./deployment-provenance.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function repository() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-provenance-"));
  temporaryDirectories.push(directory);
  await execFileAsync("git", ["init", "-b", "provenance-test", directory]);
  await execFileAsync("git", ["-C", directory, "config", "user.email", "tests@example.invalid"]);
  await execFileAsync("git", ["-C", directory, "config", "user.name", "Tests"]);
  await writeFile(path.join(directory, "source.txt"), "current source\n", "utf8");
  await execFileAsync("git", ["-C", directory, "add", "source.txt"]);
  await execFileAsync("git", ["-C", directory, "commit", "-m", "initial"]);
  return directory;
}

const options = { now: () => "2026-08-26T12:00:00.000Z", nonce: () => "test-nonce" };

describe("deployment provenance", () => {
  it("derives a stable clean branch epoch and an exact immutable commit", async () => {
    const directory = await repository();
    const first = await deriveDeploymentProvenance(directory, options);
    const second = await deriveDeploymentProvenance(directory, { ...options, nonce: () => "different-nonce" });
    const commitSha = (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();

    expect(first).toMatchObject({ commitSha, reference: { kind: "branch", name: "provenance-test" }, worktree: "clean", observedAt: options.now() });
    expect(first.epoch).toBe(second.epoch);
    expect(deploymentPromptContext(first)).toContain(`Commit: ${commitSha}`);
  });

  it("represents detached and dirty checkouts unambiguously and does not make dirty epochs restart-portable", async () => {
    const directory = await repository();
    await execFileAsync("git", ["-C", directory, "checkout", "--detach"]);
    const detached = await deriveDeploymentProvenance(directory, options);
    expect(detached).toMatchObject({ reference: { kind: "detached" }, worktree: "clean" });

    await writeFile(path.join(directory, "source.txt"), "dirty source\n", "utf8");
    const dirty = await deriveDeploymentProvenance(directory, options);
    const afterRestart = await deriveDeploymentProvenance(directory, { ...options, nonce: () => "new-process" });
    expect(dirty).toMatchObject({ reference: { kind: "detached" }, worktree: "dirty" });
    expect(dirty.epoch).not.toBe(detached.epoch);
    expect(dirty.epoch).not.toBe(afterRestart.epoch);
  });

  it("fails safely for a non-checkout and a missing Git executable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-no-git-"));
    temporaryDirectories.push(directory);
    const nonCheckout = await deriveDeploymentProvenance(directory, options);
    const missingGit = await deriveDeploymentProvenance(directory, { ...options, gitCommand: "__missing_amfaa_git__" });

    expect(nonCheckout).toMatchObject({ commitSha: null, reference: { kind: "unavailable" }, worktree: "unavailable", unavailableReason: "not-a-git-checkout" });
    expect(missingGit).toMatchObject({ commitSha: null, reference: { kind: "unavailable" }, worktree: "unavailable", unavailableReason: "git-unavailable" });
    expect(nonCheckout.epoch).not.toBe(missingGit.epoch);
    expect(deploymentPromptContext(missingGit)).toContain("do not guess a revision");
  });

  it("rejects malformed persisted provenance instead of exposing it", () => {
    expect(normalizeDeploymentProvenance({ schemaVersion: 1, commitSha: "not-a-sha", reference: { kind: "branch", name: "main\nINJECT" }, worktree: "clean", epoch: "invalid", observedAt: "never" })).toBeUndefined();
  });
});
