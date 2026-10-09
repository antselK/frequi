import { describe, it, expect } from 'vitest';
import { pairInfoChain, readPairInfoToggles } from '@/utils/pairlistChain';
import type { PairlistChainHandler } from '@/types/vps';

const pif = (info_key: string, info_compare_value: string): PairlistChainHandler => ({
  method: 'PairInformationFilter',
  info_key,
  info_compare_value,
  selection_mode: 'blacklist',
});
const STOCK = pif('info.symbolType', 'stock');
const COMMODITY = pif('info.symbolType', 'commodity');
const MAX_5X = pif('info.leverageFilter.maxLeverage', '5.00');

// Shape of the live Bybit configs (bybit_meanrevert_optimized / _volatility_optimized).
const bybitChain = (withMaxLeverage: boolean): PairlistChainHandler[] => [
  { method: 'VolumePairList', number_assets: 200, sort_key: 'quoteVolume', min_value: 7000000 },
  STOCK,
  COMMODITY,
  ...(withMaxLeverage ? [MAX_5X] : []),
  { method: 'DelistFilter', max_days_from_now: 0 },
  { method: 'AgeFilter', min_days_listed: 60 },
  { method: 'OffsetFilter', number_assets: 200 },
];
const pairInfoPart = (chain: PairlistChainHandler[]) =>
  chain.filter((h) => h.method === 'PairInformationFilter');

describe('pairlist chain PairInformationFilter round trip', () => {
  it('keeps the 5x-max handler when a Bybit config is loaded and saved again', () => {
    const chain = bybitChain(true);
    const toggles = readPairInfoToggles(chain, 'bybit');
    expect(toggles).toEqual({ equities: true, maxLeverage: true });
    expect(pairInfoChain('bybit', toggles)).toEqual(pairInfoPart(chain));
  });

  it('does not add the handler to a Bybit config that lacks it', () => {
    const chain = bybitChain(false);
    const toggles = readPairInfoToggles(chain, 'bybit');
    expect(toggles).toEqual({ equities: true, maxLeverage: false });
    expect(pairInfoChain('bybit', toggles)).toEqual([STOCK, COMMODITY]);
  });

  it('does not mistake the leverage handler for the equity filter', () => {
    const chain = [{ method: 'VolumePairList' }, MAX_5X];
    expect(readPairInfoToggles(chain, 'bybit')).toEqual({ equities: false, maxLeverage: true });
    expect(pairInfoChain('bybit', { equities: false, maxLeverage: true })).toEqual([MAX_5X]);
  });

  it('writes the exact handler the live service configs use, after the equity filters', () => {
    expect(pairInfoChain('bybit', { equities: true, maxLeverage: true })).toEqual([
      STOCK,
      COMMODITY,
      {
        method: 'PairInformationFilter',
        info_key: 'info.leverageFilter.maxLeverage',
        info_compare_value: '5.00',
        selection_mode: 'blacklist',
      },
    ]);
  });

  it('leaves Kraken Futures with its equity handlers only', () => {
    const kraken = ['xStocks', 'Pre-IPO', 'Forex'].map((v) => pif('info.category', v));
    const chain = [{ method: 'VolumePairList' }, ...kraken, { method: 'OffsetFilter' }];
    const toggles = readPairInfoToggles(chain, 'krakenfutures');
    expect(toggles).toEqual({ equities: true, maxLeverage: false });
    expect(pairInfoChain('krakenfutures', { equities: true, maxLeverage: true })).toEqual(kraken);
  });

  it('writes nothing for Hyperliquid', () => {
    expect(pairInfoChain('hyperliquid', { equities: true, maxLeverage: true })).toEqual([]);
  });
});
