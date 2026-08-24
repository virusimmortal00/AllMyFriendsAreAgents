import { describe, expect, it } from "vitest";
import { applyTaskChange, createTask, forkTask, TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH, type TaskActor } from "./task-domain.js";

const owner: TaskActor = { id: "owner" };
const now = "2026-08-21T12:00:00.000Z";

describe("canonical task domain", () => {
  it("bounds content and rejects stale or unauthorized changes without mutation", () => {
    expect(() => createTask({ roomId: "room", taskId: "task", title: "x".repeat(TASK_TITLE_MAX_LENGTH + 1), actor: owner, now })).toThrow();
    expect(() => createTask({ roomId: "room", taskId: "task", title: "ok", description: "x".repeat(TASK_DESCRIPTION_MAX_LENGTH + 1), actor: owner, now })).toThrow();
    const task = createTask({ roomId: "room", taskId: "task", title: "Canonical", actor: owner, now });
    expect(applyTaskChange(task, 0, { kind: "set_title", title: "stale" }, owner, now)).toEqual({ kind: "conflict", expectedRevision: 0, actualRevision: 1 });
    expect(task).toMatchObject({ revision: 1, title: "Canonical", attribution: [{ action: "create" }] });
    expect(applyTaskChange(task, 1, { kind: "set_title", title: "denied" }, { id: "stranger" }, now)).toMatchObject({ kind: "rejected" });
  });

  it("requires evidence and dispositions, then reopens and forks only explicitly", () => {
    let task = createTask({ roomId: "room", taskId: "task", title: "Lifecycle", actor: owner, now });
    const apply = (change: Parameters<typeof applyTaskChange>[2]) => {
      const result = applyTaskChange(task, task.revision, change, owner, now);
      expect(result.kind).toBe("accepted");
      if (result.kind === "accepted") task = result.task;
    };
    apply({ kind: "append_reference", reference: { id: "assignment-1", kind: "assignment", targetId: "assignment-1", completionState: "unfinished" } });
    apply({ kind: "transition", to: "proposed" });
    apply({ kind: "transition", to: "approved" });
    apply({ kind: "transition", to: "active" });
    expect(applyTaskChange(task, task.revision, { kind: "transition", to: "completed" }, owner, now)).toMatchObject({ kind: "rejected" });
    apply({ kind: "append_reference", reference: { id: "evidence-1", kind: "evidence", targetId: "sha256:result", contentHash: "sha256:result" } });
    apply({ kind: "append_reference", reference: { id: "disposition-1", kind: "disposition", targetId: "deferred", dispositionFor: "assignment-1" } });
    apply({ kind: "transition", to: "completed" });
    expect(applyTaskChange(task, task.revision, { kind: "transition", to: "active" }, owner, now)).toMatchObject({ kind: "rejected" });
    apply({ kind: "reopen", to: "draft" });
    expect(task.lifecycleHistory.at(-1)).toMatchObject({ from: "completed", to: "draft", operation: "reopen" });
    // Forking a reopened task is forbidden; terminality is explicit rather than inferred from old history.
    expect(forkTask(task, task.revision, { taskId: "fork", actor: owner, now })).toMatchObject({ kind: "rejected" });
  });
});
