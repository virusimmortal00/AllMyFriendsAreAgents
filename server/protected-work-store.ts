import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isAgentId } from "../shared/participants.js";
import { PROTECTED_WORK_PHASES } from "../shared/protected-work.js";

const timestamp = z.string().datetime();
const text = z.string().max(4_000);
const evidence = z.object({ kind: z.enum(["room_message", "project_artifact", "observability"]), ref: z.string().max(1_000), label: z.string().max(500).optional() }).strict();
const actionSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(["stop", "retry-return", "dismiss"]) }).strict();
const recordSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(), workId: z.string().min(1).max(100),
  roomId: z.string().min(1).max(100), owner: z.string().refine(isAgentId), objective: text.min(1),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(PROTECTED_WORK_PHASES), createdAt: timestamp, startedAt: timestamp.nullable(),
  stoppedAt: timestamp.nullable(), updatedAt: timestamp, blocker: z.string().max(2_000).nullable(),
  disposition: z.enum(["delivered", "no-update"]).nullable(), departureCursor: z.string().nullable(),
  // Deliberately not schema-capped: v1 installations may already exceed the v2
  // budget. New receipts are bounded by ProtectedWorkStore.actionReceiptAvailable.
  actions: z.array(actionSchema).optional(),
  returnAttempts: z.number().int().min(0).max(3),
  package: z.object({ summary: z.string().max(16_000), evidenceRefs: z.array(evidence).max(32), unresolvedQuestions: z.array(z.string().max(500)).max(16),
    status: z.enum(["completed", "interrupted", "failed"]), createdAt: timestamp }).strict().nullable(),
  report: z.object({ text: text.nullable(), relevance: z.enum(["relevant", "superseded", "qualified"]), cursor: z.string().nullable(), generationId: z.string().min(1).max(100).optional(), costUsd: z.number().finite().nonnegative().optional() }).strict().nullable(),
}).strict();
export type ProtectedWorkRecord = z.infer<typeof recordSchema>;
export type ProtectedReturnReport = NonNullable<ProtectedWorkRecord["report"]>;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eventSchema = z.object({ workId: z.string(), revision: z.number().int().positive(), at: timestamp, phase: z.enum(PROTECTED_WORK_PHASES),
  recordHash: z.string().regex(/^[a-f0-9]{64}$/), previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), eventHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type AuditEvent = z.infer<typeof eventSchema>;
const archiveEntrySchema = z.object({ record: recordSchema, auditAnchor: eventSchema.nullable(), events: z.array(eventSchema).min(1), archivedAt: timestamp,
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), entryHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type ArchiveEntry = z.infer<typeof archiveEntrySchema>;
const archiveCheckpointSchema = z.object({ entryCount: z.number().int().positive(), throughHash: z.string().regex(/^[a-f0-9]{64}$/),
  compactedAt: timestamp, checkpointHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type ArchiveCheckpoint = z.infer<typeof archiveCheckpointSchema>;
const archiveSchema = z.object({ checkpoint: archiveCheckpointSchema.nullable(), entries: z.array(archiveEntrySchema), entryBytes: z.number().int().nonnegative() }).strict();
type Archive = z.infer<typeof archiveSchema>;
const stateSchema = z.object({ schemaVersion: z.literal(2), records: z.record(z.string(), recordSchema), events: z.array(eventSchema),
  anchors: z.record(z.string(), eventSchema), actionReceiptCaps: z.record(z.string(), z.number().int().positive()), archive: archiveSchema }).strict();
type State = z.infer<typeof stateSchema>;
const legacyStateSchema = z.object({ schemaVersion: z.literal(1), records: z.record(z.string(), recordSchema), events: z.array(eventSchema) }).strict();

export interface ProtectedWorkRetention {
  terminalRetentionMs: number;
  maxTerminalRecords: number;
  maxActionReceipts: number;
  actionRecoveryReserve: number;
  maxAuditEventsPerRecord: number;
  maxAdmissionBytes: number;
  maxHotLedgerBytes: number;
  maxArchiveBytes: number;
}
export const DEFAULT_PROTECTED_WORK_RETENTION: Readonly<ProtectedWorkRetention> = Object.freeze({
  terminalRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxTerminalRecords: 256,
  maxActionReceipts: 64,
  actionRecoveryReserve: 2,
  maxAuditEventsPerRecord: 32,
  maxAdmissionBytes: 6 * 1024 * 1024,
  maxHotLedgerBytes: 8 * 1024 * 1024,
  maxArchiveBytes: 16 * 1024 * 1024,
});

export class ProtectedWorkCapacityError extends Error {
  constructor(message = "Protected-work history is at its admission capacity; active recovery remains available.") { super(message); }
}

function verifyEvent(event: AuditEvent) {
  const { eventHash, ...unsigned } = event;
  return eventHash === hash(unsigned);
}

function verifyCheckpoint(value: ArchiveCheckpoint) {
  const { checkpointHash, ...unsigned } = value;
  if (checkpointHash !== hash(unsigned)) throw new Error("Invalid protected-work archive checkpoint.");
}

function verifyArchiveEntry(entry: ArchiveEntry, previousHash: string | null) {
  const { entryHash, ...unsigned } = entry;
  if (entry.record.phase !== "available" || entry.record.disposition === null || entry.previousHash !== previousHash || entryHash !== hash(unsigned)) throw new Error("Invalid protected-work archive chain.");
  let auditHead = entry.auditAnchor;
  if (auditHead && (!verifyEvent(auditHead) || auditHead.workId !== entry.record.workId)) throw new Error("Invalid protected-work archived audit anchor.");
  for (const event of entry.events) {
    if (!verifyEvent(event) || event.workId !== entry.record.workId || event.previousHash !== (auditHead?.eventHash ?? null) || event.revision !== (auditHead?.revision ?? 0) + 1) throw new Error("Invalid protected-work archived audit chain.");
    auditHead = event;
  }
  if (auditHead?.revision !== entry.record.revision || auditHead.recordHash !== hash(entry.record)) throw new Error("Invalid protected-work archived record.");
}

function validateRecords(records: State["records"], events: AuditEvent[], anchors: State["anchors"]) {
  const heads = new Map<string, AuditEvent>();
  for (const [workId, anchor] of Object.entries(anchors)) {
    if (workId !== anchor.workId || !verifyEvent(anchor)) throw new Error("Invalid protected-work audit anchor.");
    heads.set(workId, anchor);
  }
  for (const event of events) {
    const previous = heads.get(event.workId);
    if (!verifyEvent(event) || event.previousHash !== (previous?.eventHash ?? null) || event.revision !== (previous?.revision ?? 0) + 1) throw new Error("Invalid protected-work audit chain.");
    heads.set(event.workId, event);
  }
  const owners = new Set<string>();
  for (const [id, record] of Object.entries(records)) {
    const head = heads.get(id);
    if (id !== record.workId || head?.recordHash !== hash(record) || head.revision !== record.revision) throw new Error("Invalid protected-work record.");
    if (record.phase !== "available") {
      const key = `${record.roomId}:${record.owner}`;
      if (owners.has(key)) throw new Error("Duplicate protected participant reservation.");
      owners.add(key);
    }
  }
  for (const workId of heads.keys()) if (!records[workId]) throw new Error("Protected-work audit history has no live record.");
}

function validateArchive(archive: Archive, records: State["records"]) {
  let previous = archive.checkpoint?.throughHash ?? null;
  if (archive.checkpoint) verifyCheckpoint(archive.checkpoint);
  const workIds = new Set(Object.keys(records));
  let entryBytes = 0;
  for (const entry of archive.entries) {
    verifyArchiveEntry(entry, previous);
    if (workIds.has(entry.record.workId)) throw new Error("Duplicate protected-work archive identity.");
    workIds.add(entry.record.workId);
    previous = entry.entryHash;
    entryBytes += serializedBytes(entry) + (entryBytes ? 1 : 0);
  }
  if (entryBytes !== archive.entryBytes) throw new Error("Invalid protected-work archive byte accounting.");
}

function validate(value: unknown, policy: ProtectedWorkRetention): State {
  const state = stateSchema.parse(value);
  validateRecords(state.records, state.events, state.anchors);
  for (const [workId, cap] of Object.entries(state.actionReceiptCaps)) {
    const record = state.records[workId];
    const count = record?.actions?.length ?? 0;
    if (!record || cap < policy.maxActionReceipts || cap < count || cap - count > policy.actionRecoveryReserve) {
      throw new Error("Invalid protected-work action receipt cap.");
    }
  }
  validateArchive(state.archive, state.records);
  return state;
}

function migrate(value: unknown, policy: ProtectedWorkRetention) {
  const legacy = legacyStateSchema.parse(value);
  validateRecords(legacy.records, legacy.events, {});
  const actionReceiptCaps = Object.fromEntries(Object.values(legacy.records).flatMap((record) => {
    const count = record.actions?.length ?? 0;
    return record.phase !== "available" && count > policy.maxActionReceipts - policy.actionRecoveryReserve
      ? [[record.workId, Math.max(policy.maxActionReceipts, count + policy.actionRecoveryReserve)]]
      : [];
  }));
  return validate({ schemaVersion: 2, records: legacy.records, events: legacy.events, anchors: {}, actionReceiptCaps,
    archive: { checkpoint: null, entries: [], entryBytes: 0 } }, policy);
}

function serializedBytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value)); }
function archiveBytes(archive: Archive) {
  return Buffer.byteLength(`{"checkpoint":${JSON.stringify(archive.checkpoint)},"entries":[],"entryBytes":${archive.entryBytes}}`) + archive.entryBytes;
}
function archiveHead(archive: Archive) { return archive.entries.at(-1)?.entryHash ?? archive.checkpoint?.throughHash ?? null; }
function checkpoint(entryCount: number, throughHash: string, compactedAt: string): ArchiveCheckpoint {
  const unsigned = { entryCount, throughHash, compactedAt };
  return { ...unsigned, checkpointHash: hash(unsigned) };
}

function compactAudit(state: State, maximum: number) {
  const grouped = new Map<string, AuditEvent[]>();
  for (const event of state.events) grouped.set(event.workId, [...(grouped.get(event.workId) || []), event]);
  for (const [workId, events] of grouped) {
    if (events.length <= maximum) continue;
    const boundary = events.at(-(maximum + 1))!;
    state.anchors[workId] = boundary;
    const retained = new Set(events.slice(-maximum).map((event) => event.eventHash));
    state.events = state.events.filter((event) => event.workId !== workId || retained.has(event.eventHash));
  }
}

function archiveTerminalRecords(state: State, policy: ProtectedWorkRetention, now: string) {
  const terminal = Object.values(state.records).filter((record) => record.phase === "available" && record.disposition !== null)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.workId.localeCompare(right.workId));
  const cutoff = Date.parse(now) - policy.terminalRetentionMs;
  const overflow = Math.max(0, terminal.length - policy.maxTerminalRecords);
  const selected = terminal.filter((record, index) => index < overflow || Date.parse(record.updatedAt) <= cutoff);
  for (const record of selected) {
    const events = state.events.filter((event) => event.workId === record.workId);
    if (!events.length) throw new Error("Protected-work terminal record has no audit events.");
    const unsigned = { record, auditAnchor: state.anchors[record.workId] ?? null, events, archivedAt: now, previousHash: archiveHead(state.archive) };
    const entry = archiveEntrySchema.parse({ ...unsigned, entryHash: hash(unsigned) });
    verifyArchiveEntry(entry, unsigned.previousHash);
    state.archive.entryBytes += serializedBytes(entry) + (state.archive.entries.length ? 1 : 0);
    state.archive.entries.push(entry);
    delete state.records[record.workId];
    delete state.anchors[record.workId];
    delete state.actionReceiptCaps[record.workId];
    state.events = state.events.filter((event) => event.workId !== record.workId);
  }
}

