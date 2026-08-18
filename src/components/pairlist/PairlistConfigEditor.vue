<script setup lang="ts">
/**
 * The remotepairlist-style config editor.
 *
 * Field grouping mirrors the original service's page (Basics / Selection / Filters /
 * Exchange-indicator-based / ranged / two-stage sort) because that layout is what the
 * operator already knows. Recovered spec: `freq-pairlist/docs/RECOVERED_UI.md`.
 *
 * **`text-left` on the root is load-bearing.** `App.vue` sets a global
 * `#app { text-align: center }`, which otherwise strands every label in the middle of
 * its column and pushes checkbox text far from its box.
 *
 * Selection is editable unless the config is file-backed (`spec.source === 'chain_file'`).
 * Those three come from `config_static/generator/chains/`, which is the definition of
 * what each chain selects, the input to the parity test, and the rollback artefact — so
 * they are changed in the file, or duplicated into a config that is not file-backed.
 */
import type {
  PairlistClassCount,
  PairlistConfig,
  PairlistExclusionCount,
  PairlistMetric,
  PairlistSpec,
} from '@/types/vps';

const props = defineProps<{
  config: PairlistConfig | null;
  metrics: PairlistMetric[];
  /** Per-token-class removal impact from the last Preview — see `classLabel`. */
  classCounts?: Record<string, PairlistClassCount> | null;
  /** Per-exclusion-source removal impact from the last Preview — see `exclusionLabel`. */
  exclusionCounts?: Record<string, PairlistExclusionCount> | null;
  saving?: boolean;
  previewing?: boolean;
}>();

const emit = defineEmits<{
  save: [
    payload: { id: string; name: string; spec: PairlistSpec; cadenceMin: number; enabled: boolean },
  ];
  preview: [spec: PairlistSpec];
  duplicate: [];
  cancel: [];
}>();

const id = ref('');
const name = ref('');
const enabled = ref(true);
const cadenceMin = ref(15);
const cronMinutes = ref('');
const exchange = ref('bybit');
const market = ref<'spot' | 'futures'>('futures');
const stake = ref('USDT');

// `krakenfutures` is a distinct ccxt exchange from `kraken` (spot) and is what the live
// Kraken config uses. It was missing here until 2026-08-14, so opening that config gave
// the select no matching item and touching it would have silently rewritten the venue to
// Kraken spot.
const EXCHANGES = [
  'binance',
  'kucoin',
  'okx',
  'bybit',
  'gate',
  'kraken',
  'krakenfutures',
  'hyperliquid',
];

