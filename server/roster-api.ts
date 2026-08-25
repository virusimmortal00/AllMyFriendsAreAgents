import type express from "express";
import { AGENT_PROFILES, SUPPORTED_AGENT_IDS, type ActiveAgentId } from "../shared/participants.js";
import { HARNESS_IDS, isHarnessId, selectedModelAvailability } from "../shared/model-discovery.js";
import { enabledRoomAgentIds, normalizeRoomAgentRoster, participantConfigurationFingerprint, roomAgentModelReference, validateRosterEntries } from "../shared/roster.js";
import type { ActiveGenerationTracker } from "./active-generations.js";
import type { AgentProcessSupervisor } from "./agent-runner.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import { sessionHuman, type HumanSessions } from "./human-session.js";
import type { RoomRepository } from "./storage/room-repository.js";
import { ModelDiscoveryService } from "./model-discovery.js";
import { ControlError, type ControlPlaneStore } from "./control-plane.js";

export function registerRosterRoutes(input: {
  app: express.Express;
  store: RoomRepository;
  humans: HumanPresenceRegistry;
  sessions: HumanSessions;
  processes: AgentProcessSupervisor;
  generations: ActiveGenerationTracker;
  broadcast: () => void;
  discovery?: ModelDiscoveryService;
  control?: ControlPlaneStore;
}) {
  const { app, store, humans, sessions, processes, generations, broadcast } = input;
  const discovery = input.discovery || new ModelDiscoveryService();
  const control = input.control;
  const authorize = (request: express.Request, response: express.Response, capability: "PROVIDER_VIEW" | "MODEL_SELECT" | "ROSTER_MANAGE" | readonly ("PROVIDER_VIEW" | "MODEL_SELECT" | "ROSTER_MANAGE")[], csrf = false) => {
    if (control) {
      const alternatives = Array.isArray(capability) ? capability : [capability];
      let failure: unknown;
      for (const candidate of alternatives) {
        try { return control.require(request, candidate, csrf); }
        catch (error) { failure = error; if (error instanceof ControlError && error.status === 401) break; }
      }
      const status = failure instanceof ControlError ? failure.status : 500; response.status(status).json({ error: failure instanceof Error ? failure.message : "Authorization failed." }); return undefined;
    }
    const human = sessionHuman(request, humans, sessions);
    if (!human) response.status(401).json({ error: "Join the room before managing agents." });
    return human;
  };
  const projection = async (refresh = false) => {
    const roster = normalizeRoomAgentRoster(store.snapshot().roster);
    const discoveries = await discovery.discoverAll(refresh);
    return {
      roster,
      catalog: SUPPORTED_AGENT_IDS.map((agentId) => ({ ...AGENT_PROFILES[agentId], agentId })),
      discoveries,
      participantAvailability: Object.fromEntries(roster.entries.map((entry) => [entry.agentId, selectedModelAvailability(roomAgentModelReference(entry), discoveries[entry.harness!])])),
    };
  };

  app.get("/api/roster", async (request, response) => {
    if (!authorize(request, response, ["ROSTER_MANAGE", "MODEL_SELECT"])) return;
    response.set("Cache-Control", "no-store").json(await projection());
  });

  app.post("/api/model-discovery/:harness/refresh", async (request, response) => {
    if (!authorize(request, response, "PROVIDER_VIEW", true)) return;
    const harness = String(request.params.harness);
    if (!isHarnessId(harness)) return response.status(400).json({ error: `Harness must be one of: ${HARNESS_IDS.join(", ")}.` });
    response.set("Cache-Control", "no-store").json(await discovery.discover(harness, true));
  });

  app.put("/api/roster", async (request, response) => {
    const expectedRevision = request.body?.expectedRevision;
    const entries = validateRosterEntries(request.body?.entries)?.map((entry) => ({ ...entry, supportsProjectWrites: true }));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !entries) {
      return response.status(400).json({ error: "A positive expectedRevision and unique supported roster entries are required." });
    }
    const before = normalizeRoomAgentRoster(store.snapshot().roster);
    const structuralChanged = entries.length !== before.entries.length || entries.some((entry, index) => {
      const previous = before.entries[index];
      return !previous || previous.agentId !== entry.agentId || previous.enabled !== entry.enabled || previous.conversationalName !== entry.conversationalName;
    });
    const selectionChanged = entries.some((entry) => {
      const previous = before.entries.find((candidate) => candidate.agentId === entry.agentId);
      return !previous || participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(entry);
    });
    const authenticated = control ? authorize(request, response, structuralChanged ? "ROSTER_MANAGE" : "MODEL_SELECT", true) : authorize(request, response, "ROSTER_MANAGE", true);
    if (!authenticated) return;
    if (control && structuralChanged && selectionChanged && !authorize(request, response, "MODEL_SELECT", true)) return;
    const discoveries = await discovery.discoverAll();
    const invalidSelection = entries.find((entry) => {
      const previous = before.entries.find((candidate) => candidate.agentId === entry.agentId);
      if (previous && participantConfigurationFingerprint(previous) === participantConfigurationFingerprint(entry)) return false;
      if (!entry.agentId.startsWith("agent-")) return false;
      return !selectedModelAvailability(roomAgentModelReference(entry), discoveries[entry.harness!]).available;
    });
    if (invalidSelection) return response.status(400).json({ error: `The selected ${invalidSelection.harness} provider/model/variant is not currently available.` });
    const result = await store.updateRoster(expectedRevision, entries);
    if (result.kind === "conflict") return response.status(409).json({ ...result, ...await projection() });
    const enabled = new Set(enabledRoomAgentIds(result.roster));
    const deactivated = enabledRoomAgentIds(before).filter((agent) => !enabled.has(agent));
    const reconfigured = result.roster.entries.flatMap((entry) => {
      const previous = before.entries.find((candidate) => candidate.agentId === entry.agentId);
      return previous && participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(entry) ? [entry.agentId] : [];
    });
    const invalidated = [...new Set([...deactivated, ...reconfigured])];
    await Promise.all(invalidated.map((agent) => processes.terminateScope(`agent:${agent}`)));
    for (const agent of invalidated) generations.clearAgent(agent as ActiveAgentId);
    if (control && "principal" in authenticated) {
      for (const entry of result.roster.entries) {
        const previous = before.entries.find((candidate) => candidate.agentId === entry.agentId);
        if (!previous || participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(entry)) await control.recordAudit(authenticated.principal.id, "MODEL_SELECTION_CHANGED", entry.agentId, { harness: entry.harness || null, previousRevision: previous?.configurationRevision || 0, nextRevision: entry.configurationRevision || 1 });
      }
    }
    broadcast();
    return response.json(await projection());
  });
}
