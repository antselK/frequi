import type { PairlistChainHandler } from '@/types/vps';

/**
 * PairInformationFilter handlers the pairlist editor writes into a config's base chain.
 *
 * The editor rebuilds `base_chain` from its form on every save, so any handler it does not
 * know how to read back is silently dropped. Each group here is read back by its `info_key`,
 * which keeps two groups on the same venue from being mistaken for each other.
 */
export interface PairInfoGroup {
  infoKey: string;
  values: string[];
  label: string;
}

// Non-crypto instrument classes, per venue — keyed on the field each exchange actually
// exposes. Hyperliquid exposes neither field, so it gets no handlers.
//
// This has to be venue-aware. It was gated on `exchange === 'bybit'` until 2026-08-14,
// which meant saving the Kraken config from this editor silently dropped its three
// handlers and readmitted 14 xStocks (TSLAX, SPCXX, …) plus ANTHROPICX/OPENAIX as
// tradeable candidates, with no checkbox rendered to hint that anything had been lost.
export const PAIR_INFO_EXCLUSIONS: Record<string, PairInfoGroup> = {
  bybit: {
    infoKey: 'info.symbolType',
    values: ['stock', 'commodity'],
    label: 'Exclude tokenised equities',
  },
  krakenfutures: {
    infoKey: 'info.category',
    values: ['xStocks', 'Pre-IPO', 'Forex'],
    label: 'Exclude equities, pre-IPO & forex',
  },
};

// Pairs whose exchange maximum is 5x (2026-10-09). On Bybit these carry a 10% maintenance
// margin, so a 5x position is liquidated after losing half its margin, and the 5,000 USDT
// first risk tier stops DCA early. Exact match only: Bybit exposes the value as the string
// "5.00", its lowest maximum on that date — a pair later moved below 5x would not match.
// Bybit only: on Hyperliquid most of the served list is 5x or lower, and Kraken Futures
// exposes no maximum. See PAIRLIST_REFERENCE → "Pairs with a 5x maximum are excluded".
export const MAX_LEVERAGE_EXCLUSIONS: Record<string, PairInfoGroup> = {
  bybit: {
    infoKey: 'info.leverageFilter.maxLeverage',
    values: ['5.00'],
    label: 'Exclude 5x-max pairs (10% maintenance margin)',
  },
};

export interface PairInfoToggles {
  equities: boolean;
  maxLeverage: boolean;
}

function hasGroup(chain: PairlistChainHandler[], group: PairInfoGroup | undefined): boolean {
  if (!group) return false;
  return chain.some(
    (h) =>
      h.method === 'PairInformationFilter' &&
      h.info_key === group.infoKey &&
      group.values.includes(String(h.info_compare_value)),
  );
}

function handlers(group: PairInfoGroup | undefined): PairlistChainHandler[] {
  if (!group) return [];
  return group.values.map((value) => ({
    method: 'PairInformationFilter',
    info_key: group.infoKey,
    info_compare_value: value,
    selection_mode: 'blacklist',
  }));
}

/** Which PairInformationFilter groups an existing chain applies, for the editor's checkboxes. */
export function readPairInfoToggles(
  chain: PairlistChainHandler[],
  exchange: string,
): PairInfoToggles {
  return {
    equities: hasGroup(chain, PAIR_INFO_EXCLUSIONS[exchange]),
    maxLeverage: hasGroup(chain, MAX_LEVERAGE_EXCLUSIONS[exchange]),
  };
}

/** The PairInformationFilter handlers to write, in chain order: equities, then max leverage. */
export function pairInfoChain(exchange: string, toggles: PairInfoToggles): PairlistChainHandler[] {
  return [
    ...(toggles.equities ? handlers(PAIR_INFO_EXCLUSIONS[exchange]) : []),
    ...(toggles.maxLeverage ? handlers(MAX_LEVERAGE_EXCLUSIONS[exchange]) : []),
  ];
}
