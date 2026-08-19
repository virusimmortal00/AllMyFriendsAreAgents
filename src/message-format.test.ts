import { describe, expect, it } from "vitest";
import { visibleAgentText } from "../shared/message-format";

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
});
