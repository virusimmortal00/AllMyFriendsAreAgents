import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES, extractStyleDirective, sanitizeChatStyle } from "./chat-style.js";

describe("chat style validation", () => {
  it("allows AIM-safe styling and clamps font size", () => {
    expect(sanitizeChatStyle({
      fontFamily: "Courier New",
      fontSize: 99,
      textColor: "#ABCDEF",
      backgroundColor: "#123456",
      bold: true,
    }, DEFAULT_PARTICIPANT_STYLES.you)).toMatchObject({
      fontFamily: "Courier New",
      fontSize: 28,
      textColor: "#abcdef",
      backgroundColor: "#123456",
      bold: true,
    });
  });

  it("rejects unsupported fonts, colors, and malformed directives", () => {
    const fallback = DEFAULT_PARTICIPANT_STYLES.codex;
    expect(sanitizeChatStyle({ fontFamily: "url(evil)", textColor: "red" }, fallback)).toEqual(fallback);
    expect(extractStyleDirective("STYLE: not-json", fallback)).toBeUndefined();
  });
});
