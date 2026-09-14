import type { AgentId } from "./types.js";
import type { OpenRouterSpendTotals } from "../shared/openrouter-usage.js";

function zero(): OpenRouterSpendTotals {
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

function add(totals: OpenRouterSpendTotals, usage: ReturnType<typeof normalizedUsage>, costUsd: number): OpenRouterSpendTotals {
  return {
    generations: totals.generations + 1,
    costUsd: totals.costUsd + costUsd,
    inputTokens: totals.inputTokens + (usage?.inputTokens || 0),
    outputTokens: totals.outputTokens + (usage?.outputTokens || 0),
    reasoningTokens: totals.reasoningTokens + (usage?.reasoningTokens || 0),
    cacheReadTokens: totals.cacheReadTokens + (usage?.cacheReadTokens || 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage?.cacheWriteTokens || 0),
  };
}

/**
 * Accumulates OpenRouter's own per-generation cost/usage accounting (already parsed out of the
 * OpenCode CLI event stream in agent-runner.ts) into running per-agent and room totals. In-memory
 * only: totals reset with the server process and reflect this room's lifetime since its last restart.
 */
export class OpenRouterSpendTracker {
  private room = zero();
  private readonly byAgent = new Map<AgentId, OpenRouterSpendTotals>();

  record(agent: AgentId, usage: unknown, costUsd: unknown) {
    const cost = typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : undefined;
    const tokens = normalizedUsage(usage);
    if (cost === undefined && tokens === undefined) return;
    this.room = add(this.room, tokens, cost || 0);
    this.byAgent.set(agent, add(this.byAgent.get(agent) || zero(), tokens, cost || 0));
  }

  snapshot(): { room: OpenRouterSpendTotals; agents: Readonly<Record<string, OpenRouterSpendTotals>> } {
    return { room: this.room, agents: Object.fromEntries(this.byAgent) };
  }
}
