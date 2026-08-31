import { describe, expect, it } from "vitest";
import { stripAgentSelfLabel, visibleAgentChatText, visibleAgentText } from "../shared/message-format";

describe("visibleAgentText", () => {
  it("hides disposition metadata from existing transcript messages", () => {
    expect(visibleAgentText("Useful answer.\n\nDISPOSITION: AGREE")).toBe("Useful answer.");
  });

  it("does not remove disposition words used in ordinary prose", () => {
    expect(visibleAgentText("My disposition: agree, with one caveat.")).toBe("My disposition: agree, with one caveat.");
  });

  it("hides agent style directives", () => {
    expect(visibleAgentText("Styled answer.\nSTYLE: {\"fontFamily\":\"Arial\"}")).toBe("Styled answer.");
  });

  it("hides a leading internal workflow preface from an agent message", () => {
    expect(visibleAgentChatText(
      "This is just casual room banter, not a coding task — plan mode doesn't apply here, so I'll skip the planning workflow and respond normally.\n\nSolitaire, unironically.",
    )).toBe("Solitaire, unironically.");
  });

  it("preserves ordinary multi-paragraph chat", () => {
    expect(visibleAgentChatText("Solitaire, unironically.\n\nFree with every copy of Windows.")).toBe(
      "Solitaire, unironically.\n\nFree with every copy of Windows.",
    );
  });

  it("removes only an exact current-speaker label, including after a separate preface", () => {
    expect(stripAgentSelfLabel("[ALPHA] Hello.", "Alpha")).toBe("Hello.");
    expect(stripAgentSelfLabel("[Alpha]\nHello.", "Alpha")).toBe("Hello.");
    expect(visibleAgentChatText("Plan mode is active.\n\n[ALPHA] Hello.", "Alpha")).toBe("Hello.");
  });

  it.each([
    "[aside] Hello.", "[Alpha Beta] Hello.", "[Beta] Hello.",
    "[Alpha](https://example.com) is a link.", "I saw [Alpha] earlier.",
    "```text\n[Alpha] Literal example.\n```",
  ])("preserves bracketed prose and Markdown that is not a self-label: %s", (text) => {
    expect(stripAgentSelfLabel(text, "Alpha")).toBe(text);
    expect(visibleAgentChatText(text, "Alpha")).toBe(text);
  });

  it("does not infer self identity when none is supplied", () => {
    expect(visibleAgentChatText("[Alpha] Hello.")).toBe("[Alpha] Hello.");
  });
});
