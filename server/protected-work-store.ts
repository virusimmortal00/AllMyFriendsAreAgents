import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isAgentId } from "../shared/participants.js";
import { PROTECTED_WORK_PHASES } from "../shared/protected-work.js";

const timestamp = z.string().datetime();
const text = z.string().max(4_000);
const evidence = z.object({ kind: z.enum(["room_message", "project_artifact", "observability"]), ref: z.string().max(1_000), label: z.string().max(500).optional() }).strict();
const recordSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(), workId: z.string().min(1).max(100),
  roomId: z.string().min(1).max(100), owner: z.string().refine(isAgentId), objective: text.min(1),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(PROTECTED_WORK_PHASES), createdAt: timestamp, startedAt: timestamp.nullable(),
  stoppedAt: timestamp.nullable(), updatedAt: timestamp, blocker: z.string().max(2_000).nullable(),
  disposition: z.enum(["delivered", "no-update"]).nullable(), departureCursor: z.string().nullable(),
  actions: z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(["stop", "retry-return", "dismiss"]) }).strict()).optional(),
  returnAttempts: z.number().int().min(0).max(3),
  package: z.object({ summary: z.string().max(16_000), evidenceRefs: z.array(evidence).max(32), unresolvedQuestions: z.array(z.string().max(500)).max(16),
    status: z.enum(["completed", "interrupted", "failed"]), createdAt: timestamp }).strict().nullable(),
  report: z.object({ text: text.nullable(), relevance: z.enum(["relevant", "superseded", "qualified"]), cursor: z.string().nullable() }).strict().nullable(),
}).strict();
export type ProtectedWorkRecord = z.infer<typeof recordSchema>;
export type ProtectedReturnReport = NonNullable<ProtectedWorkRecord["report"]>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eventSchema = z.object({ workId: z.string(), revision: z.number().int().positive(), at: timestamp, phase: z.enum(PROTECTED_WORK_PHASES),
  recordHash: z.string(), previousHash: z.string().nullable(), eventHash: z.string() }).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), records: z.record(z.string(), recordSchema), events: z.array(eventSchema) }).strict();
type State = z.infer<typeof stateSchema>;
function validate(value: unknown): State {
  const state = stateSchema.parse(value);
  const heads = new Map<string, z.infer<typeof eventSchema>>();
  for (const event of state.events) {
    const { eventHash, ...unsigned } = event;
    const previous = heads.get(event.workId);
    if (eventHash !== hash(unsigned) || event.previousHash !== (previous?.eventHash ?? null) || event.revision !== (previous?.revision ?? 0) + 1) throw new Error("Invalid protected-work audit chain.");
    heads.set(event.workId, event);
  }
  const owners = new Set<string>();
  for (const [id, record] of Object.entries(state.records)) {
    const head = heads.get(id);
    if (id !== record.workId || head?.recordHash !== hash(record) || head.revision !== record.revision) throw new Error("Invalid protected-work record.");
    if (record.phase !== "available") {
      const key = `${record.roomId}:${record.owner}`;
      if (owners.has(key)) throw new Error("Duplicate protected participant reservation.");
      owners.add(key);
    }
  }
  return state;
}
export class ProtectedWorkStore {
  private queue = Promise.resolve();
  private constructor(private file: string, private state: State) {}
  static async open(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "protected-work.json");
    const state = await readFile(file, "utf8").then((raw) => validate(JSON.parse(raw))).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return { schemaVersion: 1 as const, records: {}, events: [] };
    });
    return new ProtectedWorkStore(file, state);
  }
  async list() { await this.queue; return structuredClone(Object.values(this.state.records)); }
  async get(id: string) { await this.queue; return structuredClone(this.state.records[id]); }
  async put(record: ProtectedWorkRecord, expectedRevision: number) {
    record = recordSchema.parse(record);
    let accepted = false;
    const write = this.queue.then(async () => {
      if ((this.state.records[record.workId]?.revision ?? 0) !== expectedRevision) return;
      const previous = this.state.events.findLast((event) => event.workId === record.workId);
      const unsigned = { workId: record.workId, revision: record.revision, at: record.updatedAt, phase: record.phase, recordHash: hash(record), previousHash: previous?.eventHash ?? null };
      const next = validate({ schemaVersion: 1, records: { ...this.state.records, [record.workId]: record }, events: [...this.state.events, { ...unsigned, eventHash: hash(unsigned) }] });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
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
