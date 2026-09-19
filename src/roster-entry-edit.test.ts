import { describe, expect, it } from "vitest";
import { confirmRosterSelection, replaceRosterModel, replaceRosterVariant } from "./roster-entry-edit";

const entry = {
  agentId: "agent-11111111-1111-4111-8111-111111111111",
  conversationalName: "Scout",
  providerId: "openai",
  modelId: "old-model",
  variant: "high",
  reasoningEffort: "high",
  enabled: true,
  sessionInvalidationReason: "Confirm this selection.",
  selectionConfirmationRequired: true,
};

describe("roster entry edits", () => {
  it("removes stale selection state when the model changes", () => {
    expect(replaceRosterModel(entry, { modelId: "local-model" })).toEqual({
      agentId: entry.agentId,
      conversationalName: "Scout",
      modelId: "local-model",
      enabled: true,
    });
  });

  it("represents the default variant and confirmed selection as absent", () => {
    expect(replaceRosterVariant(entry, "")).not.toHaveProperty("variant");
    expect(replaceRosterVariant(entry, "")).not.toHaveProperty("reasoningEffort");
    expect(confirmRosterSelection(entry)).not.toHaveProperty("sessionInvalidationReason");
    expect(confirmRosterSelection(entry)).not.toHaveProperty("selectionConfirmationRequired");
  });
});
