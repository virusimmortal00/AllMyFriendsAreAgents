import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createImprovement, type DomainActor } from "../shared/improvement-domain.js";
import { DeveloperBridgeService } from "./developer-bridge.js";
import { DeveloperTeamRegistry, hashToken, type DeveloperTeamMemberRevision } from "./developer-team.js";
import { RoomStore } from "./room-store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const builderToken = "builder-token-that-is-at-least-thirty-two-characters";
const replacementToken = "replacement-token-that-is-at-least-thirty-two-characters";
const reviewerToken = "reviewer-token-that-is-at-least-thirty-two-characters";
const allCapabilities = ["IMPROVEMENT_READ", "IMPROVEMENT_CLAIM", "IMPROVEMENT_EVIDENCE", "IMPROVEMENT_TRANSITION"] as const;
const members: DeveloperTeamMemberRevision[] = [
  { memberId: "builder", revision: 3, displayName: "Builder", roles: ["AUTHOR", "OPERATOR"], capabilities: allCapabilities, tokenHash: hashToken(builderToken), createdAt: "2026-08-21T11:00:00.000Z" },
  { memberId: "replacement", revision: 1, displayName: "Replacement", roles: ["AUTHOR", "OPERATOR"], capabilities: allCapabilities, tokenHash: hashToken(replacementToken), createdAt: "2026-08-21T11:00:00.000Z" },
  { memberId: "reviewer", revision: 1, displayName: "Reviewer", roles: ["REVIEWER"], capabilities: ["IMPROVEMENT_READ", "IMPROVEMENT_REVIEW"], tokenHash: hashToken(reviewerToken), createdAt: "2026-08-21T11:00:00.000Z" },
];
const author: DomainActor = { id: "human-author", role: "AUTHOR", human: true };

function manifest() {
  return { model: "gpt-test", harness: "codex", promptReference: "prompt://work/1", promptHash: "sha256:abc", effectiveToolGrants: ["read", "edit", "test"], policyRevision: 7, repositoryBaseCommit: "abc123", environmentId: "test-worktree" };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-developer-bridge-"));
  directories.push(root);
  const repository = await RoomStore.open(root, path.join(root, "state"));
  await repository.createImprovement(createImprovement({ id: "imp-1", risk: "LOW", author, now: "2026-08-21T12:00:00.000Z" }));
  let now = "2026-08-21T12:01:00.000Z";
  return { repository, bridge: new DeveloperBridgeService(repository, new DeveloperTeamRegistry(members), () => now), setNow(value: string) { now = value; } };
}

