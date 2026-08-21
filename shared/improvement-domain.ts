import {
  applyImprovementStatusTransition,
  emptyImprovementStatus,
  type ImprovementStatusContract,
  type ImprovementStatusTransition,
} from "./improvement-status.js";

export const IMPROVEMENT_RISK_LEVELS = ["LOW", "GUARDED", "RESTRICTED"] as const;
export type ImprovementRisk = (typeof IMPROVEMENT_RISK_LEVELS)[number];

export const IMPROVEMENT_STATES = [
  "DRAFT",
  "PROPOSED",
  "IN_REVIEW",
  "APPROVED",
  "IN_PROGRESS",
  "PAUSED",
  "BLOCKED",
  "CANCELED",
  "COMPLETED",
] as const;
export type ImprovementState = (typeof IMPROVEMENT_STATES)[number];

export type ActorRole = "AUTHOR" | "REVIEWER" | "OPERATOR" | "ADMIN";

export interface DomainActor {
  readonly id: string;
  readonly role: ActorRole;
  readonly human: boolean;
}

export interface TechnicalReview {
  readonly reviewerId: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly at: string;
}

export interface TechnicalConsensus {
  readonly status: "PENDING" | "ACCEPTED" | "REJECTED";
  readonly reviews: readonly TechnicalReview[];
}

export type AutonomousAction = "ANALYZE" | "EDIT_SANDBOX" | "RUN_TESTS";
export type ExcludedAutonomousAction =
  | "MERGE"
  | "DEPLOY"
  | "CHANGE_CREDENTIALS"
  | "DESTRUCTIVE_OPERATION"
  | "EDIT_LIVE_CHECKOUT";
export type ImprovementAction = AutonomousAction | ExcludedAutonomousAction;

export interface ActionAuthority {
  readonly status: "PENDING" | "GRANTED" | "DENIED";
  readonly grantedBy: string | null;
  readonly grantedByHuman: boolean;
  readonly improvementRevision: number | null;
  readonly allowedActions: readonly AutonomousAction[];
}

export interface ImprovementClaim {
  readonly id: string;
  readonly statement: string;
}

export interface DeveloperExecutionManifest {
  readonly revision: number;
  readonly memberId: string;
  readonly memberConfigRevision: number;
  readonly model: string;
  readonly harness: string;
  readonly promptReference: string;
  readonly promptHash?: string;
  readonly effectiveToolGrants: readonly string[];
  readonly policyRevision: number;
  readonly repositoryBaseCommit: string;
  readonly environmentId: string;
  readonly createdAt: string;
}

export type WorkClaimEventKind = "ACQUIRED" | "RENEWED" | "HANDED_OFF" | "RELEASED" | "EXPIRED" | "REPLACED" | "COMPLETED" | "MANIFEST_REVISED";

export interface WorkClaimEvent {
  readonly idempotencyKey: string;
  readonly kind: WorkClaimEventKind;
  readonly memberId: string;
  readonly at: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string | null;
  readonly manifestRevision: number;
  readonly replacedMemberId?: string;
}

export interface ImprovementWorkClaim {
  readonly fencingToken: number;
  readonly holderMemberId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly status: "UNCLAIMED" | "ACTIVE" | "RELEASED" | "EXPIRED" | "COMPLETED";
  readonly manifests: readonly DeveloperExecutionManifest[];
  readonly history: readonly WorkClaimEvent[];
}

export interface EvidenceReference {
  readonly id: string;
  readonly uri: string;
  readonly description: string;
  readonly addedBy: string;
  readonly addedAt: string;
}

export interface AttributionEntry {
  readonly actorId: string;
  readonly at: string;
  readonly change: string;
  readonly revision: number;
}

