import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenRouterSpendChart } from "./spend-chart";

const zero = { generations: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("OpenRouterSpendChart", () => {
  it("orders slices by spend, uses given labels, and shows shares that sum to 100%", () => {
    const html = renderToStaticMarkup(
      <OpenRouterSpendChart
        agents={{
          "codex-sol": { ...zero, generations: 2, costUsd: 0.03 },
          "claude-sonnet": { ...zero, generations: 1, costUsd: 0.09 },
        }}
        labels={{ "codex-sol": "Sol", "claude-sonnet": "Claude" }}
      />,
    );
    const labelOrder = [...html.matchAll(/spend-chart__label">([^<]+)</g)].map(([, label]) => label);
    expect(labelOrder).toEqual(["Claude", "Sol"]); // higher spend first
    expect(html).toContain("$0.09");
    expect(html).toContain("$0.03");
    expect(html).toContain(">75%<");
    expect(html).toContain(">25%<");
  });

  it("allocates rounded shares that always sum to exactly 100%, even for three equal thirds", () => {
    const html = renderToStaticMarkup(
      <OpenRouterSpendChart agents={{
        a: { ...zero, generations: 1, costUsd: 1 },
        b: { ...zero, generations: 1, costUsd: 1 },
        c: { ...zero, generations: 1, costUsd: 1 },
      }} />,
    );
    const shares = [...html.matchAll(/spend-chart__share">(\d+)%</g)].map(([, value]) => Number(value));
    expect(shares).toHaveLength(3);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(shares.sort((a, b) => b - a)).toEqual([34, 33, 33]); // largest remainder gets the odd point, not naive rounding's 33/33/33 = 99
  });

  it("falls back to comparing generation counts when every agent is free", () => {
    const html = renderToStaticMarkup(
      <OpenRouterSpendChart agents={{ "codex-sol": { ...zero, generations: 3, costUsd: 0 }, "claude-sonnet": { ...zero, generations: 1, costUsd: 0 } }} />,
    );
    expect(html).toContain("3 turns");
    expect(html).toContain("1 turn<"); // singular
    expect(html).not.toContain("$0.00");
  });

  it("falls back to the raw agent id when no label is given, and excludes agents with zero generations", () => {
    const html = renderToStaticMarkup(
      <OpenRouterSpendChart agents={{ "codex-sol": { ...zero, generations: 1, costUsd: 0.01 }, "idle-agent": zero }} />,
    );
    expect(html).toContain(">codex-sol<");
    expect(html).not.toContain("idle-agent");
  });

  it("shows an empty state instead of a chart when nothing has been recorded", () => {
    const html = renderToStaticMarkup(<OpenRouterSpendChart agents={{}} />);
    expect(html).toContain("No OpenRouter spend recorded yet");
    expect(html).not.toContain("<svg");
  });
});
