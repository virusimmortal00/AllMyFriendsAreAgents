import { describe, expect, it } from "vitest";
import { visibleAgentChatText, visibleAgentText } from "../shared/message-format";

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
});
