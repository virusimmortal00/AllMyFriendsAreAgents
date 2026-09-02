import type express from "express";
import { AGENT_PROFILES, SUPPORTED_AGENT_IDS, type ActiveAgentId } from "../shared/participants.js";
import { selectedModelAvailability } from "../shared/model-discovery.js";
import type { AgentCapabilityStatus } from "../shared/capabilities.js";
import { enabledRoomAgentIds, normalizeRoomAgentRoster, participantConfigurationFingerprint, roomAgentModelReference, validateRosterEntries, type RoomRosterAccess } from "../shared/roster.js";
import type { ActiveGenerationTracker } from "./active-generations.js";
import type { AgentProcessSupervisor } from "./agent-runner.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import { sessionHuman, type HumanSessions } from "./human-session.js";
import type { RoomRepository } from "./storage/room-repository.js";
import { ModelDiscoveryService } from "./model-discovery.js";
import type { OpenRouterCatalogService } from "./openrouter-catalog.js";
import { ControlError, type ControlPlaneStore } from "./control-plane.js";
import { normalizeCommandPermissions } from "../shared/command-domain.js";
import { parseOpenRouterModelPageUrl } from "../shared/openrouter-model-page.js";

export function registerRosterRoutes(input: {
  app: express.Express;
  store: RoomRepository;
  humans: HumanPresenceRegistry;
  sessions: HumanSessions;
  processes: AgentProcessSupervisor;
  generations: ActiveGenerationTracker;
  broadcast: () => void | Promise<void>;
  discovery?: ModelDiscoveryService;
  intelligence?: OpenRouterCatalogService;
  control?: ControlPlaneStore;
  humanIsMember?: (humanId: string) => boolean;
  auditChange?: (change: { roomId: string; actorKind: "room-member" | "control"; actorId: string; previousRevision: number; nextRevision: number }) => Promise<unknown>;
  capabilityStatuses?: () => Readonly<Record<string, AgentCapabilityStatus>> | Promise<Readonly<Record<string, AgentCapabilityStatus>>>;
}) {
  const { app, store, humans, sessions, processes, generations, broadcast } = input;
  const discovery = input.discovery || new ModelDiscoveryService();
  const intelligence = input.intelligence;
  const control = input.control;
  const authorize = (request: express.Request, response: express.Response, capability: "PROVIDER_VIEW" | "MODEL_SELECT" | "ROSTER_MANAGE" | readonly ("PROVIDER_VIEW" | "MODEL_SELECT" | "ROSTER_MANAGE")[], csrf = false) => {
    // Room members manage this roster by default. Keep this policy local to the
    // roster/catalog routes; it grants no provider-configuration or admin powers.
    const human = sessionHuman(request, humans, sessions);
    if (human) {
      if (input.humanIsMember && !input.humanIsMember(human.id)) {
        response.status(403).json({ error: "Room membership is required to manage agents." });
        return undefined;
      }
      const csrfToken = sessions.csrfToken(request.header("cookie"));
      if (!csrfToken || (csrf && request.header("x-amfaa-csrf") !== csrfToken)) {
        response.status(403).json({ error: "Reload the roster to obtain a valid room-session CSRF token." });
        return undefined;
      }
      return { kind: "room-member" as const, human, csrfToken };
    }
    if (control) {
      const alternatives = Array.isArray(capability) ? capability : [capability];
      let failure: unknown;
      for (const candidate of alternatives) {
        try { return { kind: "control" as const, ...control.require(request, candidate, csrf) }; }
        catch (error) { failure = error; if (error instanceof ControlError && error.status === 401) break; }
      }
      const status = failure instanceof ControlError ? failure.status : 500; response.status(status).json({ error: failure instanceof Error ? failure.message : "Authorization failed." }); return undefined;
    }
    response.status(401).json({ error: "Join the room before managing agents." });
    return undefined;
  };
  const projection = async (refresh = false) => {
    const roster = normalizeRoomAgentRoster(store.snapshot().roster);
    const discovered = await discovery.discover(refresh);
    const modelDiscovery = intelligence ? await intelligence.enrich(discovered) : discovered;
    return {
      roster,
      catalog: SUPPORTED_AGENT_IDS.map((agentId) => ({ ...AGENT_PROFILES[agentId], agentId })),
      modelDiscovery,
      participantAvailability: Object.fromEntries(roster.entries.map((entry) => [entry.agentId, entry.selectionConfirmationRequired
        ? { available: false as const, reason: "selection_unpinnable" as const, diagnostic: entry.sessionInvalidationReason || "Confirm this participant's OpenCode model before it can run." }
        : selectedModelAvailability(roomAgentModelReference(entry), modelDiscovery)])),
      capabilityStatuses: input.capabilityStatuses ? await input.capabilityStatuses() : {},
    };
  };

  app.get("/api/roster", async (request, response) => {
    const authenticated = authorize(request, response, ["ROSTER_MANAGE", "MODEL_SELECT"]);
    if (!authenticated) return;
    response.set("Cache-Control", "no-store").json({ ...await projection(), access: { kind: authenticated.kind, csrfToken: authenticated.csrfToken } satisfies RoomRosterAccess });
  });

  app.post("/api/model-discovery/refresh", async (request, response) => {
    if (!authorize(request, response, "PROVIDER_VIEW", true)) return;
    const discovered = await discovery.discover(true);
    response.set("Cache-Control", "no-store").json(intelligence ? await intelligence.enrich(discovered) : discovered);
  });

  app.get("/api/model-details", async (request, response) => {
    if (!authorize(request, response, ["PROVIDER_VIEW", "MODEL_SELECT"])) return;
    const providerId = typeof request.query.providerId === "string" ? request.query.providerId : "";
    const modelId = typeof request.query.modelId === "string" ? request.query.modelId : "";
    if (!providerId || !modelId) return response.status(400).json({ error: "providerId and modelId are required." });
    if (!intelligence) return response.status(404).json({ error: "Live provider offers are not configured." });
    try {
      const details = await intelligence.details(providerId, modelId);
      if (!details) return response.status(404).json({ error: "Live provider offers are not available for this model." });
      return response.set("Cache-Control", "private, max-age=120").json(details);
    } catch {
      return response.status(503).json({ error: "Live provider offers are temporarily unavailable." });
    }
  });

  app.get("/api/openrouter-model-page", async (request, response) => {
    if (!authorize(request, response, ["PROVIDER_VIEW", "MODEL_SELECT"])) return;
    const pageUrl = typeof request.query.url === "string" ? request.query.url : "";
    if (!pageUrl) return response.status(400).json({ error: "An OpenRouter model page URL is required." });
    if (!parseOpenRouterModelPageUrl(pageUrl)) return response.status(400).json({ error: "Paste a full https://openrouter.ai/<maker>/<model> URL." });
    if (!intelligence) return response.status(404).json({ error: "OpenRouter model-page lookup is not configured." });
    const discovered = await discovery.discover();
    try {
      const resolution = await intelligence.resolveModelPage(pageUrl, discovered.models);
      if (!resolution) return response.status(400).json({ error: "Paste a full https://openrouter.ai/<maker>/<model> URL." });
      return response.set("Cache-Control", "no-store").json(resolution);
    } catch {
      return response.status(503).json({ error: "OpenRouter could not resolve that model page right now." });
    }
  });

  app.put("/api/roster", async (request, response) => {
    const authenticated = authorize(request, response, ["ROSTER_MANAGE", "MODEL_SELECT"], true);
    if (!authenticated) return;
    const expectedRevision = request.body?.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return response.status(400).json({ error: "A positive expectedRevision is required." });
    }
    const entries = validateRosterEntries(request.body?.entries)?.map((entry) => ({ ...entry, supportsProjectWrites: true }));
    if (!entries) {
      return response.status(400).json({ error: "Roster entries must use supported identifiers and unique participant IDs and conversational names." });
    }
    const before = normalizeRoomAgentRoster(store.snapshot().roster);
    const structuralChanged = entries.length !== before.entries.length || entries.some((entry, index) => {
      const previous = before.entries[index];
      return !previous || previous.agentId !== entry.agentId || previous.enabled !== entry.enabled || previous.conversationalName !== entry.conversationalName
        || JSON.stringify(normalizeCommandPermissions(previous.commandPermissions)) !== JSON.stringify(normalizeCommandPermissions(entry.commandPermissions));
    });
    const selectionChanged = entries.some((entry) => {
      const previous = before.entries.find((candidate) => candidate.agentId === entry.agentId);
      return !previous || participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(entry);
    });
    if (!authorize(request, response, structuralChanged ? "ROSTER_MANAGE" : "MODEL_SELECT", true)) return;
    if (control && structuralChanged && selectionChanged && !authorize(request, response, "MODEL_SELECT", true)) return;
    const modelDiscovery = await discovery.discover();
    const invalidSelection = entries.find((entry) => {
      const previous = before.entries.find((candidate) => candidate.agentId === entry.agentId);
      if (previous && participantConfigurationFingerprint(previous) === participantConfigurationFingerprint(entry)) return false;
      return !selectedModelAvailability(roomAgentModelReference(entry), modelDiscovery).available;
    });
    if (invalidSelection) return response.status(400).json({ error: "The selected OpenCode provider/model/variant is not currently available." });
    // Discovery can yield to other requests; recheck membership/grants before committing.
    if (!authorize(request, response, structuralChanged ? "ROSTER_MANAGE" : "MODEL_SELECT", true)) return;
    if (structuralChanged && selectionChanged && !authorize(request, response, "MODEL_SELECT", true)) return;
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
    await input.auditChange?.({ roomId: store.roomId, actorKind: authenticated.kind, actorId: authenticated.kind === "room-member" ? authenticated.human.id : authenticated.principal.id, previousRevision: before.revision, nextRevision: result.roster.revision });
    if (control && "principal" in authenticated) {
      for (const entry of result.roster.entries) {
        const previous = before.entries.find((candidate) => candidate.agentId === entry.agentId);
        if (!previous || participantConfigurationFingerprint(previous) !== participantConfigurationFingerprint(entry)) await control.recordAudit(authenticated.principal.id, "MODEL_SELECTION_CHANGED", entry.agentId, { previousRevision: previous?.configurationRevision || 0, nextRevision: entry.configurationRevision || 1 });
        if (!previous || JSON.stringify(normalizeCommandPermissions(previous.commandPermissions)) !== JSON.stringify(normalizeCommandPermissions(entry.commandPermissions))) await control.recordAudit(authenticated.principal.id, "COMMAND_PERMISSIONS_CHANGED", entry.agentId, { allowAll: normalizeCommandPermissions(entry.commandPermissions).allowAll, allowedCommands: normalizeCommandPermissions(entry.commandPermissions).allowed.join(",") });
      }
    }
    await broadcast();
    return response.set("Cache-Control", "no-store").json(await projection());
  });
}
