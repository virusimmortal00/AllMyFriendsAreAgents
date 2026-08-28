import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openJsonServerIdentity } from "./json-server-identity.js";
import { repositoryAuthorityBlocker, requireReconciledSourceWork, sourceWorkAuthorityReason, sourceWorkReconciliationBlocker, type SourceWorkBinding } from "./identity-domain.js";
import { RoomStore } from "../room-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("durable identity domain", () => {
  it("keeps a process-independent JSON compatibility identity with private permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-json-server-identity-")); roots.push(root);
    const identities = await Promise.all(Array.from({ length: 12 }, () => openJsonServerIdentity(root)));
    expect(new Set(identities.map(({ serverId }) => serverId)).size).toBe(1);
    expect(identities.every((identity) => JSON.stringify(identity) === JSON.stringify(identities[0]))).toBe(true);
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

  it("accepts only the current project's verified server-held repository connection", async () => {
    const base = { getStorageScope: async () => ({ schemaVersion: 1 as const, serverId: "server", roomId: "room", projectId: "project",
      repositoryReferenceId: "legacy", repositoryReferenceRevision: 1 }), getRepositoryReference: async () => ({ schemaVersion: 1 as const,
      repositoryReferenceId: "legacy", projectId: "project", revision: 1, state: "unverified-legacy-placeholder" as const,
      localPath: "/private/repository", sanitizedRemoteIdentity: null, createdAt: "now", updatedAt: "now" }) };
    expect(await repositoryAuthorityBlocker(base, "room")).toBe("repository-reference-unverified");
    expect(await repositoryAuthorityBlocker({ ...base, getVerifiedRepositoryConnection: () => ({ projectId: "other", revision: 1, state: "verified" }) }, "room"))
      .toBe("repository-reference-unverified");
    expect(await repositoryAuthorityBlocker({ ...base, getVerifiedRepositoryConnection: () => ({ projectId: "project", revision: 2, state: "verified" }) }, "room"))
      .toBeNull();
  });
});
