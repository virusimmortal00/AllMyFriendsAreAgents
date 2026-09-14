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

export interface OpenRouterUsageSummary {
  readonly room: OpenRouterSpendTotals;
  readonly agents: Readonly<Record<string, OpenRouterSpendTotals>>;
  readonly credits?: OpenRouterCreditBalance;
}
