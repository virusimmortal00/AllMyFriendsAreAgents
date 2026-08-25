import type { DeveloperCapability } from "./developer-team.js";

export const GITHUB_BROKER_REVISION = "github-contribution-broker/v1" as const;
export const GITHUB_POLICY_REVISION = 1 as const;

export const GITHUB_OPERATIONS = [
  "READ_ISSUE", "READ_PULL_REQUEST", "READ_CHECKS", "COMMENT",
  "PUBLISH_DRAFT_PULL_REQUEST", "UPDATE_PULL_REQUEST", "REQUEST_REVIEW",
] as const;
export type GitHubOperation = typeof GITHUB_OPERATIONS[number];

export const GITHUB_OPERATION_CAPABILITY: Readonly<Record<GitHubOperation, DeveloperCapability>> = {
  READ_ISSUE: "GITHUB_READ",
  READ_PULL_REQUEST: "GITHUB_READ",
  READ_CHECKS: "GITHUB_READ",
  COMMENT: "GITHUB_COMMENT",
  PUBLISH_DRAFT_PULL_REQUEST: "GITHUB_PUBLISH_DRAFT",
  UPDATE_PULL_REQUEST: "GITHUB_PR_METADATA",
  REQUEST_REVIEW: "GITHUB_REQUEST_REVIEW",
};

export interface GitHubBrokerClaims {
  readonly repository: string;
  readonly roomId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly memberId: string;
  readonly memberRevision: number;
  readonly fencingToken: number;
  readonly manifestRevision: number;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly policyRevision: typeof GITHUB_POLICY_REVISION;
}

export interface GitHubBrokerRequest {
  readonly idempotencyKey: string;
  readonly operation: GitHubOperation;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly expectedTaskRevision: number;
  readonly expectedAssignmentRevision: number;
  readonly expectedFencingToken: number;
  readonly expectedManifestRevision: number;
  readonly expectedPolicyRevision: typeof GITHUB_POLICY_REVISION;
  readonly expectedBaseSha: string;
  readonly expectedHeadSha: string;
  readonly issueNumber?: number;
  readonly pullNumber?: number;
  readonly body?: string;
  readonly title?: string;
  readonly reviewers?: readonly string[];
}

export interface GitHubExternalResult {
  readonly id: string;
  readonly url: string;
  readonly number?: number;
  readonly state?: string;
  readonly data?: unknown;
}

export interface GitHubBrokerAuditRecord {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly brokerRevision: typeof GITHUB_BROKER_REVISION;
  readonly timestamp: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly actorId: string;
  readonly operation: GitHubOperation;
  readonly target: string;
  readonly claims: GitHubBrokerClaims | null;
  readonly outcome: "PENDING" | "SUCCEEDED" | "REJECTED" | "FAILED";
  readonly result: GitHubExternalResult | null;
  readonly detail: string;
  readonly previousHash: string;
  readonly recordHash: string;
}

export interface GitHubBrokerStoreState {
  readonly schemaVersion: 1;
  readonly records: readonly GitHubBrokerAuditRecord[];
}

export type GitHubBrokerResult =
  | { readonly kind: "ok"; readonly value: GitHubExternalResult; readonly claims: GitHubBrokerClaims; readonly replayed: boolean }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string; readonly retryable: boolean };
