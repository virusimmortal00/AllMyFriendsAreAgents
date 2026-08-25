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

  it("keeps the compact classic menu bar visible instead of turning it into a mobile scroller", () => {
    expect(mobileStyles).toMatch(/\.menu-bar \{[^}]*overflow: visible;/s);
    expect(mobileStyles).toMatch(/\.menu-bar > \.menu-wrap > button \{[^}]*white-space: nowrap;/s);
  });

  it("contains long room names and message content", () => {
    expect(styles).not.toContain("transcript-header");
    expect(styles).toMatch(/\.transcript \{[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/s);
    expect(styles).toMatch(/\.message > div \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/s);
    expect(styles).toMatch(/\.chat-panel \{[^}]*contain: inline-size;/s);
    expect(styles).toMatch(/\.transcript-shell \{[^}]*min-width: 0;[^}]*overflow: hidden;/s);
    expect(styles).toMatch(/\.agent-settings-window \{[^}]*min-width: 0;[^}]*max-width: 100%;/s);
  });

  it("uses dialogs for secondary room controls and removes the desktop rail on mobile", () => {
    expect(mobileStyles).toMatch(/\.right-rail \{[^}]*display: none;/s);
    expect(mobileStyles).toMatch(/\.room-settings-window \.controls-panel \{[^}]*max-height:/s);
    expect(mobileStyles).toMatch(/\.people-window \.presence-panel \{[^}]*max-height:/s);
  });

  it("uses horizontally scrollable formatting controls instead of wrapping", () => {
    expect(mobileStyles).toMatch(/\.format-toolbar \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/s);
    expect(mobileStyles).toMatch(/\.format-toolbar button, \.format-toolbar \.color-well \{[^}]*width: 38px;/s);
  });

  it("places formatting popovers above the toolbar clipping boundary", () => {
    expect(components).toMatch(/<div className="format-popover-layer"[\s\S]*?<div className="format-toolbar"/);
    expect(components).toContain('formatPopover === "text" || formatPopover === "background"');
    expect(components).toContain('formatPopover === "emoji"');
    expect(styles).toMatch(/\.aim-color-picker \{[^}]*position: fixed;/s);
    expect(styles).toMatch(/\.emoji-picker \{[^}]*position: fixed;/s);
    expect(components).toContain("triggerBounds.top - popoverBounds.height - gap");
    expect(components).toContain("Math.min(centeredLeft, maxLeft)");
  });

  it("lets the timestamp preference control narrow and wide transcripts consistently", () => {
    expect(styles).toMatch(/\.transcript--timestamps-hidden \.message \{[^}]*grid-template-columns: 1fr;/s);
    expect(styles).toMatch(/\.transcript--timestamps-hidden \.message time \{[^}]*display: none;/s);
    expect(mobileStyles).not.toMatch(/(^|\n)\s*\.message time \{[^}]*display: none;/s);
  });

  it("gives non-chat workflows the full workspace", () => {
    expect(mobileStyles).toMatch(/\.tasks-panel \{[^}]*width: 100%;[^}]*height: 100%;/s);
    expect(styles).toMatch(/\.workspace--single \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
    expect(mobileStyles).toMatch(/\.task-columns form \{[^}]*grid-template-columns: 1fr;/s);
  });
});
