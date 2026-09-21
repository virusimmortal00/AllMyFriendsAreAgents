import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_SESSION_COOKIE, ControlPlaneStore } from "./control-plane.js";
import { registerOpenRouterIntegrationRoutes } from "./openrouter-integration-api.js";
import type { OpenRouterCreditBalance } from "../shared/openrouter-usage.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function harness(intelligence?: { credits: (forceRefresh?: boolean) => Promise<OpenRouterCreditBalance | undefined> }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-openrouter-integration-api-"));
  const control = await ControlPlaneStore.open(path.join(directory, "control"), "local-bootstrap-secret-with-32-characters");
  const app = express(); app.use(express.json());
  registerOpenRouterIntegrationRoutes({ app, control, ...(intelligence?{intelligence}:{}) });
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (route: string, cookie = "") => fetch(`${base}${route}`, { headers: cookie ? { cookie } : {} });
  await control.bootstrap("local-bootstrap-secret-with-32-characters", "owner", "correct horse battery staple");
  const owner = await control.authenticate("owner", "correct horse battery staple");
  if (!owner) throw new Error("owner authentication failed");
  const ownerCookie = `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(owner.token)}`;
  const ownerActor = control.require({ header: (name: string) => name.toLowerCase() === "cookie" ? ownerCookie : undefined } as express.Request).principal;
  await control.createPrincipal(ownerActor, { username: "viewer", password: "viewer password long", role: "MEMBER", capabilities: ["INTEGRATION_VIEW"] });
  await control.createPrincipal(ownerActor, { username: "roster-manager", password: "roster manager password long", role: "MEMBER", capabilities: ["ROSTER_MANAGE"] });
  const viewer = await control.authenticate("viewer", "viewer password long"); if (!viewer) throw new Error("viewer authentication failed");
  const rosterManager = await control.authenticate("roster-manager", "roster manager password long"); if (!rosterManager) throw new Error("roster-manager authentication failed");
  const viewerCookie = `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(viewer.token)}`;
  const rosterManagerCookie = `${CONTROL_SESSION_COOKIE}=${encodeURIComponent(rosterManager.token)}`;
  return { call, ownerCookie, viewerCookie, rosterManagerCookie };
}

describe("OpenRouter integration control-plane API", () => {
  it("serves the credit balance only to a capability holder, never to a plain control session", async () => {
    const credits = vi.fn(async (forceRefresh?: boolean) => ({ totalCreditsUsd: 100, totalUsageUsd: forceRefresh ? 90 : 73.85, remainingUsd: forceRefresh ? 10 : 26.15, fetchedAt: "2026-09-14T12:47:00.000Z" }));
    const { call, ownerCookie, viewerCookie, rosterManagerCookie } = await harness({ credits });

    expect((await call("/api/control/integrations/openrouter")).status).toBe(401);
    expect((await call("/api/control/integrations/openrouter", rosterManagerCookie)).status).toBe(403);

    const viewed = await call("/api/control/integrations/openrouter", viewerCookie);
    expect(viewed.status).toBe(200);
    expect(await viewed.json()).toEqual({ credits: { totalCreditsUsd: 100, totalUsageUsd: 73.85, remainingUsd: 26.15, fetchedAt: "2026-09-14T12:47:00.000Z" } });
    expect(credits).toHaveBeenLastCalledWith(false);

    const refreshed = await call("/api/control/integrations/openrouter?refresh=1", ownerCookie);
    expect(await refreshed.json()).toMatchObject({ credits: { remainingUsd: 10 } });
    expect(credits).toHaveBeenLastCalledWith(true);
  });

  it("reports not configured, and never lets a rejected balance fetch leak past a graceful empty response", async () => {
    const { call, ownerCookie } = await harness(undefined);
    expect((await call("/api/control/integrations/openrouter", ownerCookie)).status).toBe(404);

    const { call: callWithFailingIntelligence, ownerCookie: ownerCookie2 } = await harness({ credits: async () => { throw new Error("offline"); } });
    const response = await callWithFailingIntelligence("/api/control/integrations/openrouter", ownerCookie2);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });
});
