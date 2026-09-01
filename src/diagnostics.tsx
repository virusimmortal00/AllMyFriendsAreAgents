import { useMemo, useState } from "react";
import { ApiRequestError, loadOwnerCapabilityDiagnostics, queryOwnerDiagnostics, type CapabilityDiagnosticsResponse, type OwnerDiagnosticChunk, type OwnerDiagnosticRecord, type OwnerDiagnosticsResult } from "./api";
import { redactDiagnosticSecrets } from "../shared/diagnostic-redaction";
import { VIEWS, viewAttributes } from "./view-registry";

const streams = ["server-service-lifecycle", "opencode-harness", "openrouter-provider", "generations", "capability-decisions", "security-audit"] as const;
const scopes = ["self", "room", "project", "operator"] as const;
type StreamChoice = "all" | (typeof streams)[number];
type ScopeChoice = (typeof scopes)[number];
type SelectorKind = "correlationId" | "traceId";
interface QueryContext { readonly from: string; readonly to: string; readonly scope: ScopeChoice; readonly stream: StreamChoice; readonly selectorKind: SelectorKind; readonly selectorValue: string; }
export interface TraceEvidenceSummary { readonly status: "partial" | "complete" | "incomplete"; readonly runCount: number; readonly missingSequences: readonly number[]; readonly unpairedRecordIds: readonly string[]; readonly missingRawGenerationIds: readonly string[]; }

const safeFailure = (error: unknown) => error instanceof ApiRequestError && [401, 403, 404].includes(error.status || 0) ? "Diagnostics are unavailable. Sign in as the owner on the server host." : "The diagnostics query could not be completed.";
const safe = (value: unknown) => redactDiagnosticSecrets(typeof value === "string" ? value : JSON.stringify(value, null, 2));

function combinePages(previous: OwnerDiagnosticsResult | null, next: OwnerDiagnosticsResult, append: boolean): OwnerDiagnosticsResult {
  if (!append || !previous) return next;
  return { ...next, records: [...previous.records, ...next.records], chunks: [...previous.chunks, ...next.chunks], scannedBytes: previous.scannedBytes + next.scannedBytes, serializedBytes: previous.serializedBytes + next.serializedBytes, malformedRecords: previous.malformedRecords + next.malformedRecords, scanLimitReached: previous.scanLimitReached || next.scanLimitReached };
}

function decodeBase64(value: string) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }

export function assembleDiagnosticChunks(chunks: readonly OwnerDiagnosticChunk[]): OwnerDiagnosticRecord[] {
  const grouped = new Map<string, OwnerDiagnosticChunk[]>();
  for (const chunk of chunks) grouped.set(chunk.recordId, [...(grouped.get(chunk.recordId) ?? []), chunk]);
  const records: OwnerDiagnosticRecord[] = [];
  for (const recordChunks of grouped.values()) {
    const ordered = [...recordChunks].sort((left, right) => left.offset - right.offset);
    const parts: Uint8Array[] = []; let offset = 0;
    try {
      for (const chunk of ordered) {
        if (chunk.offset !== offset || chunk.encoding !== "base64-json-utf8") { parts.length = 0; break; }
        const part = decodeBase64(chunk.data); parts.push(part); offset += part.length;
      }
      if (!parts.length || !ordered.at(-1)?.final || offset !== ordered[0].totalBytes) continue;
      const bytes = new Uint8Array(offset); let position = 0;
      for (const part of parts) { bytes.set(part, position); position += part.length; }
      records.push(JSON.parse(new TextDecoder().decode(bytes)) as OwnerDiagnosticRecord);
    }
    catch { /* A malformed assembled record remains safely unrendered. */ }
  }
  return records;
}

const structuredEvent = (record: OwnerDiagnosticRecord) => record.event.startsWith("conversation.");
const generationIdOf = (record: OwnerDiagnosticRecord) => record.generationId || (typeof record.content.generationId === "string" ? record.content.generationId : undefined);
const rawEvidenceStreams = new Set(["generations", "opencode-harness", "openrouter-provider"]);

