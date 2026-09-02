import { describe, expect, it } from "vitest";
import { parseOpenRouterModelPageUrl } from "./openrouter-model-page.js";

describe("OpenRouter model page URLs", () => {
  it("normalizes a public model page and ignores query and fragment data", () => {
    expect(parseOpenRouterModelPageUrl("https://www.openrouter.ai/z-ai/glm-5.3-flash?tab=providers#pricing")).toEqual({
      modelId: "z-ai/glm-5.3-flash",
      pageUrl: "https://openrouter.ai/z-ai/glm-5.3-flash",
    });
  });

  it.each(["model:free", "model%3Afree"])("preserves variant suffixes in model slugs: %s", (slug) => {
    expect(parseOpenRouterModelPageUrl(`https://openrouter.ai/example/${slug}`)).toEqual({
      modelId: "example/model:free",
      pageUrl: "https://openrouter.ai/example/model%3Afree",
    });
  });

  it("retains the model segment length limit with variant suffixes", () => {
    const slug = `${"a".repeat(95)}:free`;
    expect(parseOpenRouterModelPageUrl(`https://openrouter.ai/example/${slug}`)?.modelId).toBe(`example/${slug}`);
    expect(parseOpenRouterModelPageUrl(`https://openrouter.ai/example/a${slug}`)).toBeUndefined();
  });

  it.each([
    "http://openrouter.ai/z-ai/glm-5.3-flash",
    "https://openrouter.ai.evil.example/z-ai/glm-5.3-flash",
    "https://user@openrouter.ai/z-ai/glm-5.3-flash",
    "https://openrouter.ai:444/z-ai/glm-5.3-flash",
    "https://openrouter.ai/z-ai/glm-5.3-flash/endpoints",
    "https://openrouter.ai/example:free/model",
    "https://openrouter.ai/example/model:free/endpoints",
    "https://openrouter.ai/example/model:free!invalid",
    "https://openrouter.ai/example/model%2Fother:free",
  ])("rejects a URL that is not a fetch-safe public model page: %s", (value) => {
    expect(parseOpenRouterModelPageUrl(value)).toBeUndefined();
  });
});
