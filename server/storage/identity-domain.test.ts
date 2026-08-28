import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openJsonServerIdentity } from "./json-server-identity.js";
import { requireReconciledSourceWork, sourceWorkAuthorityReason, sourceWorkReconciliationBlocker, type SourceWorkBinding } from "./identity-domain.js";
import { RoomStore } from "../room-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("durable identity domain", () => {
  it("keeps a process-independent JSON compatibility identity with private permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-json-server-identity-")); roots.push(root);
    const first = await openJsonServerIdentity(root);
    const second = await openJsonServerIdentity(root);
    expect(second).toEqual(first);
    expect((await stat(path.join(root, "server-identity.json"))).mode & 0o777).toBe(0o600);
  });

  it("fails closed for migrated reconciliation overlays without inferring a worker", async () => {
    const binding: SourceWorkBinding = {
      schemaVersion: 1, kind: "assignment", workId: "legacy", roomId: "room", projectId: "project", repositoryReferenceId: "repository",
      repositoryReferenceRevision: 1, originTaskId: null, originTaskRevision: null, implementationJobId: null, implementationWorkerId: null,
      state: "needs-reconciliation", reasonCode: "legacy-missing-implementation-job-worker", evidence: {}, revision: 1,
      createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const repository = { getSourceWorkBinding: async () => binding };
    expect(sourceWorkAuthorityReason(binding)).toBe("legacy-missing-implementation-job-worker");
    await expect(requireReconciledSourceWork(repository, "assignment", "legacy")).rejects.toThrow(/not authorized.*legacy-missing-implementation-job-worker/i);
  });

  it("fails closed when an identity-aware store has no source-work binding", async () => {
    const repository = { getSourceWorkBinding: async () => undefined };
    expect(await sourceWorkReconciliationBlocker(repository, "assignment", "new-work")).toBe("source-work-binding-missing");
    await expect(requireReconciledSourceWork(repository, "assignment", "new-work")).rejects.toThrow(/source-work-binding-missing/i);
  });

  it("allows only current-boot JSON work and denies it after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-json-boot-work-")); roots.push(root);
    const first = await RoomStore.open(root, path.join(root, "state"));
    first.authorizeSourceWorkForCurrentBoot("assignment", "new-assignment");
    expect(await sourceWorkReconciliationBlocker(first, "assignment", "new-assignment")).toBeNull();
    const restarted = await RoomStore.open(root, path.join(root, "state"));
    expect(await sourceWorkReconciliationBlocker(restarted, "assignment", "new-assignment")).toBe("source-work-binding-missing");
  });
});
