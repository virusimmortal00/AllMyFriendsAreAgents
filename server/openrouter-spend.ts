import type { AgentId } from "./types.js";
import type { OpenRouterSpendTotals } from "../shared/openrouter-usage.js";

/** One normalized (agent-less) accounting entry: what a single `record()` call contributes. */
export type OpenRouterSpendEntry = Omit<OpenRouterSpendTotals, "generations">;

export function zeroSpendTotals(): OpenRouterSpendTotals {
  return { generations: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Accepts either shape the OpenCode CLI emits: flat camelCase totals, or the SDK's `{ input, output, reasoning, cache: { read, write } }`. */
function normalizedUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const cache = record.cache && typeof record.cache === "object" ? record.cache as Record<string, unknown> : undefined;
  return {
    inputTokens: finiteNonNegative(record.inputTokens ?? record.input),
    outputTokens: finiteNonNegative(record.outputTokens ?? record.output),
    reasoningTokens: finiteNonNegative(record.reasoningTokens ?? record.reasoning),
    cacheReadTokens: finiteNonNegative(record.cacheReadTokens ?? cache?.read),
    cacheWriteTokens: finiteNonNegative(record.cacheWriteTokens ?? cache?.write),
  };
}

/** Normalizes one `record()` call's raw usage/cost into a storable entry, or undefined when there is nothing to record. */
export function spendEntry(usage: unknown, costUsd: unknown): OpenRouterSpendEntry | undefined {
  const cost = typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : undefined;
  const tokens = normalizedUsage(usage);
  if (cost === undefined && tokens === undefined) return undefined;
  return {
    costUsd: cost || 0,
    inputTokens: tokens?.inputTokens || 0,
    outputTokens: tokens?.outputTokens || 0,
    reasoningTokens: tokens?.reasoningTokens || 0,
    cacheReadTokens: tokens?.cacheReadTokens || 0,
    cacheWriteTokens: tokens?.cacheWriteTokens || 0,
  };
}

export function addSpendEntry(totals: OpenRouterSpendTotals, entry: OpenRouterSpendEntry): OpenRouterSpendTotals {
  return {
    generations: totals.generations + 1,
    costUsd: totals.costUsd + entry.costUsd,
    inputTokens: totals.inputTokens + entry.inputTokens,
    outputTokens: totals.outputTokens + entry.outputTokens,
    reasoningTokens: totals.reasoningTokens + entry.reasoningTokens,
    cacheReadTokens: totals.cacheReadTokens + entry.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens + entry.cacheWriteTokens,
  };
}

/**
 * Accumulates OpenRouter's own per-generation cost/usage accounting (already parsed out of the
 * OpenCode CLI event stream in agent-runner.ts) into running per-agent and room totals. In-memory
 * only, with no persistence of its own — see OpenRouterSpendStore for the durable, windowed version
 * wired into the running server.
 */
export class OpenRouterSpendTracker {
  private room = zeroSpendTotals();
  private readonly byAgent = new Map<AgentId, OpenRouterSpendTotals>();

  record(agent: AgentId, usage: unknown, costUsd: unknown) {
    const entry = spendEntry(usage, costUsd);
    if (!entry) return;
    this.room = addSpendEntry(this.room, entry);
    this.byAgent.set(agent, addSpendEntry(this.byAgent.get(agent) || zeroSpendTotals(), entry));
  }

  snapshot(): { room: OpenRouterSpendTotals; agents: Readonly<Record<string, OpenRouterSpendTotals>> } {
    return { room: this.room, agents: Object.fromEntries(this.byAgent) };
  }
}
