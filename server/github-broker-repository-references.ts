import { isDeepStrictEqual } from "node:util";
import { GITHUB_OPERATIONS, type GitHubBrokerAuditRecord } from "./github-contribution-record.js";

const READ_ONLY = new Set(["READ_ISSUE", "READ_PULL_REQUEST", "READ_CHECKS"]);

/** Classify the complete verified audit, not just the last attempt per key. */
export function githubBrokerRepositoryReferences(records: readonly GitHubBrokerAuditRecord[]) {
  const operations = new Map<string, { first: GitHubBrokerAuditRecord; unresolved: boolean; invalid: boolean }>();
  for (const record of records) {
    const state = operations.get(record.idempotencyKey) ?? { first: record, unresolved: false, invalid: false };
    operations.set(record.idempotencyKey, state);
    if (!GITHUB_OPERATIONS.includes(record.operation) || !["PENDING", "FAILED", "REJECTED", "SUCCEEDED"].includes(record.outcome)) state.invalid = true;
    const sameRequest = record.operation === state.first.operation && record.actorId === state.first.actorId && record.requestHash === state.first.requestHash;
    if (!sameRequest && !(READ_ONLY.has(record.operation) && READ_ONLY.has(state.first.operation))) state.invalid = true;
    // Interrupted reads cannot leave an external mutation to reconcile. They
    // retain their original audit outcome and all normal read authorization.
    if (READ_ONLY.has(record.operation)) continue;
    // Rejections before authorization legitimately have an invalid target and
    // no claims. Actual attempts must retain the original target and authority.
    if (record.outcome !== "REJECTED" && (record.target !== state.first.target || !record.claims
      || !isDeepStrictEqual(record.claims, state.first.claims))) state.invalid = true;
    switch (record.outcome) {
      case "PENDING":
      case "FAILED":
        // Retryability is not evidence of whether a mutation acted. Even a
        // nonretryable failure may follow a successful partial publication.
        state.unresolved = true;
        break;
      case "SUCCEEDED":
        state.unresolved = !record.claims || !record.result;
        break;
      case "REJECTED":
        // A later authorization failure cannot settle an earlier lost result.
        break;
      default:
        state.invalid = true;
    }
  }
  return [...operations.entries()].map(([id, state]) => ({
    kind: "operation" as const, id, terminal: !state.unresolved && !state.invalid, reconciled: !state.unresolved && !state.invalid,
  }));
}
