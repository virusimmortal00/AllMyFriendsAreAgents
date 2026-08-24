// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { DEFAULT_PARTICIPANT_STYLES, type ChatStyle } from "../shared/chat-style";
import { ChatComposer } from "./components";

afterEach(() => cleanup());

function FormattingFlow() {
  const [draft, setDraft] = useState("");
  const [style, setStyle] = useState<ChatStyle>({ ...DEFAULT_PARTICIPANT_STYLES.you });
  return <>
    <ChatComposer draft={draft} style={style} onDraftChange={setDraft} onStyleChange={setStyle} onSubmit={(event) => event.preventDefault()} />
    <button type="button">Outside composer</button>
  </>;
}

describe("composer formatting popovers", () => {
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
