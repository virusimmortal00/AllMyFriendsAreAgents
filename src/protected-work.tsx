import { useCallback, useEffect, useRef, useState } from "react";
import type { ProtectedWorkView } from "../shared/protected-work";
import type { AgentId } from "./types";
import { loadProtectedWork, protectedWorkAction, startProtectedWork } from "./api";

export function useProtectedWork(enabled: boolean) {
  const [work, setWork] = useState<ProtectedWorkView[]>([]);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try { const result = await loadProtectedWork(); if (current === generation.current) { setWork(Array.isArray(result) ? result : []); setError(""); } }
    catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : "Could not load protected work."); }
  }, []);
  useEffect(() => {
    if (!enabled) { generation.current++; setWork([]); return; }
    let stopped = false; let timer: number | undefined;
    const poll = async () => { await refresh(); if (!stopped) timer = window.setTimeout(() => void poll(), 2_000); };
    void poll();
    return () => { stopped = true; generation.current++; if (timer) clearTimeout(timer); };
  }, [enabled, refresh]);
  return { work, error, refresh };
}
export function ProtectedWorkStatus({ work }: { work: ProtectedWorkView }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  const seconds = work.startedAt ? Math.max(0, Math.floor(((work.stoppedAt ? Date.parse(work.stoppedAt) : now) - Date.parse(work.startedAt)) / 1_000)) : null;
  return <span className="protected-work-status"><strong>{work.phase.replaceAll("-", " ")}</strong> · {work.objective}{seconds !== null ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} elapsed` : " · waiting to start"}</span>;
}
export function ProtectedWorkControls({ work, onChanged }: { work: ProtectedWorkView; onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const action = async (value: "stop" | "retry-return" | "dismiss") => {
    setPending(true); setError("");
    try { await protectedWorkAction(work.workId, value); await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Work changed."); }
    finally { setPending(false); }
  };
  if (work.phase === "available") return null;
  return <div className="protected-work-controls">
    {work.blocker ? <p role="status">{work.blocker}</p> : null}
    {!work.stoppedAt ? <button type="button" className="classic-button" disabled={pending || work.phase === "stopping"} onClick={() => void action("stop")}>{work.phase === "stopping" ? "Stop requested…" : "Stop and return to chat"}</button> : null}
    {work.phase === "blocked" && work.stoppedAt ? <button type="button" className="classic-button" disabled={pending} onClick={() => void action("retry-return")}>Retry catch-up</button> : null}
    {work.stoppedAt ? <button type="button" className="classic-button" disabled={pending} onClick={() => void action("dismiss")}>Return without an update</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
export function ProtectedWorkForm({ agents, enabled, onChanged }: { agents: readonly { agentId: AgentId; conversationalName?: string }[]; enabled: boolean; onChanged: () => Promise<void> }) {
  const [owner, setOwner] = useState<AgentId | "">(""); const [objective, setObjective] = useState("");
  const [pending, setPending] = useState(false); const [error, setError] = useState("");
  const request = useRef<{ content: string; id: string } | null>(null);
  const selected = owner || agents[0]?.agentId;
  return <form className="protected-work-form classic-group" onSubmit={async (event) => {
    event.preventDefault(); if (!selected || !objective.trim()) return;
    const content = JSON.stringify([selected, objective.trim()]);
    if (request.current?.content !== content) request.current = { content, id: crypto.randomUUID() };
    setPending(true); setError("");
    try { await startProtectedWork({ owner: selected, objective: objective.trim(), requestId: request.current.id }); setObjective(""); request.current = null; await onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not start protected work."); }
    finally { setPending(false); }
  }}>
    <h3>Protected review or research</h3>
    <p>The participant pauses ordinary chat, works read-only within the configured budget, then catches up before returning.</p>
    <label>Participant<select value={selected || ""} onChange={(event) => setOwner(event.target.value as AgentId)} disabled={pending}>{agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.conversationalName || agent.agentId}</option>)}</select></label>
    <label>Objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={4_000} rows={3} disabled={pending} /></label>
    <button type="submit" className="classic-button" disabled={!enabled || pending || !selected || !objective.trim()}>{pending ? "Starting…" : "Start protected work"}</button>
    {!enabled ? <p>Enable investigations and configure a read-only executor before starting.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
