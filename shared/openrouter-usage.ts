/** Running totals accumulated from OpenRouter's own per-generation usage/cost accounting. */
export interface OpenRouterSpendTotals {
  readonly generations: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** The account's remaining OpenRouter balance, from `GET /api/v1/credits`. */
export interface OpenRouterCreditBalance {
  readonly totalCreditsUsd: number;
  readonly totalUsageUsd: number;
  readonly remainingUsd: number;
  readonly fetchedAt: string;
}

/**
 * Room activity, not account data: every room member may see it (same bar as the
 * per-message cost badges in the transcript). The account's credit balance is
 * account-level and financial instead — see `OpenRouterCreditsResponse`, which is
 * gated behind server administration.
 */
export interface OpenRouterUsageSummary {
  readonly room: OpenRouterSpendTotals;
  readonly agents: Readonly<Record<string, OpenRouterSpendTotals>>;
}

/** A named, bounded time span for the windowed spend query. "all" reaches only as far back as retained history. */
export const OPEN_ROUTER_SPEND_WINDOWS = ["1h", "24h", "7d", "30d", "all"] as const;
export type OpenRouterSpendWindow = (typeof OPEN_ROUTER_SPEND_WINDOWS)[number];

export interface OpenRouterUsageWindow {
  readonly room: OpenRouterSpendTotals;
  readonly agents: Readonly<Record<string, OpenRouterSpendTotals>>;
  /** Null for "all" when retained history reaches back further than any bound; otherwise the window's start. */
  readonly sinceIso: string | null;
  /** True when retained event history does not reach back to the requested window start (results understate the window). */
  readonly truncated: boolean;
}

/** The account's remaining credit balance, served only to a signed-in server administrator (`GET /api/control/integrations/openrouter`). */
export interface OpenRouterCreditsResponse {
  readonly credits?: OpenRouterCreditBalance;
}
