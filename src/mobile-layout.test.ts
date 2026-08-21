import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
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

  it("hides timestamps in the narrow transcript", () => {
    expect(mobileStyles).toMatch(/\.message time \{[^}]*display: none;/s);
  });
});
