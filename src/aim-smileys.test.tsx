import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AIM_SMILEY_SHORTCUTS } from "../shared/aim-smileys";
import { AIM_SMILEYS, renderAimSmileys } from "./aim-smileys";

describe("classic AIM smileys", () => {
  it("offers the original 16-icon set", () => {
    expect(AIM_SMILEYS).toHaveLength(16);
    expect(AIM_SMILEYS.map((smiley) => smiley.shortcut)).toEqual(AIM_SMILEY_SHORTCUTS);
  });

  it("renders recognized shortcuts as the classic GIFs while preserving text", () => {
    const html = renderToStaticMarkup(<>{renderAimSmileys("Hello :-) wow =-O")}</>);

    expect(html).toContain("Hello ");
    expect(html).toContain(" wow ");
    expect(html.match(/<img/g)).toHaveLength(2);
    expect(html).toContain("Smile :-)");
    expect(html).toContain("Surprised =-O");
  });

  it("leaves ordinary text untouched", () => {
    expect(renderToStaticMarkup(<>{renderAimSmileys("plain text")}</>)).toBe("plain text");
  });
});
