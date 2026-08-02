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
import type { PairlistConfig, PairlistMetric, PairlistSpec } from '@/types/vps';

const props = defineProps<{
  config: PairlistConfig | null;
  metrics: PairlistMetric[];
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

const EXCHANGES = ['binance', 'kucoin', 'okx', 'bybit', 'gate', 'kraken', 'hyperliquid'];
const STAKES = ['USDT', 'USDC', 'USD', 'BTC', 'ETH'];
const ORDERS = [
  { label: 'Descending', value: 'desc' },
  { label: 'Ascending', value: 'asc' },
  { label: 'Shuffle', value: 'shuffle' },
];

// --- selection ------------------------------------------------------------
const volumeAssets = ref(200);
const minVolume = ref(1_000_000);
const applyBlacklist = ref(true);
// Bybit tags tokenised equities `stock` (159 symbols) and metals `commodity` (4).
// Without this the volatility ranking pulls in INTC, MU, MRVL and friends — they are
// volatile and liquid enough to rank well, and every fleet chain excludes them for
// that reason. Only Bybit exposes info.symbolType, so it is a no-op elsewhere.
const excludeEquities = ref(true);
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

const TOKEN_CLASSES = [
  { key: 'meme', label: 'Meme token' },
  { key: 'fantoken', label: 'Fan token' },
  { key: 'leveraged', label: 'Leveraged tokens' },
  { key: 'cryptopanic', label: 'CryptoPanic filter' },
  { key: 'nfi', label: 'NFI blacklist' },
];
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
    emaCross.value = (filters.ema_cross as 'above' | 'below') ?? '';
    smiState.value = (filters.smi_state as 'bullish' | 'bearish') ?? '';
    useFng.value = filters.fng_min != null;
    if (typeof filters.fng_min === 'number') fngMin.value = filters.fng_min;
    useSpread.value = filters.spread_max != null;
    if (typeof filters.spread_max === 'number') spreadMax.value = filters.spread_max;

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
  const chain: Record<string, unknown>[] = [
    {
      method: 'VolumePairList',
      number_assets: volumeAssets.value,
      sort_key: 'quoteVolume',
      min_value: minVolume.value,
    },
  ];
  if (excludeEquities.value && exchange.value === 'bybit') {
    for (const kind of ['stock', 'commodity']) {
      chain.push({
        method: 'PairInformationFilter',
        info_key: 'info.symbolType',
        info_compare_value: kind,
        selection_mode: 'blacklist',
      });
    }
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
  if (emaCross.value) filters.ema_cross = emaCross.value;
  if (smiState.value) filters.smi_state = smiState.value;
  if (useFng.value) filters.fng_min = fngMin.value;
  if (useSpread.value) filters.spread_max = spreadMax.value;
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
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Min 24h volume</span>
          <UInputNumber v-model="minVolume" :min="0" :step="100000" size="sm" />
        </label>
        <label class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Final pair count</span>
          <UInputNumber v-model="finalCount" :min="1" :max="500" size="sm" />
        </label>
        <div class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Blacklists</span>
          <UCheckbox v-model="applyBlacklist" label="Apply exclusion set" />
        </div>
        <div v-if="exchange === 'bybit'" class="grid grid-cols-[10rem_1fr] items-center gap-3">
          <span class="text-xs text-surface-400">Bybit only</span>
          <UCheckbox v-model="excludeEquities" label="Exclude tokenised equities" />
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
        <strong>Apply exclusion set</strong> removes blacklisted symbols — CoinGecko categories,
        pairs delisting on Binance or Bybit, and symbols this account cannot trade. Leave it on
        unless you specifically want the raw universe.
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
      <div class="grid gap-x-8 gap-y-4 lg:grid-cols-2">
        <div>
          <p class="mb-2 text-xs font-medium text-surface-300">Token classes</p>
          <div class="space-y-1.5">
            <UCheckbox
              v-for="o in TOKEN_CLASSES"
              :key="o.key"
              v-model="f[o.key]"
              :label="o.label"
            />
          </div>
        </div>
        <div>
          <p class="mb-2 text-xs font-medium text-surface-300">Special</p>
          <div class="space-y-1.5">
            <UCheckbox v-for="o in SPECIAL" :key="o.key" v-model="f[o.key]" :label="o.label" />
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
