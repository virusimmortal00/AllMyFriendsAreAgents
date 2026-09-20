import type express from "express";
import { controlRoute, type ControlPlaneStore } from "./control-plane.js";
import type { OpenRouterCatalogService } from "./openrouter-catalog.js";
import type { OpenRouterCreditsResponse } from "../shared/openrouter-usage.js";

type CreditsSource = Pick<OpenRouterCatalogService, "credits">;

/**
 * The account's OpenRouter credit balance is account-level, financial data connected
 * once by whoever set up the server — not room activity. It sits behind the same
 * server-admin wall as GitHub (`registerGitHubIntegrationRoutes`), not the room-member
 * gate that `/api/openrouter-usage` (spend by window) uses.
 */
export function registerOpenRouterIntegrationRoutes(input: {
  readonly app: express.Express;
  readonly control: ControlPlaneStore;
  readonly intelligence?: CreditsSource;
}) {
  const { app, control, intelligence } = input;

  app.get("/api/control/integrations/openrouter", controlRoute(async (request, response) => {
    control.require(request, "INTEGRATION_VIEW");
    if (!intelligence) return response.status(404).json({ error: "OpenRouter credit lookup is not configured." });
    const forceRefresh = request.query.refresh === "1" || request.query.refresh === "true";
    const credits = await intelligence.credits(forceRefresh).catch(() => undefined);
    const body = credits === undefined ? {} : { credits };
    response.set("Cache-Control", "no-store").json(body satisfies OpenRouterCreditsResponse);
  }));
}
