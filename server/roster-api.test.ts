import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveGenerationTracker } from "./active-generations.js";
import { AgentProcessSupervisor } from "./agent-runner.js";
import { HumanPresenceRegistry } from "./human-presence.js";
import { HUMAN_SESSION_COOKIE, HumanSessions } from "./human-session.js";
import { RoomStore } from "./room-store.js";
import { registerRosterRoutes } from "./roster-api.js";
import type { ModelDiscoveryService } from "./model-discovery.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-roster-api-")); roots.push(root);
  const store = await RoomStore.open(root, path.join(root, "state"));
  const humans = new HumanPresenceRegistry();
  const human = humans.join({ name: "Ada" });
  const sessions = new HumanSessions();
  const cookie = `${HUMAN_SESSION_COOKIE}=${sessions.issue(human.id)}`;
  const processes = new AgentProcessSupervisor();
  const generations = new ActiveGenerationTracker();
  const discovery = { discover: vi.fn(async () => ({ status: "available" as const, discoveredAt: new Date(0).toISOString(), models: [
    "openai/gpt-5.6-sol", "anthropic/claude-sonnet-5", "anthropic/claude-opus-5", "cursor/cursor-grok-4.6-high", "cursor/composer-2.5", "cursor/gemini-3.7-flash-high", "cursor/glm-5.2-high",
  ].map((identity) => { const [providerId, modelId] = identity.split("/"); return { providerId, modelId, displayName: identity, provenance: "opencode-catalog" as const }; }) })) } as unknown as ModelDiscoveryService;
  const app = express(); app.use(express.json());
  registerRosterRoutes({ app, store, humans, sessions, processes, generations, discovery, broadcast() {} });
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (url: string, init: RequestInit = {}, authenticated = true) => fetch(`${base}${url}`, { ...init, headers: { "Content-Type": "application/json", ...(authenticated ? { Cookie: cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
  return { call, store, processes, generations, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

describe("live roster API", () => {
  it("requires a joined human and rejects unsupported or stale replacements", async () => {
    const api = await fixture();
    try {
      expect((await api.call("/api/roster", {}, false)).status).toBe(401);
      expect((await api.call("/api/roster", { method: "PUT", body: JSON.stringify({ expectedRevision: 1, entries: [{ agentId: "shell", enabled: true, command: "sh" }] }) })).status).toBe(400);
      expect((await api.call("/api/roster", { method: "PUT", body: JSON.stringify({ expectedRevision: 1, entries: [{ agentId: "codex-sol", conversationalName: "Sol", providerId: "missing", modelId: "missing", enabled: true }] }) })).status).toBe(400);
      const accepted = await api.call("/api/roster", { method: "PUT", body: JSON.stringify({ expectedRevision: 1, entries: [{ agentId: "claude-opus", enabled: true }] }) });
      expect(accepted.status).toBe(200);
      expect((await accepted.json() as { roster: { revision: number } }).roster.revision).toBe(2);
      const conflict = await api.call("/api/roster", { method: "PUT", body: JSON.stringify({ expectedRevision: 1, entries: [] }) });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ kind: "conflict", actualRevision: 2, roster: { revision: 2 } });
    } finally { await api.close(); }
  });

  it("terminates deactivated agent work and clears visible generation state", async () => {
    const api = await fixture();
    try {
      const terminate = vi.spyOn(api.processes, "terminateScope");
      api.generations.start("generation-sol", "codex-sol");
      const response = await api.call("/api/roster", { method: "PUT", body: JSON.stringify({ expectedRevision: 1, entries: [{ agentId: "claude-sonnet", enabled: true }] }) });
      expect(response.status).toBe(200);
      expect(terminate).toHaveBeenCalledWith("agent:codex-sol");
      expect(api.generations.snapshot()).toEqual({});
    } finally { await api.close(); }
  });
});
