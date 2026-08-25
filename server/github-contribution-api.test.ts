import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { DeveloperTeamRegistry, hashToken } from "./developer-team.js";
import { registerGitHubContributionRoutes } from "./github-contribution-api.js";
import type { GitHubContributionBroker } from "./github-contribution-broker.js";

describe("GitHub contribution API", () => {
  it("hides configuration and targets from unauthenticated callers and derives the operation capability server-side", async () => {
    const token = "g".repeat(40);
    const developers = new DeveloperTeamRegistry([{ memberId: "publisher", revision: 1, displayName: "Publisher", roles: ["AUTHOR"],
      capabilities: ["GITHUB_READ", "GITHUB_COMMENT"], tokenHash: hashToken(token), createdAt: new Date().toISOString() }]);
    const execute = vi.fn(async () => ({ kind: "rejected", reason: "bounded" }));
    const audit = vi.fn(() => [{ idempotencyKey: "one" }]);
    const app = express(); app.use(express.json()); registerGitHubContributionRoutes({ app, developers, broker: { execute, audit } as unknown as GitHubContributionBroker });
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/api/developer/github/audit`)).status).toBe(404);
      expect((await fetch(`${base}/api/developer/github`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "COMMENT" }) })).status).toBe(404);
      const comment = await fetch(`${base}/api/developer/github`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ operation: "COMMENT" }) });
      expect(comment.status).toBe(403); expect(execute).toHaveBeenCalledOnce();
      const publish = await fetch(`${base}/api/developer/github`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ operation: "PUBLISH_DRAFT_PULL_REQUEST" }) });
      expect(publish.status).toBe(404); expect(execute).toHaveBeenCalledOnce();
      const visibleAudit = await fetch(`${base}/api/developer/github/audit`, { headers: { Authorization: `Bearer ${token}` } });
      expect(visibleAudit.status).toBe(200); expect(await visibleAudit.json()).toEqual({ records: [{ idempotencyKey: "one" }] });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("keeps the broker undiscoverable when it is not configured", async () => {
    const developers = { authenticate: vi.fn() } as unknown as DeveloperTeamRegistry;
    const app = express(); app.use(express.json()); registerGitHubContributionRoutes({ app, developers });
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/api/developer/github/audit`)).status).toBe(404);
      expect((await fetch(`${base}/api/developer/github`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "READ_ISSUE" }) })).status).toBe(404);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
