import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeveloperTeamRegistry, hashToken } from "./developer-team.js";
import { HumanPresenceRegistry } from "./human-presence.js";
import { RoomStore } from "./room-store.js";
import { HumanTaskSessions, joinHumanWithTaskSession, registerTaskRoutes } from "./task-api.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-task-api-")); roots.push(root);
  const store = await RoomStore.open(root, path.join(root, "state"));
  const humans = new HumanPresenceRegistry();
  const human = humans.join({ id: "human-a", name: "Ada" });
  const sessions = new HumanTaskSessions();
  const cookie = `amfaa_task_session=${sessions.issue(human.id)}`;
  const developerToken = "d".repeat(40);
  const developerTeam = new DeveloperTeamRegistry([{ memberId: "agent-a", revision: 7, displayName: "Agent A", roles: ["AUTHOR"], capabilities: ["TASK_READ", "TASK_PROPOSE", "TASK_UPDATE"], tokenHash: hashToken(developerToken), createdAt: new Date().toISOString() }]);
  const app = express(); app.use(express.json());
  app.post("/api/humans", (request, response) => response.status(201).json(joinHumanWithTaskSession(request, response, humans, sessions)));
  registerTaskRoutes({ app, store, humans, sessions, developerTeam, broadcast() {} });
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (url: string, init: RequestInit = {}) => fetch(`${base}${url}`, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers as Record<string, string> | undefined) } });
  const callWithoutSession = (url: string, init: RequestInit = {}) => fetch(`${base}${url}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) } });
  return { call, callWithoutSession, store, humanId: human.id, developerToken, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

describe("identity-safe task API", () => {
  it("derives human identity, rejects spoofing and stale writes, and exposes the lifecycle", async () => {
    const api = await fixture();
    try {
      expect((await api.call("/api/tasks")).status).toBe(200);
      expect((await api.call("/api/tasks", { method: "POST", body: JSON.stringify({ title: "spoof", roomId: "other" }) })).status).toBe(400);
      const createdResponse = await api.call("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Ship task API", description: "Bounded room work" }) });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { taskId: string; revision: number; participants: { participantId: string }[] };
      expect(created.participants[0]?.participantId).toBe(api.humanId);
      const stale = await api.call(`/api/tasks/${created.taskId}/propose`, { method: "POST", body: JSON.stringify({ expectedRevision: 99 }) });
      expect(stale.status).toBe(409);
      let revision = 1;
      for (const action of ["propose", "approve", "start", "block", "unblock"] as const) {
        const response = await api.call(`/api/tasks/${created.taskId}/${action}`, { method: "POST", body: JSON.stringify({ expectedRevision: revision }) });
        expect(response.status).toBe(200); revision = (await response.json() as { revision: number }).revision;
      }
      const completed = await api.call(`/api/tasks/${created.taskId}/complete`, { method: "POST", body: JSON.stringify({ expectedRevision: revision, evidence: { targetId: "sha256:result" }, dispositions: [] }) });
      expect(completed.status).toBe(200); revision = (await completed.json() as { revision: number }).revision;
      const archived = await api.call(`/api/tasks/${created.taskId}/archive`, { method: "POST", body: JSON.stringify({ expectedRevision: revision }) });
      expect(archived.status).toBe(200); revision = (await archived.json() as { revision: number }).revision;
      const forked = await api.call(`/api/tasks/${created.taskId}/fork`, { method: "POST", body: JSON.stringify({ expectedRevision: revision }) });
      expect(forked.status).toBe(200);
      const detail = await (await api.call(`/api/tasks/${created.taskId}`)).json() as { history: unknown[]; task: { attribution: unknown[] } };
      expect(detail.history.length).toBeGreaterThan(6); expect(detail.task.attribution.length).toBeGreaterThan(6);
    } finally { await api.close(); }
  });

  it("never converts a caller-supplied human ID into task authority", async () => {
    const api = await fixture();
    try {
      const response = await api.callWithoutSession("/api/humans", { method: "POST", body: JSON.stringify({ id: api.humanId, name: "Impersonator" }) });
      expect(response.status).toBe(201);
      const joined = await response.json() as { id: string };
      expect(joined.id).not.toBe(api.humanId);
      expect(response.headers.get("set-cookie")).toContain("amfaa_task_session=");
      const resumed = await api.call("/api/humans", { method: "POST", body: JSON.stringify({ id: joined.id, name: "Session owner" }) });
      expect((await resumed.json() as { id: string }).id).toBe(api.humanId);
    } finally { await api.close(); }
  });

  it("authenticates assignment routes before checking whether an assignment exists", async () => {
    const api = await fixture();
    try {
      const lookup = vi.spyOn(api.store, "getAssignment");
      const response = await api.callWithoutSession("/api/tasks/secret/assign", { method: "POST", body: JSON.stringify({ expectedRevision: 1, assignmentId: "secret-assignment" }) });
      expect(response.status).toBe(401);
      expect(lookup).not.toHaveBeenCalled();
    } finally { await api.close(); }
  });

  it("requires explicit developer capabilities and confines proposal/update authority", async () => {
    const api = await fixture();
    try {
      expect((await api.call("/api/developer/tasks")).status).toBe(404);
      const headers = { Authorization: `Bearer ${api.developerToken}` };
      const proposedResponse = await api.call("/api/developer/tasks", { method: "POST", headers, body: JSON.stringify({ title: "Agent proposal" }) });
      expect(proposedResponse.status).toBe(201);
      const proposed = await proposedResponse.json() as { taskId: string; revision: number; state: string; attribution: { memberRevision?: number }[] };
      expect(proposed).toMatchObject({ state: "proposed" });
      expect(proposed.attribution.every(({ memberRevision }) => memberRevision === 7)).toBe(true);
      const forbidden = await api.call(`/api/developer/tasks/${proposed.taskId}`, { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: proposed.revision, change: { kind: "transition", to: "approved" } }) });
      expect(forbidden.status).toBe(400);
      const edited = await api.call(`/api/developer/tasks/${proposed.taskId}`, { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: proposed.revision, change: { kind: "set_description", description: "analysis only" } }) });
      expect(edited.status).toBe(200);
      expect((await edited.json() as { attribution: { memberRevision?: number }[] }).attribution.at(-1)?.memberRevision).toBe(7);
    } finally { await api.close(); }
  });
});
