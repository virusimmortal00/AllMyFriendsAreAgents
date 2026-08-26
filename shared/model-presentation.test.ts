import { describe, expect, it } from "vitest";
import { friendlyModelName, modelAuthorId, providerLogoUrl } from "./model-presentation.js";

describe("model presentation", () => {
  it("uses verified brand sources without treating models.dev placeholders as logos", () => {
    expect(providerLogoUrl("openai")).toBe("https://models.dev/logos/openai.svg");
    expect(providerLogoUrl("google-vertex")).toBe("https://models.dev/logos/google.svg");
    expect(providerLogoUrl("cursor")).toBe("https://cursor.com/favicon.ico");
    expect(providerLogoUrl("mistralai")).toBe("https://openrouter.ai/images/icons/Mistral.png");
    expect(providerLogoUrl("qwen")).toBe("https://openrouter.ai/images/icons/Qwen.png");
    expect(providerLogoUrl("qwen-lan")).toBe("https://openrouter.ai/images/icons/Qwen.png");
    expect(providerLogoUrl("x-ai")).toContain("t0.gstatic.com/faviconV2");
    expect(providerLogoUrl("gryphe")).toBeUndefined();
  });

  it("keeps author and friendly-name derivation stable", () => {
    expect(modelAuthorId("openrouter", "google/gemini-3.7-flash")).toBe("google");
    expect(modelAuthorId("cursor", "cursor-grok-4.6-high")).toBe("x-ai");
    expect(modelAuthorId("cursor", "gemini-3.7-flash-high")).toBe("google");
    expect(modelAuthorId("cursor", "glm-5.2-high")).toBe("z-ai");
    expect(modelAuthorId("cursor", "composer-2.5")).toBe("cursor");
    expect(friendlyModelName("openai/gpt-5.6-sol")).toBe("GPT 5.6 Sol");
  });
});
