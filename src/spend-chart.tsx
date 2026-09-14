import type { OpenRouterSpendTotals } from "../shared/openrouter-usage";
import { formatUsd } from "../shared/currency";

const SLICE_COLORS = ["#4f6df5", "#e0793c", "#3fae5c", "#c0463c", "#8a5fd1", "#d4a72c", "#2f9e97", "#c2538f", "#6b7280", "#7a4f9c"];

function polarPoint(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + r * Math.sin(angle), y: cy - r * Math.cos(angle) };
}

function wedgePath(cx: number, cy: number, r: number, start: number, end: number): string {
  if (end - start >= Math.PI * 2 - 1e-6) {
    // A full circle can't be drawn as one SVG arc (start === end); split it into two halves.
    const mid = start + Math.PI;
    return `${wedgePath(cx, cy, r, start, mid)} ${wedgePath(cx, cy, r, mid, end)}`;
  }
  const from = polarPoint(cx, cy, r, start);
  const to = polarPoint(cx, cy, r, end);
  const largeArc = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${from.x} ${from.y} A ${r} ${r} 0 ${largeArc} 1 ${to.x} ${to.y} Z`;
}

/** Per-agent comparative OpenRouter spend as a donut chart with a legend. Falls back to comparing generation counts when every slice is free. */
export function OpenRouterSpendChart({ agents, labels }: { agents: Readonly<Record<string, OpenRouterSpendTotals>>; labels?: Readonly<Record<string, string>> }) {
  const entries = Object.entries(agents).filter(([, totals]) => totals.generations > 0);
  if (!entries.length) return <p className="spend-chart__empty">No OpenRouter spend recorded yet for this window.</p>;
  const byCost = entries.some(([, totals]) => totals.costUsd > 0);
  const metric = ([, totals]: (typeof entries)[number]) => byCost ? totals.costUsd : totals.generations;
  const sorted = [...entries].sort((a, b) => metric(b) - metric(a));
  const total = sorted.reduce((sum, entry) => sum + metric(entry), 0) || 1;

  let angle = 0;
  const slices = sorted.map(([agentId, totals], index) => {
    const share = metric([agentId, totals]) / total;
    const start = angle;
    angle += share * Math.PI * 2;
    return { agentId, totals, share, start, end: angle, color: SLICE_COLORS[index % SLICE_COLORS.length] };
  });

  return (
    <div className="spend-chart">
      <svg viewBox="0 0 120 120" className="spend-chart__donut" role="img" aria-label="OpenRouter spend by agent">
        {slices.map((slice) => (
          <path key={slice.agentId} d={wedgePath(60, 60, 54, slice.start, slice.end)} fill={slice.color} />
        ))}
        <circle cx="60" cy="60" r="30" className="spend-chart__hole" />
      </svg>
      <ul className="spend-chart__legend">
        {slices.map((slice) => (
          <li key={slice.agentId}>
            <span className="spend-chart__swatch" style={{ background: slice.color }} aria-hidden="true" />
            <span className="spend-chart__label">{labels?.[slice.agentId] || slice.agentId}</span>
            <span className="spend-chart__value">{byCost ? formatUsd(slice.totals.costUsd) : `${slice.totals.generations} turn${slice.totals.generations === 1 ? "" : "s"}`}</span>
            <span className="spend-chart__share">{Math.round(slice.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
