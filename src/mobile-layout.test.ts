import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const components = readFileSync(new URL("./components.tsx", import.meta.url), "utf8");
const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 720px) {"));

describe("mobile layout contract", () => {
  it("keeps the application and chat inside the dynamic viewport", () => {
    expect(mobileStyles).toContain("height: 100dvh");
    expect(styles).toMatch(/\.desktop \{[^}]*height: 100dvh;[^}]*min-height: 0;/s);
    expect(styles).toMatch(/@media \(max-width: 1050px\) \{[\s\S]*?\.app-window \{[^}]*height: calc\(100dvh - 24px\);[^}]*min-height: 0;/s);
    expect(styles).toMatch(/\.app-window \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
    expect(mobileStyles).toMatch(/\.workspace \{[^}]*min-height: 0;[^}]*overflow: hidden;/s);
    expect(mobileStyles).toMatch(/\.chat-panel \{[^}]*height: 100%;[^}]*minmax\(0, 1fr\)/s);
    expect(styles).toMatch(/\.composer \{[^}]*width: 100%;[^}]*min-width: 0;/s);
    expect(styles).toMatch(/\.composer textarea \{[^}]*width: 100%;[^}]*min-width: 0;/s);
  });

  it("centers the primary window with balanced safe-area margins", () => {
    expect(mobileStyles).toMatch(/\.desktop \{[^}]*display: grid;[^}]*place-items: center;/s);
    expect(mobileStyles).toMatch(/\.desktop \{[^}]*padding-top: max\(6px, env\(safe-area-inset-top\)\);[^}]*padding-right: max\(6px, env\(safe-area-inset-right\)\);[^}]*padding-bottom: max\(6px, env\(safe-area-inset-bottom\)\);[^}]*padding-left: max\(6px, env\(safe-area-inset-left\)\);/s);
    expect(mobileStyles).toMatch(/\.app-window \{[^}]*width: 100%;[^}]*height: 100%;[^}]*max-height: 100%;/s);
    expect(mobileStyles).not.toMatch(/\.app-window \{[^}]*height: 100dvh;/s);
  });

  it("keeps the compact classic menu bar visible instead of turning it into a mobile scroller", () => {
    expect(mobileStyles).toMatch(/\.menu-bar \{[^}]*overflow: visible;/s);
    expect(styles).toMatch(/\.menu-bar > \.menu-wrap > button \{[^}]*min-height: var\(--classic-menu-item-height\);[^}]*white-space: nowrap;/s);
    expect(mobileStyles).toMatch(/\.dropdown-menu \{[^}]*top: 100%;/s);
    expect(styles).toMatch(/\.dropdown-menu button \{[^}]*min-height: var\(--classic-menu-item-height\);/s);
  });

  it("selects touch density by pointer capability without width or short-height chrome jumps", () => {
    expect(styles).toMatch(/@media \(pointer: coarse\) \{\s*:root \{[^}]*--classic-command-height: 44px;[^}]*--classic-menu-item-height: 44px;[^}]*--classic-toolbar-height: 44px;/s);
    expect(styles).not.toContain("@media (min-width: 721px) and (max-width: 820px)");
    expect(styles).toMatch(/grid-template-rows: 24px calc\(var\(--classic-menu-item-height\) \+ 4px\) minmax\(0, 1fr\) auto 24px;/);
    expect(mobileStyles).not.toMatch(/\.menu-bar > \.menu-wrap > button[^}]*min-height:/s);
    expect(mobileStyles).not.toMatch(/\.format-toolbar[^}]*height: (?:31|35)px;/s);
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
    expect(mobileStyles).toMatch(/\.room-properties-body \.controls-panel \{[^}]*margin:/s);
    expect(styles).toMatch(/\.human-avatar-window \{[^}]*width:/s);
    expect(styles).toMatch(/\.dialog-window \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;[^}]*overflow: hidden;/s);
    expect(styles).toMatch(/\.dialog-body \{[^}]*min-height: 0;[^}]*overflow: auto;/s);
    expect(mobileStyles).toMatch(/\.modal-backdrop \.dialog-window \{[^}]*width: 100%;[^}]*max-height: 100%;[^}]*align-self: center;[^}]*justify-self: center;/s);
    expect(styles).toContain("min-height: var(--classic-command-height)");
    expect(mobileStyles).not.toMatch(/\.dialog-actions \.classic-button \{[^}]*min-height:/s);
  });

  it("turns the roster manager into a single-pane master-detail flow", () => {
    expect(mobileStyles).toMatch(/\.roster-workspace \{[^}]*display: block;[^}]*overflow: hidden;/s);
    expect(mobileStyles).toContain('.roster-workspace[data-mobile-pane="list"] > .roster-detail-shell');
    expect(mobileStyles).toContain('.roster-workspace[data-mobile-pane="detail"] > .roster-rail');
    expect(mobileStyles).toMatch(/\.roster-mobile-back \{[^}]*display: block;/s);
    expect(styles).toMatch(/\.roster-mobile-back, [^{]+\{[^}]*min-height: var\(--classic-command-height\);/s);
  });

  it("reflows formatting controls without hiding actions in a horizontal scroller", () => {
    expect(mobileStyles).toMatch(/\.format-toolbar \{[^}]*flex-wrap: wrap;/s);
    expect(mobileStyles).toMatch(/\.format-toolbar button, \.format-toolbar \.color-well \{[^}]*width: var\(--classic-toolbar-width\);/s);
  });

  it("places formatting popovers above the toolbar clipping boundary", () => {
    expect(components).toMatch(/<div className="format-popover-layer"[\s\S]*?<div className="format-toolbar"/);
    expect(components).toContain('formatPopover === "text" || formatPopover === "background"');
    expect(components).toContain('formatPopover === "emoji"');
    expect(styles).toMatch(/\.aim-color-picker \{[^}]*position: fixed;/s);
    expect(styles).toMatch(/\.emoji-picker \{[^}]*position: fixed;/s);
    expect(components).toContain('trigger.closest(".format-toolbar")');
    expect(components).toContain("toolbarBounds.top - popoverBounds.height - gap");
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
    expect(styles).toMatch(/@media \(max-width: 1050px\) \{[\s\S]*?\.workspace--single \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
    expect(mobileStyles).toMatch(/\.task-columns form \{[^}]*grid-template-columns: 1fr;/s);
  });

  it("sizes the diagnostics summary from its result pane instead of the viewport", () => {
    expect(styles).toMatch(/\.diagnostics-result-list \{[^}]*container: diagnostic-list \/ inline-size;/s);
    expect(styles).toMatch(/\.diagnostic-trace-summary \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(styles).toMatch(/@container diagnostic-list \(min-width: 500px\) \{\s*\.diagnostic-trace-summary \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/s);
    expect(mobileStyles).not.toMatch(/\.diagnostic-trace-summary \{[^}]*grid-template-columns:/s);
  });
});
