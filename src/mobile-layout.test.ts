import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8");
const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 720px) {"));

describe("mobile layout contract", () => {
  it("keeps the application and chat inside the dynamic viewport", () => {
    expect(mobileStyles).toContain("height: 100dvh");
    expect(mobileStyles).toMatch(/\.workspace \{[^}]*min-height: 0;[^}]*overflow: hidden;/s);
    expect(mobileStyles).toMatch(/\.chat-panel \{[^}]*height: 100%;[^}]*minmax\(0, 1fr\)/s);
  });

  it("moves secondary room controls into an off-canvas panel", () => {
    expect(mobileStyles).toMatch(/\.right-rail \{[^}]*position: fixed;[^}]*translateX\(100%\)/s);
    expect(mobileStyles).toMatch(/\.right-rail--open \{[^}]*translateX\(0\)/s);
    expect(mobileStyles).toContain('.right-rail[data-mobile-panel="people"] .controls-panel');
    expect(mobileStyles).toContain('.right-rail[data-mobile-panel="room"] .presence-panel');
  });

  it("uses horizontally scrollable formatting controls instead of wrapping", () => {
    expect(mobileStyles).toMatch(/\.format-toolbar \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/s);
    expect(mobileStyles).toMatch(/\.format-toolbar button, \.format-toolbar \.color-well \{[^}]*width: 38px;/s);
  });

  it("places formatting popovers above the toolbar clipping boundary", () => {
    expect(components).toMatch(/<div className="format-toolbar"[\s\S]*?<\/div>\s*\{colorPicker \? \(/);
    expect(components).toMatch(/\) : null\}\s*\{emojiOpen \? \(/);
    expect(mobileStyles).toMatch(/\.aim-color-picker \{[^}]*position: fixed;[^}]*inset:/s);
    expect(mobileStyles).toMatch(/\.emoji-picker \{[^}]*position: fixed;/s);
  });

  it("hides timestamps in the narrow transcript", () => {
    expect(mobileStyles).toMatch(/\.message time \{[^}]*display: none;/s);
  });

  it("gives the task workflow the full mobile workspace without covering room controls", () => {
    expect(mobileStyles).toMatch(/\.tasks-panel \{[^}]*width: 100%;[^}]*height: 100%;/s);
    expect(mobileStyles).toMatch(/\.tasks-room-rail \{[^}]*display: none;/s);
    expect(mobileStyles).toMatch(/\.task-columns form \{[^}]*grid-template-columns: 1fr;/s);
  });
});
