// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicMenuBar, type ClassicMenuDefinition } from "./classic-menu";
import { DialogFrame } from "./dialog-frame";

afterEach(() => cleanup());

function menus(onSelect = vi.fn()): ClassicMenuDefinition[] {
  return [
    { id: "room", label: "Room", accessKey: "R", items: [
      { label: "Room properties...", accessKey: "P", onSelect },
      { type: "separator" },
      { label: "Unavailable", accessKey: "U", disabled: true, onSelect },
    ] },
    { id: "view", label: "View", accessKey: "V", items: [
      { label: "Timestamps", accessKey: "T", checked: true, checkType: "checkbox", onSelect },
      { label: "Chat", accessKey: "C", checked: true, onSelect },
      { label: "Tasks", accessKey: "T", checked: false, onSelect },
    ] },
    { id: "window", label: "Window", accessKey: "W", disabled: true, items: [
      { label: "Chat", accessKey: "C", onSelect },
    ] },
    { id: "help", label: "Help", accessKey: "H", items: [
      { label: "Help topics", accessKey: "H", onSelect },
    ] },
  ];
}

describe("Windows-style application menu", () => {
  it("supports F10, arrow traversal, activation, and focus return", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<><ClassicMenuBar menus={menus(onSelect)} /><div data-primary-workspace tabIndex={-1} /></>);

    await user.keyboard("{F10}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Room" }));
    await user.keyboard("{ArrowRight}{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitemcheckbox", { name: "Timestamps" }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect.mock.calls[0][0]).toBe(screen.getByRole("menuitem", { name: "View" }));
    expect(screen.queryByRole("menu", { name: "View" })).toBeNull();
  });

  it("opens from an Alt mnemonic, skips disabled commands, and closes one level with Escape", async () => {
    const user = userEvent.setup();
    render(<ClassicMenuBar menus={menus()} />);

    await user.keyboard("{Alt>}r{/Alt}");
    const roomMenu = screen.getByRole("menu", { name: "Room" });
    expect(document.activeElement).toBe(within(roomMenu).getByRole("menuitem", { name: "Room properties..." }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(roomMenu).getByRole("menuitem", { name: "Room properties..." }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Room" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Room" }));
  });

  it("restores the menu title after an ordinary command", async () => {
    const user = userEvent.setup();
    render(<ClassicMenuBar menus={menus()} />);

    const viewTitle = screen.getByRole("menuitem", { name: "View" });
    await user.click(viewTitle);
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Timestamps" }));

    expect(document.activeElement).toBe(viewTitle);
  });

  it("grays out a disabled top-level category and skips it during keyboard traversal", async () => {
    const user = userEvent.setup();
    render(<ClassicMenuBar menus={menus()} />);
    const windowTitle = screen.getByRole("menuitem", { name: "Window" });
    expect((windowTitle as HTMLButtonElement).disabled).toBe(true);

    const viewTitle = screen.getByRole("menuitem", { name: "View" });
    viewTitle.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Help" }));

    await user.keyboard("{Alt>}w{/Alt}");
    expect(screen.queryByRole("menu", { name: "Window" })).toBeNull();
  });

  it("leaves application shortcuts to the active modal", async () => {
    const user = userEvent.setup();
    const onHelp = vi.fn();
    render(<>
      <ClassicMenuBar menus={menus()} onHelp={onHelp} />
      <section role="dialog" aria-modal="true" aria-label="Open dialog"><button type="button">Inside dialog</button></section>
    </>);
    const insideDialog = screen.getByRole("button", { name: "Inside dialog" });
    insideDialog.focus();

    await user.keyboard("{F10}{F1}{Alt>}v{/Alt}");

    expect(document.activeElement).toBe(insideDialog);
    expect(onHelp).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "View" })).toBeNull();
  });

  it("restores application shortcuts while a mounted dialog is inactive", async () => {
    const user = userEvent.setup();
    const onHelp = vi.fn();
    const content = (active: boolean) => <>
      <ClassicMenuBar menus={menus()} onHelp={onHelp} />
      <DialogFrame title="Room Properties" active={active} onClose={() => undefined}>
        <input aria-label="Retained draft" defaultValue="Unsaved changes" />
      </DialogFrame>
    </>;
    const view = render(content(true));
    const draft = screen.getByRole("textbox", { name: "Retained draft" });
    view.rerender(content(false));
    await user.keyboard("{F10}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Room" }));
    await user.keyboard("{Escape}{Alt>}v{/Alt}");
    expect(screen.getByRole("menu", { name: "View" })).toBeTruthy();
    await user.keyboard("{Escape}{F1}");
    expect(onHelp).toHaveBeenCalledOnce();
    view.rerender(content(true));
    expect(screen.getByRole("textbox", { name: "Retained draft" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("Unsaved changes");
    await user.keyboard("{F10}{F1}{Alt>}v{/Alt}");
    expect(onHelp).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "View" })).toBeNull();
  });
});
