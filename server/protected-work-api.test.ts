import type { AddressInfo } from "node:net";
import express from "express";
import { expect, it, vi } from "vitest";
import { registerProtectedWorkRoutes } from "./protected-work-api.js";
import type { ProtectedWorkService } from "./protected-work-service.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import type { HumanSessions } from "./human-session.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";

it("requires current membership or scoped command authority and rejects extra authority fields", async () => {
  const start = vi.fn(async () => ({ workId: "protected-fixture" }));
  const action = vi.fn(async () => ({}));
  let present = false, member = false;
  const app = express(); app.use(express.json());
  registerProtectedWorkRoutes({ app, roomId: "room", service: { start, action, list: async () => [] } as unknown as ProtectedWorkService,
    humans: { get: () => present ? { id: "fixture-human", name: "Fixture" } : undefined } as unknown as HumanPresenceRegistry,
    sessions: { humanId: () => present ? "fixture-human" : undefined } as unknown as HumanSessions,
    member: async () => member,
    developers: { authenticate: (header: string, capability: string) => header === "Bearer fixture-command" || header === "Bearer fixture-read" && capability === "ROOM_READ" ? { member: { memberId: "fixture-cli" } } : undefined } as unknown as DeveloperTeamRegistry,
  });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/protected-work`;
  const body = { roomId: "room", owner: "codex-sol", objective: "Review", requestId: "fixture-request" };
  const post = (value: unknown, token = "", suffix = "") => fetch(base + suffix, { method: "POST", headers: { "content-type": "application/json", authorization: token }, body: JSON.stringify(value) });
  try {
    expect((await post(body)).status).toBe(404);
    expect((await post(body, "Bearer fixture-read")).status).toBe(404);
    expect((await fetch(base + "?roomId=room", { headers: { authorization: "Bearer fixture-read" } })).status).toBe(200);
    present = true; expect((await post(body)).status).toBe(404);
    member = true; expect((await post({ ...body, capabilities: ["EDIT"] })).status).toBe(400);
    expect((await post({ ...body, roomId: "other" })).status).toBe(400);
    expect(start).not.toHaveBeenCalled();
    expect((await post(body)).status).toBe(202); expect(start).toHaveBeenCalledOnce();
    member = false;
    expect((await post({ roomId: "room", requestId: "fixture-stop" }, "", "/protected-fixture/stop")).status).toBe(404);
    expect(action).not.toHaveBeenCalled();
    expect((await post(body, "Bearer fixture-command")).status).toBe(202);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
