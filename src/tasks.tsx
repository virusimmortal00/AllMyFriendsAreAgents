import { useEffect, useMemo, useRef, useState } from "react";
import type { Task, TaskParticipantRole, TaskReferenceKind } from "../shared/task-domain";
import { ApiRequestError, createRoomTask, loadTask, loadTasks, taskAction, updateRoomTask, type TaskDetailResponse } from "./api";

export function TasksMenuControl({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  return <button type="button" aria-current={active ? "page" : undefined} onClick={onOpen}>Tasks</button>;
}

function TaskList({ items, onOpen }: { items: readonly Task[]; onOpen: (id: string) => void }) {
  return items.length ? <ul className="task-list">{items.map((task) => <li key={task.taskId}>
    <button type="button" onClick={() => onOpen(task.taskId)}><strong>{task.title}</strong><span>{task.state} · revision {task.revision}</span><small>{task.participants.length} participants · {task.dependencies.length} dependencies · updated {new Date(task.updatedAt).toLocaleString()}</small></button>
  </li>)}</ul> : <div className="task-empty"><strong>No tasks yet.</strong><span>Create the room's first durable task above.</span></div>;
}

function Lines({ values, empty }: { values: readonly string[]; empty: string }) {
  return values.length ? <ul>{values.map((value, index) => <li key={`${value}:${index}`}>{value}</li>)}</ul> : <p className="task-muted">{empty}</p>;
}

export function Tasks({ refreshKey = 0 }: { refreshKey?: number }) {
  const [items, setItems] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTitleRevision, setEditTitleRevision] = useState(0);
  const [editDescriptionRevision, setEditDescriptionRevision] = useState(0);
  const titleDirty = useRef(false);
  const descriptionDirty = useRef(false);

  const refreshList = async () => { const page = await loadTasks(); setItems(page.items); };
  const applyDetail = (next: TaskDetailResponse, resetEditors = false) => {
    setDetail(next);
    if (resetEditors || !titleDirty.current) { setEditTitle(next.task.title); setEditTitleRevision(next.task.revision); titleDirty.current = false; }
    if (resetEditors || !descriptionDirty.current) { setEditDescription(next.task.description); setEditDescriptionRevision(next.task.revision); descriptionDirty.current = false; }
  };
  const refreshDetail = async (id = selected, resetEditors = false) => { if (!id) return; applyDetail(await loadTask(id), resetEditors); };
  useEffect(() => { let cancelled = false; setLoading(true); void loadTasks().then((page) => { if (!cancelled) setItems(page.items); }).catch((reason) => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [refreshKey]);
  useEffect(() => { if (!selected) { setDetail(null); return; } let cancelled = false; titleDirty.current = false; descriptionDirty.current = false; setLoading(true); void loadTask(selected).then((next) => { if (!cancelled) applyDetail(next, true); }).catch((reason) => { if (!cancelled) { setDetail(null); setError(reason instanceof ApiRequestError && reason.status === 404 ? "That task no longer exists." : reason.message); } }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [selected]);
  useEffect(() => { if (!selected) return; void loadTask(selected).then((next) => applyDetail(next)).catch(() => undefined); }, [refreshKey, selected]);
  useEffect(() => { const timer = window.setInterval(() => { void refreshList(); if (selected) void loadTask(selected).then((next) => applyDetail(next)).catch(() => undefined); }, 5_000); return () => window.clearInterval(timer); }, [selected]);

  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!createTitle.trim()) return; setBusy(true); setError("");
    try { const task = await createRoomTask(createTitle, createDescription); setCreateTitle(""); setCreateDescription(""); await refreshList(); setSelected(task.taskId); setNotice("Task created."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }

  async function mutate(action: string, body: Record<string, unknown> = {}) {
    if (!detail) return; setBusy(true); setError(""); setNotice("");
    try { await taskAction(detail.task.taskId, action, { expectedRevision: detail.task.revision, ...body }); await Promise.all([refreshDetail(detail.task.taskId), refreshList()]); setNotice("Task updated."); }
    catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 409) { await refreshDetail(detail.task.taskId); setNotice("This task changed elsewhere. The latest revision is shown; your form input was kept."); }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  async function saveField(field: "title" | "description") {
    if (!detail) return; const submitted = field === "title" ? editTitle : editDescription; const editorRevision = field === "title" ? editTitleRevision : editDescriptionRevision; setBusy(true); setError("");
    try { await updateRoomTask(detail.task.taskId, editorRevision, field, submitted); await Promise.all([refreshDetail(detail.task.taskId, true), refreshList()]); setNotice("Task text saved."); }
    catch (reason) { if (reason instanceof ApiRequestError && reason.status === 409) { const latest = await loadTask(detail.task.taskId); applyDetail(latest); if (field === "title") { setEditTitle(submitted); setEditTitleRevision(latest.task.revision); titleDirty.current = true; } else { setEditDescription(submitted); setEditDescriptionRevision(latest.task.revision); descriptionDirty.current = true; } setNotice("A newer revision was loaded. Your typed value remains in the editor; review and save again."); } setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <section className="tasks-panel beveled-inset" aria-label="Room tasks">
    <header className="tasks-header"><h2>Room tasks</h2>{selected ? <button type="button" className="classic-button" onClick={() => setSelected(null)}>Back to list</button> : null}</header>
    {notice ? <div className="task-notice" role="status">{notice}</div> : null}{error ? <div className="task-error" role="alert">{error}</div> : null}
    <div className="tasks-body">
      {loading && !detail ? <p role="status">Loading tasks…</p> : !selected ? <>
        <form className="task-create" onSubmit={create}><h3>Create task</h3><label>Title<input required maxLength={160} value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} /></label><label>Description<textarea maxLength={8000} value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} /></label><button className="classic-button" disabled={busy || !createTitle.trim()}>Create task</button></form>
        <TaskList items={items} onOpen={setSelected} />
      </> : detail ? <TaskDetail detail={detail} busy={busy} editTitle={editTitle} editDescription={editDescription} setEditTitle={(value) => { titleDirty.current = true; setEditTitle(value); }} setEditDescription={(value) => { descriptionDirty.current = true; setEditDescription(value); }} saveField={saveField} mutate={mutate} /> : <div className="task-empty"><strong>Task unavailable.</strong><button type="button" className="classic-button" onClick={() => setSelected(null)}>Return to task list</button></div>}
    </div>
  </section>;
}

function TaskDetail({ detail, busy, editTitle, editDescription, setEditTitle, setEditDescription, saveField, mutate }: {
  detail: TaskDetailResponse; busy: boolean; editTitle: string; editDescription: string; setEditTitle: (value: string) => void; setEditDescription: (value: string) => void; saveField: (field: "title" | "description") => void; mutate: (action: string, body?: Record<string, unknown>) => void;
}) {
  const task = detail.task;
  const [participantId, setParticipantId] = useState(""); const [role, setRole] = useState<TaskParticipantRole>("assignee");
  const [linkedTaskId, setLinkedTaskId] = useState(""); const [relation, setRelation] = useState<"dependency" | "blocker">("dependency");
  const [referenceTarget, setReferenceTarget] = useState(""); const [referenceKind, setReferenceKind] = useState<TaskReferenceKind>("message");
  const [assignmentId, setAssignmentId] = useState(""); const [evidence, setEvidence] = useState("");
  const [dispositions, setDispositions] = useState<Record<string, string>>({});
  const unfinished = task.references.filter((item) => (item.kind === "assignment" || item.completionState === "unfinished") && !task.references.some((candidate) => candidate.kind === "disposition" && candidate.dispositionFor === item.id));
  const can = useMemo(() => ({ propose: task.state === "draft", approve: task.state === "proposed", start: task.state === "approved", block: task.state === "active", unblock: task.state === "blocked", complete: task.state === "active" || task.state === "blocked", abandon: ["draft", "proposed", "approved", "active", "blocked"].includes(task.state), archive: task.state === "completed" || task.state === "abandoned", reopen: ["completed", "abandoned", "archived"].includes(task.state), fork: ["completed", "abandoned", "archived"].includes(task.state) }), [task.state]);
  return <article className="task-detail" aria-labelledby="task-title">
    <div className="task-state-line"><span className={`task-state task-state--${task.state}`}>{task.state}</span><span>Revision {task.revision}</span><span>Updated {new Date(task.updatedAt).toLocaleString()}</span></div>
    <section className="task-edit"><label htmlFor="task-edit-title">Title</label><div><input id="task-edit-title" maxLength={160} value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /><button className="classic-button" disabled={busy || !editTitle.trim()} onClick={() => saveField("title")}>Save title</button></div><label htmlFor="task-edit-description">Description</label><textarea id="task-edit-description" maxLength={8000} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} /><button className="classic-button" disabled={busy} onClick={() => saveField("description")}>Save description</button></section>
    <section className="task-actions" aria-label="Task lifecycle actions">{Object.entries(can).map(([action, enabled]) => <button key={action} type="button" className="classic-button" disabled={busy || !enabled || (action === "complete" && (!evidence.trim() || unfinished.some((item) => !dispositions[item.id]?.trim())))} onClick={() => action === "complete" ? mutate("complete", { evidence: { targetId: evidence.trim(), contentHash: evidence.trim() }, dispositions: unfinished.map((item) => ({ dispositionFor: item.id, targetId: dispositions[item.id] })) }) : mutate(action, action === "fork" ? { title: `${task.title} (follow-up)` } : {})}>{action}</button>)}</section>
    {can.complete ? <label className="task-evidence">Completion evidence ID or hash<input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="sha256:… or result ID" /></label> : null}
    {can.complete && unfinished.length ? <section><h3>Required dispositions</h3>{unfinished.map((item) => <label className="task-evidence" key={item.id}>Disposition for {item.targetId}<input value={dispositions[item.id] || ""} onChange={(event) => setDispositions((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Completed elsewhere, deferred, or superseded by…" /></label>)}</section> : null}
    <div className="task-columns">
      <section><h3>Participants</h3><Lines values={task.participants.map((item) => `${item.participantId} — ${item.role}`)} empty="No participants." /><form onSubmit={(event) => { event.preventDefault(); if (participantId) mutate("participants", { participantId, role }); }}><input aria-label="Participant ID" value={participantId} onChange={(event) => setParticipantId(event.target.value)} placeholder="Current room participant ID" /><select aria-label="Participant role" value={role} onChange={(event) => setRole(event.target.value as TaskParticipantRole)}>{["owner", "coordinator", "assignee", "reviewer", "observer"].map((value) => <option key={value}>{value}</option>)}</select><button className="classic-button" disabled={busy}>Add</button></form>{task.participants.map((item) => <button key={`${item.participantId}:${item.role}`} className="task-link-button" disabled={busy || item.role === "owner"} onClick={() => mutate("participants", { operation: "remove", participantId: item.participantId, role: item.role })}>Remove {item.participantId} ({item.role})</button>)}</section>
      <section><h3>Dependencies & blockers</h3><Lines values={[...task.dependencies.map((item) => `Depends on ${item.taskId}`), ...task.blockers.map((item) => `Blocked by ${item.taskId}`), ...detail.relationships.dependents.map((item) => `Required by ${item.taskId}`)]} empty="No task links." /><form onSubmit={(event) => { event.preventDefault(); if (linkedTaskId) mutate("dependencies", { taskId: linkedTaskId, relation }); }}><input aria-label="Linked task ID" value={linkedTaskId} onChange={(event) => setLinkedTaskId(event.target.value)} placeholder="Existing task ID" /><select aria-label="Link relationship" value={relation} onChange={(event) => setRelation(event.target.value as typeof relation)}><option value="dependency">dependency</option><option value="blocker">blocker</option></select><button className="classic-button" disabled={busy}>Add link</button></form>{[...task.dependencies.map((item) => ({ ...item, relation: "dependency" })), ...task.blockers.map((item) => ({ ...item, relation: "blocker" }))].map((item) => <button key={`${item.relation}:${item.taskId}`} className="task-link-button" onClick={() => mutate("dependencies", { operation: "remove", relation: item.relation, taskId: item.taskId })}>Remove {item.relation} {item.taskId}</button>)}</section>
      <section><h3>Assignment links</h3><Lines values={task.references.filter((item) => item.kind === "assignment").map((item) => `${item.targetId} — ${item.completionState}`)} empty="No assignments linked." /><form onSubmit={(event) => { event.preventDefault(); if (assignmentId) mutate("assign", { assignmentId }); }}><input aria-label="Existing assignment ID" value={assignmentId} onChange={(event) => setAssignmentId(event.target.value)} placeholder="Existing assignment ID" /><button className="classic-button" disabled={busy}>Link assignment</button></form></section>
      <section><h3>Immutable references</h3><Lines values={task.references.map((item) => `${item.kind}: ${item.targetId}${item.uri ? ` — ${item.uri}` : ""}`)} empty="No references." /><form onSubmit={(event) => { event.preventDefault(); if (referenceTarget) mutate("references", { reference: { id: crypto.randomUUID(), kind: referenceKind, targetId: referenceTarget, ...(referenceKind === "document_revision" ? { contentHash: referenceTarget } : {}) } }); }}><input aria-label="Reference target" value={referenceTarget} onChange={(event) => setReferenceTarget(event.target.value)} placeholder="Immutable target ID" /><select aria-label="Reference kind" value={referenceKind} onChange={(event) => setReferenceKind(event.target.value as TaskReferenceKind)}>{["message", "document_revision", "improvement", "evidence"].map((value) => <option key={value}>{value}</option>)}</select><button className="classic-button" disabled={busy}>Attach</button></form></section>
    </div>
    <section><h3>Append-only history</h3><ol className="task-history">{detail.history.map((event) => <li key={event.revision}><strong>r{event.revision}</strong> {event.actorId} · {new Date(event.at).toLocaleString()}<code>{typeof event.change === "string" ? event.change : JSON.stringify(event.change)}</code></li>)}</ol></section>
  </article>;
}
