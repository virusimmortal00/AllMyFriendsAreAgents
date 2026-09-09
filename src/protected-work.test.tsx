// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtectedWorkControls, ProtectedWorkForm, ProtectedWorkStatus } from "./protected-work";
import { protectedWorkAction, startProtectedWork } from "./api";
import type { ProtectedWorkView } from "../shared/protected-work";
vi.mock("./api", () => ({ protectedWorkAction: vi.fn(), startProtectedWork: vi.fn(), loadProtectedWork: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
const work: ProtectedWorkView = { workId: "work", roomId: "room", owner: "codex-sol", objective: "Review evidence", phase: "queued", createdAt: "2026-09-08T10:00:00.000Z", startedAt: null, stoppedAt: null, updatedAt: "2026-09-08T10:00:00.000Z", blocker: null, disposition: null };
describe("protected work controls", () => {
  it("does not count queued time as execution time and shows live execution elapsed", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T10:02:00.000Z"));
    const view = render(<ProtectedWorkStatus work={work} />); expect(screen.getByText(/waiting to start/)).toBeTruthy();
    view.rerender(<ProtectedWorkStatus work={{ ...work, phase: "busy", startedAt: "2026-09-08T10:01:00.000Z" }} />);
    expect(screen.getByText(/1:00 elapsed/)).toBeTruthy();
  });
  it("keeps an ambiguous start retry on the same request identity", async () => {
    vi.mocked(startProtectedWork).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValue({});
    render(<ProtectedWorkForm agents={[{ agentId: "codex-sol", conversationalName: "Sol" }]} enabled onChanged={async () => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Objective" }), { target: { value: "Review evidence" } });
    fireEvent.click(screen.getByRole("button", { name: "Start protected work" }));
    await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "Start protected work" }));
    await waitFor(() => expect(startProtectedWork).toHaveBeenCalledTimes(2));
    expect(vi.mocked(startProtectedWork).mock.calls[0][0].requestId).toBe(vi.mocked(startProtectedWork).mock.calls[1][0].requestId);
  });
  it("separates stop requested from confirmation and offers explicit recovery after termination", async () => {
    const changed = vi.fn(async () => {}); vi.mocked(protectedWorkAction).mockResolvedValue({});
    const view = render(<ProtectedWorkControls work={work} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop and return to chat" }));
    await waitFor(() => expect(protectedWorkAction).toHaveBeenCalledWith("work", "stop"));
    view.rerender(<ProtectedWorkControls work={{ ...work, phase: "stopping" }} onChanged={changed} />);
    expect((screen.getByRole("button", { name: "Stop requested…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Return without an update" })).toBeNull();
    view.rerender(<ProtectedWorkControls work={{ ...work, phase: "blocked", stoppedAt: work.createdAt }} onChanged={changed} />);
    expect(screen.getByRole("button", { name: "Retry catch-up" })).toBeTruthy();
  });
});
