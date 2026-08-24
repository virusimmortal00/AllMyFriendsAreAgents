import { isAgentId } from "../shared/participants.js";
import type { AgentId } from "./types.js";

export const ASSIGNMENT_LIFECYCLE_METADATA = Object.freeze({
  label: "Trusted assignment lifecycle prototype",
  trustModel: "trusted" as const,
  writerMode: "single-writer" as const,
  operations: ["create", "inspect", "reconcile", "cancel", "dispose", "cleanup"] as const,
  excludedOperations: ["push", "merge", "deploy"] as const,
});

export type AssignmentRecoveryClassification = "clean" | "dirty" | "missing" | "merged" | "unmerged";
export type AssignmentLifecycleStatus = "ACTIVE" | "RECOVERABLE" | "COMPLETED" | "MISSING" | "CANCELLED" | "DISPOSED";

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
  readonly lifecycleRevision?: number;
  readonly cancelledAt?: string | null;
  readonly disposedAt?: string | null;
  readonly lastOperationKey?: string | null;
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
    || !["ACTIVE", "RECOVERABLE", "COMPLETED", "MISSING", "CANCELLED", "DISPOSED"].includes(record.lifecycleStatus || "")
    || (record.lifecycleRevision !== undefined && (!Number.isSafeInteger(record.lifecycleRevision) || record.lifecycleRevision < 1))
    || (record.cancelledAt !== undefined && record.cancelledAt !== null && typeof record.cancelledAt !== "string")
    || (record.disposedAt !== undefined && record.disposedAt !== null && typeof record.disposedAt !== "string")
    || (record.lastOperationKey !== undefined && record.lastOperationKey !== null && typeof record.lastOperationKey !== "string")
    || !recovery || !["clean", "dirty", "missing", "merged", "unmerged"].includes(recovery.classification || "")
    || !recovery.reconciledAt || typeof recovery.detail !== "string") return undefined;
  return structuredClone({
    ...record,
    lifecycleRevision: record.lifecycleRevision ?? 1,
    cancelledAt: record.cancelledAt ?? null,
    disposedAt: record.disposedAt ?? null,
    lastOperationKey: record.lastOperationKey ?? null,
  } as AssignmentRecord);
}
