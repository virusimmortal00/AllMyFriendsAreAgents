import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { authorizeHeartbeat, emergencyStopHeartbeat, loadHeartbeat, loadImprovement, loadImprovements } from "./api";
import { ConfirmationDialog } from "./components";
import type { GovernedImprovementDetail, GovernedImprovementSummary, HeartbeatStatus, ImprovementStatusContract } from "./types";

export type ImprovementsRoute = { view: "list"; scope: "active" | "all" } | { view: "detail"; id: string } | { view: "missing"; id: string };

export function ImprovementsMenuControl({ active = false, onOpen }: { active?: boolean; onOpen: () => void }) {
  return <button type="button" aria-current={active ? "page" : undefined} onClick={onOpen}>Improvements</button>;
}

export function improvementsRoute(location = window.location): ImprovementsRoute | null {
  const match = location.pathname.match(/^\/improvements\/([^/]+)$/);
  if (match) return { view: "detail", id: decodeURIComponent(match[1]) };
  if (location.pathname === "/improvements") return { view: "list", scope: location.search === "?scope=all" ? "all" : "active" };
  return null;
}

/** A hash is only an alias after an exact canonical read succeeds. */
export async function resolveImprovementsAlias(
  alias: string,
  read: (id: string) => Promise<Pick<GovernedImprovementDetail, "canonicalId">>,
): Promise<ImprovementsRoute | null> {
  if (!alias) return null;
  try {
    const item = await read(alias);
    return item.canonicalId === alias ? { view: "detail", id: alias } : { view: "missing", id: alias };
  } catch {
    return { view: "missing", id: alias };
  }
}

function describe(value: Record<string, unknown>) {
  const { state, ...details } = value;
  const tail = Object.entries(details).map(([key, entry]) => `${key.replace(/([A-Z])/g, " $1")}: ${Array.isArray(entry) ? entry.map((item) => typeof item === "object" && item ? (item as { id?: string }).id || JSON.stringify(item) : String(item)).join(", ") : typeof entry === "object" && entry ? JSON.stringify(entry) : String(entry)}`).join(" · ");
  return tail ? `${String(state)} — ${tail}` : String(state);
}

const STATUS_LABELS: { [K in Exclude<keyof ImprovementStatusContract, "schemaVersion">]: string } = {
  implementation: "Implementation", deployment: "Deployment", developerTeamEvidence: "Developer team evidence", independentAcceptance: "Independent acceptance", upstreamPublication: "Upstream publication", nextAction: "Next action",
};

function Detail({ item }: { item: GovernedImprovementDetail }) {
  return <article className="improvements-detail" aria-labelledby="improvement-detail-title">
    <p className="improvements-breadcrumb"><a href="/improvements">Active improvements</a> / {item.canonicalId}</p>
    <h2 id="improvement-detail-title">{item.canonicalId}</h2>
    <p><strong>Canonical ID:</strong> {item.canonicalId} · <strong>Revision:</strong> {item.revisionLabel} · <strong>State:</strong> {item.state} · <strong>Risk:</strong> {item.risk}</p>
    <p><a href={`/improvements/${encodeURIComponent(item.canonicalId)}`}>Permanent link to this improvement</a></p>
    <h3>Delivery status</h3>
    <dl className="improvements-status">{(Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[]).map((key) => <Fragment key={key}><dt>{STATUS_LABELS[key]}</dt><dd>{describe(item.status[key] as Record<string, unknown>)}</dd></Fragment>)}</dl>
    <h3>Qualified evidence</h3>
    {item.evidence.length ? <ul>{item.evidence.map((evidence) => <li key={evidence.id}><a href={evidence.uri} target="_blank" rel="noreferrer">{evidence.summary}</a> <small>{evidence.sourceClass} · {evidence.revisionLabel}</small></li>)}</ul> : <p>No qualified evidence is recorded for this item.</p>}
    <h3>Milestones</h3>
    {item.milestones.length ? <ul>{item.milestones.map((milestone) => <li key={`${milestone.revisionLabel}:${milestone.id}`}><strong>{milestone.state}</strong> · {milestone.summary} <small>{milestone.revisionLabel}</small></li>)}</ul> : <p>No milestones have been recorded yet.</p>}
  </article>;
}

