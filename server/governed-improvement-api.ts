import { createHash } from "node:crypto";
import type { ParticipantId } from "../shared/participants.js";
import {
  createImprovement,
  type ImprovementGovernanceDecision,
  type ImprovementParticipantIdentity,
  type ImprovementState,
} from "../shared/improvement-domain.js";
import { emptyImprovementStatus } from "../shared/improvement-status.js";
import { improvementReferences } from "../shared/workshop.js";
import {
  improvementRevisionLabel,
  type GovernedImprovementDetail,
  type GovernedImprovementSummary,
} from "../shared/governed-improvements.js";
import type { RoomRepository } from "./storage/room-repository.js";

export type GovernedImprovementScope = "active" | "all";

const TERMINAL_STATES = new Set(["CANCELED", "COMPLETED"]);
const MAX_PROJECTED_PARTICIPANTS = 16;
const MAX_PROJECTED_ITEMS_PER_PARTICIPANT = 32;

export async function listGovernedImprovements(repository: RoomRepository, scope: GovernedImprovementScope) {
  const items = [] as GovernedImprovementSummary[];
  let cursor: string | undefined;
  do {
    const page = await repository.listImprovements({ cursor, limit: 100 });
    for (const improvement of page.items) {
      if (scope === "active" && TERMINAL_STATES.has(improvement.state)) continue;
      items.push({
        canonicalId: improvement.id,
        revisionLabel: improvementRevisionLabel(improvement.revision),
        state: improvement.state,
        risk: improvement.risk,
        updatedAt: improvement.updatedAt,
      });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { scope, items } as const;
}

export async function readGovernedImprovement(repository: RoomRepository, canonicalId: string) {
  const improvement = await repository.getImprovement(canonicalId);
  if (!improvement) return { kind: "missing_item", canonicalId } as const;
  const ledger = await repository.getImprovementLedgerRecords(canonicalId);
  if (!ledger) return { kind: "missing_item", canonicalId } as const;
  const detail: GovernedImprovementDetail = {
    canonicalId: improvement.id,
    revisionLabel: improvementRevisionLabel(improvement.revision),
    state: improvement.state,
    risk: improvement.risk,
    updatedAt: improvement.updatedAt,
    status: structuredClone(improvement.statusContract),
    evidence: ledger.evidence.map((entry) => ({ ...entry, revisionLabel: improvementRevisionLabel(entry.introducedRevision) })),
    revisions: ledger.revisions.map((entry) => ({ ...entry, revisionLabel: improvementRevisionLabel(entry.revision) })),
    milestones: ledger.milestones.map(({ improvementId: _improvementId, ...entry }) => ({
      ...entry,
      revisionLabel: improvementRevisionLabel(entry.introducedRevision),
    })),
    audit: structuredClone(ledger.audit),
  };
  return { kind: "found", item: detail } as const;
}

export const IMPROVEMENT_PROPOSE_CAPABILITY = "IMPROVEMENT_PROPOSE" as const;

export interface ImprovementProposeCommand {
  readonly proposer: ImprovementParticipantIdentity;
  readonly idempotencyKey: string;
  readonly rationale: string;
  readonly requestedOutcome: string;
  readonly risk?: "LOW" | "GUARDED" | "RESTRICTED";
}

export interface ImprovementAdvanceCommand {
  readonly canonicalId: string;
  readonly expectedRevision: number;
  readonly to: ImprovementState;
  readonly decision: Omit<ImprovementGovernanceDecision, "priorState" | "to">;
  /** Execution is deliberately not part of lifecycle advancement. */
  readonly requestedAction?: string;
}

export type GovernanceAuthorizer = (
  decision: ImprovementAdvanceCommand["decision"],
  canonicalId: string,
) => boolean | Promise<boolean>;

export async function improvementPropose(
  repository: RoomRepository,
  command: ImprovementProposeCommand,
  now = new Date().toISOString(),
) {
  const invalid = validateProposeCommand(command, now);
  if (invalid) return { kind: "rejected", reason: invalid } as const;

  const canonicalId = governedCanonicalId(command.idempotencyKey.trim());
  const rationale = normalizeText(command.rationale);
  const requestedOutcome = normalizeText(command.requestedOutcome);
  const base = createImprovement({
    id: canonicalId,
    risk: command.risk ?? "LOW",
    author: { id: command.proposer.id.trim(), role: "AUTHOR", human: false },
    claims: [{ id: `${canonicalId}-requested-outcome`, statement: requestedOutcome }],
    now,
  });
  const proposal = {
    ...base,
    state: "PROPOSED" as const,
    proposal: {
      idempotencyKey: command.idempotencyKey.trim(),
      proposer: {
        id: command.proposer.id.trim(),
        kind: command.proposer.kind.trim(),
        capabilities: [...command.proposer.capabilities],
      },
      proposedAt: now,
      rationale,
      requestedOutcome,
    },
    statusContract: {
      ...emptyImprovementStatus(),
      nextAction: { state: "ACTION_REQUIRED" as const, action: "Await an explicit authorized governance decision." },
    },
    attribution: [{ actorId: command.proposer.id.trim(), at: now, change: "IMPROVEMENT_PROPOSE", revision: 1 }],
  };
  const result = await repository.createImprovement(proposal);
  if (result.kind === "created") return { kind: "accepted", created: true, proposal: result.improvement } as const;

  const existing = await repository.getImprovement(canonicalId);
  if (existing?.proposal?.idempotencyKey === command.idempotencyKey.trim()) {
    return { kind: "accepted", created: false, proposal: existing } as const;
  }
  return { kind: "rejected", reason: "Canonical proposal identity collision" } as const;
}

export async function advanceImprovementProposal(
  repository: RoomRepository,
  command: ImprovementAdvanceCommand,
  authorize: GovernanceAuthorizer,
  now = new Date().toISOString(),
) {
  if (command.requestedAction) {
    return { kind: "rejected", reason: "Lifecycle advancement cannot request or perform execution" } as const;
  }
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) {
    return { kind: "rejected", reason: "A positive expected revision is required" } as const;
  }
  const current = await repository.getImprovement(command.canonicalId);
  if (!current?.proposal) return { kind: "rejected", reason: "Governed proposal not found" } as const;
  if (current.revision !== command.expectedRevision) {
    return { kind: "conflict", expectedRevision: command.expectedRevision, actualRevision: current.revision } as const;
  }
  if (!validIdentity(command.decision.decidedBy) || !command.decision.decisionId.trim()
    || !command.decision.authorityId.trim() || command.decision.evidence.length === 0
    || command.decision.evidence.some((entry) => !entry.trim())) {
    return { kind: "rejected", reason: "Decision identity, authority, and evidence are required" } as const;
  }
  if (!await authorize(command.decision, command.canonicalId)) {
    return { kind: "rejected", reason: "Governance authority was not independently authorized" } as const;
  }

  return repository.applyImprovementChange(
    command.canonicalId,
    command.expectedRevision,
    {
      kind: "GOVERNANCE_ADVANCE",
      decision: { ...command.decision, priorState: current.state, to: command.to },
    },
    { id: command.decision.decidedBy.id, role: "ADMIN", human: false },
    now,
  );
}

function validateProposeCommand(command: ImprovementProposeCommand, now: string) {
  if (!validIdentity(command.proposer)) return "A capability-bearing participant identity is required";
  if (!command.proposer.capabilities.includes(IMPROVEMENT_PROPOSE_CAPABILITY)) return "Participant lacks IMPROVEMENT_PROPOSE capability";
  if (!command.idempotencyKey.trim() || command.idempotencyKey.length > 240) return "A bounded idempotency key is required";
  if (!normalizeText(command.rationale) || !normalizeText(command.requestedOutcome)) return "Rationale and requested outcome are required";
  if (!Number.isFinite(Date.parse(now))) return "Proposal time must be an ISO-compatible timestamp";
  return null;
}

function validIdentity(identity: ImprovementParticipantIdentity) {
  return Boolean(identity && identity.id?.trim() && identity.kind?.trim()
    && Array.isArray(identity.capabilities) && identity.capabilities.every((capability) => typeof capability === "string" && capability.trim()));
}

function normalizeText(value: string) {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function governedCanonicalId(idempotencyKey: string) {
  return `improvement-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 20)}`;
}

export async function resolveImprovementReferences(repository: RoomRepository, text: string) {
  const canonicalIds = [...new Set(improvementReferences(text).map(({ id }) => id))];
  const references = await Promise.all(canonicalIds.map((canonicalId) => readGovernedImprovement(repository, canonicalId)));
  return { references } as const;
}

export interface ParticipantImprovementManifestInput {
  readonly interaction: {
    readonly text: string;
    readonly addressedParticipants: readonly ParticipantId[];
  };
  readonly explicitRetrievals?: readonly {
    readonly participantId: ParticipantId;
    readonly canonicalId: string;
  }[];
}

/**
 * Projects only canonical identities needed for this addressed interaction.
 * It deliberately contains no evidence bodies, revisions, audit data, or work manifests.
 */
export async function projectParticipantImprovementManifest(
  repository: RoomRepository,
  input: ParticipantImprovementManifestInput,
) {
  const participants = [...new Set(input.interaction.addressedParticipants)].slice(0, MAX_PROJECTED_PARTICIPANTS);
  const addressed = new Set<ParticipantId>(participants);
  const referencedIds = [...new Set(improvementReferences(input.interaction.text).map(({ id }) => id))];
  const idsByParticipant = new Map(participants.map((participantId) => [participantId, [...referencedIds]]));
  for (const retrieval of input.explicitRetrievals ?? []) {
    if (!addressed.has(retrieval.participantId)) continue;
    idsByParticipant.get(retrieval.participantId)?.push(retrieval.canonicalId);
  }

  const cache = new Map<string, Awaited<ReturnType<typeof readGovernedImprovement>>>();
  const read = async (id: string) => {
    const cached = cache.get(id);
    if (cached) return cached;
    const result = await readGovernedImprovement(repository, id);
    cache.set(id, result);
    return result;
  };
  return {
    participants: await Promise.all(participants.map(async (participantId) => {
      const ids = [...new Set(idsByParticipant.get(participantId))].slice(0, MAX_PROJECTED_ITEMS_PER_PARTICIPANT);
      const resolved = await Promise.all(ids.map(read));
      return {
        participantId,
        improvements: resolved.flatMap((result) => result.kind === "found"
          ? [{ canonicalId: result.item.canonicalId, revisionLabel: result.item.revisionLabel }]
          : []),
      };
    })),
  } as const;
}
