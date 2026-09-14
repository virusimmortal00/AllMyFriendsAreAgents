import { useEffect, useState } from "react";
import { ApiRequestError, loadOpenRouterUsageWindow } from "./api";
import { OPEN_ROUTER_SPEND_WINDOWS, type OpenRouterSpendWindow, type OpenRouterUsageWindow } from "../shared/openrouter-usage";
import { formatUsd } from "../shared/currency";
import { OpenRouterSpendChart } from "./spend-chart";
import { OpenRouterMark } from "./openrouter-mark";
import { loadOpenRouterSpendWindow, saveOpenRouterSpendWindow } from "./openrouter-spend-window";
import { VIEWS, viewAttributes } from "./view-registry";

const CHECKED_AT_FORMATTER = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });

/** The room's dedicated view of its OpenRouter account: remaining credits, spend by time window, and spend by agent. */
export function OpenRouterAccount({ agentLabels, refreshKey = 0 }: { agentLabels?: Readonly<Record<string, string>>; refreshKey?: number }) {
  const [spendWindow, setSpendWindow] = useState<OpenRouterSpendWindow>(() => loadOpenRouterSpendWindow(typeof window === "undefined" ? undefined : window.localStorage));
  const [usage, setUsage] = useState<OpenRouterUsageWindow>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    loadOpenRouterUsageWindow(spendWindow, controller.signal).then((value) => {
      setUsage(value);
      setNotConfigured(false);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiRequestError && reason.status === 404) { setNotConfigured(true); return; }
      setError(reason instanceof Error ? reason.message : "OpenRouter usage could not be loaded.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [spendWindow, refreshKey, manualRefresh]);

  const credits = usage?.credits;

  return (
    <section className="workspace-view openrouter-account" aria-label="OpenRouter account" {...viewAttributes(VIEWS.openRouterAccount)}>
      <header className="workspace-view__header"><h2>OpenRouter account</h2></header>
      <div className="workspace-view__body openrouter-account__body">
        {notConfigured ? (
          <div className="task-empty"><strong>OpenRouter spend tracking is not configured on this server.</strong></div>
        ) : error ? (
          <div className="task-error" role="alert">{error}</div>
        ) : loading && !usage ? (
          <p role="status">Loading OpenRouter usage…</p>
        ) : usage ? (
          <>
            <section className="openrouter-credits" aria-label="Remaining OpenRouter credits">
              <div className="openrouter-credits__brand"><OpenRouterMark size={26} /><span>OpenRouter</span></div>
              {credits ? (
                <>
                  <div className="openrouter-credits__headline"><strong>{formatUsd(credits.remainingUsd)}</strong><span>available</span></div>
                  <div className="openrouter-credits__meta">
                    <span>Checked {CHECKED_AT_FORMATTER.format(new Date(credits.fetchedAt))}</span>
                    <button type="button" className="classic-button" disabled={loading} onClick={() => setManualRefresh((current) => current + 1)}>{loading ? "Checking…" : "Refresh"}</button>
                  </div>
                </>
              ) : <p>Connect an OpenRouter API key to see your remaining balance here.</p>}
            </section>
            <div className="openrouter-account__toolbar">
              <label>Window<select className="classic-select" aria-label="Spend time window" value={spendWindow} onChange={(event) => {
                const next = event.target.value as OpenRouterSpendWindow;
                setSpendWindow(next);
                saveOpenRouterSpendWindow(typeof window === "undefined" ? undefined : window.localStorage, next);
              }}>{OPEN_ROUTER_SPEND_WINDOWS.map((value) => <option key={value} value={value}>{value === "all" ? "All time" : `Last ${value}`}</option>)}</select></label>
              <span className="openrouter-account__total">{formatUsd(usage.room.costUsd)} spent · {usage.room.generations} turn{usage.room.generations === 1 ? "" : "s"}</span>
            </div>
            {usage.truncated ? <p className="roster-diagnostic" role="status">Retained history doesn't reach back this far; totals may undercount.</p> : null}
            <OpenRouterSpendChart agents={usage.agents} labels={agentLabels} />
          </>
        ) : null}
      </div>
    </section>
  );
}
