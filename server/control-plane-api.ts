import type express from "express";
import { HARNESS_IDS, isHarnessId, type HarnessId } from "../shared/model-discovery.js";
import { clearControlSession, controlRoute, setControlSession, type ControlPlaneStore } from "./control-plane.js";
import type { ModelDiscoveryService } from "./model-discovery.js";

const LOCAL_HANDOFF: Record<HarnessId, readonly string[]> = {
  codex: ["codex", "login"],
  claude: ["claude", "auth", "login"],
  cursor: ["agent", "login"],
  opencode: ["opencode", "auth", "login"],
};

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
    response.status(201).json({ principal, csrfToken: authenticated.csrfToken });
  }));
  app.post("/api/control/login", controlRoute(async (request, response) => {
    const authenticated = await control.authenticate(request.body?.username, request.body?.password);
    if (!authenticated) return response.status(401).json({ error: "Control-plane credentials are invalid." });
    setControlSession(response, authenticated.token);
    response.json({ principal: authenticated.principal, csrfToken: authenticated.csrfToken });
  }));
  app.post("/api/control/logout", controlRoute((request, response) => { control.require(request, undefined, true); control.logout(request); clearControlSession(response); response.status(204).end(); }));
  app.get("/api/control/me", controlRoute((request, response) => { const session = control.require(request); response.set("Cache-Control", "no-store").json({ principal: session.publicPrincipal, csrfToken: session.csrfToken }); }));
  app.get("/api/control/principals", controlRoute((request, response) => { const actor = control.require(request).principal; response.set("Cache-Control", "no-store").json({ principals: control.principals(actor) }); }));
  app.post("/api/control/principals", controlRoute(async (request, response) => { const actor = control.require(request, undefined, true).principal; response.status(201).json(await control.createPrincipal(actor, request.body || {})); }));
  app.put("/api/control/principals/:id/grants", controlRoute(async (request, response) => { const actor = control.require(request, undefined, true).principal; response.json(await control.updateGrants(actor, String(request.params.id), request.body || {})); }));
  app.get("/api/control/audit", controlRoute(async (request, response) => { const actor = control.require(request).principal; response.set("Cache-Control", "no-store").json({ events: await control.audit(actor) }); }));

  app.get("/api/provider-setup", controlRoute(async (request, response) => {
    control.require(request, "PROVIDER_VIEW");
    const discoveries = await discovery.discoverAll();
    response.set("Cache-Control", "no-store").json({
      harnesses: Object.fromEntries(HARNESS_IDS.map((harness) => [harness, { discovery: discoveries[harness], setup: { mode: "server-local-handoff", command: LOCAL_HANDOFF[harness], browserHostIsServerHost: false } }])),
    });
  }));
  app.post("/api/provider-setup/:harness/initiate", controlRoute(async (request, response) => {
    const actor = control.require(request, "PROVIDER_CONFIGURE", true).principal;
    const harness = String(request.params.harness);
    if (!isHarnessId(harness)) return response.status(400).json({ error: `Harness must be one of: ${HARNESS_IDS.join(", ")}.` });
    await control.recordAudit(actor.id, "PROVIDER_SETUP_INITIATED", harness, { harness, mode: "server-local-handoff" });
    response.status(202).json({ harness, mode: "server-local-handoff", command: LOCAL_HANDOFF[harness], instruction: "Run this exact command in a terminal on the server host. Credentials remain in the harness or operating-system keychain. Return here and refresh readiness." });
  }));
  app.post("/api/provider-setup/:harness/refresh", controlRoute(async (request, response) => {
    const actor = control.require(request, "PROVIDER_CONFIGURE", true).principal;
    const harness = String(request.params.harness);
    if (!isHarnessId(harness)) return response.status(400).json({ error: `Harness must be one of: ${HARNESS_IDS.join(", ")}.` });
    const result = await discovery.discover(harness, true);
    const action = result.status === "available" || result.status === "discovery_unsupported" ? "PROVIDER_SETUP_COMPLETED" : "PROVIDER_SETUP_FAILED";
    if (result.status === "authentication_required") await control.recordAudit(actor.id, "CREDENTIAL_REVOCATION_SIGNAL", harness, { harness, status: result.status });
    await control.recordAudit(actor.id, action, harness, { harness, status: result.status });
    response.set("Cache-Control", "no-store").json(result);
  }));
}
