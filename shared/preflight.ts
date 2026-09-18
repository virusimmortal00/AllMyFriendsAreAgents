import type { AgentId } from "./participants.js";

export const PREFLIGHT_MODES = ["off", "shadow", "enforce"] as const;

export type PreflightMode = (typeof PREFLIGHT_MODES)[number];

export const DEFAULT_PREFLIGHT_MODE: PreflightMode = "enforce";

export const PREFLIGHT_MODE_LABELS: Record<PreflightMode, { label: string; description: string }> = {
  off: {
    label: "Off",
    description: "Disable pre-flight gating and preserve the current full-room fan-out exactly.",
  },
  shadow: {
    label: "Shadow",
    description: "Measure routing decisions without suppressing any agent.",
  },
  enforce: {
    label: "Enforce",
    description: "Default. Invoke only agents selected by the energy-aware pre-flight gate, advised by the intent classifier.",
  },
};

export function isPreflightMode(value: unknown): value is PreflightMode {
  return typeof value === "string" && PREFLIGHT_MODES.includes(value as PreflightMode);
}

export interface PreflightEvidence {
  recordedDecisions: number;
  recordedAgents: number;
  shadowSuppressions: number;
  evaluatedShadowSuppressions: number;
  falseSuppressions: number;
  falseSuppressionRate: number | null;
  firstShadowDecisionAt: string | null;
  shadowDaysRecorded: number;
  outcomeTallies: Record<"invoke" | "suppress" | "unavailable", number>;
  reasonTallies: Partial<Record<string, number>>;
  dispositionTallies: Record<"speak" | "yield", number>;
  /** Aggregate advisory-classifier evidence, present once a classified decision is recorded. */
  classification?: PreflightClassificationEvidence;
}

/**
 * Address classification for one trigger message, supplied by an optional
 * intent classifier consulted before pre-flight routing. Probabilities are
 * 0–1. Only the deterministic gate consumes `agents` and `wholeRoom`; the
 * remaining fields are observability payload for routing evidence.
 */
export interface PreflightClassificationSnapshot {
  model: string;
  /** Probability that the trigger directly addresses each roster agent. */
  agents: Partial<Record<AgentId, number>>;
  /** Probability that the trigger invites every participant to respond. */
  wholeRoom: number;
  /** Classifier's primary addressee choice, when it ranked one above the rest. */
  primaryAddressee?: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  latencyMs: number;
}

/** Durable routing-audit projection of one classification consult. */
export interface PreflightClassificationAudit {
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wholeRoomProbability: number;
  addressProbabilities: Partial<Record<AgentId, number>>;
  /** Deterministic decision computed without classification, for attribution. */
  baseline: Array<{ agent: AgentId; outcome: "invoke" | "suppress" | "unavailable"; reason: string }>;
}

/**
 * Aggregate classification evidence. `counterfactualSavedCostUsd` and
 * `counterfactualSavedDurationMs` only sum dispositions of turns that actually
 * ran, so they measure shadow-mode counterfactuals rather than estimates.
 */
export interface PreflightClassificationEvidence {
  calls: number;
  /** Source model when every consult agrees, otherwise the explicit value `mixed`. */
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  averageLatencyMs: number;
  additionalSuppressions: number;
  additionalInvocations: number;
  suppressedSpoke: number;
  suppressedYield: number;
  rescuedSpoke: number;
  counterfactualSavedCostUsd: number;
  counterfactualSavedDurationMs: number;
}