// Non-crypto instrument classes to exclude via PairInformationFilter, per venue — keyed
// on the field each exchange actually exposes. Hyperliquid exposes neither field, so it
// gets no handlers.
//
// This has to be venue-aware. It was gated on `exchange === 'bybit'` until 2026-08-14,
// which meant saving the Kraken config from this editor silently dropped its three
// handlers and readmitted 14 xStocks (TSLAX, SPCXX, …) plus ANTHROPICX/OPENAIX as
// tradeable candidates, with no checkbox rendered to hint that anything had been lost.
const PAIR_INFO_EXCLUSIONS: Record<string, { infoKey: string; values: string[]; label: string }> = {
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
const STAKES = ['USDT', 'USDC', 'USD', 'BTC', 'ETH'];
const ORDERS = [
  { label: 'Descending', value: 'desc' },
  { label: 'Ascending', value: 'asc' },
  { label: 'Shuffle', value: 'shuffle' },
];

// --- selection ------------------------------------------------------------
const volumeAssets = ref(200);
const minVolume = ref(1_000_000);
// 0 ranks on the ticker's 24h `quoteVolume`; >0 switches VolumePairList to a rolling
// sum over that many days, which changes what `min_value` is measured against. Editable
// because it was previously unreachable: `buildSelectionChain()` never emitted it and
// `readSelection()` never read it back, so saving a copy of a rolling-window chain
// silently applied its 7-day $7M floor to a 24h figure — 200 candidates became 62 and
// every build was refused under the pair floor (bybit_7dRollingVol_optimized, 2026-08-18).
const volumeLookbackDays = ref(0);
const volumeWindowHint = computed(() =>
  volumeLookbackDays.value > 0 ? 'rolling sum' : "0 = ticker's 24h volume",
);
const applyBlacklist = ref(true);
// Bybit tags tokenised equities `stock` (159 symbols) and metals `commodity` (4);
// Kraken Futures tags them `xStocks` (14) plus `Pre-IPO` (2) and `Forex` (3). Without
// this the volatility ranking pulls in INTC, MU, MRVL, TSLAX and friends — they are
// volatile and liquid enough to rank well, and every fleet chain excludes them for that
// reason. Venues exposing neither field (Hyperliquid) get no handlers; see
// PAIR_INFO_EXCLUSIONS.
const excludeEquities = ref(true);
const pairInfoExclusion = computed(() => PAIR_INFO_EXCLUSIONS[exchange.value]);
const useAge = ref(true);
const minDaysListed = ref(30);
const useVolatilityWindow = ref(true);
const volatilityLookback = ref(7);
const minVolatility = ref(0.07);
const maxVolatility = ref(0.35);
const useRangeStability = ref(true);
// Deliberately longer than the volatility window. A 10-day range is what separates a
// steady melt-up from ordinary chop cleanly — at 7 days the threshold has to be
// squeezed against the pack and starts taking profitable pairs with it.
const rangeLookback = ref(10);
const maxRateOfChange = ref(2.0);
const finalCount = ref(50);

const fileBacked = computed(() => props.config?.spec.source === 'chain_file');

// --- toggles --------------------------------------------------------------
const f = reactive<Record<string, boolean>>({
  meme: false,
  fantoken: false,
  leveraged: false,
  cryptopanic: false,
  nfi: false,
  bothx: false,
  threex: false,
  no_max_supply: false,
  bb_squeeze: false,
  macdhist_positive: false,
  zero_volume: false,
  linreg: false,
  recent_pump: false,
  nhnl: false,
});

// NB "Trending token" used to sit here. It moved to EXCLUSION_SOURCES below, where it
// belongs: these are post-pool symbol filters, whereas trending gates a source of the
// upstream exclusion set. Leaving it here as well would have meant two checkboxes
// bound to the same key.
const TOKEN_CLASSES = [
  { key: 'meme', label: 'Meme token' },
  { key: 'fantoken', label: 'Fan token' },
  { key: 'leveraged', label: 'Leveraged tokens' },
  { key: 'cryptopanic', label: 'CryptoPanic filter' },
  { key: 'nfi', label: 'NFI blacklist' },
];
/**
 * "Meme token (21)" — how many candidate pairs ticking the box would remove.
 *
 * No suffix when the count is null (source data not fetched this cycle) or before a
 * Preview has run: "(0)" would read as "ticking this is free". Preview-driven rather
 * than read from the last saved build, because the counts depend on the whole spec, so
 * a stored number goes stale as soon as anything is edited.
 *
 * Every class here is pool-measured. The upstream-acting sources live in
 * EXCLUSION_SOURCES / `exclusionLabel`, which count against the venue universe — see
 * the backend's exclusion_component_counts for why they cannot share this denominator.
 */
function classLabel(o: { key: string; label: string }): string {
  const entry = props.classCounts?.[o.key];
  if (!entry || entry.count === null) return o.label;
  return `${o.label} (${entry.count})`;
}

/**
 * The exclusion set's five independent sources.
 *
 * All default ON. That inverts the convention used by `f` above, and deliberately:
 * these were applied unconditionally until they became toggleable, so an absent key
 * has to keep meaning "applied" — on the backend (`include_exclusion_component`) and
 * here — or a config-editor round-trip would silently loosen the exclusion set.
 *
 * Keys are written prefixed (`excl_static`, …) because `filters` is one flat namespace
 * shared with the metric filters, where a bare `static` or `coingecko` would be
 * ambiguous. `trending` shipped bare earlier and is read as a legacy alias on load.
 */
const EXCLUSION_SOURCES = [
  { key: 'static', label: 'Hand-kept blacklist' },
  { key: 'auto_restricted', label: 'Account-restricted symbols' },
  { key: 'coingecko', label: 'CoinGecko memes' },
  { key: 'trending', label: 'CoinGecko trending' },
  { key: 'delistings', label: 'Delisting (Binance + Bybit)' },
];
const excl = reactive<Record<string, boolean>>(
  Object.fromEntries(EXCLUSION_SOURCES.map((s) => [s.key, true])),
);

/**
 * "CoinGecko trending (56)" — pairs this source removes from the venue's tradeable
 * universe. Universe, not the candidate pool: these all apply upstream of ranking, so
 * an excluded pair never reaches the pool. The count is what the source *would*
 * remove either way, so it does not vanish when you untick the box. No suffix when
 * the count is null (no data yet) — "(0)" would read as "this source excludes
 * nothing".
 */
function exclusionLabel(s: { key: string; label: string }): string {
  const entry = props.exclusionCounts?.[s.key];
  if (!entry || entry.count === null) return s.label;
  return `${s.label} (${entry.count})`;
}

const SPECIAL = [
  { key: 'bothx', label: 'Exists on Binance and Kucoin' },
  { key: 'threex', label: 'Exists on Binance, Kucoin and OKX' },
  { key: 'no_max_supply', label: 'No max supply (CoinGecko)' },
];
const INDICATOR_TOGGLES = [
  { key: 'bb_squeeze', label: 'bb_width at 180-day low (1d)' },
  { key: 'macdhist_positive', label: 'macdhist > 0 (1d)' },
  { key: 'linreg', label: 'Positive linear regression (1d)' },
  { key: 'recent_pump', label: 'Recent pump (5m)' },
  { key: 'zero_volume', label: 'Has a zero-volume candle (5m)' },
  { key: 'nhnl', label: 'NHNL positive (30m)' },
];

const emaCross = ref<'' | 'above' | 'below'>('');
const smiState = ref<'' | 'bullish' | 'bearish'>('');
const useFng = ref(false);
const fngMin = ref(20);
const useSpread = ref(false);
const spreadMax = ref(0.005);
// New-pair cooling-off. Two windows, because the rule is a conjunction — see the
// help text below and PAIRLIST_REFERENCE. Defaults match the measured recommendation.
const useNewPairCooldown = ref(false);
const newPairMaturityDays = ref(30);
const newPairCooldownHours = ref(6);
const newPairCooldownGraceMin = ref(120);
const newPairCooldownObserve = ref(false);

interface RangeField {
  key: string;
  label: string;
  enabled: boolean;
  min: number;
  max: number;
  step: number;
}
const ranges = reactive<RangeField[]>([
  {
    key: 'volatility',
    label: 'Volatility (10d avg)',
    enabled: false,
    min: 0.1,
    max: 0.35,
    step: 0.01,
  },
  {
    key: 'pearson',
    label: 'Pearson corr. to BTC (5m)',
    enabled: false,
    min: 0.1,
    max: 0.35,
    step: 0.01,
  },
  { key: 'rsi_14', label: 'RSI 14 (1h)', enabled: false, min: 0, max: 100, step: 1 },
  { key: 'adx_14', label: 'ADX 14 (1h)', enabled: false, min: 0, max: 100, step: 1 },
  { key: 'price', label: 'Price (5m)', enabled: false, min: 1, max: -1, step: 0.1 },
  { key: 'volume24', label: 'Volume (24h rolling)', enabled: false, min: 1, max: -1, step: 100000 },
  { key: 'ad_ratio', label: 'Adratio (30m)', enabled: false, min: 1, max: 1000, step: 0.1 },
  { key: 'ad_line', label: 'Adline (30m)', enabled: false, min: 0, max: 1000, step: 1 },
  {
    // min:11 excludes the top 10 by market cap too (apply_range's bounds are
    // inclusive, so 11 is the first *kept* rank) — folded in from the CoinGecko
    // top-10 blacklist component (market.TOP_MARKETCAP_COUNT, disabled 2026-08-05)
    // now that real CoinMarketCap rank data covers the same intent per config.
    key: 'cm_marketcap_rank',
    label: 'CoinMarketCap rank (min / max)',
    enabled: false,
    min: 11,
    max: 500,
    step: 1,
  },
]);

// --- sorting --------------------------------------------------------------
const sortKey = ref('');
const sortOrder = ref<'desc' | 'asc' | 'shuffle'>('desc');
const limit = ref<number | null>(50);
const sort2Key = ref('');
const sort2Order = ref<'desc' | 'asc' | 'shuffle'>('desc');
const limit2 = ref<number | null>(null);

const sortOptions = computed(() => [
  { label: '— none —', value: '' },
  ...[...props.metrics]
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.key.localeCompare(b.key))
    .map((m) => ({ label: `${m.key} · ${m.timeframe} — ${m.description}`, value: m.key })),
]);

