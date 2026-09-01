import { useState } from "react";
import App, { LoadingScreen, NameEntry } from "../../src/App";
import { AgentSettingsDialog, ConfirmationDialog, WorkshopDialog } from "../../src/components";
import { savePendingSend } from "../../src/client-persistence";
import { createImprovement } from "../../shared/improvement-domain";
import { workshopView } from "../../shared/workshop";
import type { WorkshopResponse } from "../../src/types";
import { fixtureHuman, fixtureRoom, fixtureTime } from "./app-fixtures";

export const appScenario = new URLSearchParams(location.search).get("scenario") || "room-chat";
// This entry is served only by the isolated fixture Vite config. The production
// bundle has no fixture imports, fake API, or authentication bypass.
localStorage.setItem("all-my-friends-are-agents-human", JSON.stringify(fixtureHuman));
if (appScenario === "pending-send-recovery") savePendingSend(localStorage, fixtureHuman.id, { clientMessageId: "visual-pending", text: "Please review the smaller navigation layout before continuing." });
if (appScenario === "improvement-not-found") history.replaceState(null, "", "/improvements/missing-review?scenario=improvement-not-found");

class FixtureEventSource extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  private timer = window.setTimeout(() => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ kind: "snapshot", reason: "initial", continuity: "fresh", streamId: "visual-stream", version: 0, state: { ...fixtureRoom, ...(appScenario === "connection-notices" ? { error: "The last room action could not finish. Your conversation and draft are preserved." } : {}) } }) })), 0);
  private heartbeat = window.setInterval(() => this.dispatchEvent(new Event("heartbeat")), 2_000);
  close() { window.clearTimeout(this.timer); window.clearInterval(this.heartbeat); }
}
Object.defineProperty(window, "EventSource", { value: FixtureEventSource, configurable: true });

const record = createImprovement({ id: "navigation-review", risk: "GUARDED", author: { id: "Alex", role: "AUTHOR", human: true }, claims: [{ id: "navigation", statement: "Navigation should remain clear at every supported screen size." }], now: fixtureTime });
const workshop: WorkshopResponse = { kind: "found", canonicalId: record.id, revisionLabel: "r1", state: record.state, risk: record.risk, updatedAt: fixtureTime, status: record.statusContract, evidence: [], revisions: [], milestones: [], audit: [], improvement: workshopView(record), emergencyStop: { active: false, reason: null, activatedAt: null } };

export function AppFixture() {
  const [overlayOpen, setOverlayOpen] = useState(true);
  if (appScenario === "startup") return <LoadingScreen />;
  if (appScenario === "join-room") return <NameEntry onJoin={() => undefined} />;
  if (appScenario === "join-recovery") return <LoadingScreen joining error="The room is temporarily unavailable. Try again or choose a different name." onRetry={() => undefined} onCancel={() => undefined} />;
  return <><App />{overlayOpen && appScenario === "agent-status" ? <AgentSettingsDialog agent={fixtureRoom.roster!.entries[0].agentId} providerId="fixture-provider" available={false} health={{ status: "cooldown", reason: "rate_limit", message: "The provider is temporarily busy. Try again shortly.", since: fixtureTime }} onClose={() => setOverlayOpen(false)} /> : null}
    {overlayOpen && appScenario.startsWith("improvement-workshop") ? <WorkshopDialog data={appScenario.endsWith("recovery") ? null : workshop} loading={false} missing={false} error={appScenario.endsWith("recovery") ? "The request timed out. Your conversation is still available." : ""} onRetry={() => undefined} onClose={() => setOverlayOpen(false)} /> : null}
    {overlayOpen && appScenario === "confirmation" ? <ConfirmationDialog returnFocusTo={null} title="Stop background work?" description="Current work will stop. You can review the saved results before starting again." confirmLabel="Stop work" onConfirm={() => setOverlayOpen(false)} onCancel={() => setOverlayOpen(false)} /> : null}
  </>;
}
