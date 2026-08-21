import type {
  ActorRole,
  DeveloperExecutionManifest,
  ImprovementAction,
  ImprovementChange,
  ImprovementState,
  TechnicalReview,
} from "../shared/improvement-domain.js";
import { evaluateActionPolicy, IMPROVEMENT_STATES } from "../shared/improvement-domain.js";
import type { RoomRepository } from "./storage/room-repository.js";
import type { AuthenticatedDeveloper, DeveloperCapability, DeveloperTeamRegistry } from "./developer-team.js";

export type BridgeResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict"; readonly expectedRevision: number; readonly actualRevision: number }
  | { readonly kind: "rejected"; readonly reason: string };

export class DeveloperBridgeService {
  constructor(
    private readonly repository: RoomRepository,
    private readonly registry: DeveloperTeamRegistry,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async readImprovement(authorization: string | undefined, improvementId: string) {
    if (!this.registry.authenticate(authorization, "IMPROVEMENT_READ")) return { kind: "unauthorized" } as const;
    const improvement = await this.repository.getImprovement(improvementId);
    return improvement ? { kind: "ok", value: improvement } as const : { kind: "not_found" } as const;
  }

  async readClaim(authorization: string | undefined, improvementId: string) {
    const result = await this.readImprovement(authorization, improvementId);
    return result.kind === "ok" ? { kind: "ok", value: result.value.workClaim } as const : result;
  }

  async acquireClaim(authorization: string | undefined, input: {
    readonly improvementId: string;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly leaseExpiresAt: string;
    readonly manifest: Omit<DeveloperExecutionManifest, "revision" | "createdAt" | "memberId" | "memberConfigRevision">;
  }) {
    const authenticated = this.registry.authenticate(authorization, "IMPROVEMENT_CLAIM", "OPERATOR");
    if (!authenticated) return { kind: "unauthorized" } as const;
    if (!validMutation(input) || !validManifest(input.manifest) || !validFutureDate(input.leaseExpiresAt, this.now())) return { kind: "rejected", reason: "A valid expected revision, future lease expiry, idempotency key, and manifest are required" } as const;
    return this.apply(input.improvementId, input.expectedRevision, {
      kind: "ACQUIRE_WORK_CLAIM",
      idempotencyKey: input.idempotencyKey,
      leaseExpiresAt: input.leaseExpiresAt,
      manifest: {
        ...input.manifest,
        memberId: authenticated.member.memberId,
        memberConfigRevision: authenticated.member.revision,
      },
    }, authenticated);
  }

  async mutateClaim(authorization: string | undefined, input: {
    readonly improvementId: string;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly fencingToken: number;
    readonly operation: "renew" | "release" | "expire" | "complete" | "manifest" | "handoff";
    readonly leaseExpiresAt?: string;
    readonly toMemberId?: string;
    readonly manifest?: Omit<DeveloperExecutionManifest, "revision" | "createdAt" | "memberId" | "memberConfigRevision">;
  }) {
    const authenticated = this.registry.authenticate(authorization, "IMPROVEMENT_CLAIM", "OPERATOR");
    if (!authenticated) return { kind: "unauthorized" } as const;
    if (!validMutation(input) || !Number.isSafeInteger(input.fencingToken)) return { kind: "rejected", reason: "Valid revision, fencing token, and idempotency key are required" } as const;
    if (!["renew", "release", "expire", "complete", "manifest", "handoff"].includes(input.operation)) return { kind: "rejected", reason: "Unknown claim operation" } as const;
    let change: ImprovementChange;
    if (input.operation === "renew") {
      if (!validFutureDate(input.leaseExpiresAt, this.now())) return { kind: "rejected", reason: "A future lease expiry is required" } as const;
      change = { kind: "RENEW_WORK_CLAIM", idempotencyKey: input.idempotencyKey, fencingToken: input.fencingToken, leaseExpiresAt: input.leaseExpiresAt };
    } else if (input.operation === "release") {
      change = { kind: "RELEASE_WORK_CLAIM", idempotencyKey: input.idempotencyKey, fencingToken: input.fencingToken };
    } else if (input.operation === "expire") {
      change = { kind: "EXPIRE_WORK_CLAIM", idempotencyKey: input.idempotencyKey, fencingToken: input.fencingToken };
    } else if (input.operation === "complete") {
      change = { kind: "COMPLETE_WORK_CLAIM", idempotencyKey: input.idempotencyKey, fencingToken: input.fencingToken };
    } else if (input.operation === "manifest") {
      if (!validManifest(input.manifest)) return { kind: "rejected", reason: "A valid manifest is required" } as const;
      change = { kind: "REVISE_WORK_CLAIM_MANIFEST", idempotencyKey: input.idempotencyKey, fencingToken: input.fencingToken, manifest: { ...input.manifest, memberId: authenticated.member.memberId, memberConfigRevision: authenticated.member.revision } };
    } else {
      const target = input.toMemberId ? this.registry.latest(input.toMemberId) : undefined;
      if (!target || !target.capabilities.includes("IMPROVEMENT_CLAIM") || !validManifest(input.manifest) || !validFutureDate(input.leaseExpiresAt, this.now())) {
        return { kind: "rejected", reason: "Handoff target, lease expiry, and manifest must identify a claim-capable team member" } as const;
      }
      change = { kind: "HANDOFF_WORK_CLAIM", idempotencyKey: input.idempotencyKey, fencingToken: input.fencingToken, toMemberId: target.memberId, leaseExpiresAt: input.leaseExpiresAt, manifest: { ...input.manifest, memberId: target.memberId, memberConfigRevision: target.revision } };
    }
    return this.apply(input.improvementId, input.expectedRevision, change, authenticated);
  }

  async appendEvidence(authorization: string | undefined, input: {
    readonly improvementId: string;
    readonly expectedRevision: number;
    readonly fencingToken: number;
    readonly evidence: { readonly id: string; readonly uri: string; readonly description: string };
  }) {
    const authenticated = this.registry.authenticate(authorization, "IMPROVEMENT_EVIDENCE", "AUTHOR");
    if (!authenticated) return { kind: "unauthorized" } as const;
    if (!Number.isSafeInteger(input.expectedRevision) || !Number.isSafeInteger(input.fencingToken) || !input.evidence || !nonempty(input.evidence.id) || !nonempty(input.evidence.uri) || !nonempty(input.evidence.description)) return { kind: "rejected", reason: "Valid revision, fencing token, and evidence are required" } as const;
    const guard = await this.requireLease(input.improvementId, authenticated, input.fencingToken);
    if (guard) return guard;
    return this.apply(input.improvementId, input.expectedRevision, { kind: "ADD_EVIDENCE", evidence: input.evidence }, authenticated);
  }

  async recordReview(authorization: string | undefined, input: {
    readonly improvementId: string;
    readonly expectedRevision: number;
    readonly decision: TechnicalReview["decision"];
  }) {
    const authenticated = this.registry.authenticate(authorization, "IMPROVEMENT_REVIEW", "REVIEWER");
    if (!authenticated) return { kind: "unauthorized" } as const;
    if (!Number.isSafeInteger(input.expectedRevision) || !["APPROVE", "REJECT"].includes(input.decision)) return { kind: "rejected", reason: "Valid revision and review decision are required" } as const;
    return this.apply(input.improvementId, input.expectedRevision, { kind: "RECORD_TECHNICAL_REVIEW", decision: input.decision }, authenticated);
  }

  async requestTransition(authorization: string | undefined, input: {
    readonly improvementId: string;
    readonly expectedRevision: number;
    readonly fencingToken: number;
    readonly to: ImprovementState;
    readonly action: ImprovementAction;
  }) {
    const authenticated = this.registry.authenticate(authorization, "IMPROVEMENT_TRANSITION", transitionRole(input.to));
    if (!authenticated) return { kind: "unauthorized" } as const;
    if (!Number.isSafeInteger(input.expectedRevision) || !Number.isSafeInteger(input.fencingToken) || !IMPROVEMENT_STATES.includes(input.to) || !IMPROVEMENT_ACTIONS.includes(input.action)) return { kind: "rejected", reason: "Valid revision, fencing token, transition, and action are required" } as const;
    const improvement = await this.repository.getImprovement(input.improvementId);
    if (!improvement) return { kind: "not_found" } as const;
    if (improvement.revision !== input.expectedRevision) return { kind: "conflict", expectedRevision: input.expectedRevision, actualRevision: improvement.revision } as const;
    const guard = this.validateLease(improvement, authenticated, input.fencingToken);
    if (guard) return guard;
    if (input.to === "IN_PROGRESS") {
      const decision = evaluateActionPolicy({
        improvement,
        action: input.action,
        autonomous: true,
        emergencyStop: await this.repository.getEmergencyStop(),
      });
      if (!decision.authorized) return { kind: "rejected", reason: decision.reasons.join("; ") } as const;
    }
    return this.apply(input.improvementId, input.expectedRevision, { kind: "TRANSITION", to: input.to }, authenticated);
  }

  private async requireLease(improvementId: string, authenticated: AuthenticatedDeveloper, fencingToken: number) {
    const improvement = await this.repository.getImprovement(improvementId);
    if (!improvement) return { kind: "not_found" } as const;
    return this.validateLease(improvement, authenticated, fencingToken);
  }

  private validateLease(improvement: NonNullable<Awaited<ReturnType<RoomRepository["getImprovement"]>>>, authenticated: AuthenticatedDeveloper, fencingToken: number) {
    const claim = improvement.workClaim;
    if (!claim || claim.status !== "ACTIVE" || claim.holderMemberId !== authenticated.member.memberId || claim.fencingToken !== fencingToken) {
      return { kind: "rejected", reason: "A current work-claim lease and fencing token are required" } as const;
    }
    if (Date.parse(claim.leaseExpiresAt ?? "") <= Date.parse(this.now())) {
      return { kind: "rejected", reason: "The work-claim lease has expired" } as const;
    }
    return null;
  }

  private async apply(
    improvementId: string,
    expectedRevision: number,
    change: ImprovementChange,
    authenticated: AuthenticatedDeveloper,
  ): Promise<BridgeResult<NonNullable<Awaited<ReturnType<RoomRepository["getImprovement"]>>>>> {
    if ("idempotencyKey" in change) {
      const current = await this.repository.getImprovement(improvementId);
      if (current?.workClaim?.history.some((event) => event.idempotencyKey === change.idempotencyKey)) return { kind: "ok", value: current };
    }
    const result = await this.repository.applyImprovementChange(improvementId, expectedRevision, change, authenticated.actor, this.now());
    if (result.kind === "accepted") return { kind: "ok", value: result.improvement };
    return result;
  }
}

function validMutation(input: { readonly expectedRevision: number; readonly idempotencyKey: string }) {
  return Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0
    && typeof input.idempotencyKey === "string" && /^[a-zA-Z0-9:_-]{8,160}$/.test(input.idempotencyKey);
}

const IMPROVEMENT_ACTIONS: readonly ImprovementAction[] = ["ANALYZE", "EDIT_SANDBOX", "RUN_TESTS", "MERGE", "DEPLOY", "CHANGE_CREDENTIALS", "DESTRUCTIVE_OPERATION", "EDIT_LIVE_CHECKOUT"];

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validFutureDate(value: unknown, now: string): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.parse(now);
}

function validManifest(value: unknown): value is Omit<DeveloperExecutionManifest, "revision" | "createdAt" | "memberId" | "memberConfigRevision"> {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return nonempty(manifest.model) && nonempty(manifest.harness) && nonempty(manifest.promptReference)
    && Array.isArray(manifest.effectiveToolGrants) && manifest.effectiveToolGrants.every(nonempty)
    && Number.isSafeInteger(manifest.policyRevision) && nonempty(manifest.repositoryBaseCommit) && nonempty(manifest.environmentId)
    && (manifest.promptHash === undefined || nonempty(manifest.promptHash));
}

function transitionRole(to: ImprovementState): ActorRole {
  if (to === "PROPOSED") return "AUTHOR";
  if (to === "IN_REVIEW" || to === "APPROVED") return "REVIEWER";
  return "OPERATOR";
}
