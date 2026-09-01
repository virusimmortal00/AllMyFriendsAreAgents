import type { RoomAgentRoster } from "../../shared/roster";

export const visualRoster: RoomAgentRoster = {
  schemaVersion: 3,
  revision: 1,
  entries: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon with a deliberately long alias", "Zeta", "Eta", "Theta", "Iota"].map((conversationalName, index) => ({
    agentId: `agent-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    conversationalName,
    providerId: "fixture-provider",
    modelId: "fixture-model-with-a-deliberately-long-display-name",
    enabled: index % 3 !== 2,
  })),
};
