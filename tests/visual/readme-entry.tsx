import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { DEFAULT_PARTICIPANT_STYLES } from "../../shared/chat-style";
import { normalizeRoomAgentRoster } from "../../shared/roster";
import type { ModelDiscoveryResult } from "../../shared/model-discovery";
import type { RoomState } from "../../src/types";
import { appFixtureResponse, fixtureHuman, fixtureRoom, fixtureTime } from "./app-fixtures";
import catalog from "./readme-models.json";
import "../../src/styles.css";

// Documentation-only entry point. Dialogue is authored example copy; real model
// names and metadata come from the saved public catalog, not a live room session.
// No production entry point imports this file, and no API request leaves this page.
const models: ModelDiscoveryResult = {
  status: "available", discoveredAt: catalog.capturedAt,
  models: catalog.models.map(({ alias: _alias, ...model }) => ({ ...model, provenance: "opencode-catalog" })),
};
const roster = normalizeRoomAgentRoster({ schemaVersion: 3, revision: 1,
  entries: catalog.models.map(({ alias: conversationalName }, index) => ({
    agentId: `agent-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    conversationalName, providerId: "openrouter", modelId: models.models[index].modelId, enabled: true,
  })),
});
const styles = { ...DEFAULT_PARTICIPANT_STYLES };
for (const [index, entry] of roster.entries.entries()) {
  styles[entry.agentId] = { ...DEFAULT_PARTICIPANT_STYLES.you,
    textColor: ["#6c1974", "#2a7238", "#2d73b7", "#6e3b0a"][index],
  };
}
const room: RoomState = {
  ...fixtureRoom, roster,
  settings: { roomName: "The Idea Room", topic: "When does a helpful notification become noise?", conversationEnergy: "balanced", participantStyles: styles },
  availability: Object.fromEntries(roster.entries.map((entry) => [entry.agentId, true])),
  messages: [
    ["you", "Should our app send a notification every time an agent finishes a task? Challenge the idea before we build it."],
    [roster.entries[0].agentId, "Start with completion notifications. They let people step away without losing track of work."],
    [roster.entries[1].agentId, "I disagree with every completion. If five agents finish together, that is five interruptions for one piece of work."],
    [roster.entries[2].agentId, "Could we group results by task? One notification opens a shared summary, with each agent’s findings underneath."],
    ["you", "What should interrupt me immediately?"],
    [roster.entries[0].agentId, "A blocking question that only you can answer. Routine completions can wait for the grouped summary."],
    [roster.entries[1].agentId, "That resolves my concern. I would still let people opt into individual updates for a task they are actively watching."],
    [roster.entries[3].agentId, "Make the summary actionable: what finished, what needs a decision, and where to read the findings."],
  ].map(([speaker, text], index) => ({ id: `readme-${index}`, speaker,
    speakerName: speaker === "you" ? "Alex" : roster.entries.find((entry) => entry.agentId === speaker)!.conversationalName,
    style: styles[speaker], text,
    timestamp: new Date(Date.parse(fixtureTime) + index * 60_000).toISOString(),
  })),
};

localStorage.setItem("all-my-friends-are-agents-human", JSON.stringify(fixtureHuman));
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
  const method = init?.method || (input instanceof Request ? input.method : "GET");
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) throw new Error("README fixture blocks external fetches.");
  let result = appFixtureResponse(url.pathname + url.search, method, "readme");
  if (method === "GET" && url.pathname === "/api/state") result = { status: 200, body: room };
  if (method === "GET" && url.pathname === "/api/roster") result = { status: 200, body: { roster, catalog: [], modelDiscovery: models, access: { kind: "room-member", csrfToken: "fictional-fixture-csrf" } } };
  if (method === "GET" && url.pathname === "/api/control/me") result = { status: 401, body: { error: "Sign in to administer the server." } };
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
};
class ReadmeEventSource extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  private timer = window.setTimeout(() => this.onmessage?.(new MessageEvent("message", {
    data: JSON.stringify({ kind: "snapshot", reason: "initial", continuity: "fresh", streamId: "readme-fixture", version: 0, state: room }),
  })), 0);
  private heartbeat = window.setInterval(() => this.dispatchEvent(new Event("heartbeat")), 2000);
  close() { window.clearTimeout(this.timer); window.clearInterval(this.heartbeat); }
}
Object.defineProperty(window, "EventSource", { value: ReadmeEventSource, configurable: true });
createRoot(document.getElementById("root")!).render(<App />);