function trimArchive(state: State, maximum: number, now: string) {
  let removed = 0;
  const priorCount = state.archive.checkpoint?.entryCount ?? 0;
  while (removed < state.archive.entries.length && archiveBytes(state.archive) > maximum) {
    const entry = state.archive.entries[removed];
    const remaining = state.archive.entries.length - removed;
    state.archive.entryBytes -= serializedBytes(entry) + (remaining > 1 ? 1 : 0);
    removed += 1;
    state.archive.checkpoint = checkpoint(priorCount + removed, entry.entryHash, now);
  }
  if (removed) state.archive.entries = state.archive.entries.slice(removed);
  if (state.archive.checkpoint) verifyCheckpoint(state.archive.checkpoint);
  const first = state.archive.entries[0];
  if (first && first.previousHash !== (state.archive.checkpoint?.throughHash ?? null)) throw new Error("Invalid protected-work archive trim boundary.");
  if (archiveBytes(state.archive) > maximum) throw new Error("Protected-work archive budget is too small for its checkpoint.");
}

function maintain(state: State, policy: ProtectedWorkRetention, now: string) {
  compactAudit(state, policy.maxAuditEventsPerRecord);
  archiveTerminalRecords(state, policy, now);
  trimArchive(state, policy.maxArchiveBytes, now);
}