// --- load ------------------------------------------------------------------
/**
 * Pull the Selection fields back out of an existing chain, so duplicating one shows
 * its real values instead of silently resetting them to defaults on the next save.
 */
function readSelection(chain: PairlistSpec['base_chain']) {
  if (!chain?.length) return;
  const find = (m: string) =>
    chain.find((h) => h.method === m) as Record<string, number> | undefined;

  excludeEquities.value = chain.some((h) => h.method === 'PairInformationFilter');

  const vol = find('VolumePairList');
  if (vol) {
    volumeAssets.value = vol.number_assets ?? volumeAssets.value;
    minVolume.value = vol.min_value ?? minVolume.value;
    // Falls back to 0, not to the current ref: an absent `lookback_days` means this
    // chain really is in 24h mode, and carrying over the previously-loaded config's
    // window would invent a rolling sum the chain never asked for.
    volumeLookbackDays.value = vol.lookback_days ?? 0;
  }
  const age = find('AgeFilter');
  useAge.value = !!age;
  if (age) minDaysListed.value = age.min_days_listed ?? minDaysListed.value;

  const rsf = find('RangeStabilityFilter');
  useRangeStability.value = !!rsf;
  if (rsf) {
    maxRateOfChange.value = rsf.max_rate_of_change ?? maxRateOfChange.value;
    rangeLookback.value = rsf.lookback_days ?? rangeLookback.value;
  }

  const vf = find('VolatilityFilter');
  useVolatilityWindow.value = !!vf;
  if (vf) {
    minVolatility.value = vf.min_volatility ?? minVolatility.value;
    maxVolatility.value = vf.max_volatility ?? maxVolatility.value;
    volatilityLookback.value = vf.lookback_days ?? volatilityLookback.value;
  }
  const off = find('OffsetFilter');
  if (off) finalCount.value = off.number_assets ?? finalCount.value;
}

