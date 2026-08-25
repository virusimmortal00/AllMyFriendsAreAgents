import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_SESSION_COOKIE, ControlPlaneStore } from "./control-plane.js";
import { registerControlPlaneRoutes } from "./control-plane-api.js";
import { ModelDiscoveryService } from "./model-discovery.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("control-plane API authorization", () => {
  it("gates provider setup, enforces CSRF, delegates capabilities, and audits only redacted metadata", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-control-api-"));
    const control = await ControlPlaneStore.open(directory, "local-bootstrap-secret-with-32-characters");
    const discovery = new ModelDiscoveryService(async (_command, args) => ({ stdout: args[0] === "models" ? "provider/model\n" : args[0] === "--list-models" ? "model - Model\n" : "1.0", stderr: "" }));
    const app = express(); app.use(express.json()); registerControlPlaneRoutes({ app, control, discovery });
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (route: string, init: RequestInit = {}, cookie = "", csrf = "") => fetch(`${base}${route}`, { ...init, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-AMFAA-CSRF": csrf } : {}), ...(init.headers as Record<string, string> | undefined) } });

    expect((await call("/api/provider-setup")).status).toBe(401);
    const bootstrap = await call("/api/control/bootstrap", { method: "POST", body: JSON.stringify({ bootstrapSecret: "local-bootstrap-secret-with-32-characters", username: "owner", password: "correct horse battery staple" }) });
    expect(bootstrap.status).toBe(201);
    const ownerCookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
    expect(ownerCookie).toContain(CONTROL_SESSION_COOKIE);
    const ownerBody = await bootstrap.json() as { csrfToken: string };
    expect((await call("/api/provider-setup/initiate", { method: "POST", body: "{}" }, ownerCookie)).status).toBe(403);
    const initiated = await call("/api/provider-setup/initiate", { method: "POST", body: "{}" }, ownerCookie, ownerBody.csrfToken);
    expect(await initiated.json()).toMatchObject({ mode: "server-local-handoff", command: ["opencode", "auth", "login"] });
    const setup = await (await call("/api/provider-setup", {}, ownerCookie)).json() as { provider: { setup: Record<string, unknown> } };
    expect(setup.provider.setup).toMatchObject({ mode: "server-local-handoff", command: ["opencode", "auth", "login"], browserHostIsServerHost: false });
    expect(setup.provider.setup).not.toHaveProperty("terminal");

    const createdResponse = await call("/api/control/principals", { method: "POST", body: JSON.stringify({ username: "operator", password: "operator password long", role: "MEMBER", capabilities: ["PROVIDER_VIEW"] }) }, ownerCookie, ownerBody.csrfToken);
    const created = await createdResponse.json() as { id: string; revision: number };
    const login = await call("/api/control/login", { method: "POST", body: JSON.stringify({ username: "operator", password: "operator password long" }) });
    const operatorCookie = login.headers.get("set-cookie")!.split(";")[0];
    const operatorCsrf = (await login.json() as { csrfToken: string }).csrfToken;
    expect((await call("/api/provider-setup", {}, operatorCookie)).status).toBe(200);
    expect((await call("/api/provider-setup/initiate", { method: "POST", body: "{}" }, operatorCookie, operatorCsrf)).status).toBe(403);
    expect((await call("/api/control/principals", { method: "POST", body: JSON.stringify({ username: "escalated", password: "escalated password long", role: "ADMIN", capabilities: [] }) }, operatorCookie, operatorCsrf)).status).toBe(403);
    await call(`/api/control/principals/${created.id}/grants`, { method: "PUT", body: JSON.stringify({ role: "MEMBER", capabilities: [], expectedRevision: created.revision }) }, ownerCookie, ownerBody.csrfToken);
    expect((await call("/api/provider-setup", {}, operatorCookie)).status).toBe(401);
    const audit = await (await call("/api/control/audit", {}, ownerCookie)).text();
    expect(audit).toContain("PROVIDER_SETUP_INITIATED");
    expect(audit).not.toContain("correct horse battery staple");
  });
});
