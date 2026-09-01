// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { DEFAULT_PARTICIPANT_STYLES, type ChatStyle } from "../shared/chat-style";
import { ChatComposer } from "./components";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function FormattingFlow() {
  const [draft, setDraft] = useState("");
  const [style, setStyle] = useState<ChatStyle>({ ...DEFAULT_PARTICIPANT_STYLES.you });
  return <>
    <ChatComposer draft={draft} style={style} onDraftChange={setDraft} onStyleChange={setStyle} onSubmit={(event) => event.preventDefault()} />
    <button type="button">Outside composer</button>
  </>;
}

describe("composer formatting popovers", () => {
  it("places a second-row popup above the whole formatting toolbar", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("format-toolbar")) return new DOMRect(0, 450, 390, 90);
      if (this.classList.contains("emoji-picker")) return new DOMRect(0, 0, 170, 200);
      if (this.getAttribute("aria-label") === "Classic emojis") return new DOMRect(200, 500, 40, 40);
      return new DOMRect();
    });
    const user = userEvent.setup();
    render(<FormattingFlow />);
    await user.click(screen.getByRole("button", { name: "Classic emojis" }));
    const popup = screen.getByRole("dialog", { name: "Classic AIM smiley picker" });
    expect(popup.style.top).toBe("245px");
    expect(popup.style.left).toBe("135px");
  });
  it("bounds the shared popup frame to the visual viewport and keeps its close action outside the scroll body", async () => {
    const viewport = Object.assign(new EventTarget(), { width: 320, height: 300, offsetLeft: 0, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    const user = userEvent.setup();
    render(<FormattingFlow />);
    await user.click(screen.getByRole("button", { name: "Text color" }));
    const popup = screen.getByRole("dialog", { name: "Text color palette" });
    expect(popup.style.maxHeight).toBe("284px");
    expect(popup.querySelector(".classic-popover__body")?.contains(screen.getByRole("button", { name: "Close Text color" }))).toBe(false);
    expect(popup.querySelectorAll(".classic-popover__body .aim-color-swatch")).toHaveLength(64);
    act(() => { viewport.height = 240; viewport.dispatchEvent(new Event("resize")); });
    expect(popup.style.maxHeight).toBe("224px");
  });
  it("toggles one popover at a time and dismisses it from Escape or an outside press", async () => {
    const user = userEvent.setup();
    render(<FormattingFlow />);
    const textColor = screen.getByRole("button", { name: "Text color" });
    await user.click(textColor);
    expect(screen.getByRole("dialog", { name: "Text color palette" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /color palette/ })).toBeNull();
    expect(document.activeElement).toBe(textColor);

    await user.click(screen.getByRole("button", { name: "Classic emojis" }));
    expect(screen.getByRole("dialog", { name: "Classic AIM smiley picker" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Outside composer" }));
    expect(screen.queryByRole("dialog", { name: "Classic AIM smiley picker" })).toBeNull();
  });

  it("closes after a color or emoji is selected", async () => {
    const user = userEvent.setup();
    render(<FormattingFlow />);
    await user.click(screen.getByRole("button", { name: "Message highlight color" }));
    const palette = screen.getByRole("dialog", { name: "Message highlight color palette" });
    await user.click(palette.querySelectorAll("button")[1]!);
    expect(screen.queryByRole("dialog", { name: /color palette/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Classic emojis" }));
    await user.click(screen.getAllByRole("button", { name: /^Insert / })[0]!);
    expect(screen.queryByRole("dialog", { name: "Classic AIM smiley picker" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).not.toBe("");
  });
});
