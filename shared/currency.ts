/** A running-spend USD amount, e.g. "$0.0034" or "$1.20" — distinct from per-million catalog pricing. */
export function formatUsd(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "$0.00";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
