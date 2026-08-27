export const PREFLIGHT_MODES = ["off", "shadow", "enforce"] as const;

export type PreflightMode = (typeof PREFLIGHT_MODES)[number];

export const DEFAULT_PREFLIGHT_MODE: PreflightMode = "off";

export const PREFLIGHT_MODE_LABELS: Record<PreflightMode, { label: string; description: string }> = {
  off: {
    label: "Off",
    description: "Preserve the current full-room fan-out exactly.",
  },
  shadow: {
    label: "Shadow",
    description: "Measure routing decisions without suppressing any agent.",
  },
  enforce: {
    label: "Enforce",
    description: "Invoke only agents selected by the energy-aware pre-flight gate.",
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
  promotionEligible: boolean;
  promotionEligibilityReasons: string[];
  outcomeTallies: Record<"invoke" | "suppress" | "unavailable", number>;
  reasonTallies: Partial<Record<string, number>>;
  dispositionTallies: Record<"speak" | "yield", number>;
}
