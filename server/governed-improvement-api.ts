import type { ParticipantId } from "../shared/participants.js";
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
  };
  return { kind: "found", item: detail } as const;
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
