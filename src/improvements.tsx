import { Fragment, useEffect, useState } from "react";
import { loadImprovement, loadImprovements } from "./api";
import type { GovernedImprovementDetail, GovernedImprovementSummary, ImprovementStatusContract } from "./types";

export type ImprovementsRoute = { view: "list"; scope: "active" | "all" } | { view: "detail"; id: string } | { view: "missing"; id: string };

export function improvementsRoute(location = window.location): ImprovementsRoute | null {
  const match = location.pathname.match(/^\/improvements\/([^/]+)$/);
  if (match) return { view: "detail", id: decodeURIComponent(match[1]) };
  if (location.pathname === "/improvements") return { view: "list", scope: location.search === "?scope=all" ? "all" : "active" };
  return null;
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
    {item.milestones.length ? <ul>{item.milestones.map((milestone) => <li key={milestone.id}><strong>{milestone.state}</strong> · {milestone.summary} <small>{milestone.revisionLabel}</small></li>)}</ul> : <p>No milestones have been recorded yet.</p>}
  </article>;
}

export function Improvements({ route, onNavigate }: { route: ImprovementsRoute; onNavigate: (route: ImprovementsRoute) => void }) {
  const scope = route.view === "list" ? route.scope : "active";
  const [items, setItems] = useState<readonly GovernedImprovementSummary[]>([]);
  const [detail, setDetail] = useState<GovernedImprovementDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setDetail(null);
    if (route.view === "list") void loadImprovements(route.scope).then((data) => { if (!cancelled) setItems(data.items); }).catch(() => { if (!cancelled) setItems([]); }).finally(() => { if (!cancelled) setLoading(false); });
    else if (route.view === "detail") void loadImprovement(route.id).then((data) => { if (!cancelled) setDetail(data); }).catch(() => { if (!cancelled) onNavigate({ view: "missing", id: route.id }); }).finally(() => { if (!cancelled) setLoading(false); });
    else setLoading(false);
    return () => { cancelled = true; };
  }, [route.view, route.view === "list" ? route.scope : route.id]);

  return <section className="improvements-panel beveled-inset" aria-live="polite" data-responsive-layout="improvements">
    <header className="improvements-header"><h2>Improvements</h2><div role="tablist" aria-label="Improvement lists"><button type="button" role="tab" aria-selected={route.view === "list" && scope === "active"} onClick={() => onNavigate({ view: "list", scope: "active" })}>Active</button><button type="button" role="tab" aria-selected={route.view === "list" && scope === "all"} onClick={() => onNavigate({ view: "list", scope: "all" })}>All</button></div></header>
    <div className="improvements-body">
      {loading ? <p role="status">Loading improvements…</p> : route.view === "missing" ? <section className="improvements-missing" role="status"><h2>Improvement not found</h2><p><code>{route.id}</code> is not an existing canonical improvement ID. It may have been removed, or the link may be stale.</p><p><button type="button" className="classic-button" onClick={() => onNavigate({ view: "list", scope: "active" })}>View Active improvements</button> <button type="button" className="classic-button" onClick={() => onNavigate({ view: "list", scope: "all" })}>View All improvements</button></p></section> : route.view === "detail" && detail ? <Detail item={detail} /> : <><p>{scope === "active" ? "Current non-terminal improvements." : "All recorded improvements."}</p>{items.length ? <ul className="improvements-list">{items.map((item) => <li key={item.canonicalId}><a href={`/improvements/${encodeURIComponent(item.canonicalId)}`}>{item.canonicalId}</a><span>{item.revisionLabel} · {item.state} · {item.risk}</span><small>Updated {new Date(item.updatedAt).toLocaleString()}</small></li>)}</ul> : <p>No improvements are available in this view.</p>}</>}
    </div>
  </section>;
}
