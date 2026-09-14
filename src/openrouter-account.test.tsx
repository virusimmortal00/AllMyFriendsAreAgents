// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenRouterAccount } from "./openrouter-account";
import * as spendWindowPreference from "./openrouter-spend-window";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const usageWithCredits = {
  room: { generations: 2, costUsd: 0.05, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  agents: { "codex-sol": { generations: 2, costUsd: 0.05, inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  sinceIso: null,
  truncated: false,
  credits: { totalCreditsUsd: 100, totalUsageUsd: 73.85, remainingUsd: 26.15, fetchedAt: "2026-09-14T12:47:00.000Z" },
};

describe("OpenRouterAccount", () => {
  it("shows the plain remaining balance (never framed as a fraction of a cap, and never the account's all-time usage) with a checked time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(usageWithCredits), { status: 200 })));
    render(<OpenRouterAccount agentLabels={{ "codex-sol": "Sol" }} />);
    await screen.findByText("$26.15");
    expect(screen.getByText("available")).toBeTruthy();
    expect(screen.queryByText(/of \$100/)).toBeNull();
    expect(screen.queryByText(/\$73\.85/)).toBeNull(); // the account's lifetime usage isn't scoped to this room
    expect(screen.getByText(/Checked/)).toBeTruthy();
    expect(screen.getByText("Sol")).toBeTruthy();
  });

  it("defaults the window to whatever the stored preference resolves to (the last 24 hours with nothing stored)", async () => {
    const loadSpy = vi.spyOn(spendWindowPreference, "loadOpenRouterSpendWindow");
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(usageWithCredits), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenRouterAccount />);
    await screen.findByText("$26.15");
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/openrouter-usage?window=24h", expect.anything());
    expect((screen.getByRole("combobox", { name: "Spend time window" }) as HTMLSelectElement).value).toBe("24h");
  });

  it("honors a previously remembered window instead of the default", async () => {
    vi.spyOn(spendWindowPreference, "loadOpenRouterSpendWindow").mockReturnValue("7d");
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(usageWithCredits), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenRouterAccount />);
    await screen.findByText("$26.15");
    expect(fetchMock).toHaveBeenCalledWith("/api/openrouter-usage?window=7d", expect.anything());
    expect((screen.getByRole("combobox", { name: "Spend time window" }) as HTMLSelectElement).value).toBe("7d");
  });

  it("re-fetches with the selected window (not bypassing the credits cache), remembers the choice, and only manual refresh bypasses the cache", async () => {
    const saveSpy = vi.spyOn(spendWindowPreference, "saveOpenRouterSpendWindow").mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(usageWithCredits), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...usageWithCredits, room: { ...usageWithCredits.room, costUsd: 0.01 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(usageWithCredits), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<OpenRouterAccount />);
    await screen.findByText("$26.15");

    await user.selectOptions(screen.getByRole("combobox", { name: "Spend time window" }), "7d");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/openrouter-usage?window=7d", expect.anything()));
    expect(saveSpy.mock.calls[0]?.[1]).toBe("7d"); // storage itself is undefined in this jsdom config (no --localstorage-file)

    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/openrouter-usage?window=7d&refresh=1", expect.anything());
  });

  it("resets a stale not-configured state instead of hiding a later error behind it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not configured" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<OpenRouterAccount refreshKey={0} />);
    expect(await screen.findByText("OpenRouter spend tracking is not configured on this server.")).toBeTruthy();

    rerender(<OpenRouterAccount refreshKey={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("OpenRouter spend tracking is not configured on this server.")).toBeNull();
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
