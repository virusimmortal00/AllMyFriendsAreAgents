import { describe, expect, it } from "vitest";
import config, { visualTestPattern } from "./playwright.config";

describe("visual capture browser configuration", () => {
  it("runs only selected scenario titles and relevant supplemental checks", () => {
    const diagnostics = visualTestPattern(["owner-diagnostics-query", "owner-diagnostics-results"]);
    expect(diagnostics.test("[webkit--desktop] app.visual.ts owner-diagnostics-query")).toBe(true);
    expect(diagnostics.test("[chromium--phone] app.visual.ts owner-diagnostics-results")).toBe(true);
    for (const title of ["room-chat", "roster-detail", "owner-diagnostics-query-other", "control density remains stable across resize boundaries and views"]) expect(diagnostics.test(title)).toBe(false);
    expect(visualTestPattern(["roster-detail"]).test("control density remains stable across resize boundaries and views")).toBe(true);
  });
  it("does not artificially hide Chromium scrollbars", () => {
    const chromium = config.projects!.filter((project) => project.use?.browserName === "chromium");
    expect(chromium).toHaveLength(6);
    for (const project of chromium) {
      expect(project.use?.launchOptions?.ignoreDefaultArgs).toEqual(["--hide-scrollbars"]);
      expect(project.use?.launchOptions?.args || []).not.toContain("--hide-scrollbars");
    }
  });
});
