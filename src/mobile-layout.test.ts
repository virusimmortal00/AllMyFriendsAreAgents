import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8");
const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 720px) {"));

describe("mobile layout contract", () => {
  it("keeps the application and chat inside the dynamic viewport", () => {
    expect(mobileStyles).toContain("height: 100dvh");
    expect(styles).toMatch(/\.app-window \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
    expect(mobileStyles).toMatch(/\.workspace \{[^}]*min-height: 0;[^}]*overflow: hidden;/s);
    expect(mobileStyles).toMatch(/\.chat-panel \{[^}]*height: 100%;[^}]*minmax\(0, 1fr\)/s);
    expect(styles).toMatch(/\.composer \{[^}]*width: 100%;[^}]*min-width: 0;/s);
    expect(styles).toMatch(/\.composer textarea \{[^}]*width: 100%;[^}]*min-width: 0;/s);
  });

  it("makes narrow navigation intentionally horizontally scrollable", () => {
    expect(mobileStyles).toMatch(/\.menu-bar \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/s);
    expect(mobileStyles).toMatch(/\.menu-bar > button, \.menu-bar > \.menu-wrap \{[^}]*flex: 0 0 auto;/s);
    expect(mobileStyles).toMatch(/\.menu-bar button \{[^}]*white-space: nowrap;/s);
  });

  it("contains long room names and message content", () => {
    expect(mobileStyles).toMatch(/\.transcript-header \.panel-title \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
    expect(styles).toMatch(/\.transcript \{[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/s);
    expect(styles).toMatch(/\.message > div \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/s);
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
});
