import { describe, expect, it } from "vitest";
import config from "./playwright.config";

describe("visual capture browser configuration", () => {
  it("does not artificially hide Chromium scrollbars", () => {
    const chromium = config.projects!.filter((project) => project.use?.browserName === "chromium");
    expect(chromium).toHaveLength(6);
    for (const project of chromium) {
      expect(project.use?.launchOptions?.ignoreDefaultArgs).toEqual(["--hide-scrollbars"]);
      expect(project.use?.launchOptions?.args || []).not.toContain("--hide-scrollbars");
    }
  });
});
