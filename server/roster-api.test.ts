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
import { ControlError, type ControlPlaneStore } from "./control-plane.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(options:{control?:boolean}={}) {
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
  ].map((identity) => { const separator = identity.indexOf("/"); const providerId = identity.slice(0, separator); const modelId = identity.slice(separator + 1); return { providerId, modelId, displayName: identity, provenance: "opencode-catalog" as const }; }).concat([{ providerId: "openrouter", modelId: "~openai/gpt-latest", displayName: "openrouter/~openai/gpt-latest", provenance: "opencode-catalog" as const }]) })) } as unknown as ModelDiscoveryService;
  const app = express(); app.use(express.json());
  const control=options.control?{require:(request:express.Request,capability:string)=>{if(request.header("x-test-capability")!==capability)throw new ControlError(403,`${capability} required`);return{principal:{id:"operator"}};},recordAudit:vi.fn(async()=>undefined)} as unknown as ControlPlaneStore:undefined;
  registerRosterRoutes({ app, store, humans, sessions, processes, generations, discovery, control, broadcast() {} });
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (url: string, init: RequestInit = {}, authenticated = true) => fetch(`${base}${url}`, { ...init, headers: { "Content-Type": "application/json", ...(authenticated ? { Cookie: cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
  return { call, store, processes, generations, control, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
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

  it("creates a dynamic participant from an OpenRouter alias model", async () => {
    const api = await fixture();
    try {
      const response = await api.call("/api/roster", { method: "PUT", body: JSON.stringify({
        expectedRevision: 1,
        entries: [{ agentId: "agent-55555555-5555-4555-8555-555555555555", conversationalName: "Router", providerId: "openrouter", modelId: "~openai/gpt-latest", enabled: true }],
      }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ roster: { revision: 2, entries: [expect.objectContaining({ conversationalName: "Router", providerId: "openrouter", modelId: "~openai/gpt-latest" })] } });
    } finally { await api.close(); }
  });

  it("requires roster-management authority for command permission grants and revocations",async()=>{const api=await fixture({control:true});try{const before=api.store.snapshot().roster!;const grant=before.entries.map((entry,index)=>index===0?{...entry,commandPermissions:{allowAll:false,allowed:["help"]}}:entry);const denied=await api.call("/api/roster",{method:"PUT",headers:{"x-test-capability":"MODEL_SELECT"},body:JSON.stringify({expectedRevision:before.revision,entries:grant})},false);expect(denied.status).toBe(403);expect(api.store.snapshot().roster?.revision).toBe(before.revision);const accepted=await api.call("/api/roster",{method:"PUT",headers:{"x-test-capability":"ROSTER_MANAGE"},body:JSON.stringify({expectedRevision:before.revision,entries:grant})},false);expect(accepted.status).toBe(200);expect(api.control?.recordAudit).toHaveBeenCalledWith("operator","COMMAND_PERMISSIONS_CHANGED","codex-sol",{allowAll:false,allowedCommands:"help"});const granted=api.store.snapshot().roster!;const revoke=granted.entries.map((entry,index)=>index===0?{...entry,commandPermissions:{allowAll:true,allowed:["task","pov","poll","help"]}}:entry);expect((await api.call("/api/roster",{method:"PUT",headers:{"x-test-capability":"MODEL_SELECT"},body:JSON.stringify({expectedRevision:granted.revision,entries:revoke})},false)).status).toBe(403);}finally{await api.close();}});
});
