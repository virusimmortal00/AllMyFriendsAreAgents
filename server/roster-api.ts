import type express from "express";
import { AGENT_PROFILES, SUPPORTED_AGENT_IDS, type ActiveAgentId } from "../shared/participants.js";
import { enabledRoomAgentIds, normalizeRoomAgentRoster, validateRosterEntries } from "../shared/roster.js";
import type { ActiveGenerationTracker } from "./active-generations.js";
import type { AgentProcessSupervisor } from "./agent-runner.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import { sessionHuman, type HumanSessions } from "./human-session.js";
import type { RoomRepository } from "./storage/room-repository.js";

export function registerRosterRoutes(input: {
  app: express.Express;
  store: RoomRepository;
  humans: HumanPresenceRegistry;
  sessions: HumanSessions;
  processes: AgentProcessSupervisor;
  generations: ActiveGenerationTracker;
  broadcast: () => void;
}) {
  const { app, store, humans, sessions, processes, generations, broadcast } = input;
  const requireHuman = (request: express.Request, response: express.Response) => {
    const human = sessionHuman(request, humans, sessions);
    if (!human) response.status(401).json({ error: "Join the room before managing agents." });
    return human;
  };
  const projection = () => ({
    roster: normalizeRoomAgentRoster(store.snapshot().roster),
    catalog: SUPPORTED_AGENT_IDS.map((agentId) => ({ ...AGENT_PROFILES[agentId], agentId })),
  });

  app.get("/api/roster", (request, response) => {
    if (!requireHuman(request, response)) return;
    response.set("Cache-Control", "no-store").json(projection());
  });

  app.put("/api/roster", async (request, response) => {
    if (!requireHuman(request, response)) return;
    const expectedRevision = request.body?.expectedRevision;
    const entries = validateRosterEntries(request.body?.entries);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !entries) {
      return response.status(400).json({ error: "A positive expectedRevision and unique supported roster entries are required." });
    }
    const before = normalizeRoomAgentRoster(store.snapshot().roster);
    const result = await store.updateRoster(expectedRevision, entries);
    if (result.kind === "conflict") return response.status(409).json({ ...result, ...projection() });
    const enabled = new Set(enabledRoomAgentIds(result.roster));
    const deactivated = enabledRoomAgentIds(before).filter((agent) => !enabled.has(agent));
    await Promise.all(deactivated.map((agent) => processes.terminateScope(`agent:${agent}`)));
    for (const agent of deactivated) generations.clearAgent(agent as ActiveAgentId);
    broadcast();
    return response.json(projection());
  });
}
