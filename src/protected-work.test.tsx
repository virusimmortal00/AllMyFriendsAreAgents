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
    const [firstStart, secondStart] = vi.mocked(startProtectedWork).mock.calls;
    if (!firstStart || !secondStart) throw new Error("Expected both protected-work start attempts.");
    expect(firstStart[0].requestId).toBe(secondStart[0].requestId);
  });
  it("reuses an action identity after a lost response and renews it only after success", async () => {
    vi.mocked(protectedWorkAction).mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({});
    render(<ProtectedWorkControls work={{ ...work, phase: "blocked", stoppedAt: work.createdAt }} onChanged={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry catch-up" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry catch-up" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect((screen.getByRole("button", { name: "Retry catch-up" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Retry catch-up" }));
    await waitFor(() => expect(protectedWorkAction).toHaveBeenCalledTimes(3));
    const [firstAction, secondAction, thirdAction] = vi.mocked(protectedWorkAction).mock.calls;
    if (!firstAction || !secondAction || !thirdAction) throw new Error("Expected all protected-work action attempts.");
    expect(firstAction[2]).toBe(secondAction[2]); expect(thirdAction[2]).not.toBe(secondAction[2]);
  });
  it("separates stop requested from confirmation and offers explicit recovery after termination", async () => {
    const changed = vi.fn(async () => {}); vi.mocked(protectedWorkAction).mockResolvedValue({});
    const view = render(<ProtectedWorkControls work={work} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop and return to chat" }));
    await waitFor(() => expect(protectedWorkAction).toHaveBeenCalledWith("work", "stop", expect.any(String)));
    view.rerender(<ProtectedWorkControls work={{ ...work, phase: "stopping" }} onChanged={changed} />);
    expect((screen.getByRole("button", { name: "Stop requested…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Return without an update" })).toBeNull();
    view.rerender(<ProtectedWorkControls work={{ ...work, phase: "blocked", stoppedAt: work.createdAt }} onChanged={changed} />);
    expect(screen.getByRole("button", { name: "Retry catch-up" })).toBeTruthy();
  });
});
