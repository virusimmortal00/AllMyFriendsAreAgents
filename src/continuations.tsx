import { useCallback, useEffect, useRef, useState } from "react";
import { acknowledgeContinuationInbox, continuationAction, loadContinuationInbox, loadContinuations, setContinuationPolicy } from "./api";
import type { ContinuationDashboard, ContinuationInboxEntry } from "./types";
import { VIEWS, viewAttributes } from "./view-registry";

export function ContinuationsMenuControl({ active, onOpen }: { active: boolean; onOpen: () => void }) { return <button type="button" aria-current={active ? "page" : undefined} onClick={onOpen}>Continuations</button>; }
export function Continuations({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<ContinuationDashboard | null>(null); const [inbox, setInbox] = useState<Record<string, ContinuationInboxEntry[]>>({}); const [error, setError] = useState("");
  const generation = useRef(0); const activeRequest = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => { const requestGeneration = ++generation.current; activeRequest.current?.abort(); const controller = new AbortController(); activeRequest.current = controller; try { const next = await loadContinuations(controller.signal); const owners = [...new Set(next.jobs.map((job) => job.owner))]; const nextInbox = Object.fromEntries(await Promise.all(owners.map(async (owner) => [owner, await loadContinuationInbox(owner, controller.signal)]))); if (requestGeneration !== generation.current || controller.signal.aborted) return; setData(next); setInbox(nextInbox); setError(""); } catch (failure) { if (requestGeneration === generation.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load continuations."); } finally { if (activeRequest.current === controller) activeRequest.current = null; } }, []);
  useEffect(() => { let stopped = false; let timer: number | undefined; const poll = async () => { await refresh(); if (!stopped) timer = window.setTimeout(() => void poll(), 2_000); }; void poll(); return () => { stopped = true; generation.current += 1; activeRequest.current?.abort(); if (timer !== undefined) window.clearTimeout(timer); }; }, [refresh, refreshKey]);
  const mutate = async (operation: () => Promise<unknown>) => { try { await operation(); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Continuation changed."); } };
  return <section className="workspace-view tasks-workspace continuation-workspace" aria-label="Durable continuations" {...viewAttributes(VIEWS.durableContinuations)}>
    <header className="workspace-view__header tasks-header"><div><h2>Durable Continuations</h2><p>Bounded assignment work stays out of the room transcript until you explicitly use its result.</p></div>{data?.policy ? <label><input type="checkbox" checked={data.policy.enabled} onChange={(event) => void mutate(() => setContinuationPolicy(data.policy.revision, event.target.checked))} /> Initiative enabled</label> : null}</header>
    <div className="workspace-view__body continuation-body">
    {error ? <div className="error-strip" role="alert">{error}</div> : null}
    {!data && !error ? <p className="task-empty" role="status">Loading continuation status…</p> : data && !data.jobs.length ? <p className="task-empty">No continuation jobs.</p> : data?.jobs.map((job) => <article className="task-card" key={job.jobId}>
      <div className="task-card__top"><strong>{job.owner}: {job.objective}</strong><span className="task-state">{job.status.replace("_", " ")}</span></div>
      <p>{job.trigger}</p><small>Task {job.task.taskId} r{job.taskRevision} · assignment {job.assignmentId} · job r{job.jobRevision} · updated {new Date(job.updatedAt).toLocaleString()}</small>
      <p><small>{job.usage.attempts} attempt(s), {job.usage.tokens} tokens, {job.usage.toolCalls} tool calls, {job.usage.elapsedMs} ms</small></p>
      {job.blocker ? <p role="status"><strong>{job.status === "FAILED" ? "Failure" : job.status === "CANCELLED" ? "Cancellation" : "Blocked"}:</strong> {job.blocker}</p> : null}
      {job.status === "QUEUED" || job.status === "RUNNING" || job.status === "WAITING_TOOL" || job.status === "BLOCKED" ? <button className="classic-button" onClick={() => void mutate(() => continuationAction(job.jobId, "cancel"))}>Cancel</button> : null}
      {job.status === "BLOCKED" ? <button className="classic-button" onClick={() => void mutate(() => continuationAction(job.jobId, "resume"))}>Resume</button> : null}
      {(inbox[job.owner] || []).filter((entry) => entry.jobId === job.jobId).map((entry) => <div className="continuation-inbox-entry" key={entry.inboxEntryId}><strong>Inbox · {entry.status}</strong><p>{entry.summary}</p><small>Expires {new Date(entry.expiresAt).toLocaleString()}</small>{entry.status === "UNREAD" ? <button className="classic-button" onClick={() => void mutate(() => acknowledgeContinuationInbox(entry.inboxEntryId, false))}>Acknowledge</button> : null}{entry.status !== "CLOSED" && entry.status !== "ARCHIVED" ? <button className="classic-button" onClick={() => void mutate(() => acknowledgeContinuationInbox(entry.inboxEntryId, true))}>Close</button> : null}</div>)}
    </article>)}
    </div>
  </section>;
}
