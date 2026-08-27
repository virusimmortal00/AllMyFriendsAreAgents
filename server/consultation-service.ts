import { randomUUID } from "node:crypto";
import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction.js";
import {
  MAX_CONSULTATION_PARTICIPANTS,
  type Consultation,
  type ConsultationArtifactEvidence,
  type ConsultationDialogueLimits,
  type ConsultationDuty,
  type ConsultationExecution,
  type ConsultationFinalArtifact,
  type ConsultationIdentity,
  type ConsultationInputRecord,
  type ConsultationProvenance,
  type ConsultationRequest,
  type ConsultationTurnRecord,
  type JsonValue,
} from "../shared/consultation-domain.js";
import type { ConsultationRepository, CreateConsultationResult } from "./storage/consultation-repository.js";

export const DEFAULT_CONSULTATION_LIMITS: ConsultationDialogueLimits = {
  participantLimit: 4,
  turnLimit: 8,
  roundLimit: 2,
  concurrencyLimit: 2,
  timeLimitMs: 60_000,
};
export const MAX_CONSULTATION_LIMITS: ConsultationDialogueLimits = {
  participantLimit: Math.min(8, MAX_CONSULTATION_PARTICIPANTS),
  turnLimit: 24,
  roundLimit: 4,
  concurrencyLimit: 4,
  timeLimitMs: 5 * 60_000,
};

export interface ConsultationDialogueOptions extends Partial<ConsultationDialogueLimits> { readonly enabled?: boolean }
export interface StartConsultationInput {
  readonly roomId: string;
  readonly consultationId?: string;
  readonly idempotencyKey: string;
  readonly request: ConsultationRequest;
  readonly provenance: ConsultationProvenance;
  readonly dialogue?: ConsultationDialogueOptions;
}
export interface ConsultationTurnInput {
  readonly roomId: string;
  readonly consultationId: string;
  readonly turnId: string;
  readonly idempotencyKey: string;
  readonly participantId: string;
  readonly duty: ConsultationDuty;
  readonly round: number;
  readonly prompt: string;
  readonly context: JsonValue | undefined;
  readonly priorTurns: readonly Pick<ConsultationTurnRecord, "participantId" | "duty" | "response" | "dissent">[];
  readonly signal: AbortSignal;
}
export interface ConsultationTurnOutput {
  readonly response: string;
  readonly evidence?: readonly ConsultationArtifactEvidence[];
  readonly dissent?: boolean;
  readonly blockingQuestion?: string;
}
export interface ConsultationDialogueExecutor { performTurn(input: ConsultationTurnInput): Promise<ConsultationTurnOutput> }
export interface ConsultationGenerationGate { reserve(participantId: string): { release(): void } | undefined }

export interface ConsultationSynthesisInput {
  readonly roomId: string;
  readonly consultationId: string;
  readonly idempotencyKey: string;
  readonly topic: string;
  readonly context: JsonValue | undefined;
  readonly turns: readonly ConsultationTurnRecord[];
  readonly inputs: readonly ConsultationInputRecord[];
  readonly provenance: readonly ConsultationProvenance[];
  readonly signal: AbortSignal;
}
export type ConsultationSynthesisOutput =
  | { readonly kind: "settled"; readonly synthesis: string; readonly recommendations?: readonly string[]; readonly evidence?: readonly ConsultationArtifactEvidence[]; readonly blockers?: readonly string[]; readonly dissent?: readonly { readonly participantId: string; readonly position: string }[]; readonly provenance?: readonly ConsultationProvenance[]; readonly completedBy?: string }
  | { readonly kind: "input_required"; readonly question: string };
export interface ConsultationSynthesisService { synthesize(input: ConsultationSynthesisInput): Promise<ConsultationSynthesisOutput> }

export type ConsultationOperationResult =
  | { readonly kind: "ok"; readonly consultation: Consultation }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" | "rejected"; readonly reason: string };

const PRIVATE_CONTEXT_KEYS = /authorization|credential|secret|token|password|passwd|cookie|private[-_]?key|ssh[-_]?key|cwd|project[-_]?path|repository[-_]?(?:path|url)|git[-_]?remote/i;