watch(
  () => props.config,
  (cfg) => {
    if (!cfg) return;
    id.value = cfg.id;
    name.value = cfg.name;
    enabled.value = cfg.enabled;
    cadenceMin.value = cfg.cadence_min;
    cronMinutes.value = (cfg.spec.cron_minutes ?? []).join(', ');
    exchange.value = cfg.spec.exchange;
    market.value = cfg.spec.market;
    stake.value = cfg.spec.stake;
    applyBlacklist.value = cfg.spec.config_blacklist !== false;
    readSelection(cfg.spec.base_chain);

    const filters = cfg.spec.filters ?? {};
    for (const key of Object.keys(f)) f[key] = filters[key] === true;
    // Exclusion sources invert that default — absent means applied. Prefixed key
    // wins; bare `trending` is the legacy alias from the first shape that shipped,
    // so a config still carrying `trending: false` keeps its opt-out.
    for (const s of EXCLUSION_SOURCES) {
      const prefixed = filters[`excl_${s.key}`];
      const legacy = s.key === 'trending' ? filters.trending : undefined;
      excl[s.key] = (prefixed ?? legacy) !== false;
    }
    emaCross.value = (filters.ema_cross as 'above' | 'below') ?? '';
    smiState.value = (filters.smi_state as 'bullish' | 'bearish') ?? '';
    useFng.value = filters.fng_min != null;
    if (typeof filters.fng_min === 'number') fngMin.value = filters.fng_min;
    useSpread.value = filters.spread_max != null;
    if (typeof filters.spread_max === 'number') spreadMax.value = filters.spread_max;

    // Both windows must be present for the backend to consider the rule enabled, so
    // the checkbox reflects that same condition rather than either key alone.
    useNewPairCooldown.value =
      filters.new_pair_maturity_days != null && filters.new_pair_cooldown_hours != null;
    if (typeof filters.new_pair_maturity_days === 'number')
      newPairMaturityDays.value = filters.new_pair_maturity_days;
    if (typeof filters.new_pair_cooldown_hours === 'number')
      newPairCooldownHours.value = filters.new_pair_cooldown_hours;
    if (typeof filters.new_pair_cooldown_grace_min === 'number')
      newPairCooldownGraceMin.value = filters.new_pair_cooldown_grace_min;
    newPairCooldownObserve.value = filters.new_pair_cooldown_observe === true;

    for (const r of ranges) {
      const v = filters[r.key];
      r.enabled = Array.isArray(v);
      if (Array.isArray(v)) [r.min, r.max] = v;
    }

    sortKey.value = cfg.spec.sort?.key ?? '';
    sortOrder.value = cfg.spec.sort?.order ?? 'desc';
    limit.value = cfg.spec.limit ?? null;
    sort2Key.value = cfg.spec.sort2?.key ?? '';
    sort2Order.value = cfg.spec.sort2?.order ?? 'desc';
    limit2.value = cfg.spec.limit2 ?? null;
  },
  { immediate: true },
);

// --- build -----------------------------------------------------------------
function buildSelectionChain() {
  const volume: Record<string, unknown> = {
    method: 'VolumePairList',
    number_assets: volumeAssets.value,
    sort_key: 'quoteVolume',
    min_value: minVolume.value,
  };
  // Omitted rather than sent as 0, so a 24h-mode chain keeps the exact shape the fleet
  // chain files use and a diff against one stays clean.
  if (volumeLookbackDays.value > 0) volume.lookback_days = volumeLookbackDays.value;
  const chain: Record<string, unknown>[] = [volume];
  if (excludeEquities.value && pairInfoExclusion.value) {
    for (const kind of pairInfoExclusion.value.values) {
      chain.push({
        method: 'PairInformationFilter',
        info_key: pairInfoExclusion.value.infoKey,
        info_compare_value: kind,
        selection_mode: 'blacklist',
      });
    }
  }
  // Free — reads already-loaded market data, no API call — and it is the only thing
  // that catches a pair the exchange itself has scheduled for delisting. Bybit's
  // measured notice is 1-4 days, so missing it means opening into a doomed pair, which
  // for a strategy with stoploss disabled has no exit but the ROI ladder.
  // Only binance/bitget/bybit publish a delisting date; elsewhere the handler refuses
  // to start, so it must not be emitted.
  if (['binance', 'bybit', 'bitget'].includes(exchange.value)) {
    chain.push({ method: 'DelistFilter', max_days_from_now: 0 });
  }
  if (useAge.value) chain.push({ method: 'AgeFilter', min_days_listed: minDaysListed.value });
  if (useRangeStability.value) {
    chain.push({
      method: 'RangeStabilityFilter',
      lookback_days: rangeLookback.value,
      max_rate_of_change: maxRateOfChange.value,
    });
  }
  if (useVolatilityWindow.value) {
    chain.push({
      method: 'VolatilityFilter',
      lookback_days: volatilityLookback.value,
      min_volatility: minVolatility.value,
      max_volatility: maxVolatility.value,
      sort_direction: 'desc',
    });
  }
  chain.push({ method: 'OffsetFilter', number_assets: finalCount.value });
  return chain;
}

