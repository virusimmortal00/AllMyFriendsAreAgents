// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogFrame } from "./dialog-frame";

afterEach(() => cleanup());

describe("shared responsive layout structure", () => {
  it("owns stable property-sheet sizing without changing ordinary content dialogs", () => {
    const { rerender } = render(<DialogFrame title="Properties" layout="property-sheet" onClose={vi.fn()}><p>One page</p></DialogFrame>);
    expect(screen.getByRole("dialog").classList.contains("dialog-window--property-sheet")).toBe(true);
    rerender(<DialogFrame title="Properties" onClose={vi.fn()}><p>A utility form</p></DialogFrame>);
    expect(screen.getByRole("dialog").classList.contains("dialog-window--property-sheet")).toBe(false);
  });

  it("gives every modal one titlebar, one scrolling body, and one action region", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<DialogFrame title="Example settings" onClose={onClose} actions={<button type="button">Save</button>}><p>Content</p></DialogFrame>);

    const dialog = screen.getByRole("dialog", { name: "Example settings" });
    expect(dialog.classList.contains("dialog-window")).toBe(true);
    expect(container.querySelectorAll(".dialog-titlebar")).toHaveLength(1);
    expect(container.querySelectorAll(".dialog-body")).toHaveLength(1);
    expect(container.querySelectorAll(".dialog-actions")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Close Example settings" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("routes every full workspace through the same header and scroll-body contract", () => {
    for (const file of ["tasks.tsx", "contributions.tsx", "improvements.tsx", "continuations.tsx", "investigations.tsx", "diagnostics.tsx"]) {
      const source = readFileSync(resolve(process.cwd(), "src", file), "utf8");
      expect(source, file).toContain("workspace-view");
      expect(source, file).toContain("workspace-view__header");
      expect(source, file).toContain("workspace-view__body");
    }
  });

  it("keeps full modal workflows on DialogFrame instead of bespoke window markup", () => {
    for (const file of ["components.tsx", "human-avatar.tsx", "roster-manager.tsx", "github-integration-dialog.tsx", "room-configuration-dialog.tsx"]) {
      const source = readFileSync(resolve(process.cwd(), "src", file), "utf8");
      expect(source, file).toContain("<DialogFrame");
      expect(source, file).not.toContain('className="agent-settings-window');
    }
  });
});
