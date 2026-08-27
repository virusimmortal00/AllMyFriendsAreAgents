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

  it("renders implementation status as read-only server state with no mutation control", () => {
    render(<AgentSettingsDialog agent="codex-sol" available implementationCapability={{ eligible: true, available: false, unavailableReason: "governance-invalid" }} onClose={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("assignment governance is no longer current");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /write|grant|transfer/i })).toBeNull();
  });
});
