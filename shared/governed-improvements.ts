import type { ImprovementRisk, ImprovementState } from "./improvement-domain.js";
import type { ImprovementStatusContract } from "./improvement-status.js";

export type ImprovementRevisionLabel = `r${number}`;

export interface GovernedImprovementSummary {
  readonly canonicalId: string;
  readonly revisionLabel: ImprovementRevisionLabel;
  readonly state: ImprovementState;
  readonly risk: ImprovementRisk;
  readonly updatedAt: string;
}

export type EvidenceSourceClass = "DEVELOPER_TEAM" | "INDEPENDENT_ACCEPTANCE" | "UNQUALIFIED";

export interface QualifiedImprovementEvidence {
  readonly id: string;
  readonly introducedRevision: number;
  readonly revisionLabel: ImprovementRevisionLabel;
  readonly sourceClass: EvidenceSourceClass;
  readonly kind: string;
  readonly uri: string;
  readonly summary: string;
  readonly recordedAt: string;
}

export type ImprovementMilestoneState = "PENDING" | "ACHIEVED" | "BLOCKED" | "CANCELED";

export interface ImprovementMilestone {
  readonly id: string;
  readonly introducedRevision: number;
  readonly revisionLabel: ImprovementRevisionLabel;
  readonly state: ImprovementMilestoneState;
  readonly summary: string;
  readonly recordedAt: string;
}

export interface GovernedImprovementRevision {
  readonly revision: number;
  readonly revisionLabel: ImprovementRevisionLabel;
  readonly state: ImprovementState;
  readonly status: ImprovementStatusContract;
  readonly createdAt: string;
}

export interface GovernedImprovementDetail extends GovernedImprovementSummary {
  readonly status: ImprovementStatusContract;
  readonly evidence: readonly QualifiedImprovementEvidence[];
  readonly revisions: readonly GovernedImprovementRevision[];
  readonly milestones: readonly ImprovementMilestone[];
}

export interface StoredImprovementMilestone {
  readonly improvementId: string;
  readonly id: string;
  readonly introducedRevision: number;
  readonly state: ImprovementMilestoneState;
  readonly summary: string;
  readonly recordedAt: string;
}

export interface ImprovementLedgerRecords {
  readonly evidence: readonly Omit<QualifiedImprovementEvidence, "revisionLabel">[];
  readonly revisions: readonly Omit<GovernedImprovementRevision, "revisionLabel">[];
  readonly milestones: readonly StoredImprovementMilestone[];
}

export type AddImprovementMilestoneResult =
  | { readonly kind: "accepted"; readonly created: boolean; readonly revision: number; readonly milestone: StoredImprovementMilestone }
  | { readonly kind: "missing_item"; readonly canonicalId: string }
  | { readonly kind: "conflict"; readonly expectedRevision: number; readonly actualRevision: number }
  | { readonly kind: "rejected"; readonly reason: string };

export function improvementRevisionLabel(revision: number): ImprovementRevisionLabel {
  return `r${revision}`;
}
