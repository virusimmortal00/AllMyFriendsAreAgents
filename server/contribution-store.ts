import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContributionAuditEvent, ContributionRecord, ContributionStoreState } from "./contribution-record.js";

const EMPTY: ContributionStoreState = { schemaVersion: 1, records: [], events: [] };

export class ContributionStore {
  private state: ContributionStoreState = EMPTY;
  private queue: Promise<void> = Promise.resolve();
  private constructor(private readonly filePath: string) {}

  static async open(filePath: string) {
    const store = new ContributionStore(filePath);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as ContributionStoreState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records) || !Array.isArray(parsed.events)) throw new Error("Contribution store has an unsupported schema");
      store.state = structuredClone(parsed); store.verify(); await chmod(filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await store.persist(EMPTY);
    }
    return store;
  }

  list() { return structuredClone(this.state.records); }
  get(id: string) { return structuredClone(this.state.records.find((record) => record.contributionId === id)); }
  events(id?: string) { return structuredClone(id ? this.state.events.filter((event) => event.contributionId === id) : this.state.events); }

  transact(input: { record: ContributionRecord; action: string; actorId: string; outcome?: ContributionAuditEvent["outcome"]; detail: string; externalResultId?: string | null }) {
    let record!: ContributionRecord;
    const operation = this.queue.then(async () => {
      const existing = this.state.records.find((value) => value.contributionId === input.record.contributionId);
      if (existing && input.record.revision !== existing.revision + 1) throw new Error("Contribution persistence revision conflict");
      if (!existing && input.record.revision !== 1) throw new Error("New contribution must start at revision 1");
      record = structuredClone(input.record);
      const records = [...this.state.records.filter((value) => value.contributionId !== record.contributionId), record].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const previous = this.state.events.at(-1); const sourceDigest = digest(record.source); const recordDigest = digest(record);
      const base = { schemaVersion: 1 as const, sequence: (previous?.sequence ?? 0) + 1, eventId: randomUUID(), contributionId: record.contributionId,
        contributionRevision: record.revision, action: input.action, actorId: input.actorId, at: record.updatedAt, outcome: input.outcome ?? "ACCEPTED" as const,
        sourceDigest, recordDigest, externalResultId: input.externalResultId ?? null, detail: input.detail.slice(0, 2_000), previousHash: previous?.eventHash ?? "0".repeat(64) };
      const event: ContributionAuditEvent = { ...base, eventHash: digest(base) };
      await this.persist({ schemaVersion: 1, records, events: [...this.state.events, event] });
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation.then(() => structuredClone(record));
  }

  appendEvent(input: { contribution: ContributionRecord; action: string; actorId: string; outcome: ContributionAuditEvent["outcome"]; detail: string; externalResultId?: string | null }) {
    const operation = this.queue.then(async () => {
      const previous = this.state.events.at(-1); const sourceDigest = digest(input.contribution.source); const recordDigest = digest(input.contribution);
      const base = { schemaVersion: 1 as const, sequence: (previous?.sequence ?? 0) + 1, eventId: randomUUID(), contributionId: input.contribution.contributionId,
        contributionRevision: input.contribution.revision, action: input.action, actorId: input.actorId, at: new Date().toISOString(), outcome: input.outcome,
        sourceDigest, recordDigest, externalResultId: input.externalResultId ?? null, detail: input.detail.slice(0, 2_000), previousHash: previous?.eventHash ?? "0".repeat(64) };
      const event: ContributionAuditEvent = { ...base, eventHash: digest(base) };
      await this.persist({ ...this.state, events: [...this.state.events, event] });
    });
    this.queue = operation.then(() => undefined, () => undefined); return operation;
  }

  private async persist(state: ContributionStoreState) {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 }); const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, this.filePath); await chmod(this.filePath, 0o600); this.state = structuredClone(state);
  }

  private verify() {
    let previousHash = "0".repeat(64); let sequence = 1;
    for (const event of this.state.events) { const { eventHash, ...base } = event; if (event.sequence !== sequence || event.previousHash !== previousHash || digest(base) !== eventHash) throw new Error("Contribution audit chain is invalid"); previousHash = eventHash; sequence += 1; }
    for (const record of this.state.records) { const latest = this.state.events.filter((event) => event.contributionId === record.contributionId).at(-1); if (!latest || latest.contributionRevision !== record.revision || latest.recordDigest !== digest(record)) throw new Error("Contribution record does not match its immutable audit evidence"); }
  }
}

export function contributionDigest(value: unknown) { return digest(value); }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
