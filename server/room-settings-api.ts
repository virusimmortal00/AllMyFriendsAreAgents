import type express from "express";
import { validDiscoveryId, validModelDiscoveryId, type ModelReference } from "../shared/model-discovery.js";
import type { ModelDiscoveryService } from "./model-discovery.js";
import { DEFAULT_ROOM_BASE_PROMPT, type RoomConfigurationUpdate } from "./room-configuration.js";
import type { RoomRepository } from "./storage/room-repository.js";
import { isPreflightMode, type PreflightEvidence } from "../shared/preflight.js";

function modelReference(input: unknown): ModelReference | null | undefined {
  if (input === null) return null;
  if (!input || typeof input !== "object") return undefined;
  const value = input as Partial<ModelReference>;
  if (!validModelDiscoveryId(value.modelId) || value.providerId !== undefined && !validDiscoveryId(value.providerId) || value.variant !== undefined && !validDiscoveryId(value.variant)) return undefined;
  return { ...(value.providerId ? { providerId: value.providerId } : {}), modelId: value.modelId, ...(value.variant ? { variant: value.variant } : {}) };
}

function flags(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const entries = Object.entries(input);
  if (entries.length > 64 || entries.some(([key, value]) => !/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) || typeof value !== "boolean")) return undefined;
  return Object.fromEntries(entries) as Record<string, boolean>;
}

export function registerRoomSettingsRoutes(input: {
  app: express.Express;
  store: RoomRepository;
  discovery: ModelDiscoveryService;
  authorizeView: (request: express.Request, response: express.Response) => boolean;
  authorizeEdit: (request: express.Request, response: express.Response, modelSelection: boolean) => string | undefined;
  broadcast: () => void;
  routingEvidence?: () => Promise<PreflightEvidence>;
}) {
  const { app, store, discovery, authorizeView, authorizeEdit, broadcast, routingEvidence } = input;

  app.get("/api/room/settings", async (request, response) => {
    if (!authorizeView(request, response)) return;
    const [settings, evidence] = await Promise.all([
      store.getRoomConfiguration(),
      routingEvidence?.(),
    ]);
    response.set("Cache-Control", "no-store").json({
      settings,
      defaults: { basePromptText: DEFAULT_ROOM_BASE_PROMPT },
      ...(evidence ? { routingEvidence: evidence } : {}),
    });
  });

  app.get("/api/room/settings/models", async (request, response) => {
    if (!authorizeView(request, response)) return;
    response.set("Cache-Control", "no-store").json(await discovery.discover());
  });

  app.put("/api/room/settings", async (request, response) => {
    const body = request.body || {};
    const hasBase = Object.prototype.hasOwnProperty.call(body, "basePromptText");
    const hasModel = Object.prototype.hasOwnProperty.call(body, "summarizerModel");
    const hasSummaryPrompt = Object.prototype.hasOwnProperty.call(body, "summarizerPromptText");
    const hasFlags = Object.prototype.hasOwnProperty.call(body, "featureFlags");
    const hasPreflightMode = Object.prototype.hasOwnProperty.call(body, "preflightMode");
    if (!hasBase && !hasModel && !hasSummaryPrompt && !hasFlags && !hasPreflightMode) return response.status(400).json({ error: "At least one room setting is required." });
    if (hasBase && body.basePromptText !== null && typeof body.basePromptText !== "string") return response.status(400).json({ error: "basePromptText must be text or null." });
    if (typeof body.basePromptText === "string" && body.basePromptText.length > 4_000) return response.status(400).json({ error: "The room base prompt must be at most 4,000 characters." });
    const model = hasModel ? modelReference(body.summarizerModel) : undefined;
    if (hasModel && model === undefined) return response.status(400).json({ error: "Choose a valid summarizer model." });
    if (hasSummaryPrompt && (typeof body.summarizerPromptText !== "string" || !body.summarizerPromptText.trim() || body.summarizerPromptText.length > 8_000 || !body.summarizerPromptText.includes("{{transcript}}"))) {
      return response.status(400).json({ error: "The summarizer prompt must be non-empty, at most 8,000 characters, and include {{transcript}}." });
    }
    const featureFlags = hasFlags ? flags(body.featureFlags) : undefined;
    if (hasFlags && !featureFlags) return response.status(400).json({ error: "Feature flags must be a bounded object of boolean values." });
    if (hasPreflightMode && !isPreflightMode(body.preflightMode)) return response.status(400).json({ error: "Choose a valid pre-flight routing mode." });
    const actorId = authorizeEdit(request, response, hasModel);
    if (!actorId) return;
    if (model) {
      const discovered = await discovery.discover();
      const known = discovered.models.find((candidate) => candidate.modelId === model.modelId && (candidate.providerId || "") === (model.providerId || ""));
      if (!known || model.variant && !known.variants?.some(({ id }) => id === model.variant)) return response.status(400).json({ error: "The selected summarizer model is not in the current model catalog." });
    }
    if (body.preflightMode === "enforce" && (await store.getRoomConfiguration()).preflightMode !== "enforce") {
      const evidence = await routingEvidence?.();
      if (!evidence?.promotionEligible) return response.status(409).json({ error: "This room has not met the recorded shadow-evidence threshold for enforcement.", evidence });
    }
    const update: RoomConfigurationUpdate = {
      ...(hasBase ? { basePromptText: body.basePromptText as string | null } : {}),
      ...(hasModel ? { summarizerModel: model! } : {}),
      ...(hasSummaryPrompt ? { summarizerPromptText: body.summarizerPromptText as string } : {}),
      ...(hasFlags ? { featureFlags: featureFlags! } : {}),
      ...(hasPreflightMode ? { preflightMode: body.preflightMode } : {}),
    };
    const settings = await store.updateRoomConfiguration(update, actorId);
    broadcast();
    response.json({ settings });
  });
}
