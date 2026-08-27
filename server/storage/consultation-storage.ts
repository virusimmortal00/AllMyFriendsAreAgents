import { CONSULTATION_DUTIES, CONSULTATION_STATES, validateConsultationId, type Consultation, type ConsultationAffinity } from "../../shared/consultation-domain.js";
import type { ConsultationEvent } from "./consultation-repository.js";

export interface JsonConsultationState {
  readonly schemaVersion: 1;
  readonly consultations: Record<string, Consultation>;
  readonly events: readonly ConsultationEvent[];
  readonly affinities: Record<string, ConsultationAffinity>;
}
export function emptyJsonConsultationState(): JsonConsultationState { return { schemaVersion: 1, consultations: {}, events: [], affinities: {} }; }
export function normalizeJsonConsultationState(value: unknown): JsonConsultationState {
  if (!value || typeof value !== "object") throw new Error("Stored consultation state must be an object");
  const stored = value as Partial<JsonConsultationState>;
  if (stored.schemaVersion !== 1) throw new Error(`Unsupported consultation storage schema version ${String(stored.schemaVersion)}`);
  if (!stored.consultations || typeof stored.consultations !== "object" || !Array.isArray(stored.events) || !stored.affinities || typeof stored.affinities !== "object") throw new Error("Stored consultation state is incomplete");
  const consultations = Object.fromEntries(Object.entries(stored.consultations).map(([key, consultation]) => [key, normalizeStoredConsultation(consultation)]));
  const affinities = Object.fromEntries(Object.entries(stored.affinities).map(([key, affinity]) => { validateAffinity(affinity); return [key, structuredClone(affinity)]; }));
  const events = stored.events.map((event) => ({ ...structuredClone(event), snapshot: normalizeStoredConsultation(event.snapshot) }));
  return {
    schemaVersion: 1,
    consultations, events, affinities,
  };
}
export function consultationStorageKey(roomId: string, consultationId: string) { return `${roomId.length}:${roomId}${consultationId}`; }
export function affinityStorageKey(roomId: string, participantId: string) { return `${roomId.length}:${roomId}${participantId}`; }
export function validateAffinity(affinity: ConsultationAffinity) {
  if (!affinity || typeof affinity !== "object") throw new Error("Stored affinity must be an object");
  if (typeof affinity.roomId !== "string" || typeof affinity.participantId !== "string") throw new Error("Stored affinity identity is invalid");
  if (!Array.isArray(affinity.duties)) throw new Error("Stored affinity duties must be an array");
  if (!affinity.provenance || typeof affinity.provenance !== "object" || typeof affinity.provenance.actorId !== "string") throw new Error("Stored affinity provenance is invalid");
  if (typeof affinity.createdAt !== "string" || typeof affinity.updatedAt !== "string") throw new Error("Stored affinity timestamps are invalid");
  validateConsultationId(affinity.roomId, "Room ID"); validateConsultationId(affinity.participantId, "Participant ID");
  if (new Set(affinity.duties).size !== affinity.duties.length) throw new Error("Affinity duties must be unique");
  if (affinity.duties.some((duty) => !CONSULTATION_DUTIES.includes(duty))) throw new Error("Affinity contains an unknown duty");
  if (!affinity.provenance.actorId.trim()) throw new Error("Affinity provenance actor ID must not be empty");
  if (affinity.updatedAt < affinity.createdAt) throw new Error("Affinity update cannot precede creation");
}

export function normalizeStoredConsultation(value: Consultation): Consultation {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw new Error(`Unsupported stored consultation schema version ${String((value as { schemaVersion?: unknown } | undefined)?.schemaVersion)}`);
  if (!CONSULTATION_STATES.includes(value.state) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Stored consultation lifecycle is invalid");
  if (typeof value.roomId !== "string" || typeof value.consultationId !== "string") throw new Error("Stored consultation identity is invalid");
  validateConsultationId(value.roomId, "Room ID"); validateConsultationId(value.consultationId, "Consultation ID");
  if (!Array.isArray(value.affinitySnapshot) || !Array.isArray(value.duties) || !Array.isArray(value.provenance)) throw new Error("Stored consultation is missing required collections");
  for (const affinity of value.affinitySnapshot) validateAffinity(affinity);
  if (value.duties.some((assignment) => !assignment || typeof assignment !== "object" || typeof assignment.participantId !== "string" || !assignment.participantId.trim() || !CONSULTATION_DUTIES.includes(assignment.duty))) throw new Error("Stored consultation contains an invalid duty assignment");
  if (value.provenance.some((entry) => !entry || typeof entry !== "object" || typeof entry.actorId !== "string" || !entry.actorId.trim())) throw new Error("Stored consultation contains invalid provenance");
  const execution = value.execution ? {
    ...value.execution,
    providerOperations: value.execution.providerOperations ?? [],
  } : null;
  if (execution && (!Array.isArray(execution.participantIds) || !Array.isArray(execution.turns) || !Array.isArray(execution.inputs) || !Array.isArray(execution.providerOperations))) throw new Error("Stored consultation execution is missing required collections");
  if (execution?.participantIds.some((participantId) => typeof participantId !== "string" || !participantId.trim())) throw new Error("Stored consultation execution contains an empty participant ID");
  if (execution?.turns.some((turn) => !turn || typeof turn !== "object" || !CONSULTATION_DUTIES.includes(turn.duty))) throw new Error("Stored consultation turn contains an unknown duty");
  const idempotencyScope = value.idempotencyScope || value.provenance[0]?.actorId;
  if (!idempotencyScope?.trim()) throw new Error("Stored consultation idempotency scope is invalid");
  if (execution?.providerOperations.some((operation) => !operation || typeof operation !== "object" || typeof operation.operationKey !== "string" || !operation.operationKey.trim() || !["turn", "synthesis"].includes(operation.kind) || !["started", "completed"].includes(operation.status))) throw new Error("Stored consultation provider operation is invalid");
  return structuredClone({
    ...value,
    idempotencyScope,
    execution,
  });
}