export function Improvements({ route, onNavigate }: { route: ImprovementsRoute; onNavigate: (route: ImprovementsRoute, options?: { focusHeading?: boolean }) => void }) {
  const scope = route.view === "list" ? route.scope : "active";
  const [items, setItems] = useState<readonly GovernedImprovementSummary[]>([]);
  const [detail, setDetail] = useState<GovernedImprovementDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadRevision, setReloadRevision] = useState(0);
  const [heartbeat, setHeartbeat] = useState<HeartbeatStatus | null>(null);
  const [heartbeatBusy, setHeartbeatBusy] = useState(false);
  const [heartbeatError, setHeartbeatError] = useState("");
  const [heartbeatReloadRevision, setHeartbeatReloadRevision] = useState(0);
  const [confirmHeartbeatStop, setConfirmHeartbeatStop] = useState(false);
  const heartbeatStopTrigger = useRef<HTMLButtonElement>(null);
  const heartbeatSubmitting = useRef(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedTab = route.view === "list" && scope === "all" ? 1 : 0;

  function selectTab(index: number) {
    const nextScope = index === 0 ? "active" : "all";
    tabRefs.current[index]?.focus();
    if (route.view !== "list" || scope !== nextScope) onNavigate({ view: "list", scope: nextScope });
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % 2
      : event.key === "ArrowLeft" ? (index + 1) % 2
      : event.key === "Home" ? 0 : event.key === "End" ? 1 : null;
    if (next === null) return;
    event.preventDefault();
    selectTab(next);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(""); setDetail(null);
    if (route.view === "list") void loadImprovements(route.scope).then((data) => { if (!cancelled) setItems(data.items); }).catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    else if (route.view === "detail") void loadImprovement(route.id).then((data) => { if (!cancelled) setDetail(data); }).catch((error) => {
      if (cancelled) return;
      if (error && typeof error === "object" && "status" in error && error.status === 404) onNavigate({ view: "missing", id: route.id });
      else setLoadError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (!cancelled) setLoading(false); });
    else setLoading(false);
    return () => { cancelled = true; };
  }, [route.view, route.view === "list" ? route.scope : route.id, reloadRevision]);

  useEffect(() => { void loadHeartbeat().then((value) => { setHeartbeat(value); setHeartbeatError(""); }).catch((error) => { setHeartbeat(null); setHeartbeatError(error instanceof Error ? error.message : String(error)); }); }, [heartbeatReloadRevision]);

  async function changeHeartbeat(action: "authorize" | "stop") {
    if (!heartbeat || heartbeatSubmitting.current) return false;
    heartbeatSubmitting.current = true;
    setHeartbeatBusy(true);
    setHeartbeatError("");
    try {
      setHeartbeat(await (action === "stop" ? emergencyStopHeartbeat(heartbeat.runtime.revision) : authorizeHeartbeat(heartbeat.runtime.revision)));
      return true;
    } catch (error) {
      setHeartbeatError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      heartbeatSubmitting.current = false;
      setHeartbeatBusy(false);
    }
  }

  return <section className="improvements-panel beveled-inset" data-responsive-layout="improvements">
    <header className="improvements-header"><h2 data-route-heading tabIndex={-1}>Improvements</h2><div role="tablist" aria-label="Improvement lists"><button ref={(element) => { tabRefs.current[0] = element; }} type="button" role="tab" id="improvements-tab-active" aria-controls="improvements-content" aria-selected={selectedTab === 0} tabIndex={selectedTab === 0 ? 0 : -1} onKeyDown={(event) => onTabKeyDown(event, 0)} onClick={() => selectTab(0)}>Active</button><button ref={(element) => { tabRefs.current[1] = element; }} type="button" role="tab" id="improvements-tab-all" aria-controls="improvements-content" aria-selected={selectedTab === 1} tabIndex={selectedTab === 1 ? 0 : -1} onKeyDown={(event) => onTabKeyDown(event, 1)} onClick={() => selectTab(1)}>All</button></div></header>
    <div id="improvements-content" className="improvements-body" role="tabpanel" aria-labelledby={selectedTab === 0 ? "improvements-tab-active" : "improvements-tab-all"}>
      <section className="heartbeat-control" aria-label="Bounded heartbeat controls">
        <div><strong>Bounded heartbeat:</strong> {!heartbeat ? "Unavailable" : heartbeat.runtime.emergencyStopped ? "EMERGENCY STOPPED" : heartbeat.runtime.enabled ? heartbeat.active ? "Running bounded work" : "Authorized, awaiting cadence" : "Disabled"}</div>
        {heartbeat && <><small>Policy {heartbeat.policy.version} · every {Math.round(heartbeat.policy.cadenceMs / 1000)}s · concurrency {heartbeat.policy.maxConcurrency} · at most {heartbeat.policy.maxDispatchedPerRun} actions/run · {heartbeat.policy.maxAttemptsPerRevision} attempts · {Math.round(heartbeat.policy.timeBudgetMs / 1000)}s budget · capabilities {heartbeat.policy.permittedCapabilities.join(", ")}</small><div className="heartbeat-actions"><button ref={heartbeatStopTrigger} type="button" className="classic-button heartbeat-stop" aria-haspopup="dialog" aria-expanded={confirmHeartbeatStop} disabled={heartbeatBusy || heartbeat.runtime.emergencyStopped} onClick={() => { setHeartbeatError(""); setConfirmHeartbeatStop(true); }}>Emergency stop heartbeat</button>{heartbeat.configured && !heartbeat.runtime.enabled && <button type="button" className="classic-button" disabled={heartbeatBusy} onClick={() => void changeHeartbeat("authorize")}>Authorize heartbeat</button>}</div></>}
        {heartbeatBusy ? <p role="status">Updating heartbeat control…</p> : null}
        {heartbeatError ? <div className="improvements-error" role="alert"><p>Heartbeat controls are unavailable. {heartbeatError}</p>{!heartbeat ? <button type="button" className="classic-button" onClick={() => setHeartbeatReloadRevision((value) => value + 1)}>Try heartbeat again</button> : null}</div> : null}
      </section>
      {confirmHeartbeatStop ? <ConfirmationDialog
        title="Emergency stop heartbeat?"
        description={<p>This immediately stops future automated scheduling and aborts active heartbeat work. A new explicit authorization is required to resume.</p>}
        confirmLabel="Emergency stop heartbeat"
        busyLabel="Stopping heartbeat…"
        busy={heartbeatBusy}
        error={heartbeatError ? `Heartbeat controls are unavailable. ${heartbeatError}` : ""}
        returnFocusTo={heartbeatStopTrigger.current}
        onConfirm={() => void changeHeartbeat("stop").then((stopped) => { if (stopped) setConfirmHeartbeatStop(false); })}
        onCancel={() => setConfirmHeartbeatStop(false)}
      /> : null}
      {loading ? <p role="status" aria-live="polite" aria-atomic="true">Loading improvements…</p> : loadError ? <section className="improvements-load-error" role="alert"><h2>Could not load improvements</h2><p>{loadError}</p><button type="button" className="classic-button" onClick={() => setReloadRevision((value) => value + 1)}>Try again</button></section> : route.view === "missing" ? <section className="improvements-missing" role="status" aria-live="polite" aria-atomic="true"><h2>Improvement not found</h2><p><code>{route.id}</code> is not an existing canonical improvement ID. It may have been removed, or the link may be stale.</p><p><button type="button" className="classic-button" onClick={() => onNavigate({ view: "list", scope: "active" })}>View Active improvements</button> <button type="button" className="classic-button" onClick={() => onNavigate({ view: "list", scope: "all" })}>View All improvements</button></p></section> : route.view === "detail" && detail ? <Detail item={detail} /> : <><p>{scope === "active" ? "Current non-terminal improvements." : "All recorded improvements."}</p>{items.length ? <ul className="improvements-list">{items.map((item) => <li key={item.canonicalId}><a href={`/improvements/${encodeURIComponent(item.canonicalId)}`}>{item.canonicalId}</a><span>{item.revisionLabel} · {item.state} · {item.risk}</span><small>Updated {new Date(item.updatedAt).toLocaleString()}</small></li>)}</ul> : <p>No improvements are available in this view.</p>}</>}
    </div>
  </section>;
}
