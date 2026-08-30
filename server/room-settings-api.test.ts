import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelDiscoveryService } from "./model-discovery.js";
import { DEFAULT_ROOM_BASE_PROMPT } from "./room-configuration.js";
import { registerRoomSettingsRoutes } from "./room-settings-api.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("room settings API", () => {
  it("serves defaults, validates edits, authorizes writes, and persists revisioned audit history", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-room-settings-"));
    temporaryDirectories.push(projectRoot);
    const databasePath = path.join(projectRoot, "amfaa.sqlite");
    const store = await SqliteRoomRepository.open(projectRoot, databasePath);
    let discoverCalls = 0;
    const discovery = { discover: async () => { discoverCalls += 1; return { status: "available", discoveredAt: "2026-08-27T00:00:00.000Z", models: [{ providerId: "opencode", modelId: "muse-spark-1.2-contributor-free", displayName: "Muse Spark 1.2 Contributor Free", provenance: "opencode-catalog", variants: [{ id: "minimal", displayName: "Minimal" }] }] }; } } as unknown as ModelDiscoveryService;
    const app = express();
    let promotionEligible = false;
    app.use(express.json());
    registerRoomSettingsRoutes({
      app, store, discovery, broadcast: () => undefined,
      authorizeView: () => true,
      authorizeEdit: (request, response) => request.header("x-edit") === "yes" ? "owner" : (response.status(403).json({ error: "Forbidden" }), undefined),
      routingEvidence: async () => ({ recordedDecisions: 1, recordedAgents: 1, shadowSuppressions: 1, evaluatedShadowSuppressions: 1, falseSuppressions: 0, falseSuppressionRate: 0, firstShadowDecisionAt: "2026-08-20T00:00:00.000Z", shadowDaysRecorded: 7, promotionEligible, promotionEligibilityReasons: promotionEligible ? [] : ["minimum_shadow_window_not_reached"], outcomeTallies: { invoke: 0, suppress: 1, unavailable: 0 }, reasonTallies: { no_routing_signal: 1 }, dispositionTallies: { speak: 0, yield: 1 } }),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const put = (body: unknown, authorized = true) => fetch(`${base}/api/room/settings`, { method: "PUT", headers: { "Content-Type": "application/json", ...(authorized ? { "X-Edit": "yes" } : {}) }, body: JSON.stringify(body) });
    try {
      const defaults = await (await fetch(`${base}/api/room/settings`)).json() as { settings: { basePromptText: string; basePromptRevision: number; summarizerModel: { modelId: string } }; routingEvidence: { promotionEligible: boolean } };
      expect(defaults.settings).toMatchObject({ configurationRevision: 0, basePromptText: DEFAULT_ROOM_BASE_PROMPT, basePromptRevision: 0, preflightMode: "off", summarizerModel: { modelId: "muse-spark-1.2-contributor-free" } });
      expect(defaults.routingEvidence.promotionEligible).toBe(false);
      expect(discoverCalls).toBe(0);
      const models = await (await fetch(`${base}/api/room/settings/models`)).json() as { models: unknown[] };
      expect(models.models).toHaveLength(1);
      expect(discoverCalls).toBe(1);
      expect((await put({ basePromptText: "x" }, false)).status).toBe(403);
      expect((await put({ basePromptText: "x".repeat(4_001) })).status).toBe(400);
      expect((await put({ summarizerModel: { providerId: "missing", modelId: "unknown" }, summarizerPromptText: "{{transcript}}" })).status).toBe(400);
      const response = await put({ basePromptText: "Room-specific rule", summarizerModel: { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free", variant: "minimal" }, summarizerPromptText: "Summarize exactly:\n{{transcript}}", featureFlags: { preflightInvocationGating: false }, preflightMode: "shadow" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ settings: { configurationRevision: 1, basePromptRevision: 1, summarizerPromptRevision: 1, basePromptText: "Room-specific rule", preflightMode: "shadow" } });
      expect((await put({ preflightMode: "enforce" })).status).toBe(409);
      promotionEligible = true;
      expect((await put({ preflightMode: "enforce" })).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
    }
    const reopened = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(await reopened.getRoomConfiguration()).toMatchObject({ configurationRevision: 2, basePromptRevision: 1, summarizerPromptRevision: 1, basePromptText: "Room-specific rule", preflightMode: "enforce" });
    reopened.close();
    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_settings_history").get()).toEqual({ count: 2 });
    expect(() => database.prepare("DELETE FROM room_settings_history").run()).toThrow(/append-only/);
    database.close();
  });
});
