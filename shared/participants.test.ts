import { describe, expect, it } from "vitest";
import { AGENT_IDS, AGENT_PROFILES, SUPPORTED_AGENT_IDS, agentScreenName, isActiveAgentId, migrateLegacyAgentId } from "./participants.js";

describe("agent participant registry", () => {
  it("defines independently model-pinned default agents and opt-in harnesses", () => {
    expect(AGENT_IDS).toEqual(["codex-sol", "claude-sonnet", "cursor-grok", "cursor-composer", "cursor-gemini-flash", "cursor-glm"]);
    expect(AGENT_IDS.map((agent) => AGENT_PROFILES[agent].modelId)).toEqual([
      "gpt-5.6-sol",
      "claude-sonnet-5",
      "cursor-grok-4.6-high",
      "composer-2.5",
      "gemini-3.7-flash-high",
      "glm-5.2-high",
    ]);
    expect(new Set(AGENT_IDS.map((agent) => AGENT_PROFILES[agent].conversationalName)).size).toBe(6);
    expect(SUPPORTED_AGENT_IDS).toEqual(expect.arrayContaining(["claude-opus", "cursor-gemini", "opencode-configured"]));
  });

  it("uses model-backed screen-name tags and maps legacy participants safely", () => {
    expect(agentScreenName("codex-luna")).toBe("Codex [gpt-5.6 Luna]");
    expect(agentScreenName("claude-sonnet")).toBe("Claude [Claude Sonnet 5]");
    expect(agentScreenName("claude-opus")).toBe("Claude [Claude Opus 5]");
    expect(agentScreenName("cursor-grok")).toBe("Cursor [Grok 4.6]");
    expect(agentScreenName("cursor-gemini-flash")).toBe("Cursor [Gemini 3.7 Flash]");
    expect(agentScreenName("cursor-glm")).toBe("Cursor [GLM 5.2]");
    expect(agentScreenName("opencode-configured")).toBe("OpenCode [Configured model]");
    expect(isActiveAgentId("codex-terra")).toBe(false);
    expect(isActiveAgentId("claude-opus")).toBe(true);
    expect(isActiveAgentId("codex-luna")).toBe(false);
    expect(migrateLegacyAgentId("codex")).toBe("codex-sol");
    expect(migrateLegacyAgentId("claude")).toBe("claude-sonnet");
  });
});
