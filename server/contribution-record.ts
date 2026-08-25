export const CONTRIBUTION_POLICY_REVISION = 1 as const;
export const CONTRIBUTION_STAGES = ["WORK_COMPLETED", "REVIEW_PENDING", "REVIEW_ACCEPTED", "PR_PUBLISHED", "MERGED", "DEPLOYED", "BLOCKED"] as const;
export type ContributionStage = typeof CONTRIBUTION_STAGES[number];
export type ContributionApprovalKind = "PUBLICATION" | "MERGE" | "DEPLOYMENT";

export interface TestEvidence { readonly command: string; readonly result: "PASSED" | "FAILED"; readonly digest: string; readonly at: string }
export interface ReviewEvidence { readonly reviewerId: string; readonly reviewerRevision: number; readonly decision: "ACCEPTED" | "REJECTED"; readonly summary: string; readonly sourceEvidenceDigest: string; readonly at: string }

export interface ContributionSourceIdentity {
  readonly repository: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly improvementId: string;
  readonly improvementRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly authorId: string;
  readonly authorRevision: number;
  readonly fencingToken: number;
  readonly manifestRevision: number;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly manifestDigest: string;
  readonly brokerRevision: string;
}

export interface ExactContributionApproval {
  readonly approvalId: string;
  readonly kind: ContributionApprovalKind;
  readonly revision: number;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly repository: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly pullNumber: number | null;
  readonly mergedSha: string | null;
  readonly environment: string | null;
  readonly artifactDigest: string | null;
  readonly consumedAt: string | null;
  readonly externalResultId: string | null;
}

export interface ContributionRecord {
  readonly schemaVersion: 1;
  readonly contributionId: string;
  readonly handoffKey: string;
  readonly handoffRequestDigest: string;
  readonly revision: number;
  readonly stage: ContributionStage;
  readonly source: ContributionSourceIdentity;
  readonly title: string;
  readonly description: string;
  readonly testEvidence: readonly TestEvidence[];
  readonly unresolvedFindings: readonly string[];
  readonly review: ReviewEvidence | null;
  readonly pullRequest: { readonly number: number; readonly url: string; readonly publishedAt: string } | null;
  readonly merged: { readonly commitSha: string; readonly resultId: string; readonly mergedAt: string } | null;
  readonly deployed: { readonly environment: string; readonly commitSha: string; readonly artifactDigest: string; readonly resultId: string; readonly deployedAt: string } | null;
  readonly approvals: readonly ExactContributionApproval[];
  readonly blockedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContributionAuditEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly eventId: string;
  readonly contributionId: string;
  readonly contributionRevision: number;
  readonly action: string;
  readonly actorId: string;
  readonly at: string;
  readonly outcome: "ACCEPTED" | "REJECTED" | "FAILED";
  readonly sourceDigest: string;
  readonly recordDigest: string;
  readonly externalResultId: string | null;
  readonly detail: string;
  readonly previousHash: string;
  readonly eventHash: string;
}

export interface ContributionStoreState { readonly schemaVersion: 1; readonly records: readonly ContributionRecord[]; readonly events: readonly ContributionAuditEvent[] }

export type ContributionResult =
  | { readonly kind: "ok"; readonly value: ContributionRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict"; readonly reason: string; readonly actualRevision?: number }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string; readonly retryable: boolean };
