export const CONSULTATION_STATES = ["queued", "discussing", "input_required", "complete", "failed", "cancelled"] as const;
export type ConsultationState = (typeof CONSULTATION_STATES)[number];
export const CONSULTATION_DUTIES = ["facilitator", "contributor", "challenger", "scribe"] as const;
export type ConsultationDuty = (typeof CONSULTATION_DUTIES)[number];
export const MAX_CONSULTATION_PARTICIPANTS = 32;

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ConsultationIdentity { readonly roomId: string; readonly consultationId: string }
export interface ConsultationRequest {
  readonly topic: string;
  readonly context?: JsonValue;
  readonly requestedParticipantIds?: readonly string[];
}
export interface ConsultationDialogueLimits {
  readonly participantLimit: number;
  readonly turnLimit: number;
  readonly roundLimit: number;
  readonly concurrencyLimit: number;
  readonly timeLimitMs: number;
}
export interface ConsultationTurnRecord {
  readonly turnId: string;
  readonly participantId: string;
  readonly round: number;
  readonly duty: ConsultationDuty;
  readonly prompt: string;
  readonly response: string;
  readonly evidence: readonly ConsultationArtifactEvidence[];
  readonly dissent: boolean;
  readonly completedAt: string;
}
export interface ConsultationInputRecord {
  readonly inputId: string;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly value: string;
  readonly recordedAt: string;
}
export interface ConsultationExecution {
  readonly dialogueEnabled: boolean;
  readonly limits: ConsultationDialogueLimits;
  readonly participantIds: readonly string[];
  readonly turns: readonly ConsultationTurnRecord[];
  readonly inputs: readonly ConsultationInputRecord[];
  readonly blockingQuestion: string | null;
  readonly synthesisKey: string;
  readonly synthesisStarted: boolean;
}
export interface ConsultationProvenance {
  readonly kind: "human" | "agent" | "system" | "import";
  readonly actorId: string;
  readonly sourceId?: string;
  readonly recordedAt: string;
}
export interface ConsultationAffinity {
  readonly roomId: string;
  readonly participantId: string;
  readonly duties: readonly ConsultationDuty[];
  readonly provenance: ConsultationProvenance;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ConsultationDutyAssignment {
  readonly participantId: string;
  readonly duty: ConsultationDuty;
  readonly assignedAt: string;
  readonly assignedBy: string;
  readonly provenance: ConsultationProvenance;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
}
export interface ConsultationArtifactEvidence { readonly id: string; readonly uri: string; readonly summary: string }
export interface ConsultationFinalArtifact {
  readonly schemaVersion: 1;
  readonly synthesis: string;
  readonly recommendations: readonly string[];
  readonly evidence: readonly ConsultationArtifactEvidence[];
  readonly blockers: readonly string[];
  readonly dissent: readonly { readonly participantId: string; readonly position: string }[];
  readonly provenance: readonly ConsultationProvenance[];
  readonly completedAt: string;
  readonly completedBy: string;
}
export interface ConsultationTransition {
  readonly revision: number;
  readonly from: ConsultationState | null;
  readonly to: ConsultationState;
  readonly at: string;
  readonly actorId: string;
  readonly reason: string;
}
export interface Consultation extends ConsultationIdentity {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly state: ConsultationState;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly request: ConsultationRequest;
  readonly affinitySnapshot: readonly ConsultationAffinity[];
  readonly duties: readonly ConsultationDutyAssignment[];
  readonly provenance: readonly ConsultationProvenance[];
  readonly execution: ConsultationExecution | null;
  readonly finalArtifact: ConsultationFinalArtifact | null;
  readonly transitions: readonly ConsultationTransition[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ConsultationChange =
  | { readonly kind: "transition"; readonly to: ConsultationState; readonly reason: string; readonly finalArtifact?: ConsultationFinalArtifact }
  | { readonly kind: "assign_duty"; readonly participantId: string; readonly duty: ConsultationDuty; readonly provenance: ConsultationProvenance }
  | { readonly kind: "release_duty"; readonly participantId: string; readonly duty: ConsultationDuty; readonly reason: string }
  | { readonly kind: "record_execution"; readonly execution: ConsultationExecution };
export type ConsultationChangeResult =
  | { readonly kind: "accepted"; readonly consultation: Consultation }
  | { readonly kind: "conflict"; readonly expectedRevision: number; readonly actualRevision: number }
  | { readonly kind: "rejected"; readonly reason: string };

const TRANSITIONS: Readonly<Record<ConsultationState, readonly ConsultationState[]>> = {
  queued: ["discussing", "failed", "cancelled"],
  discussing: ["input_required", "complete", "failed", "cancelled"],
  input_required: ["discussing", "failed", "cancelled"],
  complete: [], failed: [], cancelled: [],
};

function required(value: string, label: string, maximum = 256) {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (new TextEncoder().encode(value).length > maximum) throw new Error(`${label} must be at most ${maximum} bytes`);
}

export function validateConsultationId(value: string, label: string) { required(value, label); }
export function validateConsultationIdempotencyKey(value: string) { required(value, "Idempotency key", 128); }

export function createConsultation(input: ConsultationIdentity & {
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly request: ConsultationRequest;
  readonly affinitySnapshot?: readonly ConsultationAffinity[];
  readonly provenance: ConsultationProvenance;
  readonly now: string;
}): Consultation {
  validateConsultationId(input.roomId, "Room ID");
  validateConsultationId(input.consultationId, "Consultation ID");
  validateConsultationIdempotencyKey(input.idempotencyKey);
  if (!/^sha256:[a-f0-9]{64}$/.test(input.requestDigest)) throw new Error("Request digest must be a lowercase SHA-256 digest");
  required(input.request.topic, "Consultation topic", 8_000);
  required(input.provenance.actorId, "Provenance actor ID");
  if ((input.request.requestedParticipantIds?.length ?? 0) > MAX_CONSULTATION_PARTICIPANTS) throw new Error(`A consultation may request at most ${MAX_CONSULTATION_PARTICIPANTS} participants`);
  if (input.request.requestedParticipantIds && new Set(input.request.requestedParticipantIds).size !== input.request.requestedParticipantIds.length) throw new Error("Requested participant IDs must be unique");
  for (const participantId of input.request.requestedParticipantIds ?? []) required(participantId, "Participant ID");
  const affinitySnapshot = structuredClone(input.affinitySnapshot ?? []);
  if (affinitySnapshot.some((affinity) => affinity.roomId !== input.roomId)) throw new Error("Affinity snapshots must belong to the consultation room");
  return {
    schemaVersion: 1, roomId: input.roomId, consultationId: input.consultationId,
    revision: 1, state: "queued", idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest, request: structuredClone(input.request), affinitySnapshot,
    duties: [], provenance: [structuredClone(input.provenance)], execution: null, finalArtifact: null,
    transitions: [{ revision: 1, from: null, to: "queued", at: input.now, actorId: input.provenance.actorId, reason: "created" }],
    createdAt: input.now, updatedAt: input.now,
  };
}

export function applyConsultationChange(
  consultation: Consultation,
  expectedRevision: number,
  change: ConsultationChange,
  actorId: string,
  now: string,
): ConsultationChangeResult {
  if (consultation.revision !== expectedRevision) return { kind: "conflict", expectedRevision, actualRevision: consultation.revision };
  try { required(actorId, "Actor ID"); } catch (error) { return { kind: "rejected", reason: (error as Error).message }; }
  const revision = consultation.revision + 1;
  if (change.kind === "transition") {
    if (!CONSULTATION_STATES.includes(change.to)) return { kind: "rejected", reason: `Unknown consultation state ${String(change.to)}` };
    if (!TRANSITIONS[consultation.state].includes(change.to)) return { kind: "rejected", reason: `Cannot transition consultation from ${consultation.state} to ${change.to}` };
    try { required(change.reason, "Transition reason", 1_000); } catch (error) { return { kind: "rejected", reason: (error as Error).message }; }
    if (change.to === "complete" && !change.finalArtifact) return { kind: "rejected", reason: "Completing a consultation requires a final artifact" };
    if (change.to !== "complete" && change.finalArtifact) return { kind: "rejected", reason: "A final artifact is only valid for completion" };
    if (change.finalArtifact && (change.finalArtifact.schemaVersion !== 1 || change.finalArtifact.completedAt !== now || !change.finalArtifact.completedBy.trim())) return { kind: "rejected", reason: "Final artifact completion metadata must match the transition" };
    return { kind: "accepted", consultation: {
      ...consultation, revision, state: change.to, finalArtifact: change.finalArtifact ? structuredClone(change.finalArtifact) : consultation.finalArtifact,
      transitions: [...consultation.transitions, { revision, from: consultation.state, to: change.to, at: now, actorId, reason: change.reason }], updatedAt: now,
    } };
  }
  if (["complete", "failed", "cancelled"].includes(consultation.state)) return { kind: "rejected", reason: `Terminal consultation ${consultation.consultationId} cannot be changed` };
  if (change.kind === "record_execution") {
    const execution = structuredClone(change.execution);
    if (execution.participantIds.length > MAX_CONSULTATION_PARTICIPANTS) return { kind: "rejected", reason: `A consultation may run at most ${MAX_CONSULTATION_PARTICIPANTS} participants` };
    if (new Set(execution.participantIds).size !== execution.participantIds.length) return { kind: "rejected", reason: "Execution participant IDs must be unique" };
    if (execution.turns.some((turn) => !execution.participantIds.includes(turn.participantId))) return { kind: "rejected", reason: "Every turn must belong to a selected participant" };
    if (new Set(execution.turns.map(({ turnId }) => turnId)).size !== execution.turns.length) return { kind: "rejected", reason: "Consultation turn IDs must be unique" };
    return { kind: "accepted", consultation: { ...consultation, revision, execution, updatedAt: now } };
  }
  if (change.kind === "assign_duty") {
    try { required(change.participantId, "Participant ID"); } catch (error) { return { kind: "rejected", reason: (error as Error).message }; }
    if (!CONSULTATION_DUTIES.includes(change.duty)) return { kind: "rejected", reason: `Unknown consultation duty ${String(change.duty)}` };
    if (!change.provenance.actorId.trim()) return { kind: "rejected", reason: "Duty provenance actor ID must not be empty" };
    if (consultation.duties.some((duty) => duty.participantId === change.participantId && duty.duty === change.duty && duty.releasedAt === null)) return { kind: "rejected", reason: `${change.participantId} already has the active ${change.duty} duty` };
    const assignment: ConsultationDutyAssignment = { participantId: change.participantId, duty: change.duty, assignedAt: now, assignedBy: actorId, provenance: structuredClone(change.provenance), releasedAt: null, releaseReason: null };
    return { kind: "accepted", consultation: { ...consultation, revision, duties: [...consultation.duties, assignment], provenance: [...consultation.provenance, structuredClone(change.provenance)], updatedAt: now } };
  }
  if (!CONSULTATION_DUTIES.includes(change.duty)) return { kind: "rejected", reason: `Unknown consultation duty ${String(change.duty)}` };
  try { required(change.reason, "Duty release reason", 1_000); } catch (error) { return { kind: "rejected", reason: (error as Error).message }; }
  const index = consultation.duties.findIndex((duty) => duty.participantId === change.participantId && duty.duty === change.duty && duty.releasedAt === null);
  if (index < 0) return { kind: "rejected", reason: `${change.participantId} does not have the active ${change.duty} duty` };
  const duties = consultation.duties.map((duty, dutyIndex) => dutyIndex === index ? { ...duty, releasedAt: now, releaseReason: change.reason } : duty);
  return { kind: "accepted", consultation: { ...consultation, revision, duties, updatedAt: now } };
}

export function consultationIdentityKey(identity: ConsultationIdentity) { return `${identity.roomId.length}:${identity.roomId}${identity.consultationId}`; }