function currentSpec(): PairlistSpec {
  const filters: Record<string, unknown> = {};
  for (const [key, on] of Object.entries(f)) if (on) filters[key] = true;
  // Exclusion sources are written explicitly, true or false — never omitted like the
  // toggles above. The backend's default-on only applies to an *absent* key, so if an
  // unchecked source just omitted its key, saving any unrelated field would silently
  // re-enable it on the next load/save round-trip. `filters` is rebuilt from scratch
  // each save, so the legacy bare `trending` key drops out here by construction.
  for (const s of EXCLUSION_SOURCES) filters[`excl_${s.key}`] = excl[s.key];
  if (emaCross.value) filters.ema_cross = emaCross.value;
  if (smiState.value) filters.smi_state = smiState.value;
  if (useFng.value) filters.fng_min = fngMin.value;
  if (useSpread.value) filters.spread_max = spreadMax.value;
  if (useNewPairCooldown.value) {
    filters.new_pair_maturity_days = newPairMaturityDays.value;
    filters.new_pair_cooldown_hours = newPairCooldownHours.value;
    filters.new_pair_cooldown_grace_min = newPairCooldownGraceMin.value;
    filters.new_pair_cooldown_observe = newPairCooldownObserve.value;
  }
  for (const r of ranges) if (r.enabled) filters[r.key] = [r.min, r.max];

  const cron = cronMinutes.value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < 60);

  return {
    ...(props.config?.spec ?? {}),
    exchange: exchange.value,
    market: market.value,
    stake: stake.value,
    mode: 'whitelist',
    base_chain: fileBacked.value ? props.config!.spec.base_chain : buildSelectionChain(),
    cron_minutes: cron.length ? cron : undefined,
    // Fleet chains carry their own mid-chain blacklist handlers; adding it as config
    // too changes what VolumePairList's cap counts and halves the candidate pool.
    config_blacklist: fileBacked.value
      ? (props.config?.spec.config_blacklist ?? false)
      : applyBlacklist.value,
    filters,
    sort: sortKey.value ? { key: sortKey.value, order: sortOrder.value } : null,
    limit: limit.value ?? null,
    sort2: sort2Key.value ? { key: sort2Key.value, order: sort2Order.value } : null,
    limit2: limit2.value ?? null,
  } as PairlistSpec;
}

const slugValid = computed(() => /^[a-zA-Z0-9_-]{1,64}$/.test(id.value));

function onSave() {
  emit('save', {
    id: id.value,
    name: name.value || id.value,
    spec: currentSpec(),
    cadenceMin: cadenceMin.value,
    enabled: enabled.value,
  });
}
</script>

