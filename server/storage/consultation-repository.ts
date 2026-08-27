import { createHash } from "node:crypto";
import type {
  Consultation, ConsultationAffinity, ConsultationChange, ConsultationChangeResult,
  ConsultationIdentity, ConsultationProvenance, ConsultationRequest, ConsultationState,
} from "../../shared/consultation-domain.js";

export const MAX_CONSULTATION_PAGE_SIZE = 100;

export interface CreateConsultationRequest extends ConsultationIdentity {
  readonly idempotencyKey: string;
  readonly request: ConsultationRequest;
  readonly provenance: ConsultationProvenance;
  readonly now: string;
}
export type CreateConsultationResult =
  | { readonly kind: "created" | "replayed"; readonly consultation: Consultation }
  | { readonly kind: "idempotency_conflict"; readonly roomId: string; readonly idempotencyKey: string }
  | { readonly kind: "identity_conflict"; readonly identity: ConsultationIdentity };
export interface ConsultationEvent extends ConsultationIdentity {
  readonly revision: number;
  readonly actorId: string;
  readonly at: string;
  readonly change: "create" | ConsultationChange;
  readonly snapshot: Consultation;
}
export interface ConsultationListQuery {
  readonly roomId: string;
  readonly states?: readonly ConsultationState[];
  readonly participantId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}
export interface ConsultationPage { readonly items: readonly Consultation[]; readonly nextCursor: string | null }

export interface ConsultationRepository {
  createConsultation(input: CreateConsultationRequest): Promise<CreateConsultationResult>;
  getConsultation(identity: ConsultationIdentity): Promise<Consultation | undefined>;
  listConsultations(query: ConsultationListQuery): Promise<ConsultationPage>;
  applyConsultationChange(identity: ConsultationIdentity, expectedRevision: number, change: ConsultationChange, actorId: string, now: string): Promise<ConsultationChangeResult>;
  listConsultationEvents(identity: ConsultationIdentity, options?: { readonly afterRevision?: number; readonly limit?: number }): Promise<readonly ConsultationEvent[]>;
  putConsultationAffinity(affinity: ConsultationAffinity): Promise<void>;
  listConsultationAffinities(roomId: string): Promise<readonly ConsultationAffinity[]>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).filter(([, entry]) => entry !== undefined).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export function consultationRequestDigest(request: ConsultationRequest) {
  return `sha256:${createHash("sha256").update(canonicalJson(request)).digest("hex")}`;
}

export function paginateConsultations(consultations: readonly Consultation[], query: ConsultationListQuery): ConsultationPage {
  const limit = Math.max(1, Math.min(MAX_CONSULTATION_PAGE_SIZE, Math.trunc(query.limit ?? 50)));
  const parsed = Number.parseInt(query.cursor ?? "0", 10);
  const offset = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  const filtered = consultations
    .filter((consultation) => consultation.roomId === query.roomId)
    .filter((consultation) => !query.states?.length || query.states.includes(consultation.state))
    .filter((consultation) => !query.participantId || consultation.duties.some(({ participantId }) => participantId === query.participantId) || consultation.affinitySnapshot.some(({ participantId }) => participantId === query.participantId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.consultationId.localeCompare(right.consultationId));
  const items = filtered.slice(offset, offset + limit);
  return { items: structuredClone(items), nextCursor: offset + items.length < filtered.length ? String(offset + items.length) : null };
}
