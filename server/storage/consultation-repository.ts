import { createHash } from "node:crypto";
import type {
  Consultation, ConsultationAffinity, ConsultationChange, ConsultationChangeResult,
  ConsultationIdentity, ConsultationProvenance, ConsultationRequest, ConsultationState,
} from "../../shared/consultation-domain.js";

export const MAX_CONSULTATION_PAGE_SIZE = 100;

export interface CreateConsultationRequest extends ConsultationIdentity {
  readonly idempotencyKey: string;
  readonly idempotencyScope: string;
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
  const cursor = decodeCursor(query.cursor);
  const filtered = consultations
    .filter((consultation) => consultation.roomId === query.roomId)
    .filter((consultation) => !query.states?.length || query.states.includes(consultation.state))
    .filter((consultation) => !query.participantId || consultation.duties.some(({ participantId }) => participantId === query.participantId) || consultation.affinitySnapshot.some(({ participantId }) => participantId === query.participantId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.consultationId.localeCompare(right.consultationId))
    .filter((consultation) => !cursor || consultation.createdAt < cursor.createdAt || (consultation.createdAt === cursor.createdAt && consultation.consultationId > cursor.consultationId));
  const items = filtered.slice(0, limit);
  const last = items.at(-1);
  return { items: structuredClone(items), nextCursor: last && filtered.length > items.length ? encodeCursor(last) : null };
}

function encodeCursor(consultation: Consultation) {
  return Buffer.from(JSON.stringify({ version: 1, createdAt: consultation.createdAt, consultationId: consultation.consultationId })).toString("base64url");
}
function decodeCursor(value: string | undefined): { createdAt: string; consultationId: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.createdAt !== "string" || typeof parsed.consultationId !== "string") throw new Error();
    return { createdAt: parsed.createdAt, consultationId: parsed.consultationId };
  } catch { throw new Error("Consultation cursor is invalid; restart reconciliation without a cursor."); }
}
