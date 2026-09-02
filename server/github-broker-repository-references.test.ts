import { describe, expect, it } from "vitest";
import { githubBrokerRepositoryReferences } from "./github-broker-repository-references.js";
import { GITHUB_BROKER_REVISION, GITHUB_OPERATIONS, type GitHubBrokerAuditRecord, type GitHubOperation } from "./github-contribution-record.js";

function record(operation: GitHubOperation, outcome: GitHubBrokerAuditRecord["outcome"], patch: Partial<GitHubBrokerAuditRecord> = {}): GitHubBrokerAuditRecord {
  return { schemaVersion: 1, brokerRevision: GITHUB_BROKER_REVISION, sequence: 1, timestamp: "2026-09-02T00:00:00.000Z",
    idempotencyKey: "fixture-operation", requestHash: "a".repeat(64), actorId: "fixture", operation, target: "fixture-target", outcome,
    claims: { repository: "example/repository", roomId: "main", taskId: "fixture-task", taskRevision: 1, assignmentId: "fixture-assignment",
      assignmentRevision: 1, memberId: "fixture", memberRevision: 1, fencingToken: 1, manifestRevision: 1, branch: "fixture-branch",
      baseSha: "a".repeat(40), headSha: "b".repeat(40), policyRevision: 1 },
    result: outcome === "SUCCEEDED" ? { id: "fixture-result", url: "https://github.com/example/repository/issues/1" } : null,
    detail: "Fixture", previousHash: "0".repeat(64), recordHash: "1".repeat(64), ...patch };
}
const READS = ["READ_ISSUE", "READ_PULL_REQUEST", "READ_CHECKS"] as const;
const MUTATIONS = ["COMMENT", "PUBLISH_DRAFT_PULL_REQUEST", "UPDATE_PULL_REQUEST", "REQUEST_REVIEW"] as const;
const unresolved = { terminal: false, reconciled: false };
const settled = { terminal: true, reconciled: true };

describe("GitHub broker repair references", () => {
  it("classifies every documented operation explicitly", () => {
    expect([...READS, ...MUTATIONS]).toEqual(GITHUB_OPERATIONS);
    expect(githubBrokerRepositoryReferences([])).toEqual([]);
  });
  it.each(READS)("never treats interrupted or failed %s as an external mutation", (operation) => {
    for (const outcome of ["PENDING", "FAILED", "REJECTED", "SUCCEEDED"] as const) {
      expect(githubBrokerRepositoryReferences([record(operation, outcome)])).toMatchObject([settled]);
    }
  });
  it.each(MUTATIONS)("retains %s uncertainty through failure and rejected retries until exact success", (operation) => {
    const history = [record(operation, "PENDING")];
    expect(githubBrokerRepositoryReferences(history)).toMatchObject([unresolved]);
    history.push(record(operation, "FAILED", { detail: "retryable:Response lost" }));
    expect(githubBrokerRepositoryReferences(history)).toMatchObject([unresolved]);
    history.push(record(operation, "REJECTED", { claims: null, target: "invalid", detail: "Authority changed" }));
    expect(githubBrokerRepositoryReferences(history)).toMatchObject([unresolved]);
    history.push(record(operation, "FAILED", { detail: "Partial publication could not finish" }));
    expect(githubBrokerRepositoryReferences(history)).toMatchObject([unresolved]);
    history.push(record(operation, "SUCCEEDED"));
    expect(githubBrokerRepositoryReferences(history)).toMatchObject([settled]);
    history.push(record(operation, "REJECTED", { claims: null, target: "invalid" }));
    expect(githubBrokerRepositoryReferences(history)).toMatchObject([settled]);
    history.push(record(operation, "PENDING"));
    expect(githubBrokerRepositoryReferences(history)).toMatchObject([unresolved]);
  });
  it("allows a request rejected before any external attempt without weakening prior uncertainty", () => {
    expect(githubBrokerRepositoryReferences([record("COMMENT", "REJECTED", { claims: null })])).toMatchObject([settled]);
    expect(githubBrokerRepositoryReferences([record("COMMENT", "FAILED")])).toMatchObject([unresolved]);
  });
  it("fails closed for unknown operations, unknown outcomes, incomplete success, and substituted identities", () => {
    const pending = record("COMMENT", "PENDING");
    for (const patch of [{ operation: "UNKNOWN" as GitHubOperation }, { outcome: "UNKNOWN" as GitHubBrokerAuditRecord["outcome"] },
      { claims: null }, { result: null }, { actorId: "different-actor" }, { requestHash: "b".repeat(64) }, { operation: "READ_ISSUE" as const }]) {
      expect(githubBrokerRepositoryReferences([pending, record("COMMENT", "SUCCEEDED", patch)])).toMatchObject([unresolved]);
    }
    expect(githubBrokerRepositoryReferences([record("UNKNOWN" as GitHubOperation, "SUCCEEDED")])).toMatchObject([unresolved]);
    expect(githubBrokerRepositoryReferences([record("READ_ISSUE", "UNKNOWN" as GitHubBrokerAuditRecord["outcome"])])).toMatchObject([unresolved]);
  });
  it("does not let a different key's success settle an unresolved mutation", () => {
    expect(githubBrokerRepositoryReferences([record("COMMENT", "FAILED"), record("READ_CHECKS", "PENDING", { idempotencyKey: "read" }),
      record("COMMENT", "SUCCEEDED", { idempotencyKey: "other-mutation" })])).toMatchObject([
      { id: "fixture-operation", ...unresolved }, { id: "read", ...settled }, { id: "other-mutation", ...settled },
    ]);
  });
  it("cannot settle substituted targets or authorization claims, even after a matching success", () => {
    const pending = record("COMMENT", "PENDING");
    const patches: Partial<GitHubBrokerAuditRecord>[] = [{ target: "issue:2" }];
    for (const [key, value] of Object.entries(pending.claims!)) {
      patches.push({ claims: { ...pending.claims!, [key]: typeof value === "number" ? value + 1 : `${value}-different` } });
    }
    for (const patch of patches) {
      const substituted = record("COMMENT", "SUCCEEDED", patch);
      expect(githubBrokerRepositoryReferences([pending, substituted])).toMatchObject([unresolved]);
      expect(githubBrokerRepositoryReferences([pending, substituted, record("COMMENT", "SUCCEEDED")])).toMatchObject([unresolved]);
    }
    const reorderedClaims = Object.fromEntries(Object.entries(pending.claims!).reverse()) as unknown as NonNullable<GitHubBrokerAuditRecord["claims"]>;
    expect(githubBrokerRepositoryReferences([pending, record("COMMENT", "SUCCEEDED", { claims: reorderedClaims })])).toMatchObject([settled]);
  });
  it("does not turn reused read-only rejection keys into mutation blockers", () => {
    // Malformed requests without a key share the broker's rejected-read fallback.
    expect(githubBrokerRepositoryReferences([record("READ_ISSUE", "REJECTED", { idempotencyKey: "invalid", claims: null }),
      record("READ_ISSUE", "REJECTED", { idempotencyKey: "invalid", claims: null, requestHash: "b".repeat(64), actorId: "other" })])).toMatchObject([settled]);
  });
});
