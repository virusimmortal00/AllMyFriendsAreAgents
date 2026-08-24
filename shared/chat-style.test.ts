import { describe, expect, it } from "vitest";
import { AIM_5_COLOR_PALETTE, CHAT_FONT_FAMILIES, CHAT_FONT_STACKS, DEFAULT_PARTICIPANT_STYLES, extractStyleDirective, normalizeParticipantStyles, sanitizeChatStyle } from "./chat-style.js";

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
    const fallback = DEFAULT_PARTICIPANT_STYLES["codex-sol"];
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

  it("limits styles to AIM-era local fonts with category-appropriate fallbacks", () => {
    expect(CHAT_FONT_FAMILIES).toEqual([
      "Arial", "Times New Roman", "Georgia", "Comic Sans MS", "Courier New", "Trebuchet MS", "Tahoma", "Verdana",
    ]);
    expect(CHAT_FONT_STACKS["Times New Roman"]).toContain("serif");
    expect(CHAT_FONT_STACKS["Courier New"]).toContain("monospace");
    expect(CHAT_FONT_STACKS["Comic Sans MS"]).toContain("cursive");
  });

  it("does not admit local transcript magnification into transmitted style", () => {
    const style = sanitizeChatStyle({
      ...DEFAULT_PARTICIPANT_STYLES.you,
      transcriptMagnification: 150,
    }, DEFAULT_PARTICIPANT_STYLES.you);

    expect(style).toEqual(DEFAULT_PARTICIPANT_STYLES.you);
    expect(style).not.toHaveProperty("transcriptMagnification");
  });

  it("keeps fallback styles for inactive historical participants", () => {
    const normalized = normalizeParticipantStyles({});

    expect(Object.keys(normalized).sort()).toEqual(Object.keys(DEFAULT_PARTICIPANT_STYLES).sort());
    expect(normalized["cursor-gemini"]).toEqual(DEFAULT_PARTICIPANT_STYLES["cursor-gemini"]);
  });
});
