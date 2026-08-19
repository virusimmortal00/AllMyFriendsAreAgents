import { describe, expect, it } from "vitest";
import { CONVERSATION_ENERGY_LEVELS, CONVERSATION_ENERGY_POLICIES, isConversationEnergy, migrateMaxRounds } from "./conversation-energy.js";

describe("conversation energy", () => {
  it("defines increasingly permissive policies with absolute ceilings", () => {
    expect(CONVERSATION_ENERGY_LEVELS).toEqual(["low", "balanced", "lively", "party"]);
    expect(CONVERSATION_ENERGY_LEVELS.map((level) => CONVERSATION_ENERGY_POLICIES[level].softMessageBudget)).toEqual([1, 4, 7, 12]);
    expect(CONVERSATION_ENERGY_LEVELS.map((level) => CONVERSATION_ENERGY_POLICIES[level].hardMessageCeiling)).toEqual([3, 6, 10, 16]);
    expect(CONVERSATION_ENERGY_LEVELS.every((level) => CONVERSATION_ENERGY_POLICIES[level].hardTurnCeiling > 0)).toBe(true);
  });

  it("validates levels and migrates the legacy numeric setting", () => {
    expect(isConversationEnergy("balanced")).toBe(true);
    expect(isConversationEnergy("maximum")).toBe(false);
    expect([1, 3, 6, 8].map(migrateMaxRounds)).toEqual(["low", "balanced", "lively", "party"]);
  });
});
