import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyConsultationChange as applyDomainChange, createConsultation as createDomainConsultation,
  validateConsultationId, type Consultation, type ConsultationAffinity, type ConsultationChange,
  type ConsultationChangeResult, type ConsultationIdentity,
} from "../../shared/consultation-domain.js";
import {
  consultationRequestDigest, paginateConsultations, type ConsultationEvent, type ConsultationListQuery,
  type ConsultationRepository, type CreateConsultationRequest, type CreateConsultationResult,
} from "./consultation-repository.js";
import { normalizeStoredConsultation, validateAffinity } from "./consultation-storage.js";
import { runSqliteMigrations } from "./sqlite-migrations.js";

interface ProjectionRow { projection_json: string }
interface EventRow { room_id: string; consultation_id: string; revision: number; actor_id: string; occurred_at: string; change_json: string; snapshot_json: string }
interface AffinityRow { room_id: string; participant_id: string; duties_json: string; provenance_json: string; created_at: string; updated_at: string }
function parseConsultation(value: string): Consultation { return normalizeStoredConsultation(JSON.parse(value) as Consultation); }
function parse<T>(value: string): T { return JSON.parse(value) as T; }

export class SqliteConsultationRepository implements ConsultationRepository {
  private constructor(readonly databasePath: string, private readonly database: DatabaseSync) {}
  static async open(databasePath: string) {
    await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      await runSqliteMigrations(database);
      await Promise.all([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((candidate) => chmod(candidate, 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
      return new SqliteConsultationRepository(databasePath, database);
    } catch (error) { database.close(); throw error; }
  }
  close() { this.database.close(); }

  async createConsultation(input: CreateConsultationRequest): Promise<CreateConsultationResult> {
    const digest = consultationRequestDigest(input.request);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const replayRow = this.database.prepare("SELECT projection_json FROM consultations WHERE room_id = ? AND idempotency_scope = ? AND idempotency_key = ?").get(input.roomId, input.idempotencyScope, input.idempotencyKey) as ProjectionRow | undefined;
      if (replayRow) {
        const replay = parseConsultation(replayRow.projection_json); this.database.exec("ROLLBACK");
        if (replay.consultationId === input.consultationId && replay.requestDigest === digest) return { kind: "replayed", consultation: structuredClone(replay) };
        return { kind: "idempotency_conflict", roomId: input.roomId, idempotencyKey: input.idempotencyKey };
      }
      if (this.row(input)) { this.database.exec("ROLLBACK"); return { kind: "identity_conflict", identity: { roomId: input.roomId, consultationId: input.consultationId } }; }
      const affinitySnapshot = this.affinities(input.roomId);
      const consultation = createDomainConsultation({ ...input, requestDigest: digest, affinitySnapshot });
      this.database.prepare("INSERT INTO consultations(room_id,consultation_id,revision,lifecycle_state,idempotency_scope,idempotency_key,request_digest,projection_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(consultation.roomId, consultation.consultationId, consultation.revision, consultation.state, consultation.idempotencyScope, consultation.idempotencyKey, consultation.requestDigest, JSON.stringify(consultation), consultation.createdAt, consultation.updatedAt);
      this.insertEvent({ ...input, revision: 1, actorId: input.provenance.actorId, at: input.now, change: "create", snapshot: consultation });
      this.database.exec("COMMIT"); return { kind: "created", consultation: structuredClone(consultation) };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  async getConsultation(identity: ConsultationIdentity) { const row = this.row(identity); return row ? structuredClone(parseConsultation(row.projection_json)) : undefined; }
  async listConsultations(query: ConsultationListQuery) {
    validateConsultationId(query.roomId, "Room ID");
    const rows = this.database.prepare("SELECT projection_json FROM consultations WHERE room_id = ?").all(query.roomId) as unknown as ProjectionRow[];
    return paginateConsultations(rows.map((row) => parseConsultation(row.projection_json)), query);
  }
  async applyConsultationChange(identity: ConsultationIdentity, expectedRevision: number, change: ConsultationChange, actorId: string, now: string): Promise<ConsultationChangeResult> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.row(identity);
      if (!row) { this.database.exec("ROLLBACK"); return { kind: "rejected", reason: `Consultation ${identity.consultationId} does not exist in room ${identity.roomId}` }; }
      const current = parseConsultation(row.projection_json);
      const result = applyDomainChange(current, expectedRevision, change, actorId, now);
      if (result.kind !== "accepted") { this.database.exec("ROLLBACK"); return result; }
      const snapshot = result.consultation;
      const updated = this.database.prepare("UPDATE consultations SET revision=?,lifecycle_state=?,projection_json=?,updated_at=? WHERE room_id=? AND consultation_id=? AND revision=?")
        .run(snapshot.revision, snapshot.state, JSON.stringify(snapshot), snapshot.updatedAt, identity.roomId, identity.consultationId, expectedRevision);
      if (updated.changes !== 1) {
        const actual = this.database.prepare("SELECT revision FROM consultations WHERE room_id=? AND consultation_id=?").get(identity.roomId, identity.consultationId) as { revision: number };
        this.database.exec("ROLLBACK"); return { kind: "conflict", expectedRevision, actualRevision: actual.revision };
      }
      this.insertEvent({ ...identity, revision: snapshot.revision, actorId, at: now, change, snapshot });
      this.database.exec("COMMIT"); return { kind: "accepted", consultation: structuredClone(snapshot) };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  async listConsultationEvents(identity: ConsultationIdentity, options: { readonly afterRevision?: number; readonly limit?: number } = {}) {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    const rows = this.database.prepare("SELECT room_id,consultation_id,revision,actor_id,occurred_at,change_json,snapshot_json FROM consultation_events WHERE room_id=? AND consultation_id=? AND revision>? ORDER BY revision LIMIT ?")
      .all(identity.roomId, identity.consultationId, options.afterRevision ?? 0, limit) as unknown as EventRow[];
    return rows.map((row): ConsultationEvent => ({ roomId: row.room_id, consultationId: row.consultation_id, revision: row.revision, actorId: row.actor_id, at: row.occurred_at, change: parse(row.change_json), snapshot: normalizeStoredConsultation(parse(row.snapshot_json)) }));
  }
  async putConsultationAffinity(affinity: ConsultationAffinity) {
    validateAffinity(affinity);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT created_at FROM consultation_affinities WHERE room_id=? AND participant_id=?").get(affinity.roomId, affinity.participantId) as { created_at: string } | undefined;
      if (existing && existing.created_at !== affinity.createdAt) throw new Error("Affinity creation metadata is immutable");
      this.database.prepare("INSERT INTO consultation_affinities(room_id,participant_id,duties_json,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(room_id,participant_id) DO UPDATE SET duties_json=excluded.duties_json,provenance_json=excluded.provenance_json,updated_at=excluded.updated_at")
        .run(affinity.roomId, affinity.participantId, JSON.stringify(affinity.duties), JSON.stringify(affinity.provenance), affinity.createdAt, affinity.updatedAt);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  async listConsultationAffinities(roomId: string) { validateConsultationId(roomId, "Room ID"); return structuredClone(this.affinities(roomId)); }

  private row(identity: ConsultationIdentity) { return this.database.prepare("SELECT projection_json FROM consultations WHERE room_id=? AND consultation_id=?").get(identity.roomId, identity.consultationId) as ProjectionRow | undefined; }
  private affinities(roomId: string) {
    const rows = this.database.prepare("SELECT room_id,participant_id,duties_json,provenance_json,created_at,updated_at FROM consultation_affinities WHERE room_id=? ORDER BY participant_id").all(roomId) as unknown as AffinityRow[];
    return rows.map((row): ConsultationAffinity => ({ roomId: row.room_id, participantId: row.participant_id, duties: parse(row.duties_json), provenance: parse(row.provenance_json), createdAt: row.created_at, updatedAt: row.updated_at }));
  }
  private insertEvent(event: ConsultationEvent) {
    this.database.prepare("INSERT INTO consultation_events(room_id,consultation_id,revision,actor_id,occurred_at,change_json,snapshot_json) VALUES (?,?,?,?,?,?,?)")
      .run(event.roomId, event.consultationId, event.revision, event.actorId, event.at, JSON.stringify(event.change), JSON.stringify(event.snapshot));
  }
}
