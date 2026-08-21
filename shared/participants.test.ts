import { describe, expect, it } from "vitest";
import { AGENT_IDS, AGENT_PROFILES, agentScreenName, migrateLegacyAgentId } from "./participants.js";

describe("agent participant registry", () => {
  it("defines independently model-pinned agents across three providers", () => {
    expect(AGENT_IDS).toEqual(["codex-luna", "codex-terra", "codex-sol", "claude-sonnet", "cursor-grok", "cursor-gemini", "cursor-composer"]);
    expect(AGENT_IDS.map((agent) => AGENT_PROFILES[agent].modelId)).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "claude-sonnet-5",
      "cursor-grok-4.6-high",
      "gemini-3.1-pro",
      "composer-2.5",
    ]);
    expect(new Set(AGENT_IDS.map((agent) => AGENT_PROFILES[agent].conversationalName)).size).toBe(7);
  });

  it("uses model-backed screen-name tags and maps legacy participants safely", () => {
    expect(agentScreenName("codex-luna")).toBe("Codex [gpt-5.6 Luna]");
    expect(agentScreenName("claude-sonnet")).toBe("Claude [Claude Sonnet 5]");
    expect(agentScreenName("cursor-grok")).toBe("Cursor [Grok 4.6]");
    expect(migrateLegacyAgentId("codex")).toBe("codex-sol");
    expect(migrateLegacyAgentId("claude")).toBe("claude-sonnet");
  });
});
