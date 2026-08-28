import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction.js";
import type { AgentCapabilityName } from "../shared/capabilities.js";

export type CapabilityAuditOutcome = "configured" | "attempted" | "allowed" | "denied" | "failed" | "completed";
export interface CapabilityAuditEvent { id: string; timestamp: string; agentId: string; capability: AgentCapabilityName; outcome: CapabilityAuditOutcome; correlationId?: string; reason?: string }

function safe(value: unknown, max = 160) { return redactDiagnosticSecrets(String(value ?? "")).replace(/[\r\n\t]+/g, " ").slice(0, max); }

export class CapabilityAuditStore {
  private events: CapabilityAuditEvent[] = [];
  private queue = Promise.resolve();
  private constructor(readonly filePath: string, readonly limit: number) {}
  static async open(directory: string, limit = 500) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new CapabilityAuditStore(path.join(directory, "capability-audit.json"), Math.max(10, Math.min(limit, 5_000)));
    try { store.events = (JSON.parse(await readFile(store.filePath, "utf8")) as CapabilityAuditEvent[]).slice(-store.limit); } catch { store.events = []; }
    return store;
  }
  async append(input: Omit<CapabilityAuditEvent, "id" | "timestamp">) {
    const event: CapabilityAuditEvent = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), agentId: safe(input.agentId, 80), capability: input.capability, outcome: input.outcome, ...(input.correlationId ? { correlationId: safe(input.correlationId, 100) } : {}), ...(input.reason ? { reason: safe(input.reason) } : {}) };
    this.events = [...this.events, event].slice(-this.limit);
    const serialized = JSON.stringify(this.events);
    this.queue = this.queue.then(async () => { const temporary = `${this.filePath}.tmp`; await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, this.filePath); await chmod(this.filePath, 0o600); });
    await this.queue;
    return event;
  }
  list(limit = 100) { return this.events.slice(-Math.max(1, Math.min(limit, 200))); }
}
