import { validateConsultationId, type Consultation, type ConsultationAffinity } from "../../shared/consultation-domain.js";
import type { ConsultationEvent } from "./consultation-repository.js";

export interface JsonConsultationState {
  readonly schemaVersion: 1;
  readonly consultations: Record<string, Consultation>;
  readonly events: readonly ConsultationEvent[];
  readonly affinities: Record<string, ConsultationAffinity>;
}
export function emptyJsonConsultationState(): JsonConsultationState { return { schemaVersion: 1, consultations: {}, events: [], affinities: {} }; }
export function normalizeJsonConsultationState(value: unknown): JsonConsultationState {
  if (!value || typeof value !== "object") return emptyJsonConsultationState();
  const stored = value as Partial<JsonConsultationState>;
  return {
    schemaVersion: 1,
    consultations: structuredClone(stored.consultations && typeof stored.consultations === "object" ? stored.consultations : {}),
    events: structuredClone(Array.isArray(stored.events) ? stored.events : []),
    affinities: structuredClone(stored.affinities && typeof stored.affinities === "object" ? stored.affinities : {}),
  };
}
export function consultationStorageKey(roomId: string, consultationId: string) { return `${roomId.length}:${roomId}${consultationId}`; }
export function affinityStorageKey(roomId: string, participantId: string) { return `${roomId.length}:${roomId}${participantId}`; }
export function validateAffinity(affinity: ConsultationAffinity) {
  validateConsultationId(affinity.roomId, "Room ID"); validateConsultationId(affinity.participantId, "Participant ID");
  if (new Set(affinity.duties).size !== affinity.duties.length) throw new Error("Affinity duties must be unique");
  if (!affinity.provenance.actorId.trim()) throw new Error("Affinity provenance actor ID must not be empty");
  if (affinity.updatedAt < affinity.createdAt) throw new Error("Affinity update cannot precede creation");
}
