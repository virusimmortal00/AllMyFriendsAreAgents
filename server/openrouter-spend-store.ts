import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "./types.js";
import { addSpendEntry, spendEntry, zeroSpendTotals, type OpenRouterSpendEntry } from "./openrouter-spend.js";
import type { OpenRouterSpendTotals, OpenRouterSpendWindow } from "../shared/openrouter-usage.js";

export interface OpenRouterSpendEvent extends OpenRouterSpendEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly agentId: string;
  readonly generationId?: string;
}

const DEFAULT_EVENT_LIMIT = 5_000;
const WINDOW_MS: Readonly<Record<Exclude<OpenRouterSpendWindow, "all">, number>> = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

interface PersistedState {
  schemaVersion: 1;
  events: OpenRouterSpendEvent[];
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidEvent(value: unknown): value is OpenRouterSpendEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp))
    && typeof record.agentId === "string" && record.agentId.length > 0
    && isFiniteNonNegative(record.costUsd) && isFiniteNonNegative(record.inputTokens) && isFiniteNonNegative(record.outputTokens)
    && isFiniteNonNegative(record.reasoningTokens) && isFiniteNonNegative(record.cacheReadTokens) && isFiniteNonNegative(record.cacheWriteTokens)
    && (record.generationId === undefined || typeof record.generationId === "string");
}

/**
 * Durable OpenRouter spend accounting: an append-only, disk-persisted, bounded-retention event log
 * (same shape as CapabilityAuditStore) plus running lifetime totals kept exact regardless of retention.
 * Lifetime totals (`snapshot()`) never lose precision to the retention bound; only windowed queries
 * (`since()`) are limited to however far back the retained event log reaches.
 */
export class OpenRouterSpendStore {
  private room = zeroSpendTotals();
  private readonly byAgent = new Map<AgentId, OpenRouterSpendTotals>();
  private events: OpenRouterSpendEvent[] = [];
  private queue = Promise.resolve();

  private constructor(private readonly filePath: string, private readonly eventLimit: number) {}

  static async open(directory: string, eventLimit = DEFAULT_EVENT_LIMIT) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new OpenRouterSpendStore(path.join(directory, "openrouter-spend.json"), Math.max(100, Math.min(eventLimit, 50_000)));
    try {
      const parsed = JSON.parse(await readFile(store.filePath, "utf8")) as Partial<PersistedState>;
      for (const event of Array.isArray(parsed.events) ? parsed.events : []) {
        if (isValidEvent(event)) store.applyEvent(event);
      }
    } catch {
      // A missing or corrupt file starts this store fresh; nothing durable was lost silently, since
      // nothing was ever confirmed written in that case.
    }
    return store;
  }

  /** Records one generation's usage/cost. Synchronous and never throws; persistence is best-effort. */
  record(agentId: AgentId, usage: unknown, costUsd: unknown, meta: { generationId?: string; timestamp?: string } = {}) {
    const entry = spendEntry(usage, costUsd);
    if (!entry) return;
    const event: OpenRouterSpendEvent = {
      id: randomUUID(), timestamp: meta.timestamp || new Date().toISOString(), agentId,
      ...(meta.generationId ? { generationId: meta.generationId } : {}), ...entry,
    };
    this.applyEvent(event);
    this.persist();
  }

  /** Lifetime totals, exact regardless of the bounded event retention below. */
  snapshot(): { room: OpenRouterSpendTotals; agents: Readonly<Record<string, OpenRouterSpendTotals>> } {
    return { room: this.room, agents: Object.fromEntries(this.byAgent) };
  }

  /**
   * Totals since a point in time, computed from retained events only. `truncated` is true only when
   * retention has actually discarded events (lifetime generations exceed retained events) *and* the
   * requested window reaches back far enough to have included some of what was discarded — a window
   * that predates the room's actual history, with nothing ever pruned, is a genuine zero, not a gap.
   */
  since(window: OpenRouterSpendWindow, now: () => number = Date.now) {
    const sinceMs = window === "all" ? undefined : now() - WINDOW_MS[window];
    const prunedSome = this.room.generations > this.events.length;
    const oldestRetained = this.events[0]?.timestamp;
    const truncated = prunedSome && (sinceMs === undefined || !oldestRetained || Date.parse(oldestRetained) > sinceMs);
    let room = zeroSpendTotals();
    const agents = new Map<string, OpenRouterSpendTotals>();
    for (const event of this.events) {
      if (sinceMs !== undefined && Date.parse(event.timestamp) < sinceMs) continue;
      room = addSpendEntry(room, event);
      agents.set(event.agentId, addSpendEntry(agents.get(event.agentId) || zeroSpendTotals(), event));
    }
    return { room, agents: Object.fromEntries(agents), sinceIso: sinceMs === undefined ? null : new Date(sinceMs).toISOString(), truncated };
  }

  /** Waits for any in-flight persistence to settle. For tests and graceful shutdown only. */
  async flush() {
    await this.queue;
  }

  private applyEvent(event: OpenRouterSpendEvent) {
    this.room = addSpendEntry(this.room, event);
    this.byAgent.set(event.agentId as AgentId, addSpendEntry(this.byAgent.get(event.agentId as AgentId) || zeroSpendTotals(), event));
    this.events = [...this.events, event].slice(-this.eventLimit);
  }

  private persist() {
    const serialized = JSON.stringify({ schemaVersion: 1, events: this.events } satisfies PersistedState, null, 2);
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    }).catch(() => undefined);
  }
}
