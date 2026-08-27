import { describe, expect, it } from "vitest";
import { agentContextConfigFor, defaultRoomConfiguration, normalizeRoomConfiguration, roomBasePrompt, DEFAULT_ROOM_BASE_PROMPT } from "./room-configuration.js";

describe("room configuration defaults", () => {
  it("uses Muse Spark first and DeepSeek V4 Flash as the built-in fallback", () => {
    expect(agentContextConfigFor(defaultRoomConfiguration()).summarizerModels).toEqual([
      { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free" },
      { providerId: "openrouter", modelId: "~deepseek/deepseek-v4-flash-latest" },
    ]);
  });

  it("maps absent and empty base prompts to the default while preserving explicit deletion", () => {
    expect(roomBasePrompt(undefined)).toBe(DEFAULT_ROOM_BASE_PROMPT);
    expect(roomBasePrompt(normalizeRoomConfiguration({ basePromptText: "" }))).toBe(DEFAULT_ROOM_BASE_PROMPT);
    expect(roomBasePrompt(normalizeRoomConfiguration({ basePromptText: null }))).toBeNull();
  });
});