/** Evaluates only fully loaded evidence and never assigns a cause to a gap. */
export function summarizeTraceEvidence(records: readonly OwnerDiagnosticRecord[], hasNextPage: boolean): TraceEvidenceSummary {
  const structured = records.filter(structuredEvent);
  const raw = records.filter((record) => !structuredEvent(record) && rawEvidenceStreams.has(record.stream) && generationIdOf(record));
  const finishedGenerationIds = new Set(structured.filter((record) => record.event === "conversation.turn.finished").map(generationIdOf).filter((value): value is string => Boolean(value)));
  const rawGenerationIds = new Set(raw.map(generationIdOf).filter((value): value is string => Boolean(value)));
  const unpairedRecordIds = raw.filter((record) => !finishedGenerationIds.has(generationIdOf(record)!)).map((record) => record.recordId);
  const missingRawGenerationIds = [...finishedGenerationIds].filter((generationId) => !rawGenerationIds.has(generationId)).sort();
  const groups = new Map<string, OwnerDiagnosticRecord[]>();
  for (const record of structured) {
    const runId = typeof record.content.runId === "string" ? record.content.runId : record.correlationId;
    if (runId) groups.set(runId, [...(groups.get(runId) ?? []), record]);
  }
  const missingSequences = new Set<number>();
  let completeRuns = 0;
  for (const run of groups.values()) {
    const sequences = new Set(run.map((record) => record.content.runEventSequence).filter((value): value is number => Number.isSafeInteger(value) && value > 0));
    const terminal = run.find((record) => record.event === "conversation.run.completed");
    const attempted = terminal?.content.attemptedEventCount;
    const expected = Number.isSafeInteger(attempted) && (attempted as number) > 0 ? attempted as number : 0;
    let runHasGap = false;
    for (let sequence = 1; sequence <= expected; sequence++) if (!sequences.has(sequence)) { missingSequences.add(sequence); runHasGap = true; }
    if (run.some((record) => record.event === "conversation.run.started") && terminal && expected && !runHasGap) completeRuns++;
  }
  const status = hasNextPage ? "partial" : groups.size > 0 && completeRuns === groups.size && !unpairedRecordIds.length && !missingRawGenerationIds.length ? "complete" : "incomplete";
  return { status, runCount: groups.size, missingSequences: [...missingSequences].sort((left, right) => left - right), unpairedRecordIds, missingRawGenerationIds };
}