<template>
  <!-- text-left overrides the global #app { text-align: center } in App.vue -->
  <div class="max-w-5xl space-y-6 text-left">
    <!-- Basics -->
    <section>
      <h3 class="mb-3 border-b border-surface-700 pb-1 text-sm font-semibold">Basics</h3>
      <div class="grid gap-x-8 gap-y-3 lg:grid-cols-2">
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Config id</span>
          <UInput v-model="id" size="sm" placeholder="my_pairlist" />
        </label>
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Name</span>
          <UInput v-model="name" size="sm" placeholder="Human-readable name" />
        </label>
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Exchange</span>
          <USelect v-model="exchange" :items="EXCHANGES" size="sm" />
        </label>
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Market</span>
          <USelect v-model="market" :items="['spot', 'futures']" size="sm" />
        </label>
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Stake currency</span>
          <USelect v-model="stake" :items="STAKES" size="sm" />
        </label>
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Rebuild every (min)</span>
          <UInputNumber v-model="cadenceMin" :min="1" :max="1440" size="sm" />
        </label>
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Build at minutes</span>
          <UInput v-model="cronMinutes" size="sm" placeholder="10, 25, 40, 55" />
        </label>
        <div class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Status</span>
          <UCheckbox v-model="enabled" label="Enabled" />
        </div>
      </div>
      <p v-if="id && !slugValid" class="mt-2 text-xs text-red-400">
        Config id may contain letters, digits, dash and underscore only.
      </p>
      <p class="mt-2 text-xs text-surface-500">
        Fixed minutes keep builds aligned to the candle close — the Bybit chains use
        <code>10, 25, 40, 55</code> so a fresh list lands before the 15-minute candle at :15. Leave
        blank to use the plain interval instead.
      </p>
    </section>

    <!-- Selection -->
    <section>
      <h3 class="mb-3 border-b border-surface-700 pb-1 text-sm font-semibold">Selection</h3>

      <div
        v-if="fileBacked"
        class="rounded border border-surface-600 bg-surface-800/40 p-3 text-xs text-surface-300"
      >
        <p class="mb-2">
          This config runs a <strong>fleet selection chain</strong> from
          <code>config_static/generator/chains/</code>, so it is read-only here — that file is the
          definition of what the chain selects, the input to the parity test, and the rollback
          artefact.
        </p>
        <p class="mb-1">To change it (age 30 → 60, say) you have two options:</p>
        <ul class="mb-3 ml-4 list-disc space-y-1">
          <li>
            <strong>Edit the chain file</strong> and restart the service — but note this also
            changes what the existing production generator builds, so it affects the live fleet.
          </li>
          <li>
            <strong>Duplicate</strong> into a fully editable config and tune that instead, leaving
            the fleet untouched. Best for experimenting.
          </li>
        </ul>
        <UButton
          label="Duplicate as editable config"
          size="xs"
          color="primary"
          variant="outline"
          icon="i-mdi-content-duplicate"
          @click="emit('duplicate')"
        />
      </div>

      <div v-else class="grid gap-x-8 gap-y-3 lg:grid-cols-2">
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Volume pool</span>
          <UInputNumber v-model="volumeAssets" :min="10" :max="1000" size="sm" />
        </label>
        <div class="grid grid-cols-[10rem_1fr] items-center gap-3 lg:col-span-2">
          <span class="text-xs text-surface-400">Min volume</span>
          <div class="flex flex-wrap items-center gap-2">
            <UInputNumber v-model="minVolume" :min="0" :step="100000" size="sm" class="w-40" />
            <span class="text-xs text-surface-500">over</span>
            <UInputNumber v-model="volumeLookbackDays" :min="0" :max="30" size="sm" class="w-24" />
            <span class="text-xs text-surface-500">days ({{ volumeWindowHint }})</span>
          </div>
        </div>
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Final pair count</span>
          <UInputNumber v-model="finalCount" :min="1" :max="500" size="sm" />
        </label>
        <div v-if="pairInfoExclusion" class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Non-crypto</span>
          <UCheckbox v-model="excludeEquities" :label="pairInfoExclusion.label" />
        </div>
        <div class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <UCheckbox v-model="useAge" label="Age filter" />
          <UInputNumber v-if="useAge" v-model="minDaysListed" :min="1" :max="365" size="sm" />
        </div>
        <div class="grid grid-cols-[10rem_1fr] items-center gap-3 lg:col-span-2">
          <UCheckbox v-model="useRangeStability" label="Parabolic guard" />
          <div v-if="useRangeStability" class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-surface-500">max range</span>
            <UInputNumber v-model="maxRateOfChange" :step="0.5" :min="0.5" size="sm" class="w-28" />
            <span class="text-xs text-surface-500">over</span>
            <UInputNumber v-model="rangeLookback" :min="2" :max="365" size="sm" class="w-24" />
            <span class="text-xs text-surface-500">days</span>
          </div>
        </div>
        <div class="grid grid-cols-[10rem_1fr] items-center gap-3 lg:col-span-2">
          <UCheckbox v-model="useVolatilityWindow" label="Volatility window" />
          <div v-if="useVolatilityWindow" class="flex flex-wrap items-center gap-2">
            <UInputNumber v-model="minVolatility" :step="0.01" size="sm" class="w-28" />
            <span class="text-xs text-surface-500">to</span>
            <UInputNumber v-model="maxVolatility" :step="0.01" size="sm" class="w-28" />
            <span class="text-xs text-surface-500">over</span>
            <UInputNumber v-model="volatilityLookback" :min="1" :max="365" size="sm" class="w-24" />
            <span class="text-xs text-surface-500">days</span>
          </div>
        </div>
      </div>

      <p v-if="!fileBacked" class="mt-2 text-xs text-surface-500">
        <strong>Exclude tokenised equities</strong> drops Bybit's 159 <code>stock</code> and 4
        <code>commodity</code> symbols — INTC, MU, MRVL and the like rank well on volatility, and
        every fleet chain removes them. The <strong>parabolic guard</strong> drops pairs whose
        10-day high/low range exceeds the threshold: volatility measures dispersion, not drift, so
        it cannot see a steady melt-up but this can.
      </p>
    </section>

    <!-- Filters -->
    <section>
      <h3 class="mb-3 border-b border-surface-700 pb-1 text-sm font-semibold">Filters</h3>

      <!--
        Moved here from Selection (2026-08-05) so every filter lives in one section. It sits ABOVE
        the two columns rather than inside them because it is a superset, not a peer: it already
        covers CoinGecko's meme and trending sets, which is why "Meme token" reads (0) on a config
        that has this on. Kept `!fileBacked` — the Selection grid it came from was `v-else` on
        fileBacked, and currentSpec() forces config_blacklist from the stored spec for chain-file
        configs, so rendering it unconditionally would show an editable control whose value is
        silently discarded on save.
      -->
      <div class="mb-4 border-b border-surface-800 pb-3">
        <p class="mb-2 text-xs font-medium text-surface-300">Exclusion set</p>

        <!--
          The master switch is `!fileBacked` because currentSpec() forces
          config_blacklist from the stored spec for chain-file configs. The five
          sources below are NOT gated: a chain-file config's `filters` ARE editable
          (only base_chain and config_blacklist are forced), and it receives the
          exclusion set through its mid-chain RemotePairList handlers, so these
          checkboxes work for it even though the master switch does not apply.
        -->
        <UCheckbox
          v-if="!fileBacked"
          v-model="applyBlacklist"
          label="Apply exclusion set"
          class="mb-2"
        />
        <div class="grid gap-1.5 sm:grid-cols-2">
          <UCheckbox
            v-for="s in EXCLUSION_SOURCES"
            :key="s.key"
            v-model="excl[s.key]"
            :label="exclusionLabel(s)"
          />
        </div>

        <p class="mt-2 text-xs text-surface-500">
          Five independent sources — unchecking one leaves the others applied. Counts are pairs
          removed from the venue's whole tradeable universe, because these apply
          <em>before</em> ranking: they bite inside the volume pool, ahead of
          <strong>Volume pool</strong> in Selection, so they change what that cap counts as well as
          what survives. The sources overlap, so the counts do not add up to the total.
          <strong>Keep Delisting and Account-restricted on.</strong> A delisting force-settles a
          position with no exit under a disabled stoploss, and a restricted symbol silently burns
          entry signals on every attempt — those two are protection, not preference, while the
          CoinGecko sets are the tunable part.
          <template v-if="!fileBacked">
            <strong>Apply exclusion set</strong> is the master switch: with it off, none of the five
            reach this config.
          </template>
          <template v-else>
            This config takes the exclusion set through its chain file's mid-chain handlers, so it
            has no master switch — but these five still apply to it.
          </template>
        </p>
      </div>

      <div class="grid gap-x-8 gap-y-4 lg:grid-cols-2">
        <div>
          <p class="mb-2 text-xs font-medium text-surface-300">Token classes</p>
          <div class="space-y-1.5">
            <UCheckbox
              v-for="o in TOKEN_CLASSES"
              :key="o.key"
              v-model="f[o.key]"
              :label="classLabel(o)"
            />
          </div>
        </div>
        <div>
          <p class="mb-2 text-xs font-medium text-surface-300">Special</p>
          <div class="space-y-1.5">
            <UCheckbox
              v-for="o in SPECIAL"
              :key="o.key"
              v-model="f[o.key]"
              :label="classLabel(o)"
            />
            <div class="flex items-center gap-3">
              <UCheckbox v-model="useFng" label="Fear &amp; Greed at least" />
              <UInputNumber
                v-if="useFng"
                v-model="fngMin"
                :min="0"
                :max="100"
                size="sm"
                class="w-24"
              />
            </div>
            <p v-if="useFng" class="text-xs text-surface-500">
              Global gate — below this index the config serves no pairs at all.
            </p>
          </div>
        </div>
      </div>

      <div class="mt-4 rounded border border-surface-700 p-3">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <UCheckbox v-model="useNewPairCooldown" label="Cooling-off for newly-promoted pairs" />
          <div v-if="useNewPairCooldown" class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-surface-500">new for</span>
            <UInputNumber
              v-model="newPairMaturityDays"
              :min="1"
              :max="365"
              size="sm"
              class="w-24"
            />
            <span class="text-xs text-surface-500">days · hold</span>
            <UInputNumber
              v-model="newPairCooldownHours"
              :min="1"
              :max="720"
              size="sm"
              class="w-24"
            />
            <span class="text-xs text-surface-500">hours · grace</span>
            <UInputNumber
              v-model="newPairCooldownGraceMin"
              :min="0"
              :max="1440"
              size="sm"
              class="w-24"
            />
            <span class="text-xs text-surface-500">min</span>
            <UCheckbox v-model="newPairCooldownObserve" label="Log only" />
          </div>
        </div>
        <p v-if="useNewPairCooldown" class="mt-2 text-xs text-surface-500">
          A pair is held out of the published list only when <em>both</em> are true: this config
          first saw it less than <strong>{{ newPairMaturityDays }} days</strong> ago,
          <em>and</em> it (re)entered the list less than
          <strong>{{ newPairCooldownHours }} hours</strong> ago. Both halves are needed — the
          volatility ranking promotes a pair <em>because</em> it just started moving violently, and
          on 7,371 closed trades that intersection held 11 of 12 catastrophic losses. Holding on
          recency alone would also block established pairs that merely went quiet and came back:
          1,775 trades, +15,442 USDT, zero tail events. <strong>Grace</strong> is how long a pair
          may be absent without restarting its hold — a pair flickering in and out on the volume
          floor would otherwise be banned rather than cooled. Held pairs are
          <em>removed, not replaced</em>, so the list just gets shorter.
          <strong>Log only</strong> reports what would be held without changing the published list.
        </p>
      </div>

      <p class="mt-3 text-xs text-surface-500">
        <template v-if="classCounts">
          The number after each class is how many of <em>this</em> spec's candidate pairs ticking it
          would remove — measured before any of these filters apply, so it does not change depending
          on which boxes are already on. <strong>(0)</strong> most often means the exclusion set
          already removed that class upstream: <em>Apply exclusion set</em> covers CoinGecko's meme
          and trending sets on its own, so with it on, these boxes are a redundant second pass and
          genuinely have nothing left to take. A class with <em>no</em> number is different — its
          data was not fetched this cycle (most are only fetched while some config uses them), so
          the impact is unknown rather than zero. <strong>Trending</strong> is marked
          <em>upstream</em> because it gates that exclusion set rather than filtering here:
          unticking it returns that many pairs to the candidate pool, but the final list is still
          capped by the count in Selection.
        </template>
        <template v-else>
          Run <strong>Preview</strong> to see how many pairs each class would remove. The counts
          depend on the whole spec — the volume pool, the volatility window — so they are measured
          per preview rather than stored.
        </template>
      </p>
    </section>

    <!-- Indicators -->
    <section>
      <h3 class="mb-3 border-b border-surface-700 pb-1 text-sm font-semibold">
        Exchange (indicator based)
      </h3>
      <div class="grid gap-x-8 gap-y-3 lg:grid-cols-2">
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">EMA50 vs EMA200 (1h)</span>
          <USelect
            v-model="emaCross"
            :items="[
              { label: '— any —', value: '' },
              { label: 'EMA50 > EMA200', value: 'above' },
              { label: 'EMA50 < EMA200', value: 'below' },
            ]"
            size="sm"
          />
        </label>
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">SMI (4h)</span>
          <USelect
            v-model="smiState"
            :items="[
              { label: '— any —', value: '' },
              { label: 'Bullish', value: 'bullish' },
              { label: 'Bearish', value: 'bearish' },
            ]"
            size="sm"
          />
        </label>
        <div class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <UCheckbox v-model="useSpread" label="Max spread (5m)" />
          <UInputNumber v-if="useSpread" v-model="spreadMax" :step="0.001" size="sm" />
        </div>
      </div>
      <div class="mt-4 grid gap-x-8 gap-y-1.5 lg:grid-cols-2">
        <UCheckbox
          v-for="o in INDICATOR_TOGGLES"
          :key="o.key"
          v-model="f[o.key]"
          :label="o.label"
        />
      </div>
    </section>

    <!-- Ranged -->
    <section>
      <h3 class="mb-3 border-b border-surface-700 pb-1 text-sm font-semibold">Ranged filters</h3>
      <div class="space-y-1">
        <div
          v-for="r in ranges"
          :key="r.key"
          class="grid grid-cols-[16rem_1fr] items-center gap-3 rounded px-2 py-1 hover:bg-surface-800/40"
        >
          <UCheckbox v-model="r.enabled" :label="r.label" />
          <div v-if="r.enabled" class="flex items-center gap-2">
            <UInputNumber v-model="r.min" :step="r.step" size="sm" class="w-36" />
            <span class="text-xs text-surface-500">to</span>
            <UInputNumber v-model="r.max" :step="r.step" size="sm" class="w-36" />
          </div>
        </div>
      </div>
      <p class="mt-2 text-xs text-surface-500">A max of <code>-1</code> means unbounded.</p>
    </section>

    <!-- Sorting -->
    <section>
      <h3 class="mb-3 border-b border-surface-700 pb-1 text-sm font-semibold">Sorting</h3>
      <div class="space-y-2">
        <div class="grid grid-cols-[10rem_minmax(0,1fr)_9rem_6rem] items-center gap-3">
          <span class="text-xs text-surface-400">Sort by</span>
          <USelectMenu v-model="sortKey" :items="sortOptions" value-key="value" size="sm" />
          <USelect v-model="sortOrder" :items="ORDERS" size="sm" />
          <UInputNumber v-model="limit" :min="1" :max="1000" size="sm" />
        </div>
        <div class="grid grid-cols-[10rem_minmax(0,1fr)_9rem_6rem] items-center gap-3">
          <span class="text-xs text-surface-400">Then sort by</span>
          <USelectMenu v-model="sort2Key" :items="sortOptions" value-key="value" size="sm" />
          <USelect v-model="sort2Order" :items="ORDERS" size="sm" />
          <UInputNumber v-model="limit2" :min="1" :max="1000" size="sm" />
        </div>
        <div class="grid grid-cols-[10rem_minmax(0,1fr)_9rem_6rem] gap-3">
          <span></span><span></span>
          <span class="text-xs text-surface-500">order</span>
          <span class="text-xs text-surface-500">limit</span>
        </div>
      </div>
      <p class="mt-2 text-xs text-surface-500">
        Rank by the first metric and cut to its limit, then re-rank <em>that subset</em> by the
        second. "Top 50 by volume, of those the 20 most oversold" needs both stages.
      </p>
    </section>

    <!-- Actions -->
    <div
      class="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-surface-700 bg-surface-900/95 py-3"
    >
      <UButton
        label="Preview"
        icon="i-mdi-eye"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="previewing"
        @click="emit('preview', currentSpec())"
      />
      <UButton
        label="Save"
        icon="i-mdi-content-save"
        color="primary"
        size="sm"
        :disabled="!slugValid"
        :loading="saving"
        @click="onSave"
      />
      <UButton label="Cancel" color="neutral" variant="ghost" size="sm" @click="emit('cancel')" />
      <span class="text-xs text-surface-500">
        Preview runs the chain live without changing what the bots are served.
      </span>
    </div>
  </div>
</template>
