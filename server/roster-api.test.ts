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
import { ControlError, ControlPlaneStore, CONTROL_SESSION_COOKIE } from "./control-plane.js";
import { registerControlPlaneRoutes } from "./control-plane-api.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(options:{control?:boolean;capabilities?:boolean;realControl?:boolean;claimed?:boolean;humanIsMember?:(humanId:string)=>boolean}={}) {
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
  const control=options.realControl ? await ControlPlaneStore.open(root, "test-bootstrap-proof") : options.control?{require:(request:express.Request,capability:string)=>{if(request.header("x-test-capability")!==capability)throw new ControlError(403,`${capability} required`);return{principal:{id:"operator"}};},recordAudit:vi.fn(async()=>undefined)} as unknown as ControlPlaneStore:undefined;
  if (options.claimed) await control!.bootstrap("test-bootstrap-proof", "owner", "test-owner-password");
  if (options.realControl) registerControlPlaneRoutes({ app, control: control!, discovery });
  const auditChange = vi.fn(async () => undefined);
  const capabilityStatuses=options.capabilities?()=>({"codex-sol":{agentId:"codex-sol",policyRevision:1 as const,capabilities:{conversation:{configured:true,runtimeAvailable:true,effective:true,reason:"available" as const,guidance:"safe"},room_diagnostics:{configured:true,runtimeAvailable:true,effective:true,reason:"available" as const,guidance:"safe",contract:"read-only" as const},github_read:{configured:false,runtimeAvailable:false,effective:false,reason:"not_configured" as const,guidance:"Configure server-only read access.",contract:"read-only" as const},project_write:{configured:false,runtimeAvailable:false,effective:false,reason:"governed_worker_only" as const,guidance:"Use a worker."}},effectiveCommands:[],commands:{}}}):undefined;
  registerRosterRoutes({ app, store, humans, sessions, processes, generations, discovery, control, capabilityStatuses, humanIsMember: options.humanIsMember, auditChange, broadcast() {} });
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (url: string, init: RequestInit = {}, authenticated = true) => fetch(`${base}${url}`, { ...init, headers: { "Content-Type": "application/json", ...(authenticated ? { Cookie: cookie, "X-AMFAA-CSRF": sessions.csrfToken(cookie)! } : {}), ...(init.headers as Record<string, string> | undefined) } });
  return { call, store, processes, generations, control, discovery, auditChange, sessions, human, cookie, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

describe("live roster API", () => {
  it.each([false, true])("lets room members manage agents with owner claimed=%s", async (claimed) => {
    const api = await fixture({ realControl: true, claimed, humanIsMember: () => true });
    try {
      const projection = await (await api.call("/api/roster")).json();
      expect(projection.access.kind).toBe("room-member");
      const headers = { "X-AMFAA-CSRF": projection.access.csrfToken };
      const entry = { agentId: "agent-55555555-5555-4555-8555-555555555555", conversationalName: "Scout", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, commandPermissions: { allowAll: false, allowed: ["help", "gh"], catalogRevision: 2 } };
      const save = (expectedRevision: number, entries: unknown[]) => api.call("/api/roster", { method: "PUT", headers, body: JSON.stringify({ expectedRevision, entries }) });
      expect((await save(1, [entry])).status).toBe(200);
      const edited = { ...entry, conversationalName: "Reviewer", providerId: "anthropic", modelId: "claude-opus-5", enabled: false, commandPermissions: { allowAll: false, allowed: ["help"], catalogRevision: 2 } };
      expect((await save(2, [edited])).status).toBe(200);
      expect(api.store.snapshot().roster?.entries).toEqual([expect.objectContaining(edited)]);
      expect((await save(3, [{ ...edited, enabled: true }])).status).toBe(200);
      const conflict = await save(3, []);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ actualRevision: 4, roster: { revision: 4 } });
      expect((await save(4, [])).status).toBe(200);
      expect(api.store.snapshot().roster?.entries).toEqual([]);
      expect(api.auditChange).toHaveBeenCalledTimes(4);
      expect(api.auditChange).toHaveBeenLastCalledWith({ roomId: api.store.roomId, actorKind: "room-member", actorId: api.human.id, previousRevision: 4, nextRevision: 5 });
      expect((await api.call("/api/model-discovery/refresh", { method: "POST", headers, body: "{}" })).status).toBe(200);
      // Authorized catalog access reaches validation, not a control-plane sign-in gate.
      expect((await api.call("/api/model-details")).status).toBe(400);
      for (const [route, method] of [["/api/provider-setup/initiate", "POST"], ["/api/provider-setup/refresh", "POST"], ["/api/control/principals", "GET"], ["/api/control/audit", "GET"]]) {
        expect((await api.call(route, { method, ...(method === "POST" ? { body: "{}" } : {}) })).status).toBe(401);
      }
    } finally { await api.close(); }
  });

  it("rejects missing, forged, and cross-session CSRF tokens before discovery or mutation", async () => {
    const api = await fixture({ realControl: true });
    try {
      const foreignCookie = `${HUMAN_SESSION_COOKIE}=${api.sessions.issue("another-human")}`;
      for (const token of ["", "forged", api.sessions.csrfToken(foreignCookie)!]) {
        for (const [route, method, body] of [["/api/roster", "PUT", JSON.stringify({ expectedRevision: 1, entries: [] })], ["/api/model-discovery/refresh", "POST", "{}"]]) {
          expect((await api.call(route, { method, headers: { "X-AMFAA-CSRF": token }, body })).status).toBe(403);
        }
      }
      expect(api.discovery.discover).not.toHaveBeenCalled();
      expect(api.store.snapshot().roster?.revision).toBe(1);
      expect(api.auditChange).not.toHaveBeenCalled();
      const access = (await (await api.call("/api/roster")).json()).access;
      expect((await api.call("/api/roster", { method: "PUT", headers: { "X-AMFAA-CSRF": access.csrfToken }, body: JSON.stringify({ expectedRevision: 1, entries: [] }) })).status).toBe(200);
    } finally { await api.close(); }
  });

  it("denies unauthenticated and nonmember requests before parsing or discovery", async () => {
    const api = await fixture({ realControl: true, humanIsMember: () => false });
    try {
      for (const authenticated of [false, true]) {
        for (const [route, method] of [["/api/roster", "GET"], ["/api/roster", "PUT"], ["/api/model-discovery/refresh", "POST"], ["/api/model-details", "GET"]]) {
          expect((await api.call(route, { method, ...(method !== "GET" ? { body: "{}" } : {}) }, authenticated)).status).toBe(authenticated ? 403 : 401);
        }
      }
      expect(api.discovery.discover).not.toHaveBeenCalled();
      expect(api.auditChange).not.toHaveBeenCalled();
      expect(api.store.snapshot().roster?.revision).toBe(1);
    } finally { await api.close(); }
  });

  it("rechecks membership after discovery and allows recovery after rejoining", async () => {
    let member = true;
    const api = await fixture({ realControl: true, humanIsMember: () => member });
    try {
      const discovered = await api.discovery.discover();
      vi.mocked(api.discovery.discover).mockImplementationOnce(async () => { member = false; return discovered; });
      const update = { method: "PUT", body: JSON.stringify({ expectedRevision: 1, entries: [] }) };
      expect((await api.call("/api/roster", update)).status).toBe(403);
      expect(api.store.snapshot().roster?.revision).toBe(1);
      expect(api.auditChange).not.toHaveBeenCalled();
      member = true;
      expect((await api.call("/api/roster", update)).status).toBe(200);
    } finally { await api.close(); }
  });

  it("retains explicit control grants and CSRF for callers without a room session", async () => {
    const api = await fixture({ realControl: true, claimed: true });
    try {
      const owner = (await api.control!.authenticate("owner", "test-owner-password"))!;
      const headers = { Cookie: `${CONTROL_SESSION_COOKIE}=${owner.token}` };
      const result = await (await api.call("/api/roster", { headers }, false)).json();
      expect(result.access).toEqual({ kind: "control", csrfToken: owner.csrfToken });
      const update = { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 1, entries: [] }) };
      expect((await api.call("/api/roster", update, false)).status).toBe(403);
      expect((await api.call("/api/roster", { ...update, headers: { ...headers, "X-AMFAA-CSRF": result.access.csrfToken } }, false)).status).toBe(200);
    } finally { await api.close(); }
  });

  it("serializes bounded capability diagnostics without credential material", async () => {
    const api = await fixture({ capabilities: true });
    try { const response = await api.call("/api/roster"); const { access, ...body } = await response.json(); expect(response.headers.get("cache-control")).toBe("no-store"); expect(access).toEqual({ kind: "room-member", csrfToken: api.sessions.csrfToken(api.cookie) }); expect(body.capabilityStatuses["codex-sol"].capabilities.github_read).toEqual({ configured: false, runtimeAvailable: false, effective: false, reason: "not_configured", guidance: "Configure server-only read access.", contract: "read-only" }); expect(JSON.stringify(body)).not.toMatch(/token|authorization|password/i); }
    finally { await api.close(); }
  });

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