/** Removes credentials and ambient repository locations before any provider dispatch. */
export function sanitizeConsultationContext(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return publicText(value, 16_000);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeConsultationContext(entry) ?? null);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_CONTEXT_KEYS.test(key)).slice(0, 100).map(([key, entry]) => [key, sanitizeConsultationContext(entry) ?? null]));
}

export function deriveConsultationPrompt(consultation: Consultation, participantId: string, duty: ConsultationDuty, round: number) {
  const affinity = consultation.affinitySnapshot.find((candidate) => candidate.participantId === participantId);
  const dutyDirection: Record<ConsultationDuty, string> = {
    facilitator: "Frame the decision and keep the response focused on what would resolve it.",
    contributor: "Offer the most useful request-specific analysis, evidence, and recommendation you can.",
    challenger: "Test consequential assumptions and state a material objection only when one exists.",
    scribe: "Capture the strongest supported conclusion while preserving meaningful dissent.",
  };
  const affinityNote = affinity?.duties.length ? ` Your durable affinities for this room are ${affinity.duties.join(", ")}.` : "";
  return publicText(`Consultation topic: ${consultation.request.topic}\nSelected participants: ${consultation.execution?.participantIds.join(", ") || participantId}.\nTemporary duty: ${duty}. ${dutyDirection[duty]}${affinityNote}\nThis is bounded round ${round}. Do not edit, publish, deploy, or assume authority over code. Ask one concise blocking question only when human input is genuinely required.`, 8_000);
}

export class ConsultationRunner {
  private readonly active = new Map<string, AbortController>();
  private readonly reschedule = new Set<string>();
  private closed = false;

  constructor(
    private readonly repository: ConsultationRepository,
    private readonly synthesis: ConsultationSynthesisService,
    private readonly dialogue?: ConsultationDialogueExecutor,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly logError: (error: unknown) => void = () => undefined,
    private readonly generationGate?: ConsultationGenerationGate,
  ) {}

  async start(input: StartConsultationInput): Promise<CreateConsultationResult> {
    if (this.closed) throw new Error("Consultation runner is closed");
    const consultationId = input.consultationId ?? randomUUID();
    const request: ConsultationRequest = {
      ...input.request,
      topic: publicText(input.request.topic, 8_000),
      context: sanitizeConsultationContext(input.request.context),
      requestedParticipantIds: input.request.requestedParticipantIds ? [...input.request.requestedParticipantIds] : undefined,
      dialogue: { enabled: input.dialogue?.enabled === true, ...boundLimits(input.dialogue) },
    };
    const result = await this.repository.createConsultation({ ...input, consultationId, idempotencyScope: input.provenance.actorId, request, now: this.now() });
    if (result.kind !== "created" && result.kind !== "replayed") return result;
    let consultation = result.consultation;
    if (!consultation.execution) {
      const limits = request.dialogue!;
      const execution: ConsultationExecution = {
        dialogueEnabled: request.dialogue!.enabled,
        limits,
        participantIds: selectParticipants(consultation, limits.participantLimit),
        turns: [], inputs: [], blockingQuestion: null,
        synthesisKey: `${consultation.roomId}:${consultation.consultationId}:synthesis:v1`,
        synthesisStarted: false, providerOperations: [],
      };
      const initialized = await this.repository.applyConsultationChange(consultation, consultation.revision, { kind: "record_execution", execution }, "consultation-runner", this.now());
      if (initialized.kind === "accepted") consultation = initialized.consultation;
      else if (initialized.kind === "conflict") consultation = await this.repository.getConsultation(consultation) ?? consultation;
    }
    this.schedule(consultation);
    return { ...result, consultation };
  }

  async get(identity: ConsultationIdentity) { return this.repository.getConsultation(identity); }

