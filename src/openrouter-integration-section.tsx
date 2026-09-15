import { useEffect, useRef, useState } from "react";
import { ApiRequestError, loadOpenRouterCredits, loadOpenRouterUsageWindow } from "./api";
import { OPEN_ROUTER_SPEND_WINDOWS, type OpenRouterSpendWindow, type OpenRouterUsageWindow } from "../shared/openrouter-usage";
import { formatUsd } from "../shared/currency";
import { OpenRouterSpendChart } from "./spend-chart";
import { OpenRouterMark } from "./openrouter-mark";
import { loadOpenRouterSpendWindow, safeLocalStorage, saveOpenRouterSpendWindow } from "./openrouter-spend-window";
import { AdministrationSignIn } from "./server-administration";
import { useControlSession } from "./control-session";
import { VIEWS, viewAttributes } from "./view-registry";

const CHECKED_AT_FORMATTER = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });

/**
 * The account's remaining credit balance is account-level, financial data — gated behind
 * server administration, same bar as GitHub. Shown as its own sub-panel within the
 * OpenRouter section so a signed-out room member still sees the room's own spend below it.
 */
function CreditsCard({ onOpenAdministration, refreshKey }: { onOpenAdministration: () => void; refreshKey: number }) {
  const { session, checked } = useControlSession(false);
  const [credits, setCredits] = useState<{ totalCreditsUsd: number; totalUsageUsd: number; remainingUsd: number; fetchedAt: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(0);
  const forceRefreshRef = useRef(false);

  useEffect(() => {
    if (!session) { setLoading(false); return; }
    const controller = new AbortController();
    const forceRefresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    setLoading(true);
    setError("");
    setNotConfigured(false);
    loadOpenRouterCredits(forceRefresh, controller.signal).then((value) => {
      setCredits(value.credits);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiRequestError && reason.status === 404) { setNotConfigured(true); return; }
      setError(reason instanceof Error ? reason.message : "OpenRouter credits could not be loaded.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [session?.principal.id, session?.principal.revision, session?.expiresAt, refreshKey, manualRefresh]);

  if (!checked) return <p role="status">Checking server administration…</p>;
  if (!session) return <div className="openrouter-credits openrouter-credits--signed-out">
    <p>Sign in as a server administrator to see the account's remaining balance.</p>
    <AdministrationSignIn onOpen={onOpenAdministration} />
  </div>;

  return <section className="openrouter-credits" aria-label="Remaining OpenRouter credits">
    <div className="openrouter-credits__brand"><OpenRouterMark size={26} /><span>OpenRouter</span></div>
    {notConfigured ? <p>OpenRouter credit tracking is not configured on this server.</p>
      : error ? <p role="alert">{error}</p>
        : loading && !credits ? <p role="status">Checking balance…</p>
          : credits ? <>
            <div className="openrouter-credits__headline"><strong>{formatUsd(credits.remainingUsd)}</strong><span>available</span></div>
            <div className="openrouter-credits__meta">
              <span>Checked {CHECKED_AT_FORMATTER.format(new Date(credits.fetchedAt))}</span>
              <button type="button" className="classic-button" disabled={loading} onClick={() => { forceRefreshRef.current = true; setManualRefresh((current) => current + 1); }}>{loading ? "Checking…" : "Refresh"}</button>
            </div>
          </> : <p>Connect an OpenRouter API key to see your remaining balance here.</p>}
  </section>;
}

/**
 * OpenRouter's account section of the shared Integrations page: this room's spend by
 * time window and per-agent chart are room activity, open to any member (same bar as
 * the transcript's per-message cost badges). The credit balance above is account-level
 * and gated separately by `CreditsCard`.
 */
export function OpenRouterIntegrationSection({ agentLabels, refreshKey = 0, onOpenAdministration }: { agentLabels?: Readonly<Record<string, string>>; refreshKey?: number; onOpenAdministration: () => void }) {
  const [spendWindow, setSpendWindow] = useState<OpenRouterSpendWindow>(() => loadOpenRouterSpendWindow(safeLocalStorage()));
  const [usage, setUsage] = useState<OpenRouterUsageWindow>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setNotConfigured(false);
    loadOpenRouterUsageWindow(spendWindow, controller.signal).then((value) => {
      setUsage(value);
      setNotConfigured(false);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiRequestError && reason.status === 404) { setNotConfigured(true); return; }
      setError(reason instanceof Error ? reason.message : "OpenRouter usage could not be loaded.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [spendWindow, refreshKey]);

  return <section className="integrations-section openrouter-account" aria-labelledby="integrations-openrouter-heading" {...viewAttributes(VIEWS.openRouterAccount)}>
    <h3 id="integrations-openrouter-heading" className="integrations-section__heading">OpenRouter</h3>
    <CreditsCard onOpenAdministration={onOpenAdministration} refreshKey={refreshKey} />
    <div className="openrouter-account__body">
      {notConfigured ? (
        <div className="task-empty"><strong>OpenRouter spend tracking is not configured on this server.</strong></div>
      ) : error ? (
        <div className="task-error" role="alert">{error}</div>
      ) : loading && !usage ? (
        <p role="status">Loading OpenRouter usage…</p>
      ) : usage ? (
        <>
          <div className="openrouter-account__toolbar">
            <label>Window<select className="classic-select" aria-label="Spend time window" value={spendWindow} onChange={(event) => {
              const next = event.target.value as OpenRouterSpendWindow;
              setSpendWindow(next);
              saveOpenRouterSpendWindow(safeLocalStorage(), next);
            }}>{OPEN_ROUTER_SPEND_WINDOWS.map((value) => <option key={value} value={value}>{value === "all" ? "All time" : `Last ${value}`}</option>)}</select></label>
            <span className="openrouter-account__total">{formatUsd(usage.room.costUsd)} spent · {usage.room.generations} turn{usage.room.generations === 1 ? "" : "s"}</span>
          </div>
          {usage.truncated ? <p className="roster-diagnostic" role="status">Retained history doesn't reach back this far; totals may undercount.</p> : null}
          <OpenRouterSpendChart agents={usage.agents} labels={agentLabels} />
        </>
      ) : null}
    </div>
  </section>;
}
