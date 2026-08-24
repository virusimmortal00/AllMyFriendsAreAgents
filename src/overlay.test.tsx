// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { AgentSettingsDialog, HelpDialog } from "./components";
import { useDismissibleLayer, useModalOverlay } from "./overlay";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

function AgentSettingsFlow() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open agent settings</button>
    {open ? <AgentSettingsDialog
      agent="codex-sol"
      available
      writableAgent="nobody"
      disabled={false}
      onWritableChange={() => undefined}
      onClose={() => setOpen(false)}
    /> : null}
  </>;
}

function DismissibleMenuFlow() {
  const [open, setOpen] = useState(false);
  const { layerRef, triggerRef } = useDismissibleLayer(open, () => setOpen(false));
  return <>
    <div ref={layerRef}>
      <button ref={triggerRef} type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>Actions</button>
      {open ? <div role="menu"><button type="button" role="menuitem">Continue</button></div> : null}
    </div>
    <button type="button">Outside</button>
  </>;
}

function HelpFlow() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>Help</button>{open ? <HelpDialog onClose={() => setOpen(false)} /> : null}</>;
}

function StackedOverlayFlow() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { dialogRef, onDialogKeyDown } = useModalOverlay(() => setPanelOpen(false), null, panelOpen);
  return <>
    <button type="button" onClick={() => setPanelOpen(true)}>People</button>
    {panelOpen ? <aside ref={dialogRef} role="dialog" aria-modal="true" aria-label="People panel" tabIndex={-1} onKeyDown={onDialogKeyDown}>
      <button type="button" onClick={() => setSettingsOpen(true)}>Configure agent</button>
      <button type="button" onClick={() => setPanelOpen(false)}>Close panel</button>
    </aside> : null}
    {settingsOpen ? <AgentSettingsDialog agent="codex-sol" available writableAgent="nobody" disabled={false} onWritableChange={() => undefined} onClose={() => setSettingsOpen(false)} /> : null}
  </>;
}

describe("overlay foundation", () => {
  it("focuses, traps, closes, restores focus, and unlocks scrolling for modal dialogs", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsFlow />);
    const trigger = screen.getByRole("button", { name: "Open agent settings" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Agent Settings" });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(document.body.style.overflow).toBe("hidden");

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close agent settings" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.body.style.overflow).toBe("");
  });

  it("closes a modal only when the backdrop itself is pressed", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsFlow />);
    await user.click(screen.getByRole("button", { name: "Open agent settings" }));
    const dialog = screen.getByRole("dialog", { name: "Agent Settings" });
    fireEvent.mouseDown(dialog);
    expect(screen.getByRole("dialog")).toBe(dialog);
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses popovers from outside press and Escape and restores the trigger", async () => {
    const user = userEvent.setup();
    render(<DismissibleMenuFlow />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("provides a real Help dialog with visible and keyboard close paths", async () => {
    const user = userEvent.setup();
    render(<HelpFlow />);
    const trigger = screen.getByRole("button", { name: "Help" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Help" })).toBeTruthy();
    expect(screen.getByText("Getting around")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes only the topmost stacked overlay and preserves the remaining scroll lock", async () => {
    const user = userEvent.setup();
    render(<StackedOverlayFlow />);
    await user.click(screen.getByRole("button", { name: "People" }));
    await user.click(screen.getByRole("button", { name: "Configure agent" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Agent Settings" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "People panel" })).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });
});