  async reconcile(roomId?: string) {
    if (this.closed) return [];
    const rooms = roomId ? [roomId] : [];
    if (!rooms.length) throw new Error("A room ID is required to reconcile consultations");
    const recovered: Consultation[] = [];
    for (const room of rooms) {
      let cursor: string | undefined;
      do {
        const page = await this.repository.listConsultations({ roomId: room, states: ["queued", "discussing", "input_required"], cursor, limit: 100 });
        recovered.push(...page.items);
        for (const consultation of page.items) if (consultation.state !== "input_required") this.schedule(consultation);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return recovered;
  }

  async submitInput(identity: ConsultationIdentity, expectedRevision: number, value: string, actorId: string, inputId: string = randomUUID()): Promise<ConsultationOperationResult> {
    const current = await this.repository.getConsultation(identity);
    if (!current) return { kind: "not_found" };
    if (current.roomId !== identity.roomId || current.consultationId !== identity.consultationId) return { kind: "rejected", reason: "Consultation input belongs to a different room." };
    if (current.revision !== expectedRevision) return { kind: "conflict", reason: "Consultation input revision is stale." };
    if (current.state !== "input_required" || !current.execution) return { kind: "rejected", reason: "Consultation is not waiting for input." };
    const sanitized = publicText(value, 4_000).trim();
    if (!sanitized) return { kind: "rejected", reason: "Consultation input must not be empty." };
    const execution: ConsultationExecution = { ...current.execution, blockingQuestion: null, synthesisStarted: false, inputs: [...current.execution.inputs, { inputId, expectedRevision, actorId, value: sanitized, recordedAt: this.now() }] };
    const recorded = await this.repository.applyConsultationChange(identity, expectedRevision, { kind: "record_execution", execution }, actorId, this.now());
    if (recorded.kind !== "accepted") return changeFailure(recorded);
    const resumed = await this.repository.applyConsultationChange(identity, recorded.consultation.revision, { kind: "transition", to: "discussing", reason: "Sanitized human input received; consultation resumed." }, actorId, this.now());
    if (resumed.kind !== "accepted") return changeFailure(resumed);
    this.schedule(resumed.consultation);
    return { kind: "ok", consultation: resumed.consultation };
  }

  async cancel(identity: ConsultationIdentity, expectedRevision: number, actorId: string, reason = "Cancelled by a human."): Promise<ConsultationOperationResult> {
    const current = await this.repository.getConsultation(identity);
    if (!current) return { kind: "not_found" };
    if (current.revision !== expectedRevision) return { kind: "conflict", reason: "Consultation cancellation revision is stale." };
    if (["complete", "failed", "cancelled"].includes(current.state)) {
      return current.state === "cancelled" ? { kind: "ok", consultation: current } : { kind: "conflict", reason: `Consultation already ${current.state}.` };
    }
    const result = await this.repository.applyConsultationChange(identity, expectedRevision, { kind: "transition", to: "cancelled", reason: publicText(reason, 1_000) }, actorId, this.now());
    if (result.kind !== "accepted") return changeFailure(result);
    this.reschedule.delete(key(identity));
    this.active.get(key(identity))?.abort("cancelled");
    return { kind: "ok", consultation: result.consultation };
  }

  close() { this.closed = true; this.reschedule.clear(); for (const controller of this.active.values()) controller.abort("shutdown"); this.active.clear(); }

  private schedule(consultation: Consultation) {
    const identity = key(consultation);
    if (this.closed || ["complete", "failed", "cancelled", "input_required"].includes(consultation.state)) return;
    if (this.active.has(identity)) { this.reschedule.add(identity); return; }
    const controller = new AbortController(); this.active.set(identity, controller);
    setTimeout(() => void this.run(consultation, controller).catch(async (error) => {
      try {
        const fresh = await this.repository.getConsultation(consultation);
        if (fresh && ["queued", "discussing", "input_required"].includes(fresh.state) && !controller.signal.aborted) await this.fail(fresh, error instanceof Error ? error.message : "Consultation execution failed.");
      } catch (nested) { this.logError(nested); }
      this.logError(error);
    }).finally(async () => {
      this.active.delete(identity);
      if (!this.closed && this.reschedule.delete(identity)) {
        const fresh = await this.repository.getConsultation(consultation);
        if (fresh) this.schedule(fresh);
      }
    }), 0);
  }

  private async run(seed: Consultation, controller: AbortController) {
    let current = await this.repository.getConsultation(seed);
    if (!current || controller.signal.aborted || !["queued", "discussing"].includes(current.state)) return;
    if (!current.execution) {
      const requested = current.request.dialogue ?? { enabled: false, ...boundLimits(undefined) };
      const enabled = requested.enabled;
      const limits = requested;
      const participantIds = selectParticipants(current, limits.participantLimit);
      if (enabled && (!this.dialogue || !participantIds.length)) {
        await this.fail(current, this.dialogue ? "Opted-in dialogue has no eligible participants." : "Opted-in dialogue executor is unavailable."); return;
      }
      const execution: ConsultationExecution = { dialogueEnabled: enabled, limits, participantIds, turns: [], inputs: [], blockingQuestion: null, synthesisKey: `${current.roomId}:${current.consultationId}:synthesis:v1`, synthesisStarted: false, providerOperations: [] };
      const initialized = await this.repository.applyConsultationChange(current, current.revision, { kind: "record_execution", execution }, "consultation-runner", this.now());
      if (initialized.kind !== "accepted") return;
      current = initialized.consultation;
    }
    const participantIds = current.execution!.participantIds;
    for (const [index, participantId] of participantIds.entries()) {
      if (!current.duties.some((duty) => duty.participantId === participantId && duty.releasedAt === null)) {
        const duty = dutyFor(current, participantId, index, participantIds.length);
        const assigned = await this.repository.applyConsultationChange(current, current.revision, { kind: "assign_duty", participantId, duty, provenance: { kind: "system", actorId: "consultation-runner", sourceId: `selection:${current.consultationId}`, recordedAt: this.now() } }, "consultation-runner", this.now());
        if (assigned.kind !== "accepted") return;
        current = assigned.consultation;
      }
    }
    if (current.state === "queued") {
      const discussing = await this.repository.applyConsultationChange(current, current.revision, { kind: "transition", to: "discussing", reason: current.execution!.dialogueEnabled ? "Bounded consultation dialogue started." : "Asynchronous synthesis handoff started without agent dialogue." }, "consultation-runner", this.now());
      if (discussing.kind !== "accepted") return;
      current = discussing.consultation;
    }
    if (current.execution!.dialogueEnabled && current.execution!.turns.length < current.execution!.limits.turnLimit) {
      const afterDialogue = await this.runDialogue(current, controller);
      if (!afterDialogue || afterDialogue.state !== "discussing") return;
      current = afterDialogue;
    }
    await this.runSynthesis(current, controller);
  }

  private async runDialogue(seed: Consultation, controller: AbortController) {
    let current = seed;
    const startedAt = Date.now();
    while (!controller.signal.aborted) {
      const execution = current.execution!;
      if (execution.providerOperations.some((operation) => operation.kind === "turn" && operation.status === "started")) {
        await this.fail(current, "A consultation turn may have executed before restart; refusing duplicate provider execution.");
        return undefined;
      }
      const eligible = execution.participantIds.filter((participantId) => {
        const count = execution.turns.filter((turn) => turn.participantId === participantId).length;
        return count < execution.limits.roundLimit && execution.turns.length + count < execution.limits.turnLimit + count;
      });
      if (!eligible.length || execution.turns.length >= execution.limits.turnLimit) break;
      const remainingMs = execution.limits.timeLimitMs - (Date.now() - startedAt);
      if (remainingMs <= 0) { await this.fail(current, "Consultation dialogue time ceiling reached."); return undefined; }
      const available = execution.limits.turnLimit - execution.turns.length;
      const batch = eligible.slice(0, Math.min(execution.limits.concurrencyLimit, available));
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(remainingMs)]);
      const reservations = batch.map((participantId) => this.generationGate?.reserve(participantId));
      if (this.generationGate && reservations.some((reservation) => !reservation)) {
        for (const reservation of reservations) reservation?.release();
        await this.fail(current, "Shared generation capacity is unavailable for consultation dialogue.");
        return undefined;
      }
      const claims: Array<{ participantId: string; duty: ConsultationDuty; round: number; turnId: string; prompt: string; reservation: { release(): void } | undefined }> = [];
      for (const [index, participantId] of batch.entries()) {
        const round = current.execution!.turns.filter((turn) => turn.participantId === participantId).length + 1;
        const turnId = `${current.consultationId}:turn:${participantId}:${round}`;
        const duty = activeDuty(current, participantId);
        const prompt = deriveConsultationPrompt(current, participantId, duty, round);
        const claimed = await this.repository.applyConsultationChange(current, current.revision, { kind: "record_execution", execution: { ...current.execution!, providerOperations: [...current.execution!.providerOperations, { operationKey: turnId, kind: "turn", status: "started", startedAt: this.now(), completedAt: null }] } }, "consultation-runner", this.now());
        if (claimed.kind !== "accepted") { for (const reservation of reservations) reservation?.release(); return undefined; }
        current = claimed.consultation;
        claims.push({ participantId, duty, round, turnId, prompt, reservation: reservations[index] });
      }
      const priorTurns = execution.turns.map(({ participantId: id, duty: priorDuty, response, dissent }) => ({ participantId: id, duty: priorDuty, response, dissent }));
      const outputs = await withTimeCeiling(Promise.all(claims.map(async (claim) => {
        try {
          const output = await this.dialogue!.performTurn({ roomId: current.roomId, consultationId: current.consultationId, turnId: claim.turnId, idempotencyKey: claim.turnId, participantId: claim.participantId, duty: claim.duty, round: claim.round, prompt: claim.prompt, context: sanitizeConsultationContext(current.request.context), priorTurns, signal: deadline });
          return { ...claim, output };
        } finally { claim.reservation?.release(); }
      })), remainingMs);
      for (const completed of outputs) {
        if (controller.signal.aborted) return undefined;
        const fresh = await this.repository.getConsultation(current);
        if (!fresh || fresh.state !== "discussing" || !fresh.execution) return undefined;
        if (fresh.execution.turns.some(({ turnId }) => turnId === completed.turnId)) { current = fresh; continue; }
        const response = publicText(completed.output.response, 12_000).trim();
        if (!response) { await this.fail(fresh, `Participant ${completed.participantId} returned an empty consultation response.`); return undefined; }
        const turn: ConsultationTurnRecord = { turnId: completed.turnId, participantId: completed.participantId, duty: completed.duty, round: completed.round, prompt: completed.prompt, response, evidence: sanitizeEvidence(completed.output.evidence), dissent: completed.output.dissent === true, completedAt: this.now() };
        const question = completed.output.blockingQuestion ? publicText(completed.output.blockingQuestion, 1_000).trim() : null;
        const nextExecution: ConsultationExecution = { ...fresh.execution, turns: [...fresh.execution.turns, turn], blockingQuestion: question || fresh.execution.blockingQuestion, providerOperations: fresh.execution.providerOperations.map((operation) => operation.operationKey === completed.turnId ? { ...operation, status: "completed" as const, completedAt: this.now() } : operation) };
        const persisted = await this.repository.applyConsultationChange(fresh, fresh.revision, { kind: "record_execution", execution: nextExecution }, completed.participantId, this.now());
        if (persisted.kind !== "accepted") return undefined;
        current = persisted.consultation;
        if (question) {
          const blocked = await this.repository.applyConsultationChange(current, current.revision, { kind: "transition", to: "input_required", reason: question }, completed.participantId, this.now());
          return blocked.kind === "accepted" ? blocked.consultation : undefined;
        }
      }
    }
    return current;
  }