export interface Improvement {
  readonly id: string;
  readonly revision: number;
  readonly state: ImprovementState;
  readonly risk: ImprovementRisk;
  readonly authorId: string;
  readonly technicalConsensus: TechnicalConsensus;
  readonly actionAuthority: ActionAuthority;
  readonly claims: readonly ImprovementClaim[];
  readonly workClaim: ImprovementWorkClaim;
  readonly evidence: readonly EvidenceReference[];
  readonly attribution: readonly AttributionEntry[];
  readonly statusContract: ImprovementStatusContract;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ImprovementChange =
  | { readonly kind: "TRANSITION"; readonly to: ImprovementState }
  | { readonly kind: "SET_RISK"; readonly risk: ImprovementRisk }
  | { readonly kind: "ADD_CLAIM"; readonly claim: ImprovementClaim }
  | { readonly kind: "ADD_EVIDENCE"; readonly evidence: Omit<EvidenceReference, "addedBy" | "addedAt"> }
  | { readonly kind: "SET_STATUS_FIELD"; readonly transition: ImprovementStatusTransition }
  | { readonly kind: "RECORD_TECHNICAL_REVIEW"; readonly decision: TechnicalReview["decision"] }
  | {
      readonly kind: "ACQUIRE_WORK_CLAIM";
      readonly idempotencyKey: string;
      readonly leaseExpiresAt: string;
      readonly manifest: Omit<DeveloperExecutionManifest, "revision" | "createdAt">;
    }
  | { readonly kind: "RENEW_WORK_CLAIM"; readonly idempotencyKey: string; readonly fencingToken: number; readonly leaseExpiresAt: string }
  | { readonly kind: "EXPIRE_WORK_CLAIM"; readonly idempotencyKey: string; readonly fencingToken: number }
  | {
      readonly kind: "HANDOFF_WORK_CLAIM";
      readonly idempotencyKey: string;
      readonly fencingToken: number;
      readonly toMemberId: string;
      readonly leaseExpiresAt: string;
      readonly manifest: Omit<DeveloperExecutionManifest, "revision" | "createdAt">;
    }
  | { readonly kind: "RELEASE_WORK_CLAIM"; readonly idempotencyKey: string; readonly fencingToken: number }
  | { readonly kind: "COMPLETE_WORK_CLAIM"; readonly idempotencyKey: string; readonly fencingToken: number }
  | {
      readonly kind: "REVISE_WORK_CLAIM_MANIFEST";
      readonly idempotencyKey: string;
      readonly fencingToken: number;
      readonly manifest: Omit<DeveloperExecutionManifest, "revision" | "createdAt">;
    }
  | {
      readonly kind: "SET_ACTION_AUTHORITY";
      readonly status: ActionAuthority["status"];
      readonly allowedActions?: readonly AutonomousAction[];
    };

export type ChangeResult =
  | { readonly kind: "accepted"; readonly improvement: Improvement }
  | { readonly kind: "conflict"; readonly expectedRevision: number; readonly actualRevision: number }
  | { readonly kind: "rejected"; readonly reason: string };

const ALLOWED_TRANSITIONS: Readonly<Record<ImprovementState, readonly ImprovementState[]>> = {
  DRAFT: ["PROPOSED", "CANCELED"],
  PROPOSED: ["IN_REVIEW", "BLOCKED", "CANCELED"],
  IN_REVIEW: ["PROPOSED", "APPROVED", "BLOCKED", "CANCELED"],
  APPROVED: ["IN_PROGRESS", "IN_REVIEW", "CANCELED"],
  IN_PROGRESS: ["PAUSED", "BLOCKED", "IN_REVIEW", "COMPLETED", "CANCELED"],
  PAUSED: ["IN_PROGRESS", "BLOCKED", "CANCELED"],
  BLOCKED: ["PROPOSED", "IN_REVIEW", "IN_PROGRESS", "CANCELED"],
  CANCELED: [],
  COMPLETED: [],
};

const TRANSITION_ROLES: Readonly<Record<ImprovementState, readonly ActorRole[]>> = {
  DRAFT: [],
  PROPOSED: ["AUTHOR", "ADMIN"],
  IN_REVIEW: ["AUTHOR", "REVIEWER", "ADMIN"],
  APPROVED: ["REVIEWER", "ADMIN"],
  IN_PROGRESS: ["OPERATOR", "ADMIN"],
  PAUSED: ["OPERATOR", "ADMIN"],
  BLOCKED: ["REVIEWER", "OPERATOR", "ADMIN"],
  CANCELED: ["AUTHOR", "OPERATOR", "ADMIN"],
  COMPLETED: ["OPERATOR", "ADMIN"],
};

export function createImprovement(input: {
  readonly id: string;
  readonly risk: ImprovementRisk;
  readonly author: DomainActor;
  readonly claims?: readonly ImprovementClaim[];
  readonly now: string;
}): Improvement {
  if (!input.id.trim()) throw new Error("Improvement ID must not be empty");
  if (!input.author.id.trim()) throw new Error("Actor ID must not be empty");
  return {
    id: input.id,
    revision: 1,
    state: "DRAFT",
    risk: input.risk,
    authorId: input.author.id,
    technicalConsensus: { status: "PENDING", reviews: [] },
    actionAuthority: {
      status: "PENDING",
      grantedBy: null,
      grantedByHuman: false,
      improvementRevision: null,
      allowedActions: [],
    },
    claims: [...(input.claims ?? [])],
    workClaim: {
      fencingToken: 0,
      holderMemberId: null,
      leaseExpiresAt: null,
      status: "UNCLAIMED",
      manifests: [],
      history: [],
    },
    evidence: [],
    attribution: [{ actorId: input.author.id, at: input.now, change: "CREATE", revision: 1 }],
    statusContract: emptyImprovementStatus(),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function validateTransition(
  improvement: Improvement,
  expectedRevision: number,
  to: ImprovementState,
  actor: DomainActor,
): Exclude<ChangeResult, { kind: "accepted" }> | null {
  if (expectedRevision !== improvement.revision) {
    return { kind: "conflict", expectedRevision, actualRevision: improvement.revision };
  }
  if (!ALLOWED_TRANSITIONS[improvement.state].includes(to)) {
    return { kind: "rejected", reason: `Transition ${improvement.state} -> ${to} is not allowed` };
  }
  if (!TRANSITION_ROLES[to].includes(actor.role)) {
    return { kind: "rejected", reason: `${actor.role} is not authorized to transition to ${to}` };
  }
  if (to === "APPROVED" && !isTechnicalConsensusSatisfied(improvement)) {
    return { kind: "rejected", reason: "Risk-appropriate technical consensus is required before approval" };
  }
  return null;
}

export function applyImprovementChange(
  improvement: Improvement,
  expectedRevision: number,
  change: ImprovementChange,
  actor: DomainActor,
  now: string,
): ChangeResult {
  if (expectedRevision !== improvement.revision) {
    return { kind: "conflict", expectedRevision, actualRevision: improvement.revision };
  }
  if (!actor.id.trim()) return { kind: "rejected", reason: "Actor ID must not be empty" };

  const workClaim = normalizeWorkClaim(improvement.workClaim);
  const statusContract = improvement.statusContract ?? emptyImprovementStatus();
  if ("idempotencyKey" in change && workClaim.history.some((event) => event.idempotencyKey === change.idempotencyKey)) {
    return { kind: "accepted", improvement };
  }
  if (change.kind === "SET_RISK" && change.risk === improvement.risk) {
    return { kind: "accepted", improvement };
  }
  if (change.kind === "SET_STATUS_FIELD") {
    try {
      const candidate = applyImprovementStatusTransition(statusContract, change.transition);
      if (JSON.stringify(candidate) === JSON.stringify(statusContract)) {
        return { kind: "accepted", improvement };
      }
    } catch (error) {
      return { kind: "rejected", reason: error instanceof Error ? error.message : "Invalid status transition" };
    }
  }

  if (change.kind === "TRANSITION") {
    const invalid = validateTransition(improvement, expectedRevision, change.to, actor);
    if (invalid) return invalid;
  }
  if (change.kind === "SET_ACTION_AUTHORITY" && !["OPERATOR", "ADMIN"].includes(actor.role)) {
    return { kind: "rejected", reason: `${actor.role} cannot set action authority` };
  }
  if (change.kind === "RECORD_TECHNICAL_REVIEW" && !["REVIEWER", "ADMIN"].includes(actor.role)) {
    return { kind: "rejected", reason: `${actor.role} cannot record a technical review` };
  }
  if (["RENEW_WORK_CLAIM", "RELEASE_WORK_CLAIM", "COMPLETE_WORK_CLAIM", "REVISE_WORK_CLAIM_MANIFEST", "HANDOFF_WORK_CLAIM"].includes(change.kind)) {
    const fencingToken = "fencingToken" in change ? change.fencingToken : -1;
    if (workClaim.status !== "ACTIVE" || workClaim.holderMemberId !== actor.id || workClaim.fencingToken !== fencingToken) {
      return { kind: "rejected", reason: "The work claim is not actively held by this member and fencing token" };
    }
    if (Date.parse(workClaim.leaseExpiresAt ?? "") <= Date.parse(now)) {
      return { kind: "rejected", reason: "The work claim lease has expired" };
    }
  }
  if (change.kind === "EXPIRE_WORK_CLAIM") {
    if (workClaim.status !== "ACTIVE" || workClaim.fencingToken !== change.fencingToken) {
      return { kind: "rejected", reason: "The work claim and fencing token are not current" };
    }
    if (Date.parse(workClaim.leaseExpiresAt ?? "") > Date.parse(now)) return { kind: "rejected", reason: "The work claim lease has not expired" };
  }
  if (change.kind === "ACQUIRE_WORK_CLAIM") {
    const leaseActive = workClaim.status === "ACTIVE" && Date.parse(workClaim.leaseExpiresAt ?? "") > Date.parse(now);
    if (leaseActive) return { kind: "rejected", reason: "The improvement already has an active work claim" };
    if (Date.parse(change.leaseExpiresAt) <= Date.parse(now)) return { kind: "rejected", reason: "Claim lease must expire in the future" };
    if (change.manifest.memberId !== actor.id) return { kind: "rejected", reason: "Execution manifest member must match the authenticated actor" };
  }
  if ((change.kind === "RENEW_WORK_CLAIM" || change.kind === "HANDOFF_WORK_CLAIM") && Date.parse(change.leaseExpiresAt) <= Date.parse(now)) {
    return { kind: "rejected", reason: "Claim lease must expire in the future" };
  }

  const nextRevision = improvement.revision + 1;
  let next: Improvement = {
    ...improvement,
    revision: nextRevision,
    updatedAt: now,
    attribution: [
      ...improvement.attribution,
      { actorId: actor.id, at: now, change: describeChange(change), revision: nextRevision },
    ],
  };

  switch (change.kind) {
    case "TRANSITION":
      next = { ...next, state: change.to };
      break;
    case "SET_RISK":
      next = { ...next, risk: change.risk };
      break;
    case "ADD_CLAIM":
      next = { ...next, claims: [...improvement.claims, change.claim] };
      break;
    case "ADD_EVIDENCE":
      next = {
        ...next,
        evidence: [...improvement.evidence, { ...change.evidence, addedBy: actor.id, addedAt: now }],
      };
      break;
    case "SET_STATUS_FIELD":
      try {
        next = { ...next, statusContract: applyImprovementStatusTransition(statusContract, change.transition) };
      } catch (error) {
        return { kind: "rejected", reason: error instanceof Error ? error.message : "Invalid status transition" };
      }
      break;
    case "RECORD_TECHNICAL_REVIEW": {
      const reviews = [
        ...improvement.technicalConsensus.reviews.filter((review) => review.reviewerId !== actor.id),
        { reviewerId: actor.id, decision: change.decision, at: now },
      ];
      next = {
        ...next,
        technicalConsensus: {
          reviews,
          status: reviews.some((review) => review.decision === "REJECT") ? "REJECTED" : "ACCEPTED",
        },
      };
      break;
    }
    case "ACQUIRE_WORK_CLAIM": {
      const replaced = workClaim.status === "ACTIVE" || workClaim.status === "EXPIRED";
      const fencingToken = workClaim.fencingToken + 1;
      const manifest = { ...change.manifest, revision: workClaim.manifests.length + 1, createdAt: now };
      next = {
        ...next,
        workClaim: {
          fencingToken,
          holderMemberId: actor.id,
          leaseExpiresAt: change.leaseExpiresAt,
          status: "ACTIVE",
          manifests: [...workClaim.manifests, manifest],
          history: [
            ...workClaim.history,
            ...(workClaim.status === "ACTIVE" && Date.parse(workClaim.leaseExpiresAt ?? "") <= Date.parse(now)
              ? [{ idempotencyKey: `${change.idempotencyKey}:expiry`, kind: "EXPIRED" as const, memberId: workClaim.holderMemberId!, at: now, fencingToken: workClaim.fencingToken, leaseExpiresAt: workClaim.leaseExpiresAt, manifestRevision: workClaim.manifests.at(-1)?.revision ?? 0 }]
              : []),
            { idempotencyKey: change.idempotencyKey, kind: replaced ? "REPLACED" : "ACQUIRED", memberId: actor.id, at: now, fencingToken, leaseExpiresAt: change.leaseExpiresAt, manifestRevision: manifest.revision, ...(workClaim.holderMemberId ? { replacedMemberId: workClaim.holderMemberId } : {}) },
          ],
        },
      };
      break;
    }
    case "RENEW_WORK_CLAIM":
      next = { ...next, workClaim: appendWorkClaimEvent(workClaim, change.idempotencyKey, "RENEWED", actor.id, now, change.leaseExpiresAt) };
      break;
    case "EXPIRE_WORK_CLAIM":
      next = { ...next, workClaim: { ...appendWorkClaimEvent(workClaim, change.idempotencyKey, "EXPIRED", workClaim.holderMemberId!, now, workClaim.leaseExpiresAt), holderMemberId: null, leaseExpiresAt: null, status: "EXPIRED" } };
      break;
    case "HANDOFF_WORK_CLAIM": {
      if (change.manifest.memberId !== change.toMemberId) return { kind: "rejected", reason: "Execution manifest member must match the handoff target" };
      const fencingToken = workClaim.fencingToken + 1;
      const manifest = { ...change.manifest, revision: workClaim.manifests.length + 1, createdAt: now };
      next = {
        ...next,
        workClaim: {
          fencingToken,
          holderMemberId: change.toMemberId,
          leaseExpiresAt: change.leaseExpiresAt,
          status: "ACTIVE",
          manifests: [...workClaim.manifests, manifest],
          history: [...workClaim.history, { idempotencyKey: change.idempotencyKey, kind: "HANDED_OFF", memberId: change.toMemberId, replacedMemberId: actor.id, at: now, fencingToken, leaseExpiresAt: change.leaseExpiresAt, manifestRevision: manifest.revision }],
        },
      };
      break;
    }
    case "RELEASE_WORK_CLAIM":
      next = { ...next, workClaim: { ...appendWorkClaimEvent(workClaim, change.idempotencyKey, "RELEASED", actor.id, now, null), holderMemberId: null, leaseExpiresAt: null, status: "RELEASED" } };
      break;
    case "COMPLETE_WORK_CLAIM":
      next = { ...next, workClaim: { ...appendWorkClaimEvent(workClaim, change.idempotencyKey, "COMPLETED", actor.id, now, null), holderMemberId: null, leaseExpiresAt: null, status: "COMPLETED" } };
      break;
    case "REVISE_WORK_CLAIM_MANIFEST": {
      if (change.manifest.memberId !== actor.id) return { kind: "rejected", reason: "Execution manifest member must match the authenticated actor" };
      const manifest = { ...change.manifest, revision: workClaim.manifests.length + 1, createdAt: now };
      next = {
        ...next,
        workClaim: {
          ...workClaim,
          manifests: [...workClaim.manifests, manifest],
          history: [...workClaim.history, { idempotencyKey: change.idempotencyKey, kind: "MANIFEST_REVISED", memberId: actor.id, at: now, fencingToken: workClaim.fencingToken, leaseExpiresAt: workClaim.leaseExpiresAt, manifestRevision: manifest.revision }],
        },
      };
      break;
    }
    case "SET_ACTION_AUTHORITY":
      next = {
        ...next,
        actionAuthority: {
          status: change.status,
          grantedBy: actor.id,
          grantedByHuman: actor.human,
          improvementRevision: change.status === "GRANTED" ? nextRevision : null,
          allowedActions: change.status === "GRANTED" ? [...(change.allowedActions ?? [])] : [],
        },
      };
      break;
  }

  return { kind: "accepted", improvement: next };
}

function describeChange(change: ImprovementChange): string {
  switch (change.kind) {
    case "TRANSITION": return `TRANSITION:${change.to}`;
    case "SET_RISK": return `SET_RISK:${change.risk}`;
    case "ADD_CLAIM": return `ADD_CLAIM:${change.claim.id}`;
    case "ADD_EVIDENCE": return `ADD_EVIDENCE:${change.evidence.id}`;
    case "SET_STATUS_FIELD": return `STATUS:${change.transition.field}`;
    case "RECORD_TECHNICAL_REVIEW": return `TECHNICAL_REVIEW:${change.decision}`;
    case "ACQUIRE_WORK_CLAIM": return `WORK_CLAIM:ACQUIRE:${change.idempotencyKey}`;
    case "RENEW_WORK_CLAIM": return `WORK_CLAIM:RENEW:${change.idempotencyKey}`;
    case "EXPIRE_WORK_CLAIM": return `WORK_CLAIM:EXPIRE:${change.idempotencyKey}`;
    case "HANDOFF_WORK_CLAIM": return `WORK_CLAIM:HANDOFF:${change.idempotencyKey}`;
    case "RELEASE_WORK_CLAIM": return `WORK_CLAIM:RELEASE:${change.idempotencyKey}`;
    case "COMPLETE_WORK_CLAIM": return `WORK_CLAIM:COMPLETE:${change.idempotencyKey}`;
    case "REVISE_WORK_CLAIM_MANIFEST": return `WORK_CLAIM:MANIFEST:${change.idempotencyKey}`;
    case "SET_ACTION_AUTHORITY": return `ACTION_AUTHORITY:${change.status}`;
  }
}

function normalizeWorkClaim(value: ImprovementWorkClaim | undefined): ImprovementWorkClaim {
  return value ?? { fencingToken: 0, holderMemberId: null, leaseExpiresAt: null, status: "UNCLAIMED", manifests: [], history: [] };
}

function appendWorkClaimEvent(
  claim: ImprovementWorkClaim,
  idempotencyKey: string,
  kind: WorkClaimEventKind,
  memberId: string,
  at: string,
  leaseExpiresAt: string | null,
): ImprovementWorkClaim {
  return {
    ...claim,
    leaseExpiresAt,
    history: [...claim.history, { idempotencyKey, kind, memberId, at, fencingToken: claim.fencingToken, leaseExpiresAt, manifestRevision: claim.manifests.at(-1)?.revision ?? 0 }],
  };
}

export interface EmergencyStop {
  readonly active: boolean;
  readonly activatedBy: string | null;
  readonly activatedAt: string | null;
  readonly reason: string | null;
}

export interface ActionPolicyDecision {
  readonly authorized: boolean;
  readonly consensusGate: boolean;
  readonly authorityGate: boolean;
  readonly reasons: readonly string[];
}

export const BOUNDED_FIRST_SLICE_EXCLUSIONS: readonly ExcludedAutonomousAction[] = [
  "MERGE",
  "DEPLOY",
  "CHANGE_CREDENTIALS",
  "DESTRUCTIVE_OPERATION",
  "EDIT_LIVE_CHECKOUT",
];

const INDEPENDENT_REVIEWERS_REQUIRED: Readonly<Record<ImprovementRisk, number>> = {
  LOW: 0,
  GUARDED: 1,
  RESTRICTED: 2,
};

export function isTechnicalConsensusSatisfied(improvement: Improvement): boolean {
  const independentApprovals = improvement.technicalConsensus.reviews.filter(
    (review) => review.decision === "APPROVE" && review.reviewerId !== improvement.authorId,
  ).length;
  return improvement.technicalConsensus.status === "ACCEPTED" && independentApprovals >= INDEPENDENT_REVIEWERS_REQUIRED[improvement.risk];
}

export function isActionAuthoritySatisfied(improvement: Improvement, action: ImprovementAction): boolean {
  const authority = improvement.actionAuthority;
  return authority.status === "GRANTED" &&
    authority.improvementRevision === improvement.revision &&
    !BOUNDED_FIRST_SLICE_EXCLUSIONS.includes(action as ExcludedAutonomousAction) &&
    authority.allowedActions.includes(action as AutonomousAction) &&
    (improvement.risk !== "RESTRICTED" || authority.grantedByHuman);
}

export function evaluateActionPolicy(input: {
  readonly improvement: Improvement;
  readonly action: ImprovementAction;
  readonly autonomous: boolean;
  readonly emergencyStop: EmergencyStop;
}): ActionPolicyDecision {
  const { improvement, action } = input;
  const required = INDEPENDENT_REVIEWERS_REQUIRED[improvement.risk];
  const consensusGate = isTechnicalConsensusSatisfied(improvement);
  const authorityGate = isActionAuthoritySatisfied(improvement, action);
  const reasons: string[] = [];

  if (input.autonomous && input.emergencyStop.active) reasons.push("Emergency stop blocks new autonomous actions");
  if (BOUNDED_FIRST_SLICE_EXCLUSIONS.includes(action as ExcludedAutonomousAction)) {
    reasons.push(`${action} is outside the bounded first-slice policy`);
  }
  if (!["APPROVED", "IN_PROGRESS"].includes(improvement.state)) reasons.push(`Lifecycle state ${improvement.state} cannot start actions`);
  if (!consensusGate) reasons.push(`Technical consensus requires ${required} independent approval(s)`);
  if (!authorityGate) reasons.push("Action authority does not grant this action at the current revision");

  return {
    authorized: reasons.length === 0,
    consensusGate,
    authorityGate,
    reasons,
  };
}

export function activateEmergencyStop(actor: DomainActor, reason: string, now: string): EmergencyStop {
  return { active: true, activatedBy: actor.id, activatedAt: now, reason };
}

export const allowedLifecycleTransitions = ALLOWED_TRANSITIONS;
