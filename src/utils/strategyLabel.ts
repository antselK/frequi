/**
 * Shortens a strategy name for display next to a bot name in cramped multi-bot tables.
 *
 * The fleet's strategies are all named after the production strategy (`Printer`), so repeating that
 * prefix on every row costs width without adding information:
 *   Printer_v4      -> v4
 *   PrinterLive_v2  -> Live_v2
 *   Claid           -> Claid       (no shared prefix: shown verbatim)
 *   Printer         -> Printer     (nothing left after stripping: shown verbatim)
 */
const STRATEGY_PREFIX = 'Printer';

export function shortStrategyName(strategy?: string | null): string {
  if (!strategy) return '';
  if (strategy.startsWith(STRATEGY_PREFIX)) {
    const rest = strategy.slice(STRATEGY_PREFIX.length).replace(/^_/, '');
    // An exact prefix match leaves nothing to show — keep the full name instead of an empty label.
    if (rest) return rest;
  }
  return strategy;
}
