import { describe, expect, it } from "vitest";
import { buildLiveScenario, ROUTING_DYNAMICS, SCENARIO_PROFILE_IDS } from "./conversation-routing-live-scenarios.js";

describe("closed conversation fixture profiles", () => {
  it("preserves the default garden-v1 scenario and its address labels", () => {
    for (const dynamic of ROUTING_DYNAMICS) {
      const selection = {
        dynamic,
        agentCount: 3 as const,
        energy: "balanced" as const,
        preflightMode: "enforce" as const,
        classifierEnabled: true,
      };
      const defaultScenario = buildLiveScenario(selection);
      const { scenarioProfileId: explicitProfile, ...explicitScenario } = buildLiveScenario({
        ...selection,
        scenarioProfileId: "garden-v1",
      });
      expect(explicitProfile).toBe("garden-v1");
      expect(defaultScenario).toEqual(explicitScenario);
    }
  });

  it("offers an opt-in invented ordinary-chat corpus without meta-evaluation cues", () => {
    expect(SCENARIO_PROFILE_IDS).toEqual(["garden-v1", "garden-chat-v2", "everyday-chat-v3"]);
    for (const dynamic of ROUTING_DYNAMICS) {
      const scenario = buildLiveScenario({
        dynamic,
        agentCount: 3,
        energy: "balanced",
        preflightMode: "enforce",
        classifierEnabled: true,
        scenarioProfileId: "garden-chat-v2",
      });
      expect(scenario.scenarioProfileId).toBe("garden-chat-v2");
      expect(scenario.text).not.toMatch(/fictional|test|eval|simulation|benchmark/i);
      expect(scenario.text.length).toBeGreaterThan(25);
      if (dynamic === "direct" || dynamic === "handoff") expect(scenario.expectedDirectAgents).toEqual(["codex-sol"]);
      if (dynamic === "multi-address" || dynamic === "disagreement")
        expect(scenario.expectedDirectAgents).toEqual(["codex-sol", "claude-sonnet"]);
      for (const followup of scenario.followup ? [scenario.followup] : [])
        expect(followup.text).not.toMatch(/fictional|test|eval|simulation|benchmark/i);
    }
    expect(() =>
      buildLiveScenario({
        dynamic: "casual",
        agentCount: 2,
        energy: "low",
        preflightMode: "enforce",
        classifierEnabled: true,
        scenarioProfileId: "unreviewed" as never,
      }),
    ).toThrow();
  });
});