describe("authenticated developer bridge", () => {
  it("derives attribution and immutable manifest identity from authentication", async () => {
    const { bridge } = await fixture();
    const acquired = await bridge.acquireClaim(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 1, idempotencyKey: "claim:first", leaseExpiresAt: "2026-08-21T12:10:00.000Z", manifest: manifest() });
    expect(acquired).toMatchObject({ kind: "ok", value: { revision: 2, workClaim: { holderMemberId: "builder", fencingToken: 1, manifests: [{ memberId: "builder", memberConfigRevision: 3 }] } } });
    expect(await bridge.readClaim(`Bearer ${builderToken}`, "imp-1")).toMatchObject({ kind: "ok", value: { holderMemberId: "builder", fencingToken: 1 } });
    const evidence = await bridge.appendEvidence(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 2, fencingToken: 1, evidence: { id: "e-1", uri: "test://evidence", description: "passes" } });
    expect(evidence).toMatchObject({ kind: "ok", value: { evidence: [{ addedBy: "builder" }] } });
    expect(await bridge.recordReview(`Bearer ${reviewerToken}`, { improvementId: "imp-1", expectedRevision: 3, decision: "APPROVE" })).toMatchObject({ kind: "ok", value: { technicalConsensus: { reviews: [{ reviewerId: "reviewer" }] } } });
    expect(await bridge.acquireClaim(`Bearer ${reviewerToken}`, { improvementId: "imp-1", expectedRevision: 4, idempotencyKey: "spoof:claim", leaseExpiresAt: "2026-08-21T12:10:00.000Z", manifest: manifest() })).toEqual({ kind: "unauthorized" });
  });

  it("fails closed on stale revisions, conflicting claims, lost leases, and fencing tokens", async () => {
    const { bridge, setNow } = await fixture();
    const input = { improvementId: "imp-1", expectedRevision: 1, idempotencyKey: "claim:first", leaseExpiresAt: "2026-08-21T12:02:00.000Z", manifest: manifest() };
    expect((await bridge.acquireClaim(`Bearer ${builderToken}`, input)).kind).toBe("ok");
    expect(await bridge.acquireClaim(`Bearer ${replacementToken}`, { ...input, expectedRevision: 2, idempotencyKey: "claim:conflict" })).toMatchObject({ kind: "rejected" });
    expect(await bridge.appendEvidence(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 1, fencingToken: 1, evidence: { id: "bad", uri: "test://bad", description: "stale" } })).toMatchObject({ kind: "conflict" });

    setNow("2026-08-21T12:03:00.000Z");
    const replaced = await bridge.acquireClaim(`Bearer ${replacementToken}`, { ...input, expectedRevision: 2, idempotencyKey: "claim:replacement", leaseExpiresAt: "2026-08-21T12:10:00.000Z" });
    expect(replaced).toMatchObject({ kind: "ok", value: { workClaim: { holderMemberId: "replacement", fencingToken: 2, history: [{ kind: "ACQUIRED" }, { kind: "EXPIRED" }, { kind: "REPLACED" }] } } });
    expect(await bridge.appendEvidence(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 3, fencingToken: 1, evidence: { id: "late", uri: "test://late", description: "late" } })).toMatchObject({ kind: "rejected" });
    const replay = await bridge.acquireClaim(`Bearer ${replacementToken}`, { ...input, expectedRevision: 2, idempotencyKey: "claim:replacement", leaseExpiresAt: "2026-08-21T12:10:00.000Z" });
    expect(replay).toMatchObject({ kind: "ok", value: { revision: 3 } });
  });

  it("keeps renewal, manifest revision, handoff, release, retry, and completion append-only", async () => {
    const { bridge } = await fixture();
    await bridge.acquireClaim(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 1, idempotencyKey: "claim:first", leaseExpiresAt: "2026-08-21T12:10:00.000Z", manifest: manifest() });
    await bridge.mutateClaim(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 2, idempotencyKey: "claim:renew", fencingToken: 1, operation: "renew", leaseExpiresAt: "2026-08-21T12:11:00.000Z" });
    await bridge.mutateClaim(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 3, idempotencyKey: "claim:manifest", fencingToken: 1, operation: "manifest", manifest: { ...manifest(), model: "gpt-test-2" } });
    await bridge.mutateClaim(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 4, idempotencyKey: "claim:handoff", fencingToken: 1, operation: "handoff", toMemberId: "replacement", leaseExpiresAt: "2026-08-21T12:12:00.000Z", manifest: { ...manifest(), environmentId: "handoff-worktree" } });
    await bridge.mutateClaim(`Bearer ${replacementToken}`, { improvementId: "imp-1", expectedRevision: 5, idempotencyKey: "claim:release", fencingToken: 2, operation: "release" });
    await bridge.acquireClaim(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 6, idempotencyKey: "claim:retry", leaseExpiresAt: "2026-08-21T12:13:00.000Z", manifest: manifest() });
    const completed = await bridge.mutateClaim(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 7, idempotencyKey: "claim:complete", fencingToken: 3, operation: "complete" });

    expect(completed).toMatchObject({ kind: "ok", value: { revision: 8, workClaim: { status: "COMPLETED", manifests: [{ revision: 1 }, { revision: 2 }, { revision: 3 }, { revision: 4 }], history: [
      { kind: "ACQUIRED", memberId: "builder" },
      { kind: "RENEWED", memberId: "builder" },
      { kind: "MANIFEST_REVISED", memberId: "builder" },
      { kind: "HANDED_OFF", memberId: "replacement", fencingToken: 2 },
      { kind: "RELEASED", memberId: "replacement" },
      { kind: "ACQUIRED", memberId: "builder", fencingToken: 3 },
      { kind: "COMPLETED", memberId: "builder" },
    ] } } });
  });

  it("routes action-start transitions through shared consensus, authority, risk, review, and emergency-stop policy", async () => {
    const { bridge, repository } = await fixture();
    await bridge.acquireClaim(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 1, idempotencyKey: "claim:first", leaseExpiresAt: "2026-08-21T12:10:00.000Z", manifest: manifest() });
    await repository.applyImprovementChange("imp-1", 2, { kind: "TRANSITION", to: "PROPOSED" }, author, "2026-08-21T12:01:10.000Z");
    const reviewer: DomainActor = { id: "reviewer", role: "REVIEWER", human: false };
    await repository.applyImprovementChange("imp-1", 3, { kind: "TRANSITION", to: "IN_REVIEW" }, reviewer, "2026-08-21T12:01:20.000Z");
    await bridge.recordReview(`Bearer ${reviewerToken}`, { improvementId: "imp-1", expectedRevision: 4, decision: "APPROVE" });
    await repository.applyImprovementChange("imp-1", 5, { kind: "TRANSITION", to: "APPROVED" }, reviewer, "2026-08-21T12:01:30.000Z");
    expect(await bridge.requestTransition(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 6, fencingToken: 1, to: "IN_PROGRESS", action: "RUN_TESTS" })).toMatchObject({ kind: "rejected", reason: expect.stringContaining("Action authority") });
    const operator: DomainActor = { id: "human-operator", role: "OPERATOR", human: true };
    await repository.applyImprovementChange("imp-1", 6, { kind: "SET_ACTION_AUTHORITY", status: "GRANTED", allowedActions: ["RUN_TESTS"] }, operator, "2026-08-21T12:01:40.000Z");
    await repository.updateEmergencyStop(0, { active: true, reason: "stop" }, operator, "2026-08-21T12:01:45.000Z");
    expect(await bridge.requestTransition(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 7, fencingToken: 1, to: "IN_PROGRESS", action: "RUN_TESTS" })).toMatchObject({ kind: "rejected", reason: expect.stringContaining("Emergency stop") });
    await repository.updateEmergencyStop(1, { active: false }, operator, "2026-08-21T12:01:50.000Z");
    expect(await bridge.requestTransition(`Bearer ${builderToken}`, { improvementId: "imp-1", expectedRevision: 7, fencingToken: 1, to: "IN_PROGRESS", action: "RUN_TESTS" })).toMatchObject({ kind: "ok", value: { state: "IN_PROGRESS" } });
  });
});
