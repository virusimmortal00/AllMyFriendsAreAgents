// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useRef, useState } from "react";
import { Transcript, WorkshopDialog } from "./components";

afterEach(() => cleanup());

function WorkshopFlow() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return <>
    <Transcript
      messages={[{ id: "ref", speaker: "you", text: "See [[improvement:imp-7]].", timestamp: "2026-08-21T12:00:00Z" }]}
      magnification={100}
      transcriptRef={createRef<HTMLDivElement>()}
      onOpenImprovement={(_id, element) => { trigger.current = element; setOpen(true); }}
    />
    {open ? <WorkshopDialog data={null} loading={false} missing returnFocusTo={trigger.current} onClose={() => setOpen(false)} /> : null}
  </>;
}

describe("rendered workshop interaction behavior", () => {
  it("opens from a transcript reference, moves focus into the dialog, and restores it after Escape", async () => {
    const user = userEvent.setup();
    render(<WorkshopFlow />);
    const reference = screen.getByRole("button", { name: "Open Improvement imp-7" });
    await user.click(reference);
    const dialog = screen.getByRole("dialog", { name: "Improvement workshop" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close improvement workshop" })));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(reference));
  });

  it("traps Tab and Shift+Tab in the rendered dialog and closes from the visible control", async () => {
    const user = userEvent.setup();
    render(<WorkshopFlow />);
    const reference = screen.getByRole("button", { name: "Open Improvement imp-7" });
    await user.click(reference);
    const dismiss = screen.getByRole("button", { name: "Close improvement workshop" });
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    await user.tab();
    expect(document.activeElement).toBe(dismiss);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
    await user.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(reference));
  });

  it("renders explicit desktop-dialog and mobile-sheet presentations", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    const desktop = render(<WorkshopDialog data={null} loading={false} missing onClose={() => undefined} />);
    expect(screen.getByRole("dialog").getAttribute("data-presentation")).toBe("desktop-dialog");
    desktop.unmount();
    window.innerWidth = 390;
    render(<WorkshopDialog data={null} loading={false} missing onClose={() => undefined} />);
    expect(screen.getByRole("dialog").getAttribute("data-presentation")).toBe("mobile-sheet");
  });

  it("keeps the rendered workshop read-only", () => {
    render(<WorkshopDialog data={null} loading={false} missing onClose={() => undefined} />);
    expect(screen.queryByRole("button", { name: /approve|claim|dispatch|stop|transition/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
