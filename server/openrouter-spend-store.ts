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
  schemaVersion: 2;
  /** Exact lifetime totals, kept independent of the bounded event list below so pruning never loses them. */
  totals: { room: OpenRouterSpendTotals; agents: Record<string, OpenRouterSpendTotals> };
  events: OpenRouterSpendEvent[];
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidTotals(value: unknown): value is OpenRouterSpendTotals {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.generations) && (record.generations as number) >= 0
    && isFiniteNonNegative(record.costUsd) && isFiniteNonNegative(record.inputTokens) && isFiniteNonNegative(record.outputTokens)
    && isFiniteNonNegative(record.reasoningTokens) && isFiniteNonNegative(record.cacheReadTokens) && isFiniteNonNegative(record.cacheWriteTokens);
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

function isValidPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2 || !record.totals || typeof record.totals !== "object" || !Array.isArray(record.events)) return false;
  const totals = record.totals as Record<string, unknown>;
  return isValidTotals(totals.room) && Boolean(totals.agents) && typeof totals.agents === "object"
    && Object.values(totals.agents as Record<string, unknown>).every(isValidTotals);
}

/**
 * Durable OpenRouter spend accounting: an append-only, disk-persisted, bounded-retention event log
 * (same shape as CapabilityAuditStore) plus running lifetime totals kept exact regardless of retention.
 * The lifetime totals are persisted directly (not derived by replaying the bounded event list), so
 * pruning old events never loses them on restart. Only windowed queries (`since()`) are limited to
 * however far back the retained event log reaches.
 */
export class OpenRouterSpendStore {
  private room = zeroSpendTotals();
  private readonly byAgent = new Map<AgentId, OpenRouterSpendTotals>();
  private events: OpenRouterSpendEvent[] = [];
  private queue = Promise.resolve();

  private constructor(private readonly filePath: string, private readonly eventLimit: number) {}

  /**
   * `onError` is called (never thrown) for a read failure that is not a simple missing file —
   * a corrupt or unreadable store starts empty in memory either way, but this makes that
   * degradation visible instead of silently indistinguishable from "nothing was ever recorded".
   */
  static async open(directory: string, eventLimit = DEFAULT_EVENT_LIMIT, onError?: (error: unknown) => unknown) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new OpenRouterSpendStore(path.join(directory, "openrouter-spend.json"), Math.max(100, Math.min(eventLimit, 50_000)));
    try {
      const parsed = JSON.parse(await readFile(store.filePath, "utf8")) as unknown;
      if (!isValidPersistedState(parsed)) throw new Error("OpenRouter spend store file is present but not a recognized schema.");
      store.room = parsed.totals.room;
      for (const [agentId, totals] of Object.entries(parsed.totals.agents)) store.byAgent.set(agentId as AgentId, totals);
      store.events = parsed.events.filter(isValidEvent).slice(-store.eventLimit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") onError?.(error);
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

  /** Waits for the most recently queued persistence attempt, rejecting if that attempt failed. For tests and graceful shutdown. */
  async flush() {
    await this.queue;
  }

  private applyEvent(event: OpenRouterSpendEvent) {
    this.room = addSpendEntry(this.room, event);
    this.byAgent.set(event.agentId as AgentId, addSpendEntry(this.byAgent.get(event.agentId as AgentId) || zeroSpendTotals(), event));
    this.events = [...this.events, event].slice(-this.eventLimit);
  }

  private persist() {
    const state: PersistedState = { schemaVersion: 2, totals: { room: this.room, agents: Object.fromEntries(this.byAgent) }, events: this.events };
    const serialized = JSON.stringify(state, null, 2);
    // Chained off the prior attempt (swallowing its failure here so one bad write doesn't
    // permanently wedge the queue) but the resulting promise is left to reject on its own
    // failure — flush() awaits this exact promise, so a write failure is still observable there.
    const attempt = this.queue.catch(() => undefined).then(async () => {
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    });
    this.queue = attempt;
    attempt.catch(() => {}); // Prevent an unhandled-rejection warning when nothing ever calls flush().
  }
}
