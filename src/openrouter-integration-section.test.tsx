// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenRouterIntegrationSection } from "./openrouter-integration-section";
import { updateControlSession } from "./control-session-state";
import * as spendWindowPreference from "./openrouter-spend-window";

afterEach(() => { cleanup(); updateControlSession({ status: null, session: null, checked: false, error: "" }); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ownerSession = () => updateControlSession({
  status: { claimed: true, bootstrapConfigured: false },
  session: { principal: { id: "owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, expiresAt: "2099-01-01T00:00:00Z" },
  checked: true,
  error: "",
});

// Distinct from the reset afterEach leaves behind (checked: false, still "checking"): this
// represents a completed check that found no session at all.
const confirmedSignedOut = () => updateControlSession({ status: { claimed: true, bootstrapConfigured: false }, session: null, checked: true, error: "" });

const usageWithoutCredits = {
  room: { generations: 2, costUsd: 0.05, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  agents: { "codex-sol": { generations: 2, costUsd: 0.05, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  sinceIso: null,
  truncated: false,
};

function stubFetch(extra: (route: string) => Response | undefined = () => undefined) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const route = String(input);
    const overridden = extra(route);
    if (overridden) return overridden;
    if (route.startsWith("/api/openrouter-usage")) return json(usageWithoutCredits);
    if (route.startsWith("/api/control/integrations/openrouter")) return json({ error: "Sign in required." }, 401);
    throw new Error(`Unexpected route: ${route}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OpenRouterIntegrationSection", () => {
  it("shows the room's spend chart to a signed-out viewer while gating credits behind admin sign-in", async () => {
    confirmedSignedOut();
    stubFetch();
    render(<OpenRouterIntegrationSection agentLabels={{ "codex-sol": "Sol" }} onOpenAdministration={vi.fn()} />);
    await screen.findByText("$0.05 spent · 2 turns");
    expect(screen.getByText("Sol")).toBeTruthy();
    expect(await screen.findByText("Sign in as a server administrator to see the account's remaining balance.")).toBeTruthy();
    expect(screen.queryByText(/available/)).toBeNull();
  });

  it("shows the plain remaining balance to a signed-in administrator, never framed as a fraction of a cap", async () => {
    ownerSession();
    stubFetch((route) => route.startsWith("/api/control/integrations/openrouter")
      ? json({ credits: { totalCreditsUsd: 100, totalUsageUsd: 73.85, remainingUsd: 26.15, fetchedAt: "2026-09-14T12:47:00.000Z" } })
      : undefined);
    render(<OpenRouterIntegrationSection onOpenAdministration={vi.fn()} />);
    await screen.findByText("$26.15");
    expect(screen.getByText("available")).toBeTruthy();
    expect(screen.queryByText(/of \$100/)).toBeNull();
    expect(screen.queryByText(/\$73\.85/)).toBeNull();
    expect(screen.getByText(/Checked/)).toBeTruthy();
  });

  it("bypasses the credits cache only on manual refresh, not on an ordinary re-render", async () => {
    ownerSession();
    const fetchMock = stubFetch((route) => route.startsWith("/api/control/integrations/openrouter")
      ? json({ credits: { totalCreditsUsd: 100, totalUsageUsd: 73.85, remainingUsd: 26.15, fetchedAt: "2026-09-14T12:47:00.000Z" } })
      : undefined);
    const user = userEvent.setup();
    render(<OpenRouterIntegrationSection onOpenAdministration={vi.fn()} />);
    await screen.findByText("$26.15");
    expect(fetchMock).toHaveBeenCalledWith("/api/control/integrations/openrouter", expect.anything());

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/control/integrations/openrouter?refresh=1", expect.anything()));
  });

  it("falls back to a connect-a-key message when signed in but no credits are available", async () => {
    ownerSession();
    stubFetch((route) => route.startsWith("/api/control/integrations/openrouter") ? json({}) : undefined);
    render(<OpenRouterIntegrationSection onOpenAdministration={vi.fn()} />);
    expect(await screen.findByText("Connect an OpenRouter API key to see your remaining balance here.")).toBeTruthy();
  });

  it("flags a truncated window without hiding the chart, and falls back to the raw agent id without a label", async () => {
    stubFetch((route) => route.startsWith("/api/openrouter-usage") ? json({ ...usageWithoutCredits, truncated: true }) : undefined);
    render(<OpenRouterIntegrationSection onOpenAdministration={vi.fn()} />);
    expect(await screen.findByText(/Retained history doesn't reach back this far/)).toBeTruthy();
    const panel = screen.getByRole("img", { name: "OpenRouter spend by agent" }).closest<HTMLElement>(".spend-chart")!;
    expect(within(panel).getByText("codex-sol")).toBeTruthy();
  });

  it("defaults the spend window to the stored preference and remembers a new choice", async () => {
    const loadSpy = vi.spyOn(spendWindowPreference, "loadOpenRouterSpendWindow");
    const fetchMock = stubFetch();
    render(<OpenRouterIntegrationSection onOpenAdministration={vi.fn()} />);
    await screen.findByText("$0.05 spent · 2 turns");
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/openrouter-usage?window=24h", expect.anything());
    expect((screen.getByRole("combobox", { name: "Spend time window" }) as HTMLSelectElement).value).toBe("24h");
  });
});
