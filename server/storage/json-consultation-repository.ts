import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyConsultationChange as applyDomainChange, createConsultation as createDomainConsultation,
  validateConsultationId, type ConsultationAffinity, type ConsultationChange, type ConsultationChangeResult,
  type ConsultationIdentity,
} from "../../shared/consultation-domain.js";
import {
  consultationRequestDigest, paginateConsultations, type ConsultationEvent, type ConsultationListQuery,
  type ConsultationRepository, type CreateConsultationRequest, type CreateConsultationResult,
} from "./consultation-repository.js";
import { affinityStorageKey, consultationStorageKey, emptyJsonConsultationState, normalizeJsonConsultationState, validateAffinity, type JsonConsultationState } from "./consultation-storage.js";

export class JsonConsultationRepository implements ConsultationRepository {
  private state: JsonConsultationState;
  private queue: Promise<void> = Promise.resolve();
  private constructor(readonly filePath: string, state: JsonConsultationState) { this.state = state; }

  static async open(filePath: string) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const state = await readFile(filePath, "utf8").then((text) => normalizeJsonConsultationState(JSON.parse(text))).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return emptyJsonConsultationState();
      throw error;
    });
    return new JsonConsultationRepository(filePath, state);
  }

  async createConsultation(input: CreateConsultationRequest): Promise<CreateConsultationResult> {
    return this.mutate<CreateConsultationResult>((state) => {
      const digest = consultationRequestDigest(input.request);
      const replay = Object.values(state.consultations).find((consultation) => consultation.roomId === input.roomId && consultation.idempotencyKey === input.idempotencyKey);
      if (replay) {
        if (replay.consultationId === input.consultationId && replay.requestDigest === digest) return { result: { kind: "replayed" as const, consultation: structuredClone(replay) } };
        return { result: { kind: "idempotency_conflict" as const, roomId: input.roomId, idempotencyKey: input.idempotencyKey } };
      }
      const key = consultationStorageKey(input.roomId, input.consultationId);
      if (state.consultations[key]) return { result: { kind: "identity_conflict" as const, identity: { roomId: input.roomId, consultationId: input.consultationId } } };
      const affinities = Object.values(state.affinities).filter((affinity) => affinity.roomId === input.roomId);
      const consultation = createDomainConsultation({ ...input, requestDigest: digest, affinitySnapshot: affinities });
      const event: ConsultationEvent = { roomId: consultation.roomId, consultationId: consultation.consultationId, revision: 1, actorId: input.provenance.actorId, at: input.now, change: "create", snapshot: consultation };
      return { next: { ...state, consultations: { ...state.consultations, [key]: consultation }, events: [...state.events, event] }, result: { kind: "created" as const, consultation: structuredClone(consultation) } };
    });
  }

  async getConsultation(identity: ConsultationIdentity) {
    await this.queue;
    const consultation = this.state.consultations[consultationStorageKey(identity.roomId, identity.consultationId)];
    return consultation ? structuredClone(consultation) : undefined;
  }
  async listConsultations(query: ConsultationListQuery) { await this.queue; return paginateConsultations(Object.values(this.state.consultations), query); }

  async applyConsultationChange(identity: ConsultationIdentity, expectedRevision: number, change: ConsultationChange, actorId: string, now: string): Promise<ConsultationChangeResult> {
    return this.mutate<ConsultationChangeResult>((state) => {
      const key = consultationStorageKey(identity.roomId, identity.consultationId);
      const current = state.consultations[key];
      if (!current) return { result: { kind: "rejected" as const, reason: `Consultation ${identity.consultationId} does not exist in room ${identity.roomId}` } };
      const result = applyDomainChange(current, expectedRevision, change, actorId, now);
      if (result.kind !== "accepted") return { result };
      const snapshot = result.consultation;
      const event: ConsultationEvent = { ...identity, revision: snapshot.revision, actorId, at: now, change: structuredClone(change), snapshot };
      return { next: { ...state, consultations: { ...state.consultations, [key]: snapshot }, events: [...state.events, event] }, result: { kind: "accepted" as const, consultation: structuredClone(snapshot) } };
    });
  }

  async listConsultationEvents(identity: ConsultationIdentity, options: { readonly afterRevision?: number; readonly limit?: number } = {}) {
    await this.queue;
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    return structuredClone(this.state.events.filter((event) => event.roomId === identity.roomId && event.consultationId === identity.consultationId && event.revision > (options.afterRevision ?? 0)).sort((left, right) => left.revision - right.revision).slice(0, limit));
  }

  async putConsultationAffinity(affinity: ConsultationAffinity) {
    validateAffinity(affinity);
    await this.mutate((state) => {
      const key = affinityStorageKey(affinity.roomId, affinity.participantId);
      const existing = state.affinities[key];
      if (existing && existing.createdAt !== affinity.createdAt) throw new Error("Affinity creation metadata is immutable");
      return { next: { ...state, affinities: { ...state.affinities, [key]: structuredClone(affinity) } }, result: undefined };
    });
  }
  async listConsultationAffinities(roomId: string) {
    validateConsultationId(roomId, "Room ID"); await this.queue;
    return structuredClone(Object.values(this.state.affinities).filter((affinity) => affinity.roomId === roomId).sort((left, right) => left.participantId.localeCompare(right.participantId)));
  }

  private async mutate<T>(mutation: (state: JsonConsultationState) => { readonly next?: JsonConsultationState; readonly result: T }): Promise<T> {
    let resolveResult!: (value: T) => void; let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const operation = this.queue.then(async () => {
      try {
        const changed = mutation(this.state);
        if (changed.next) {
          const temporaryPath = `${this.filePath}.tmp`;
          await writeFile(temporaryPath, `${JSON.stringify(changed.next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(temporaryPath, this.filePath); await chmod(this.filePath, 0o600); this.state = changed.next;
        }
        resolveResult(changed.result);
      } catch (error) { rejectResult(error); throw error; }
    });
    this.queue = operation.catch(() => undefined);
    return result;
  }
}