  private async runSynthesis(seed: Consultation, controller: AbortController) {
    let current = await this.repository.getConsultation(seed);
    if (!current || current.state !== "discussing" || !current.execution || controller.signal.aborted) return;
    const operationKey = `${current.execution.synthesisKey}:inputs:${current.execution.inputs.length}`;
    const previous = current.execution.providerOperations.find((operation) => operation.operationKey === operationKey);
    if (previous?.status === "started") {
      await this.fail(current, "Consultation synthesis may have executed before restart; refusing duplicate provider execution.");
      return;
    }
    if (previous?.status === "completed") {
      if (current.execution.blockingQuestion) await this.repository.applyConsultationChange(current, current.revision, { kind: "transition", to: "input_required", reason: current.execution.blockingQuestion }, "consultation-synthesizer", this.now());
      else await this.fail(current, "Consultation synthesis completed without a durable terminal result.");
      return;
    }
    const claimed = await this.repository.applyConsultationChange(current, current.revision, { kind: "record_execution", execution: { ...current.execution, synthesisStarted: true, providerOperations: [...current.execution.providerOperations, { operationKey, kind: "synthesis", status: "started", startedAt: this.now(), completedAt: null }] } }, "consultation-synthesizer", this.now());
    if (claimed.kind !== "accepted") return;
    current = claimed.consultation;
    try {
      const execution = current.execution;
      if (!execution) return;
      const output = await this.synthesis.synthesize({ roomId: current.roomId, consultationId: current.consultationId, idempotencyKey: operationKey, topic: publicText(current.request.topic, 8_000), context: sanitizeConsultationContext(current.request.context), turns: execution.turns, inputs: execution.inputs, provenance: current.provenance.map(sanitizeProvenance), signal: controller.signal });
      const fresh = await this.repository.getConsultation(current);
      if (!fresh || fresh.state !== "discussing" || !fresh.execution) return;
      if (output.kind === "input_required") {
        const question = publicText(output.question, 1_000).trim() || "Additional human input is required.";
        const journaled = await this.repository.applyConsultationChange(fresh, fresh.revision, { kind: "record_execution", execution: { ...fresh.execution, blockingQuestion: question, providerOperations: completeOperation(fresh.execution.providerOperations, operationKey, this.now()) } }, "consultation-synthesizer", this.now());
        if (journaled.kind === "accepted") await this.repository.applyConsultationChange(journaled.consultation, journaled.consultation.revision, { kind: "transition", to: "input_required", reason: question }, "consultation-synthesizer", this.now());
        return;
      }
      const completedAt = this.now();
      const artifact = artifactFrom(fresh, output, completedAt);
      await this.repository.applyConsultationChange(fresh, fresh.revision, { kind: "transition", to: "complete", reason: "Durable consultation synthesis completed.", finalArtifact: artifact, execution: { ...fresh.execution, providerOperations: completeOperation(fresh.execution.providerOperations, operationKey, completedAt) } }, artifact.completedBy, completedAt);
    } catch (error) {
      if (controller.signal.aborted) return;
      const fresh = await this.repository.getConsultation(current);
      if (fresh && fresh.state === "discussing") await this.fail(fresh, error instanceof Error ? error.message : "Consultation synthesis failed.");
    }
  }