export function Diagnostics() {
  const [scope, setScope] = useState<ScopeChoice>("operator");
  const [stream, setStream] = useState<StreamChoice>("all");
  const [selectorKind, setSelectorKind] = useState<SelectorKind>("correlationId");
  const [selectorValue, setSelectorValue] = useState("");
  const [result, setResult] = useState<OwnerDiagnosticsResult | null>(null);
  const [selected, setSelected] = useState<OwnerDiagnosticRecord | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [queryContext, setQueryContext] = useState<QueryContext | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityDiagnosticsResponse | null>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const visibleRecords = useMemo(() => result ? [...result.records, ...assembleDiagnosticChunks(result.chunks)] : [], [result]);
  const traceSummary = useMemo(() => result && queryContext?.selectorKind === "traceId" ? summarizeTraceEvidence(visibleRecords, Boolean(result.nextCursor)) : null, [queryContext, result, visibleRecords]);

  async function load(cursor?: string, override?: Partial<Pick<QueryContext, "scope" | "stream" | "selectorKind" | "selectorValue">>) {
    const context = cursor && queryContext ? queryContext : { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString(), scope: override?.scope ?? scope, stream: override?.stream ?? stream, selectorKind: override?.selectorKind ?? selectorKind, selectorValue: override?.selectorValue ?? selectorValue };
    if (!cursor) { setQueryContext(context); setSelected(null); }
    setLoading(true); setError("");
    try {
      const value = context.selectorValue.trim().slice(0, 200);
      const page = await queryOwnerDiagnostics({ from: context.from, to: context.to, scope: context.scope, streams: context.selectorKind === "traceId" || context.stream === "all" ? streams : [context.stream], correlation: value ? { [context.selectorKind]: value } : undefined, limit: 50, maxScannedBytes: 1_048_576, maxSerializedBytes: 262_144, cursor });
      setResult((previous) => combinePages(previous, page, Boolean(cursor)));
    } catch (failure) { if (!cursor) setResult(null); setError(safeFailure(failure)); }
    finally { setLoading(false); }
  }

  async function refreshCapabilities() {
    setLoading(true); setCapabilityError("");
    try { setCapabilities(await loadOwnerCapabilityDiagnostics()); }
    catch (failure) { setCapabilities(null); setCapabilityError(failure instanceof ApiRequestError && [401, 403].includes(failure.status || 0) ? "Owner sign-in is required to inspect capability policy and audit events." : "Capability diagnostics could not be loaded."); }
    finally { setLoading(false); }
  }

  return <section className="workspace-view tasks-workspace diagnostics-workspace" aria-label="Owner diagnostics" {...viewAttributes(VIEWS.ownerDiagnosticsQuery)}>
    <header className="workspace-view__header tasks-header"><div><h2>Owner diagnostics</h2><p>Local OWNER session only. Records load only after an explicit bounded query. Provider output is evidence, not a claim of hidden chain-of-thought.</p></div></header>
    <div className="workspace-view__body diagnostics-body">
    <div className="diagnostics-controls">
      <label>Visibility <select className="classic-select" aria-label="Diagnostic visibility" value={scope} onChange={(event) => setScope(event.target.value as ScopeChoice)}>{scopes.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      <label>Stream <select className="classic-select" aria-label="Diagnostic stream" value={stream} disabled={selectorKind === "traceId"} onChange={(event) => setStream(event.target.value as StreamChoice)}><option value="all">All six streams</option>{streams.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      <label>Selector <select className="classic-select" aria-label="Diagnostic selector" value={selectorKind} onChange={(event) => { const next = event.target.value as SelectorKind; setSelectorKind(next); if (next === "traceId") setStream("all"); }}><option value="correlationId">Correlation ID</option><option value="traceId">Trace ID (whole trace)</option></select></label>
      <label>{selectorKind === "traceId" ? "Trace ID" : "Correlation ID"} <input className="classic-input" aria-label={selectorKind === "traceId" ? "Trace ID" : "Correlation ID"} value={selectorValue} maxLength={200} onChange={(event) => setSelectorValue(event.target.value)} /></label>
      <button type="button" className="classic-button" disabled={loading} onClick={() => void load()}>{loading ? "Loading…" : "Query diagnostics"}</button>
    </div>
    {error ? <p className="diagnostics-error" role="alert">{error}</p> : null}
    {!result ? <p className="task-empty">No diagnostics loaded. This view does not fetch automatically.</p> : <section className="diagnostics-results-view" {...viewAttributes(VIEWS.ownerDiagnosticsResults)}>
      <div className="diagnostics-result-list">
      <p role="status">{visibleRecords.length} bounded records · {result.scannedBytes} bytes scanned{result.malformedRecords ? ` · ${result.malformedRecords} malformed records skipped` : ""}{result.scanLimitReached ? " · scan bound reached" : ""}{traceSummary ? traceSummary.status === "complete" ? " · Trace evidence is complete." : traceSummary.status === "partial" ? " · Trace evidence is incomplete while bounded pages remain." : " · Trace evidence is incomplete." : ""}</p>
      {traceSummary ? <dl className="diagnostic-trace-summary"><div><dt>Structured runs</dt><dd>{traceSummary.runCount}</dd></div><div><dt>Sequence gaps</dt><dd>{traceSummary.missingSequences.join(", ") || "none detected"}</dd></div><div><dt>Unpaired raw records</dt><dd>{traceSummary.unpairedRecordIds.length}</dd></div><div><dt>Decision links without loaded raw evidence</dt><dd>{traceSummary.missingRawGenerationIds.length}</dd></div></dl> : null}
      {traceSummary && traceSummary.status !== "complete" ? <p className="diagnostics-note">Missing or unpaired evidence remains visible. The cause is unknown; possibilities include independent retention, transport loss, legacy schema, or unfinished work.</p> : null}
      <div className="diagnostics-results">{visibleRecords.length ? visibleRecords.map((item) => <button type="button" key={item.recordId} aria-pressed={selected?.recordId === item.recordId} onClick={() => setSelected(item)}><strong>{item.event}{traceSummary?.unpairedRecordIds.includes(item.recordId) ? " · Unpaired" : ""}</strong><span>{item.stream} · {new Date(item.timestamp).toLocaleString()}{item.correlationId ? ` · ${item.correlationId}` : ""}</span></button>) : result.chunks.length ? <p>A large record is loading in bounded chunks.</p> : <p>No matching records.</p>}</div>
      {result.nextCursor ? <button type="button" className="classic-button" disabled={loading} onClick={() => void load(result.nextCursor || undefined)}>Load next bounded page</button> : null}
      </div>
      {selected ? <article className="diagnostic-detail diagnostic-record-detail"><h3>{selected.event}</h3><p><small>{selected.stream} · {selected.severity} · {selected.correlationId || "no correlation ID"}</small></p><dl><div><dt>Trace ID</dt><dd>{selected.traceId || "unavailable"}</dd></div><div><dt>Generation ID</dt><dd>{generationIdOf(selected) || "unavailable"}</dd></div></dl><pre>{safe(selected.content)}</pre>{selected.traceId ? <button type="button" className="classic-button" disabled={loading} onClick={() => { setScope("operator"); setStream("all"); setSelectorKind("traceId"); setSelectorValue(selected.traceId || ""); void load(undefined, { scope: "operator", stream: "all", selectorKind: "traceId", selectorValue: selected.traceId }); }}>Open whole trace</button> : <p>Whole-trace navigation is unavailable because this record has no trace ID.</p>}</article> : null}
    </section>}
    <section className="diagnostic-detail capability-inspector" aria-label="Owner capability inspector">
      <h3>Owner capability inspector</h3><p>Loads the server-owned effective policy and bounded capability audit only when requested.</p>
      <button type="button" className="classic-button" disabled={loading} onClick={() => void refreshCapabilities()}>Refresh capability diagnostics</button>
      {capabilityError ? <p className="diagnostics-error" role="alert">{capabilityError}</p> : null}
      {capabilities ? <><p><strong>Policy revision {capabilities.policyRevision}</strong> · {capabilities.audit.length} recent audit events</p>
        <div className="diagnostics-results">{Object.values(capabilities.agents).map((agent) => <article key={agent.agentId}><strong>{agent.agentId}</strong><p>Effective commands: {agent.effectiveCommands.join(", ") || "none"}</p><ul>{Object.entries(agent.capabilities).map(([name, status]) => <li key={name}>{name}: {status.effective ? "effective" : `unavailable (${status.reason.replaceAll("_", " ")})`}{status.contract ? ` · ${status.contract}` : ""}</li>)}</ul></article>)}</div>
        <div className="diagnostics-results" role="region" aria-label="Capability audit events">{capabilities.audit.map((event) => <article key={event.id}><strong>{event.capability} · {event.outcome}</strong><span>{event.agentId} · {new Date(event.timestamp).toLocaleString()}{event.reason ? ` · ${safe(event.reason)}` : ""}</span></article>)}</div></> : null}
    </section>
    </div>
  </section>;
}
