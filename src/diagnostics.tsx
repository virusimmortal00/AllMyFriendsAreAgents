import { useState } from "react";
import { ApiRequestError, loadDiagnostic, loadDiagnostics, loadOwnerCapabilityDiagnostics, type CapabilityDiagnosticsResponse } from "./api";
import type { ActiveAgentId } from "../shared/participants";
import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction";

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
  return redactDiagnosticSecrets(value);
}

export function Diagnostics({ agents }: { agents: readonly ActiveAgentId[] }) {
  const [token, setToken] = useState("");
  const [agentId, setAgentId] = useState(agents[0] || "");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<DiagnosticRecord[] | null>(null);
  const [selected, setSelected] = useState<DiagnosticRecord | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [capabilities, setCapabilities] = useState<CapabilityDiagnosticsResponse | null>(null);
  const [capabilityError, setCapabilityError] = useState("");

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
  async function refreshCapabilities() {
    setLoading(true); setCapabilityError("");
    try { setCapabilities(await loadOwnerCapabilityDiagnostics()); }
    catch (failure) { setCapabilities(null); setCapabilityError(failure instanceof ApiRequestError && [401, 403].includes(failure.status || 0) ? "Owner sign-in is required to inspect capability policy and audit events." : "Capability diagnostics could not be loaded."); }
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
    <section className="diagnostic-detail capability-inspector" aria-label="Owner capability inspector">
      <h3>Owner capability inspector</h3><p>Loads the server-owned effective policy and bounded capability audit only when requested. Credentials and raw inputs are never returned.</p>
      <button type="button" className="classic-button" disabled={loading} onClick={() => void refreshCapabilities()}>Refresh capability diagnostics</button>
      {capabilityError ? <p className="diagnostics-error" role="alert">{capabilityError}</p> : null}
      {capabilities ? <><p><strong>Policy revision {capabilities.policyRevision}</strong> · {capabilities.audit.length} recent audit events</p>
        <div className="diagnostics-results">{Object.values(capabilities.agents).map((agent) => <article key={agent.agentId}><strong>{agent.agentId}</strong><p>Effective commands: {agent.effectiveCommands.join(", ") || "none"}</p><ul>{Object.entries(agent.capabilities).map(([name, status]) => <li key={name}>{name}: {status.effective ? "effective" : `unavailable (${status.reason.replaceAll("_", " ")})`}{status.contract ? ` · ${status.contract}` : ""}</li>)}</ul><dl>{Object.entries(agent.commands).map(([name, command]) => <div key={name}><dt>{name}</dt><dd>{command.effective ? "effective" : `excluded: ${command.exclusions.join(", ") || "none"}`} · compiled {String(command.featureCompiled)} · config {String(command.requiredConfigPresent)} · ceiling {String(command.serverCeiling)} · roster {String(command.rosterEnabled)} · grant {String(command.requestedGrant)} · catalog {String(command.catalogRevisionCurrent)} · session fresh {String(command.providerSessionFresh)} · lease {command.lease.status}{command.lease.issuedAt ? ` issued ${command.lease.issuedAt}` : ""}{command.lease.expiresAt ? ` expires ${command.lease.expiresAt}` : ""}{command.lastManifestIssuance ? ` · manifest r${command.lastManifestIssuance.revision}` : ""}{command.lastRejection ? ` · last rejection ${command.lastRejection.reason}` : ""}</dd></div>)}</dl></article>)}</div>
        <div className="diagnostics-results" role="region" aria-label="Capability audit events">{capabilities.audit.map((event) => <article key={event.id}><strong>{event.capability} · {event.outcome}</strong><span>{event.agentId} · {new Date(event.timestamp).toLocaleString()}{event.reason ? ` · ${redact(event.reason)}` : ""}</span></article>)}</div></> : null}
    </section>
  </section>;
}
