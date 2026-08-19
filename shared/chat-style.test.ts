import { describe, expect, it } from "vitest";
import { AIM_5_COLOR_PALETTE, DEFAULT_PARTICIPANT_STYLES, extractStyleDirective, sanitizeChatStyle } from "./chat-style.js";

describe("chat style validation", () => {
  it("allows AIM-safe styling and clamps font size", () => {
    expect(sanitizeChatStyle({
      fontFamily: "Courier New",
      fontSize: 99,
      textColor: "#F07C1B",
      backgroundColor: "#111111",
      bold: true,
    }, DEFAULT_PARTICIPANT_STYLES.you)).toMatchObject({
      fontFamily: "Courier New",
      fontSize: 28,
      textColor: "#f07c1b",
      backgroundColor: "#111111",
      bold: true,
    });
  });

  it("rejects unsupported fonts, colors, and malformed directives", () => {
    const fallback = DEFAULT_PARTICIPANT_STYLES.codex;
    expect(sanitizeChatStyle({ fontFamily: "url(evil)", textColor: "#abcdef", backgroundColor: "red" }, fallback)).toEqual(fallback);
    expect(extractStyleDirective("STYLE: not-json", fallback)).toBeUndefined();
  });

  it("exposes only the finite AIM 5.x color wells", () => {
    expect(AIM_5_COLOR_PALETTE).toContain("#1618fd");
    expect(AIM_5_COLOR_PALETTE).toContain("#ffffff");
    expect(AIM_5_COLOR_PALETTE).not.toContain("#abcdef");
  });

  it("does not preserve an off-palette fallback color", () => {
    expect(sanitizeChatStyle({}, {
      ...DEFAULT_PARTICIPANT_STYLES.you,
      textColor: "#abcdef",
      backgroundColor: "#123456",
    })).toMatchObject({ textColor: "#000000", backgroundColor: "#ffffff" });
  });
});
