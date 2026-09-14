// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenRouterAccount } from "./openrouter-account";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const usageWithCredits = {
  room: { generations: 2, costUsd: 0.05, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  agents: { "codex-sol": { generations: 2, costUsd: 0.05, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  sinceIso: null,
  truncated: false,
  credits: { totalCreditsUsd: 100, totalUsageUsd: 73.85, remainingUsd: 26.15, fetchedAt: "2026-09-14T12:47:00.000Z" },
};

describe("OpenRouterAccount", () => {
  it("shows the plain remaining balance (never framed as a fraction of a cap), spend all-time, and a checked time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(usageWithCredits), { status: 200 })));
    render(<OpenRouterAccount agentLabels={{ "codex-sol": "Sol" }} />);
    await screen.findByText("$26.15");
    expect(screen.getByText("available")).toBeTruthy();
    expect(screen.queryByText(/of \$100/)).toBeNull();
    expect(screen.getByText(/\$73\.85 spent all-time/)).toBeTruthy();
    expect(screen.getByText(/Checked/)).toBeTruthy();
    expect(screen.getByText("Sol")).toBeTruthy();
  });

  it("re-fetches with the selected window and on manual refresh", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(usageWithCredits), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...usageWithCredits, room: { ...usageWithCredits.room, costUsd: 0.01 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(usageWithCredits), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<OpenRouterAccount />);
    await screen.findByText("$26.15");

    await user.selectOptions(screen.getByRole("combobox", { name: "Spend time window" }), "24h");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/openrouter-usage?window=24h", expect.anything()));

    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("shows a not-configured message on 404 instead of a generic error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "OpenRouter spend tracking is not configured." }), { status: 404 })));
    render(<OpenRouterAccount />);
    expect(await screen.findByText("OpenRouter spend tracking is not configured on this server.")).toBeTruthy();
  });

  it("falls back to a connect-a-key message when spend is tracked but no credits are available", async () => {
    const { credits: _credits, ...withoutCredits } = usageWithCredits;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(withoutCredits), { status: 200 })));
    render(<OpenRouterAccount />);
    expect(await screen.findByText("Connect an OpenRouter API key to see your remaining balance here.")).toBeTruthy();
  });

  it("flags a truncated window without hiding the rest of the page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...usageWithCredits, truncated: true }), { status: 200 })));
    render(<OpenRouterAccount />);
    expect(await screen.findByText(/Retained history doesn't reach back this far/)).toBeTruthy();
    expect(screen.getByText("$26.15")).toBeTruthy();
  });

  it("falls back to the raw agent id in the chart when no label is supplied", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(usageWithCredits), { status: 200 })));
    render(<OpenRouterAccount />);
    await screen.findByText("$26.15");
    const panel = screen.getByRole("img", { name: "OpenRouter spend by agent" }).closest<HTMLElement>(".spend-chart")!;
    expect(within(panel).getByText("codex-sol")).toBeTruthy();
  });
});
