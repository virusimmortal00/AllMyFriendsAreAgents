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
  readonly evidence: readonly EvidenceReference[];
  readonly attribution: readonly AttributionEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ImprovementChange =
  | { readonly kind: "TRANSITION"; readonly to: ImprovementState }
  | { readonly kind: "SET_RISK"; readonly risk: ImprovementRisk }
  | { readonly kind: "ADD_CLAIM"; readonly claim: ImprovementClaim }
  | { readonly kind: "ADD_EVIDENCE"; readonly evidence: Omit<EvidenceReference, "addedBy" | "addedAt"> }
  | { readonly kind: "RECORD_TECHNICAL_REVIEW"; readonly decision: TechnicalReview["decision"] }
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
    evidence: [],
    attribution: [{ actorId: input.author.id, at: input.now, change: "CREATE", revision: 1 }],
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
    case "RECORD_TECHNICAL_REVIEW": return `TECHNICAL_REVIEW:${change.decision}`;
    case "SET_ACTION_AUTHORITY": return `ACTION_AUTHORITY:${change.status}`;
  }
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
