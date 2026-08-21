export const CONVERSATION_ENERGY_LEVELS = ["low", "balanced", "lively", "party"] as const;

export type ConversationEnergy = (typeof CONVERSATION_ENERGY_LEVELS)[number];

export interface ConversationEnergyPolicy {
  label: string;
  description: string;
  participantLimit: number | "all";
  secondaryChance: number;
  softMessageBudget: number;
  hardMessageCeiling: number;
  hardTurnCeiling: number;
}

export const CONVERSATION_ENERGY_POLICIES: Record<ConversationEnergy, ConversationEnergyPolicy> = {
  low: {
    label: "Low",
    description: "Usually one agent responds.",
    participantLimit: 1,
    secondaryChance: 0,
    softMessageBudget: 1,
    hardMessageCeiling: 3,
    hardTurnCeiling: 3,
  },
  balanced: {
    label: "Balanced",
    description: "Usually one or two agents join in.",
    participantLimit: 2,
    secondaryChance: 0.72,
    softMessageBudget: 4,
    hardMessageCeiling: 6,
    hardTurnCeiling: 6,
  },
  lively: {
    label: "Lively",
    description: "Several agents may join and continue.",
    participantLimit: 3,
    secondaryChance: 0.9,
    softMessageBudget: 7,
    hardMessageCeiling: 10,
    hardTurnCeiling: 10,
  },
  party: {
    label: "Party",
    description: "The whole room can pile in—within limits.",
    participantLimit: "all",
    secondaryChance: 1,
    softMessageBudget: 12,
    hardMessageCeiling: 16,
    hardTurnCeiling: 16,
  },
};

export function isConversationEnergy(value: unknown): value is ConversationEnergy {
  return typeof value === "string" && CONVERSATION_ENERGY_LEVELS.includes(value as ConversationEnergy);
}

export function migrateMaxRounds(value: unknown): ConversationEnergy {
  if (typeof value !== "number" || !Number.isFinite(value)) return "balanced";
  if (value <= 1) return "low";
  if (value <= 3) return "balanced";
  if (value <= 6) return "lively";
  return "party";
}
