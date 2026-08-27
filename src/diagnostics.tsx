import { useState } from "react";
import { ApiRequestError, loadDiagnostic, loadDiagnostics } from "./api";
import type { ActiveAgentId } from "../shared/participants";

export interface DiagnosticRecord {
  readonly recordId: string;
  readonly agentId: string;
  readonly attemptId: string;
  readonly generationId: string | null;
  readonly promptFingerprint: string;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly diagnosticText: string | null;
  readonly createdAt: string;
}

function safeFailure(error: unknown) {
  if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status || 0)) return "Diagnostics are unavailable. Check your diagnostic-read authorization.";
  return "The diagnostic request could not be completed. Try again when you are ready.";
}

function redact(value: string) {
  return value.replace(/(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|cookie|set-cookie)\s*[:=]\s*\S+/gi, "[REDACTED]");
}

export function Diagnostics({ agents }: { agents: readonly ActiveAgentId[] }) {
  const [token, setToken] = useState("");
  const [agentId, setAgentId] = useState(agents[0] || "");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<DiagnosticRecord[] | null>(null);
  const [selected, setSelected] = useState<DiagnosticRecord | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function refresh() {
    if (!token.trim() || !agentId) { setError("Enter a diagnostic-read token and select an agent."); return; }
    setLoading(true); setError(""); setSelected(null);
    try { setItems((await loadDiagnostics(token.trim(), agentId, search)).items); }
    catch (failure) { setItems(null); setError(safeFailure(failure)); }
    finally { setLoading(false); }
  }
  async function openDetail(recordId: string) {
    if (!token.trim()) return;
    setLoading(true); setError("");
    try { setSelected(await loadDiagnostic(token.trim(), agentId, recordId)); }
    catch (failure) { setSelected(null); setError(safeFailure(failure)); }
    finally { setLoading(false); }
  }

  return <section className="tasks-workspace diagnostics-workspace" aria-label="Authorized diagnostics">
    <header className="tasks-header"><div><h2>Authorized diagnostics</h2><p>Private, bounded diagnostic records are requested only when you press Search or Refresh. They are never added to the room transcript.</p></div></header>
    <div className="diagnostics-controls">
      <label>Diagnostic-read token <input className="classic-input" aria-label="Diagnostic-read token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>
      <label>Agent <select className="classic-select" aria-label="Diagnostic agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}</select></label>
      <label>Search <input className="classic-input" aria-label="Search diagnostics" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <button type="button" className="classic-button" disabled={loading} onClick={() => void refresh()}>{loading ? "Loading…" : "Search / Refresh"}</button>
    </div>
    {error ? <p className="diagnostics-error" role="alert">{error}</p> : null}
    {items ? <div className="diagnostics-results" aria-live="polite">{items.length ? items.map((item) => <button type="button" key={item.recordId} onClick={() => void openDetail(item.recordId)}><strong>{item.reason}</strong><span>{new Date(item.createdAt).toLocaleString()} · {item.promptFingerprint}</span></button>) : <p>No matching diagnostic records.</p>}</div> : <p className="task-empty">No diagnostics loaded. This view does not fetch automatically.</p>}
    {selected ? <article className="diagnostic-detail"><h3>{selected.reason}</h3><p><small>{selected.agentId} · {selected.attemptId} · {selected.promptFingerprint}</small></p><pre>{redact(selected.diagnosticText || "No diagnostic text was retained.")}</pre><dl>{Object.entries(selected.metadata).slice(0, 20).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{redact(String(value))}</dd></div>)}</dl></article> : null}
  </section>;
}
