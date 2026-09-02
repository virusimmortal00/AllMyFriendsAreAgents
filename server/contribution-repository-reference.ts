import type { ContributionAuditEvent, ContributionRecord } from "./contribution-record.js";
import { contributionDigest } from "./contribution-store.js";

const LOCAL_ACTIONS = new Set([
  "HANDOFF_CREATED", "REVIEW_ACCEPTED", "REVIEW_REJECTED", "REVIEW_SOURCE_REJECTED", "REVIEW_FAILED", "REVIEW_STALE",
  "PUBLICATION_APPROVAL_STALE",
  ...["PUBLICATION", "MERGE", "DEPLOYMENT"].flatMap((kind) => [`${kind}_APPROVAL_REJECTED`, `${kind}_EXECUTION_REJECTED`]),
]);
const LOCAL_BLOCKS = new Set(["REVIEW_STALE", "PUBLICATION_APPROVAL_STALE"]);

/** Consume the complete, verified store audit; a missing or unknown history fails closed. */
export function contributionRepositoryReference(record: ContributionRecord, audit: readonly ContributionAuditEvent[]) {
  return {
    kind: (record.stage === "MERGED" || record.stage === "DEPLOYED" ? "deployment" : "contribution") as "deployment" | "contribution",
    id: record.contributionId,
    terminal: record.stage === "DEPLOYED" || record.stage === "BLOCKED",
    reconciled: record.stage === "BLOCKED" ? locallyTerminated(record, audit) : record.blockedReason === null,
  };
}

function locallyTerminated(record: ContributionRecord, audit: readonly ContributionAuditEvent[]) {
  // BLOCKED cannot resume publication. Never-approved local rejection needs no
  // external reconciliation. Even an unused approval may have acted before a
  // crash prevented result persistence, so absence of an execution event is not
  // enough. Check both the immutable approvals and the complete audit history.
  if (record.blockedReason === null || record.pullRequest !== null || record.merged !== null || record.deployed !== null
    || record.approvals.length !== 0) return false;
  const history = audit.filter((event) => event.contributionId === record.contributionId);
  if (history[0]?.action !== "HANDOFF_CREATED" || history[0].contributionRevision !== 1
    || history.some((event) => !LOCAL_ACTIONS.has(event.action) || event.outcome === "FAILED" || event.externalResultId !== null)) return false;
  // Later rejected retries append events at the same revision. Inspect the
  // transition that first wrote this revision, not the final retry's action.
  const transition = history.find((event) => event.contributionRevision === record.revision);
  if (!transition || transition.recordDigest !== contributionDigest(record)) return false;
  return (transition.action === "REVIEW_REJECTED" && transition.outcome === "ACCEPTED" && record.review?.decision === "REJECTED")
    || (LOCAL_BLOCKS.has(transition.action) && transition.outcome === "REJECTED");
}
