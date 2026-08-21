import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIM_SMILEY_SHORTCUTS } from "../shared/aim-smileys";
import { AIM_SMILEYS, renderAimSmileys } from "./aim-smileys";

describe("retro smileys", () => {
  it("offers the 16-icon set", () => {
    expect(AIM_SMILEYS).toHaveLength(16);
    expect(AIM_SMILEYS.map((smiley) => smiley.shortcut)).toEqual(AIM_SMILEY_SHORTCUTS);
  });

  it("renders recognized shortcuts as the original PNG assets while preserving text", () => {
    const html = renderToStaticMarkup(<>{renderAimSmileys("Hello :-) wow =-O")}</>);

    expect(html).toContain("Hello ");
    expect(html).toContain(" wow ");
    expect(html.match(/<img/g)).toHaveLength(2);
    expect(html).toContain("Smile :-)");
    expect(html).toContain("Surprised =-O");
    expect(html).toContain("/smileys/smile.png");
    expect(html).toContain("/smileys/surprised.png");
  });

  it("leaves ordinary text untouched", () => {
    expect(renderToStaticMarkup(<>{renderAimSmileys("plain text")}</>)).toBe("plain text");
  });
});
