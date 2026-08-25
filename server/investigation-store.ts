import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyInvestigationState, investigationIsNonterminal, normalizeInvestigationState, type InvestigationEvent, type InvestigationInboxEntry, type InvestigationPolicy, type InvestigationRecord, type InvestigationState } from "./investigation-record.js";
import type { AgentId } from "./types.js";

export class InvestigationStore {
  readonly path: string;
  private state: InvestigationState;
  private queue: Promise<void> = Promise.resolve();
  private constructor(filePath: string, state: InvestigationState) { this.path = filePath; this.state = state; }
  static async open(stateDirectory: string) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 }); await chmod(stateDirectory, 0o700);
    const filePath = path.join(stateDirectory, "investigations.json");
    const state = await readFile(filePath, "utf8").then((raw) => normalizeInvestigationState(JSON.parse(raw))).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return emptyInvestigationState(); throw error; });
    return new InvestigationStore(filePath, state);
  }
  async policy() { await this.queue; return this.state.policy ? structuredClone(this.state.policy) : null; }
  async list(owner?: AgentId) { await this.queue; return structuredClone(Object.values(this.state.jobs).filter((job) => !owner || job.owner === owner).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  async get(id: string) { await this.queue; return this.state.jobs[id] ? structuredClone(this.state.jobs[id]) : undefined; }
  async audit(id: string) { await this.queue; return structuredClone(this.state.events.filter((event) => event.investigationId === id)); }
  async inbox(owner: AgentId) { await this.queue; return structuredClone(Object.values(this.state.inbox).filter((entry) => entry.owner === owner).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  async getInbox(id: string) { await this.queue; return this.state.inbox[id] ? structuredClone(this.state.inbox[id]) : undefined; }
  async setPolicy(expectedRevision: number, policy: InvestigationPolicy) { return this.mutate((state) => { const actual = state.policy?.revision ?? 0; if (actual !== expectedRevision) return { result: false }; return { state: { ...state, policy }, result: true }; }); }
  async create(record: InvestigationRecord, event: InvestigationEvent) { return this.mutate((state) => { if (state.jobs[record.investigationId] || Object.values(state.jobs).some((job) => job.owner === record.owner && investigationIsNonterminal(job))) return { result: false }; return { state: { ...state, jobs: { ...state.jobs, [record.investigationId]: record }, events: [...state.events, event] }, result: true }; }); }
  async compareAndSet(expectedRevision: number, record: InvestigationRecord, event: InvestigationEvent) { return this.mutate((state) => { const before = state.jobs[record.investigationId]; if (!before || before.revision !== expectedRevision) return { result: false }; if (investigationIsNonterminal(record) && Object.values(state.jobs).some((job) => job.investigationId !== record.investigationId && job.owner === record.owner && investigationIsNonterminal(job))) return { result: false }; return { state: { ...state, jobs: { ...state.jobs, [record.investigationId]: record }, events: [...state.events, event] }, result: true }; }); }
  async complete(expectedRevision: number, record: InvestigationRecord, entry: InvestigationInboxEntry, event: InvestigationEvent, maxEntries: number) { return this.mutate((state) => { const before = state.jobs[record.investigationId]; if (!before || before.revision !== expectedRevision || state.inbox[entry.inboxEntryId]) return { result: "conflict" as const }; if (record.providerSessionId && Object.values(state.jobs).some((job) => job.investigationId !== record.investigationId && job.providerSessionId === record.providerSessionId)) return { result: "provider_session_conflict" as const }; const inbox = { ...state.inbox, [entry.inboxEntryId]: entry }; const active = Object.values(inbox).filter((item) => item.owner === entry.owner && (item.status === "UNREAD" || item.status === "ACKNOWLEDGED")).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); for (const stale of active.slice(0, Math.max(0, active.length - maxEntries))) inbox[stale.inboxEntryId] = { ...stale, revision: stale.revision + 1, status: "ARCHIVED", updatedAt: entry.createdAt }; return { state: { ...state, jobs: { ...state.jobs, [record.investigationId]: record }, inbox, events: [...state.events, event] }, result: "completed" as const }; }); }
  async updateInbox(expectedRevision: number, entry: InvestigationInboxEntry) { return this.mutate((state) => { const before = state.inbox[entry.inboxEntryId]; if (!before || before.revision !== expectedRevision) return { result: false }; return { state: { ...state, inbox: { ...state.inbox, [entry.inboxEntryId]: entry } }, result: true }; }); }
  private mutate<T>(operation: (state: InvestigationState) => { state?: InvestigationState; result: T }): Promise<T> { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); this.queue = this.queue.then(async () => { try { const next = operation(structuredClone(this.state)); if (next.state) { const validated = normalizeInvestigationState(next.state); const temporary = `${this.path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, this.path); this.state = validated; } resolve(next.result); } catch (error) { reject(error); } }); this.queue.catch(() => undefined); return result; }
}
