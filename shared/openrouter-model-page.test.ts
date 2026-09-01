import { describe, expect, it } from "vitest";
import { parseOpenRouterModelPageUrl } from "./openrouter-model-page.js";

describe("OpenRouter model page URLs", () => {
  it("normalizes a public model page and ignores query and fragment data", () => {
    expect(parseOpenRouterModelPageUrl("https://www.openrouter.ai/z-ai/glm-5.3-flash?tab=providers#pricing")).toEqual({
      modelId: "z-ai/glm-5.3-flash",
      pageUrl: "https://openrouter.ai/z-ai/glm-5.3-flash",
    });
  });

  it.each([
    "http://openrouter.ai/z-ai/glm-5.3-flash",
    "https://openrouter.ai.evil.example/z-ai/glm-5.3-flash",
    "https://user@openrouter.ai/z-ai/glm-5.3-flash",
    "https://openrouter.ai:444/z-ai/glm-5.3-flash",
    "https://openrouter.ai/z-ai/glm-5.3-flash/endpoints",
  ])("rejects a URL that is not a fetch-safe public model page: %s", (value) => {
    expect(parseOpenRouterModelPageUrl(value)).toBeUndefined();
  });
});
