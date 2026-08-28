// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineViewMenu, defineWindowMenu, presentationCommand, workspaceCommand } from "./application-menu-policy";
import { WORKSPACE_NAMES, WorkspaceSurface } from "./workspace-surface";

afterEach(() => cleanup());

const command = { label: "Example", accessKey: "E", onSelect: () => {} };

describe("non-negotiable UI standards", () => {
  it("fails closed when workspace navigation is placed in View", () => {
    expect(() => defineViewMenu([workspaceCommand(command) as never])).toThrow(/View cannot contain workspace command/);
  });

  it("fails closed when presentation controls are placed in Window", () => {
    expect(() => defineWindowMenu([presentationCommand(command) as never])).toThrow(/Window cannot contain presentation command/);
  });

  it.each(WORKSPACE_NAMES)("gives the %s workspace a visible route back to Chat", async (name) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WorkspaceSurface name={name} onClose={onClose}><div>Workspace content</div></WorkspaceSurface>);

    await user.click(screen.getByRole("button", { name: `Close ${name} and return to Chat` }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
