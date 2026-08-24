// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSettingsDialog, RoomControls } from "./components";

afterEach(() => cleanup());

describe("user-editable settings", () => {
  it("keeps room edits local until Save and restores the server values on Cancel", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RoomControls roomName="Original Room" topic="Original topic" conversationEnergy="balanced" disabled={false} onSave={onSave} />);
    const roomName = screen.getByRole("textbox", { name: "Room name" }) as HTMLInputElement;
    await user.clear(roomName);
    await user.type(roomName, "Edited Room");
    await user.tab();
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(roomName.value).toBe("Original Room");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("validates, disables duplicate submission, and preserves a failed room draft", async () => {
    const user = userEvent.setup();
    let rejectSave!: (error: Error) => void;
    const onSave = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    render(<RoomControls roomName="Original Room" topic="Original topic" conversationEnergy="balanced" disabled={false} onSave={onSave} />);
    const topic = screen.getByRole("textbox", { name: "Topic" }) as HTMLInputElement;
    await user.clear(topic);
    expect(screen.getByRole("alert").textContent).toContain("cannot be blank");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(topic, "A revised topic");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => rejectSave(new Error("Server rejected the change")));
    expect(screen.getByRole("alert").textContent).toContain("Server rejected the change");
    expect(topic.value).toBe("A revised topic");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the saved confirmation visible when the server values arrive", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    const view = render(<RoomControls roomName="Original Room" topic="Original topic" conversationEnergy="balanced" disabled={false} onSave={onSave} />);
    const roomName = screen.getByRole("textbox", { name: "Room name" });
    await user.clear(roomName);
    await user.type(roomName, "Saved Room");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    view.rerender(<RoomControls roomName="Saved Room" topic="Original topic" conversationEnergy="balanced" disabled={false} onSave={onSave} />);
    expect(screen.getByRole("status").textContent).toBe("Room settings saved.");
  });

  it("confirms a project permission grant and reports a save failure without duplicate submission", async () => {
    const user = userEvent.setup();
    let rejectSave!: (error: Error) => void;
    const onWritableChange = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
    render(<AgentSettingsDialog agent="codex-sol" available writableAgent="nobody" disabled={false} onWritableChange={onWritableChange} onClose={() => undefined} />);
    const permission = screen.getByRole("checkbox", { name: "Allow this agent to edit project files" }) as HTMLInputElement;
    await user.click(permission);
    const confirmation = screen.getByRole("alertdialog", { name: "Grant project write access?" });
    expect(confirmation.getAttribute("aria-describedby")).toBeTruthy();
    expect(confirmation.textContent).toContain("Codex [gpt-5.6 Sol]");
    expect(onWritableChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Grant write access" }));
    expect(onWritableChange).toHaveBeenCalledOnce();
    expect(onWritableChange).toHaveBeenCalledWith("codex-sol");
    expect(permission.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Saving permission…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => rejectSave(new Error("Permission update failed")));
    expect(permission.checked).toBe(false);
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Permission update failed"))).toBe(true);
  });

  it("cancels a write-access transfer, restores focus, and makes no request", async () => {
    const user = userEvent.setup();
    const onWritableChange = vi.fn(async () => undefined);
    render(<AgentSettingsDialog agent="cursor-grok" available writableAgent="codex-sol" disabled={false} onWritableChange={onWritableChange} onClose={() => undefined} />);
    const permission = screen.getByRole("checkbox", { name: "Allow this agent to edit project files" }) as HTMLInputElement;
    await user.click(permission);
    const dialog = screen.getByRole("alertdialog", { name: "Transfer project write access?" });
    expect(dialog.textContent).toContain("Codex [gpt-5.6 Sol]");
    expect(dialog.textContent).toContain("Cursor [Grok 4.6]");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onWritableChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(permission);
  });
});
