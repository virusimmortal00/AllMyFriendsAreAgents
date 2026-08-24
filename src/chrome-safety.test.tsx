// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingScreen, NameEntry } from "./App";
import { ConfirmationDialog } from "./components";

afterEach(() => cleanup());

describe("intentional title-bar presentation", () => {
  it.each([
    ["loading", <LoadingScreen />],
    ["join", <NameEntry onJoin={() => undefined} />],
  ])("renders %s window glyphs as hidden, non-button decoration", (_view, ui) => {
    const { container } = render(ui);
    const chrome = container.querySelector(".window-buttons--decorative");
    expect(chrome?.getAttribute("aria-hidden")).toBe("true");
    expect(chrome?.querySelectorAll("span")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /minimize|maximize|close/i })).toBeNull();
  });
});

describe("consequential-action confirmation", () => {
  it("has an accessible description, traps focus, cancels with Escape, and restores its trigger", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const view = render(<ConfirmationDialog
      title="Confirm consequence?"
      description={<p>This action changes durable state.</p>}
      confirmLabel="Confirm action"
      returnFocusTo={trigger}
      onConfirm={() => undefined}
      onCancel={onCancel}
    />);
    const dialog = screen.getByRole("alertdialog", { name: "Confirm consequence?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm action" }));
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("disables cancellation and submission while busy", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmationDialog
      title="Busy consequence"
      description={<p>Please wait.</p>}
      confirmLabel="Confirm"
      busyLabel="Saving…"
      busy
      returnFocusTo={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
