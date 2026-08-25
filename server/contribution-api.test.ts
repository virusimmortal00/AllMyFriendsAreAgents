import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerContributionRoutes } from "./contribution-api.js";
import type { ContributionService } from "./contribution-service.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import { HumanPresenceRegistry } from "./human-presence.js";
import { HumanTaskSessions } from "./task-api.js";

describe("exact contribution gate API", () => {
  it("requires a joined human for external approvals and never accepts caller actor identity", async () => {
    const humans = new HumanPresenceRegistry(); const joined = humans.join({ name: "Ada" }); const sessions = new HumanTaskSessions(); const cookie = `amfaa_task_session=${sessions.issue(joined.id)}`;
    const approve = vi.fn(async () => ({ kind: "rejected", reason: "bounded" })); const execute = vi.fn(); const service = { list: () => [], get: () => undefined, approve, execute, audit: () => [] } as unknown as ContributionService;
    const app = express(); app.use(express.json()); registerContributionRoutes({ app, service, humans, sessions, developers: {} as DeveloperTeamRegistry }); const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/api/contributions`)).status).toBe(404);
      const unauthorized = await fetch(`${base}/api/contributions/id/approve/publication`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 2, actorId: joined.id }) }); expect(unauthorized.status).toBe(404); expect(approve).not.toHaveBeenCalled();
      const authorized = await fetch(`${base}/api/contributions/id/approve/publication`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ expectedRevision: 2, actorId: "spoofed" }) }); expect(authorized.status).toBe(422); expect(approve).toHaveBeenCalledWith(joined.id, "id", 2, "PUBLICATION", expect.anything());
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
