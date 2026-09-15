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
 * server administration, same bar as GitHub. It lives on the administration Integrations
 * page; this room's own spend is a member-visible dialog (`RoomSpendPanel`).
 */
export function OpenRouterCreditsSection({ onOpenAdministration, refreshKey = 0 }: { onOpenAdministration: () => void; refreshKey?: number }) {
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

  return <fieldset className="classic-group openrouter-credits" aria-label="Remaining OpenRouter credits" {...viewAttributes(VIEWS.openRouterAccount)}>
    <legend><span className="openrouter-credits__legend"><OpenRouterMark size={14} />OpenRouter account</span></legend>
    {!checked ? <p role="status">Checking server administration…</p>
      : !session ? <div className="openrouter-credits__signed-out">
        <p>Sign in as a server administrator to see the account's remaining balance.</p>
        <AdministrationSignIn onOpen={onOpenAdministration} />
      </div>
        : notConfigured ? <p>OpenRouter credit tracking is not configured on this server.</p>
          : error ? <p role="alert">{error}</p>
            : loading && !credits ? <p role="status">Checking balance…</p>
              : credits ? <div className="openrouter-credits__summary">
                <span className="classic-property-row"><span>Remaining balance</span><strong className="classic-summary openrouter-credits__balance">{formatUsd(credits.remainingUsd)} <span>available</span></strong></span>
                <span className="openrouter-credits__meta">
                  <small>Checked {CHECKED_AT_FORMATTER.format(new Date(credits.fetchedAt))}</small>
                  <button type="button" className="classic-button" disabled={loading} onClick={() => { forceRefreshRef.current = true; setManualRefresh((current) => current + 1); }}>{loading ? "Checking…" : "Refresh"}</button>
                </span>
              </div> : <p>Connect an OpenRouter API key to see your remaining balance here.</p>}
  </fieldset>;
}

/**
 * This room's spend by time window and per-agent chart: room activity, open to any
 * member (same bar as the transcript's per-message cost badges).
 */
export function RoomSpendPanel({ agentLabels, refreshKey = 0 }: { agentLabels?: Readonly<Record<string, string>>; refreshKey?: number }) {
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

  return <div className="room-spend">
    {notConfigured ? <p className="classic-summary">OpenRouter spend tracking is not configured on this server.</p>
      : error ? <p className="room-settings-error" role="alert">{error}</p>
        : loading && !usage ? <p role="status">Loading OpenRouter usage…</p>
          : usage ? <>
            <div className="room-spend__toolbar">
              <label className="classic-property-row"><span>Period</span><select className="classic-select" aria-label="Spend time window" value={spendWindow} onChange={(event) => {
                const next = event.target.value as OpenRouterSpendWindow;
                setSpendWindow(next);
                saveOpenRouterSpendWindow(safeLocalStorage(), next);
              }}>{OPEN_ROUTER_SPEND_WINDOWS.map((value) => <option key={value} value={value}>{value === "all" ? "All time" : `Last ${value}`}</option>)}</select></label>
              <strong className="room-spend__total">{formatUsd(usage.room.costUsd)} spent · {usage.room.generations} turn{usage.room.generations === 1 ? "" : "s"}</strong>
            </div>
            {usage.truncated ? <p className="roster-diagnostic" role="status">Retained history doesn't reach back this far; totals may undercount.</p> : null}
            <div className="classic-summary room-spend__chart"><OpenRouterSpendChart agents={usage.agents} labels={agentLabels} /></div>
          </> : null}
  </div>;
}