  private async fail(current: Consultation, reason: string) {
    return this.repository.applyConsultationChange(current, current.revision, { kind: "transition", to: "failed", reason: publicText(reason, 1_000) || "Consultation failed." }, "consultation-runner", this.now());
  }
}

function boundLimits(value: ConsultationDialogueOptions | undefined): ConsultationDialogueLimits {
  const bounded = (candidate: number | undefined, fallback: number, maximum: number) => Math.max(1, Math.min(maximum, Math.trunc(candidate ?? fallback)));
  return {
    participantLimit: bounded(value?.participantLimit, DEFAULT_CONSULTATION_LIMITS.participantLimit, MAX_CONSULTATION_LIMITS.participantLimit),
    turnLimit: bounded(value?.turnLimit, DEFAULT_CONSULTATION_LIMITS.turnLimit, MAX_CONSULTATION_LIMITS.turnLimit),
    roundLimit: bounded(value?.roundLimit, DEFAULT_CONSULTATION_LIMITS.roundLimit, MAX_CONSULTATION_LIMITS.roundLimit),
    concurrencyLimit: bounded(value?.concurrencyLimit, DEFAULT_CONSULTATION_LIMITS.concurrencyLimit, MAX_CONSULTATION_LIMITS.concurrencyLimit),
    timeLimitMs: bounded(value?.timeLimitMs, DEFAULT_CONSULTATION_LIMITS.timeLimitMs, MAX_CONSULTATION_LIMITS.timeLimitMs),
  };
}
function selectParticipants(consultation: Consultation, limit: number) {
  const requested = consultation.request.requestedParticipantIds ?? [];
  const affinity = consultation.affinitySnapshot.map(({ participantId }) => participantId);
  return [...new Set([...requested, ...affinity])].slice(0, limit);
}
function dutyFor(consultation: Consultation, participantId: string, index: number, total: number): ConsultationDuty {
  const preferred = consultation.affinitySnapshot.find((candidate) => candidate.participantId === participantId)?.duties[0];
  if (preferred) return preferred;
  if (index === 0) return "facilitator";
  if (total > 2 && index === total - 2) return "challenger";
  if (total > 1 && index === total - 1) return "scribe";
  return "contributor";
}
function activeDuty(consultation: Consultation, participantId: string): ConsultationDuty { return consultation.duties.find((duty) => duty.participantId === participantId && duty.releasedAt === null)?.duty ?? "contributor"; }
function publicText(value: string, maximum: number) { return redactDiagnosticSecrets(String(value)).replace(/<(?:analysis|thinking|reasoning)>[\s\S]*?(?:<\/(?:analysis|thinking|reasoning)>|$)/gi, "[REDACTED]").slice(0, maximum); }
function sanitizeEvidence(values: readonly ConsultationArtifactEvidence[] | undefined) { return (values ?? []).slice(0, 64).map((value) => ({ id: publicText(value.id, 256), uri: publicText(value.uri, 2_000), summary: publicText(value.summary, 2_000) })).filter(({ id, uri, summary }) => id && uri && summary); }
function artifactFrom(consultation: Consultation, output: Extract<ConsultationSynthesisOutput, { kind: "settled" }>, completedAt: string): ConsultationFinalArtifact {
  const recordedDissent = consultation.execution!.turns.filter(({ dissent }) => dissent).map(({ participantId, response }) => ({ participantId, position: publicText(response, 4_000) }));
  const supplied = (output.dissent ?? []).map(({ participantId, position }) => ({ participantId: publicText(participantId, 256), position: publicText(position, 4_000) }));
  return { schemaVersion: 1, synthesis: publicText(output.synthesis, 16_000), recommendations: (output.recommendations ?? []).slice(0, 64).map((value) => publicText(value, 2_000)).filter(Boolean), evidence: sanitizeEvidence([...(consultation.execution?.turns.flatMap(({ evidence }) => evidence) ?? []), ...(output.evidence ?? [])]), blockers: (output.blockers ?? []).slice(0, 32).map((value) => publicText(value, 1_000)).filter(Boolean), dissent: [...recordedDissent, ...supplied.filter((entry) => !recordedDissent.some((candidate) => candidate.participantId === entry.participantId && candidate.position === entry.position))], provenance: (output.provenance?.length ? output.provenance : consultation.provenance).map(sanitizeProvenance), completedAt, completedBy: publicText(output.completedBy ?? "consultation-synthesizer", 256) || "consultation-synthesizer" };
}
function sanitizeProvenance(value: ConsultationProvenance): ConsultationProvenance { return { ...value, actorId: publicText(value.actorId, 256), sourceId: value.sourceId ? publicText(value.sourceId, 2_000) : undefined }; }
function key(identity: ConsultationIdentity) { return `${identity.roomId.length}:${identity.roomId}${identity.consultationId}`; }
function changeFailure(result: { kind: "conflict"; expectedRevision: number; actualRevision: number } | { kind: "rejected"; reason: string }): ConsultationOperationResult { return result.kind === "conflict" ? { kind: "conflict", reason: `Expected revision ${result.expectedRevision}; actual revision is ${result.actualRevision}.` } : { kind: "rejected", reason: result.reason }; }
function completeOperation(operations: ConsultationExecution["providerOperations"], operationKey: string, completedAt: string) { return operations.map((operation) => operation.operationKey === operationKey ? { ...operation, status: "completed" as const, completedAt } : operation); }
async function withTimeCeiling<T>(operation: Promise<T>, timeMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Consultation dialogue time ceiling reached.")), timeMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
