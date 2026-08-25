// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tasks, TasksMenuControl } from "./tasks";
import { ApiRequestError, createRoomTask, loadTask, loadTasks, sendContinuationWorkRequest, taskAction, updateRoomTask } from "./api";

const task = { roomId: "room", taskId: "task-1", title: "Ship task workflow", description: "Complete API and UI", state: "active" as const, participants: [{ participantId: "human-1", role: "owner" as const, addedAt: "2026-08-21T12:00:00Z", addedBy: "human-1" }], dependencies: [], blockers: [], references: [], forkedFrom: null, revision: 4, createdAt: "2026-08-21T12:00:00Z", updatedAt: "2026-08-21T12:10:00Z", attribution: [], lifecycleHistory: [] };
const detail = { task, relationships: { dependencies: [], blockers: [], dependents: [] }, history: [{ revision: 1, actorId: "human-1", at: "2026-08-21T12:00:00Z", change: "create" }] };

vi.mock("./api", async (original) => {
  const actual = await original<typeof import("./api")>();
  return { ...actual, loadTasks: vi.fn(async () => ({ items: [task], nextCursor: null })), loadTask: vi.fn(async () => detail), createRoomTask: vi.fn(async (title: string, description: string) => ({ ...task, taskId: "task-2", title, description, revision: 1, state: "draft" })), taskAction: vi.fn(async () => task), updateRoomTask: vi.fn(async () => task), sendContinuationWorkRequest: vi.fn(async () => ({ accepted: true, duplicate: false, clientMessageId: "message-1", messageId: "room-message-1", continuation: { outcome: "queued", jobId: "job-1", status: "QUEUED" } })) };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("room task interface", () => {
  it("is discoverable and creates a task with keyboard-operable labeled fields", async () => {
    const user = userEvent.setup(); const onOpen = vi.fn();
    render(<TasksMenuControl active={false} onOpen={onOpen} />);
    await user.click(screen.getByRole("button", { name: "Tasks" })); expect(onOpen).toHaveBeenCalledOnce(); cleanup();
    render(<Tasks />);
    await screen.findByRole("button", { name: /Ship task workflow/ });
    await user.type(screen.getByLabelText("Title"), "New durable task");
    await user.type(screen.getByLabelText("Description"), "Visible on mobile");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(createRoomTask).toHaveBeenCalledWith("New durable task", "Visible on mobile"));
  });

  it("shows lifecycle, relationships, references, evidence, and append-only history controls", async () => {
    const user = userEvent.setup(); render(<Tasks />);
    await user.click(await screen.findByRole("button", { name: /Ship task workflow/ }));
    expect(await screen.findByText("Append-only history")).toBeTruthy();
    expect(screen.getByText("Participants")).toBeTruthy(); expect(screen.getByText("Dependencies & blockers")).toBeTruthy();
    expect(screen.getByText("Assignment links")).toBeTruthy(); expect(screen.getByText("Immutable references")).toBeTruthy();
    await user.type(screen.getByLabelText("Completion evidence ID or hash"), "sha256:result");
    await user.click(screen.getByRole("button", { name: "complete" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith("task-1", "complete", expect.objectContaining({ expectedRevision: 4, evidence: { targetId: "sha256:result", contentHash: "sha256:result" } })));
    expect(loadTask).toHaveBeenCalled(); expect(loadTasks).toHaveBeenCalled();
  });

  it("loads a concurrent revision without discarding typed edits", async () => {
    const user = userEvent.setup(); vi.mocked(updateRoomTask).mockRejectedValueOnce(new ApiRequestError("Task changed", false, 409));
    render(<Tasks />); await user.click(await screen.findByRole("button", { name: /Ship task workflow/ }));
    const title = await screen.findByLabelText("Title"); await user.clear(title); await user.type(title, "My unsaved title");
    await user.click(screen.getByRole("button", { name: "Save title" }));
    await screen.findByText(/typed value remains/);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("My unsaved title");
  });

  it("starts a governed continuation from an exact assignment reference", async () => {
    const user = userEvent.setup(); const linked = { ...detail, task: { ...task, references: [{ id: "assignment-ref", kind: "assignment" as const, targetId: "assignment-1", completionState: "unfinished" as const, addedAt: task.updatedAt, addedBy: "human-1" }] } };
    vi.mocked(loadTask).mockResolvedValue(linked); render(<Tasks />); await user.click(await screen.findByRole("button", { name: /Ship task workflow/ }));
    await user.type(await screen.findByLabelText("Continuation objective for assignment-1"), "Run the remaining checks");
    await user.click(screen.getByRole("button", { name: "Start continuation" }));
    await waitFor(() => expect(sendContinuationWorkRequest).toHaveBeenCalledWith(linked.task, "assignment-ref", "Run the remaining checks"));
    expect(await screen.findByText("Continuation queued: job-1")).toBeTruthy();
  });

  it("keeps each dirty editor pinned to its loaded revision while polling newer task state", async () => {
    const user = userEvent.setup(); const view = render(<Tasks refreshKey={0} />);
    await user.click(await screen.findByRole("button", { name: /Ship task workflow/ }));
    const title = await screen.findByLabelText("Title"); await user.clear(title); await user.type(title, "My locally edited title");
    const newer = { ...detail, task: { ...task, revision: 5, title: "Remote title", description: "Remote description" } };
    vi.mocked(loadTask).mockResolvedValue(newer);
    view.rerender(<Tasks refreshKey={1} />);
    await screen.findByText("Revision 5");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("My locally edited title");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Remote description");
    await user.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() => expect(updateRoomTask).toHaveBeenCalledWith("task-1", 4, "title", "My locally edited title"));
  });
});
