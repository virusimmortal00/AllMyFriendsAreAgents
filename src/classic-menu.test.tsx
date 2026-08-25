// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicMenuBar, type ClassicMenuDefinition } from "./classic-menu";

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
});
