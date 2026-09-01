// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { measureScrollAffordances, measureScrollRegions } from "./geometry";

afterEach(() => { document.body.replaceChildren(); });

function scrollRegion(parent: HTMLElement, name: string, offset = 0, maximum = 200, gutter = 0) {
  const element = document.createElement("div");
  element.className = name;
  element.style.overflowY = "auto";
  element.style.border = "0px solid transparent";
  element.scrollTop = offset;
  Object.defineProperties(element, { clientHeight: { value: 100 }, scrollHeight: { value: 100 + maximum }, clientWidth: { value: 200 - gutter }, offsetWidth: { value: 200 } });
  element.getBoundingClientRect = () => ({ left: 0, top: 10, right: 200, bottom: 110, width: 200, height: 100, x: 0, y: 10, toJSON: () => ({}) });
  element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
  parent.append(element);
  return element;
}

describe("screenshot scroll context", () => {
  it("requires a real native gutter only when the pane overflows", () => {
    scrollRegion(document.body, "native-track", 0, 200, 14);
    scrollRegion(document.body, "fitting-content", 0, 0);
    expect(measureScrollAffordances()).toEqual([]);
    scrollRegion(document.body, "invisible-overlay", 0, 200);
    expect(measureScrollAffordances()).toEqual(["invisible-overlay: overflowing content has neither a native scrollbar gutter nor a directional edge."]);
  });

  it("rejects instruction rows and does not count borders as scrollbars", () => {
    const pane = scrollRegion(document.body, "border-only", 0, 200, 14);
    pane.style.border = "7px solid black";
    const hint = document.createElement("small"); hint.className = "classic-scroll-hint"; document.body.append(hint);
    expect(measureScrollAffordances()).toEqual(["A redundant scroll-instruction row is rendered.", "border-only: overflowing content has neither a native scrollbar gutter nor a directional edge."]);
  });

  it("accepts a directional inset edge, not a content mask or stale direction", () => {
    const pane = scrollRegion(document.body, "overlay", 0, 200);
    pane.dataset.overlayScroll = "true";
    pane.dataset.scrollEdges = "below";
    pane.style.boxShadow = "inset 0 -4px 3px -3px #666";
    expect(measureScrollAffordances()).toEqual([]);
    pane.style.maskImage = "linear-gradient(black, transparent)";
    expect(measureScrollAffordances()).toContain("A scroll affordance fades readable pane content.");
    pane.style.maskImage = "none";
    pane.scrollTop = 200;
    expect(measureScrollAffordances()).toContain("A scroll edge disagrees with its pane's actual position.");
  });

  it("records actual offsets including fitting regions without using text or cue state", () => {
    const app = document.createElement("main"); app.className = "app-window"; app.dataset.viewName = "Room properties"; document.body.append(app);
    const page = scrollRegion(app, "settings-page", 41, 300);
    page.textContent = "This content must not enter review metadata.";
    scrollRegion(page, "model-picker", 0, 0);
    expect(measureScrollRegions()).toEqual([{ name: "Room properties / settings-page", offset: 41, maximum: 300 }, { name: "Room properties / model-picker", offset: 0, maximum: 0 }]);
  });
  it("uses the topmost modal and excludes hidden or offscreen regions and native inputs", () => {
    scrollRegion(document.body, "background");
    const first = scrollRegion(document.body, "first-dialog"); first.setAttribute("aria-modal", "true");
    const last = scrollRegion(document.body, "last-dialog"); last.setAttribute("aria-modal", "true");
    const hidden = scrollRegion(last, "hidden"); hidden.style.visibility = "hidden";
    const offscreen = scrollRegion(last, "offscreen"); offscreen.getBoundingClientRect = () => ({ ...last.getBoundingClientRect(), top: innerHeight + 1 });
    const input = document.createElement("textarea"); input.style.overflowY = "auto"; last.append(input);
    expect(measureScrollRegions()).toEqual([{ name: "Application / last-dialog", offset: 0, maximum: 200 }]);
  });
});