function hotLedgerBytes(state: State) {
  return serializedBytes({ schemaVersion: state.schemaVersion, records: state.records, events: state.events,
    anchors: state.anchors, actionReceiptCaps: state.actionReceiptCaps });
}

async function persist(file: string, state: State) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function retentionPolicy(overrides: Partial<ProtectedWorkRetention>): ProtectedWorkRetention {
  const policy = { ...DEFAULT_PROTECTED_WORK_RETENTION, ...overrides };
  for (const value of Object.values(policy)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Protected-work retention budgets must be positive integers.");
  if (policy.actionRecoveryReserve >= policy.maxActionReceipts) throw new Error("Protected-work action recovery reserve must be smaller than its receipt budget.");
  if (policy.maxAdmissionBytes >= policy.maxHotLedgerBytes) throw new Error("Protected-work admission capacity must leave a recovery reserve.");
  if (policy.maxArchiveBytes < 512) throw new Error("Protected-work archive budget must retain a verification checkpoint.");
  return policy;
}

export class ProtectedWorkStore {
  private queue = Promise.resolve();
  private constructor(private file: string, private state: State, readonly retention: ProtectedWorkRetention) {}
  static async open(directory: string, overrides: Partial<ProtectedWorkRetention> = {}) {
    const policy = retentionPolicy(overrides);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "protected-work.json");
    let migrated = false;
    const state = await readFile(file, "utf8").then((raw) => {
      const parsed: unknown = JSON.parse(raw);
      if ((parsed as { schemaVersion?: unknown }).schemaVersion === 1) { migrated = true; return migrate(parsed, policy); }
      return validate(parsed, policy);
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return validate({ schemaVersion: 2, records: {}, events: [], anchors: {}, actionReceiptCaps: {},
        archive: { checkpoint: null, entries: [], entryBytes: 0 } }, policy);
    });
    const beforeMaintenance = JSON.stringify(state);
    // The migration write is intentionally lossless. Existing v2 ledgers enforce
    // elapsed-time retention on open even when no later work arrives.
    if (!migrated) maintain(state, policy, new Date().toISOString());
    if (migrated || JSON.stringify(state) !== beforeMaintenance) await persist(file, state);
    return new ProtectedWorkStore(file, state, policy);
  }
  async list() { await this.queue; return structuredClone(Object.values(this.state.records)); }
  async retainedWorkIds() {
    await this.queue;
    return [...Object.keys(this.state.records), ...this.state.archive.entries.map((entry) => entry.record.workId)];
  }
  async get(id: string) {
    await this.queue;
    return structuredClone(this.state.records[id] ?? this.state.archive.entries.findLast((entry) => entry.record.workId === id)?.record);
  }
  actionReceiptAvailable(record: ProtectedWorkRecord, action: "stop" | "retry-return" | "dismiss") {
    const count = record.actions?.length ?? 0;
    if (action === "retry-return") return count < this.retention.maxActionReceipts - this.retention.actionRecoveryReserve;
    const cap = this.state.actionReceiptCaps[record.workId] ?? this.retention.maxActionReceipts;
    if (action === "stop") return count < cap - 1;
    return count < cap;
  }
  async put(record: ProtectedWorkRecord, expectedRevision: number) {
    record = recordSchema.parse(record);
    let accepted = false;
    const write = this.queue.then(async () => {
      const archived = this.state.archive.entries.findLast((entry) => entry.record.workId === record.workId)?.record;
      if (archived || (this.state.records[record.workId]?.revision ?? 0) !== expectedRevision) return;
      const next = structuredClone(this.state);
      const previous = next.events.findLast((event) => event.workId === record.workId) ?? next.anchors[record.workId];
      const unsigned = { workId: record.workId, revision: record.revision, at: record.updatedAt, phase: record.phase, recordHash: hash(record), previousHash: previous?.eventHash ?? null };
      const event = eventSchema.parse({ ...unsigned, eventHash: hash(unsigned) });
      if (!verifyEvent(event) || event.previousHash !== (previous?.eventHash ?? null) || event.revision !== (previous?.revision ?? 0) + 1) throw new Error("Invalid protected-work audit mutation.");
      if (record.phase !== "available" && Object.values(next.records).some((candidate) => candidate.workId !== record.workId && candidate.phase !== "available" && candidate.roomId === record.roomId && candidate.owner === record.owner)) throw new Error("Duplicate protected participant reservation.");
      next.records[record.workId] = record;
      next.events.push(event);
      maintain(next, this.retention, record.updatedAt);
      const bytes = hotLedgerBytes(next);
      const currentBytes = hotLedgerBytes(this.state);
      if (expectedRevision === 0 && bytes > this.retention.maxAdmissionBytes) throw new ProtectedWorkCapacityError();
      if (expectedRevision > 0 && bytes > this.retention.maxHotLedgerBytes && bytes > currentBytes) {
        throw new ProtectedWorkCapacityError("Protected-work recovery reserve is exhausted.");
      }
      await persist(this.file, next);
      this.state = next;
      accepted = true;
    });
    this.queue = write.catch(() => undefined);
    await write;
    return accepted;
  }
}

/** Shared synchronous admission gate: no await between checking and reserving. */
export class ParticipantReservations {
  private readonly owners = new Map<string, string>();
  constructor(private readonly foregroundBusy: (owner: string) => boolean) {}
  claim(owner: string, workId: string) {
    if (this.owners.has(owner) || this.foregroundBusy(owner)) return false;
    this.owners.set(owner, workId);
    return true;
  }
  restore(owner: string, workId: string) { this.owners.set(owner, workId); }
  allows(owner: string, workId?: string) { const reserved = this.owners.get(owner); return !reserved || reserved === workId; }
  release(owner: string, workId: string) { if (this.owners.get(owner) === workId) this.owners.delete(owner); }
}
