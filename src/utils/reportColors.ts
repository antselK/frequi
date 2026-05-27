// Shared Tailwind text-color helpers for report tables. Centralizes the green/red
// thresholds that were previously inlined as ternaries across the report views.

/** Green when the profit/PnL value is ≥ 0, red otherwise. Null/undefined treated as 0. */
export function profitColor(value: number | null | undefined): string {
  return (value ?? 0) >= 0 ? 'text-green-400' : 'text-red-400';
}

/** Green when a percentage rate meets the pass threshold (default 50%), red otherwise. */
export function rateColor(value: number | null | undefined, threshold = 50): string {
  return (value ?? 0) >= threshold ? 'text-green-400' : 'text-red-400';
}
