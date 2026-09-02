import type express from "express";
import type { ControlSessionResponse } from "../shared/control-session.js";
import { clearControlSession, controlRoute, setControlSession, type ControlPlaneStore } from "./control-plane.js";
import type { ModelDiscoveryService } from "./model-discovery.js";

const LOCAL_HANDOFF = ["opencode", "auth", "login"] as const;

export function registerControlPlaneRoutes(input: { app: express.Express; control: ControlPlaneStore; discovery: ModelDiscoveryService }) {
  const { app, control, discovery } = input;

  app.get("/api/control/status", (_request, response) => {
    const status = control.status();
    response.set("Cache-Control", "no-store").json({ claimed: status.claimed, bootstrapConfigured: status.bootstrapConfigured });
  });
  app.post("/api/control/bootstrap", controlRoute(async (request, response) => {
    const principal = await control.bootstrap(request.body?.bootstrapSecret, request.body?.username, request.body?.password);
    const authenticated = await control.authenticate(request.body?.username, request.body?.password);
    if (!authenticated) throw new Error("Bootstrapped owner authentication failed.");
    setControlSession(response, authenticated.token);
    response.set("Cache-Control", "no-store").status(201).json({ principal, csrfToken: authenticated.csrfToken, expiresAt: authenticated.expiresAt } satisfies ControlSessionResponse);
  }));
  app.post("/api/control/login", controlRoute(async (request, response) => {
    const authenticated = await control.authenticate(request.body?.username, request.body?.password);
    if (!authenticated) return response.status(401).json({ error: "Control-plane credentials are invalid." });
    setControlSession(response, authenticated.token);
    response.set("Cache-Control", "no-store").json({ principal: authenticated.principal, csrfToken: authenticated.csrfToken, expiresAt: authenticated.expiresAt } satisfies ControlSessionResponse);
  }));
  app.post("/api/control/logout", controlRoute((request, response) => { control.require(request, undefined, true); control.logout(request); clearControlSession(response); response.status(204).end(); }));
  app.get("/api/control/me", controlRoute((request, response) => { const session = control.require(request); response.set("Cache-Control", "no-store").json({ principal: session.publicPrincipal, csrfToken: session.csrfToken, expiresAt: session.expiresAt } satisfies ControlSessionResponse); }));
  app.get("/api/control/principals", controlRoute((request, response) => { const actor = control.require(request).principal; response.set("Cache-Control", "no-store").json({ principals: control.principals(actor) }); }));
  app.post("/api/control/principals", controlRoute(async (request, response) => { const actor = control.require(request, undefined, true).principal; response.status(201).json(await control.createPrincipal(actor, request.body || {})); }));
  app.put("/api/control/principals/:id/grants", controlRoute(async (request, response) => { const actor = control.require(request, undefined, true).principal; response.json(await control.updateGrants(actor, String(request.params.id), request.body || {})); }));
  app.get("/api/control/audit", controlRoute(async (request, response) => { const actor = control.require(request).principal; response.set("Cache-Control", "no-store").json({ events: await control.audit(actor) }); }));

  app.get("/api/provider-setup", controlRoute(async (request, response) => {
    control.require(request, "PROVIDER_VIEW");
    const modelDiscovery = await discovery.discover();
    response.set("Cache-Control", "no-store").json({
      provider: { discovery: modelDiscovery, setup: { mode: "server-local-handoff", command: LOCAL_HANDOFF, browserHostIsServerHost: false } },
    });
  }));
  app.post("/api/provider-setup/initiate", controlRoute(async (request, response) => {
    const actor = control.require(request, "PROVIDER_CONFIGURE", true).principal;
    await control.recordAudit(actor.id, "PROVIDER_SETUP_INITIATED", "opencode", { mode: "server-local-handoff" });
    response.status(202).json({ mode: "server-local-handoff", command: LOCAL_HANDOFF, instruction: "Run this exact command in a terminal on the server host. Credentials remain in OpenCode or the operating-system keychain. Return here and refresh readiness." });
  }));
  app.post("/api/provider-setup/refresh", controlRoute(async (request, response) => {
    const actor = control.require(request, "PROVIDER_CONFIGURE", true).principal;
    const result = await discovery.discover(true);
    const action = result.status === "available" || result.status === "discovery_unsupported" ? "PROVIDER_SETUP_COMPLETED" : "PROVIDER_SETUP_FAILED";
    if (result.status === "authentication_required") await control.recordAudit(actor.id, "CREDENTIAL_REVOCATION_SIGNAL", "opencode", { status: result.status });
    await control.recordAudit(actor.id, action, "opencode", { status: result.status });
    response.set("Cache-Control", "no-store").json(result);
  }));
}
