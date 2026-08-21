import { isAgentId } from "../shared/participants.js";
import type { AgentId } from "./types.js";

export const ASSIGNMENT_LIFECYCLE_METADATA = Object.freeze({
  label: "Trusted assignment lifecycle prototype",
  trustModel: "trusted" as const,
  writerMode: "single-writer" as const,
  operations: ["create", "inspect", "reconcile", "cleanup"] as const,
  excludedOperations: ["push", "merge", "deploy"] as const,
});

export type AssignmentRecoveryClassification = "clean" | "dirty" | "missing" | "merged" | "unmerged";
export type AssignmentLifecycleStatus = "ACTIVE" | "RECOVERABLE" | "COMPLETED" | "MISSING";

export interface AssignmentRecoveryMetadata {
  readonly classification: AssignmentRecoveryClassification;
  readonly reconciledAt: string;
  readonly previousStatus: AssignmentLifecycleStatus | null;
  readonly detail: string;
}

export interface AssignmentRecord {
  readonly assignmentId: string;
  readonly improvementId: string;
  readonly developerMemberId: string;
  readonly developerMemberConfigRevision: number;
  readonly agent: AgentId;
  readonly fencingToken: number;
  readonly manifestRevision: number;
  readonly pinnedBaseSha: string;
  readonly branch: string;
  readonly observedHeadSha: string;
  readonly workspacePath: string;
  readonly lifecycleStatus: AssignmentLifecycleStatus;
  readonly recovery: AssignmentRecoveryMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AssignmentRecordStore {
  listAssignments(): Promise<readonly AssignmentRecord[]>;
  getAssignment(assignmentId: string): Promise<AssignmentRecord | undefined>;
  putAssignment(assignment: AssignmentRecord): Promise<void>;
}

export function normalizeAssignmentRecord(value: unknown): AssignmentRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<AssignmentRecord>;
  const recovery = record.recovery as Partial<AssignmentRecoveryMetadata> | undefined;
  if (!record.assignmentId || !record.improvementId || !record.developerMemberId || !isAgentId(record.agent)
    || !Number.isSafeInteger(record.developerMemberConfigRevision) || !Number.isSafeInteger(record.fencingToken)
    || !Number.isSafeInteger(record.manifestRevision) || !record.pinnedBaseSha || !record.branch
    || !record.observedHeadSha || !record.workspacePath || !record.createdAt || !record.updatedAt
    || !["ACTIVE", "RECOVERABLE", "COMPLETED", "MISSING"].includes(record.lifecycleStatus || "")
    || !recovery || !["clean", "dirty", "missing", "merged", "unmerged"].includes(recovery.classification || "")
    || !recovery.reconciledAt || typeof recovery.detail !== "string") return undefined;
  return structuredClone(record as AssignmentRecord);
}
