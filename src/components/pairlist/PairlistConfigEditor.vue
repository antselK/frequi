<script setup lang="ts">
/**
 * The remotepairlist-style config editor.
 *
 * Field grouping deliberately mirrors the original service's page (Basics / Filter /
 * Special / Exchange-indicator-based / ranged filters / two-stage sort), because that
 * layout is what the fleet's operator already knows. The recovered spec for every
 * field lives in `freq-pairlist/docs/RECOVERED_UI.md`.
 *
 * Two shapes of config exist and the editor treats them differently:
 *
 *  - **Seeded fleet chains** carry a `base_chain` — the fleet's own selection chain,
 *    run verbatim so its universe stays bit-identical to `test-pairlist`. That is not
 *    editable here; it is owned by `config_static/generator/chains/*.json` and is the
 *    documented rollback artefact. Extended filters and sorts layer on top.
 *  - **New configs** have no base_chain, so the editor builds one from the Selection
 *    fields below (volume pool, age, volatility window, parabolic guard, final count).
 *
 * A `-1` maximum means unbounded, matching the original.
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
  cancel: [];
}>();

// --- identity -------------------------------------------------------------
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

// --- selection (only used when the config has no fleet base_chain) --------
const volumeAssets = ref(200);
const minVolume = ref(1000000);
const useAge = ref(true);
const minDaysListed = ref(30);
const useVolatilityWindow = ref(true);
const minVolatility = ref(0.07);
const maxVolatility = ref(0.35);
const useRangeStability = ref(true);
const maxRateOfChange = ref(2.0);
const finalCount = ref(50);
// Defaults ON. A chain built here has no mid-chain RemotePairList handler, so
// without this the config bypasses the entire exclusion set — CoinGecko, the
// cross-exchange delist list, AND the account-restricted symbols. That is not a
// cosmetic gap: it would let a new config enter a pair that is delisting or that
// the live account cannot trade at all.
const applyBlacklist = ref(true);

// --- Filter / Special toggles --------------------------------------------
const f = reactive<Record<string, boolean>>({
  meme: false,
  fantoken: false,
  leveraged: false,
  cryptopanic: false,
  bothx: false,
  threex: false,
  no_max_supply: false,
  nfi: false,
  bb_squeeze: false,
  macdhist_positive: false,
  zero_volume: false,
  linreg: false,
  recent_pump: false,
  nhnl: false,
});

const emaCross = ref<'' | 'above' | 'below'>('');
const smiState = ref<'' | 'bullish' | 'bearish'>('');

const useFng = ref(false);
const fngMin = ref(20);
const useSpread = ref(false);
const spreadMax = ref(0.005);

// --- ranged filters -------------------------------------------------------
interface RangeField {
  key: string;
  label: string;
  enabled: boolean;
  min: number;
  max: number;
}

const ranges = reactive<RangeField[]>([
  { key: 'volatility', label: 'Volatility (10d avg)', enabled: false, min: 0.1, max: 0.35 },
  { key: 'pearson', label: 'Pearson corr. to BTC (5m)', enabled: false, min: 0.1, max: 0.35 },
  { key: 'price', label: 'Price (5m)', enabled: false, min: 1, max: -1 },
  { key: 'volume24', label: 'Volume (24h rolling)', enabled: false, min: 1, max: -1 },
  { key: 'rsi_14', label: 'RSI 14 (1h)', enabled: false, min: 0, max: 100 },
  { key: 'adx_14', label: 'ADX 14 (1h)', enabled: false, min: 0, max: 100 },
  { key: 'ad_ratio', label: 'Adratio (30m)', enabled: false, min: 1, max: 1000 },
  { key: 'ad_line', label: 'Adline (30m)', enabled: false, min: 0, max: 1000 },
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
    .map((m) => ({
      label: `${m.key}  (${m.timeframe}) — ${m.description}`,
      value: m.key,
    })),
]);

const ORDERS = [
  { label: 'Descending', value: 'desc' },
  { label: 'Ascending', value: 'asc' },
  { label: 'Shuffle', value: 'shuffle' },
];

const hasFleetChain = computed(() => (props.config?.spec.base_chain?.length ?? 0) > 0);

// --- load an existing config into the form --------------------------------
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
      if (Array.isArray(v)) {
        r.min = v[0];
        r.max = v[1];
      }
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

// --- build the spec -------------------------------------------------------
function buildSelectionChain() {
  const chain: Record<string, unknown>[] = [
    {
      method: 'VolumePairList',
      number_assets: volumeAssets.value,
      sort_key: 'quoteVolume',
      min_value: minVolume.value,
    },
  ];
  if (useAge.value) chain.push({ method: 'AgeFilter', min_days_listed: minDaysListed.value });
  if (useRangeStability.value) {
    chain.push({
      method: 'RangeStabilityFilter',
      lookback_days: 10,
      max_rate_of_change: maxRateOfChange.value,
    });
  }
  if (useVolatilityWindow.value) {
    chain.push({
      method: 'VolatilityFilter',
      lookback_days: 7,
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
    // Never synthesise over a fleet chain — that file is the definition of what the
    // chain selects and the rollback artefact.
    base_chain: hasFleetChain.value ? props.config!.spec.base_chain : buildSelectionChain(),
    // Fleet chains carry their own mid-chain RemotePairList blacklist handlers, so
    // they must NOT also get it as config — that changes what VolumePairList's cap
    // counts and halves the candidate pool. Editor-built chains have no such
    // handler, so this is how they get the exclusion set at all.
    config_blacklist: hasFleetChain.value
      ? (props.config?.spec.config_blacklist ?? false)
      : applyBlacklist.value,
    cron_minutes: cron.length ? cron : undefined,
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
  <div class="space-y-5">
    <!-- Basics -->
    <div>
      <h3 class="mb-2 text-sm font-semibold">Basics</h3>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label class="mb-1 block text-xs text-surface-400">Config id (used in the URL)</label>
          <UInput v-model="id" size="sm" placeholder="my_pairlist" />
          <p v-if="id && !slugValid" class="mt-1 text-xs text-red-400">
            letters, digits, dash and underscore only
          </p>
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Name</label>
          <UInput v-model="name" size="sm" placeholder="Human-readable name" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Exchange</label>
          <USelect v-model="exchange" :items="EXCHANGES" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Market</label>
          <USelect v-model="market" :items="['spot', 'futures']" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Stake currency</label>
          <USelect v-model="stake" :items="STAKES" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Rebuild every (min)</label>
          <UInputNumber v-model="cadenceMin" :min="1" :max="1440" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">
            Build at minutes (blank = interval)
          </label>
          <UInput v-model="cronMinutes" size="sm" placeholder="10, 25, 40, 55" />
        </div>
        <div class="flex items-end">
          <UCheckbox v-model="enabled" label="Enabled" />
        </div>
      </div>
      <p class="mt-1 text-xs text-surface-500">
        Fixed minutes keep builds aligned to the candle close — the Bybit chains use
        <code>10, 25, 40, 55</code> so a fresh list lands before the 15-minute candle at :15.
      </p>
    </div>

    <!-- Selection -->
    <div>
      <h3 class="mb-2 text-sm font-semibold">Selection</h3>
      <UAlert
        v-if="hasFleetChain"
        color="info"
        variant="subtle"
        title="This config runs a fleet selection chain verbatim"
        description="Its chain comes from config_static/generator/chains/ and is not editable here — that file is the definition of what the chain selects and the rollback artefact. The filters and sorts below still layer on top."
        class="mb-2"
      />
      <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label class="mb-1 block text-xs text-surface-400">Volume pool (candidates)</label>
          <UInputNumber v-model="volumeAssets" :min="10" :max="1000" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Min 24h quote volume</label>
          <UInputNumber v-model="minVolume" :min="0" :step="100000" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Final pair count</label>
          <UInputNumber v-model="finalCount" :min="1" :max="500" size="sm" />
        </div>
        <div class="flex items-end">
          <UCheckbox v-model="applyBlacklist" label="Apply exclusion set" />
        </div>
        <div class="flex items-end">
          <UCheckbox v-model="useAge" label="Age filter" />
        </div>
        <div v-if="useAge">
          <label class="mb-1 block text-xs text-surface-400">Min days listed</label>
          <UInputNumber v-model="minDaysListed" :min="1" :max="365" size="sm" />
        </div>
        <div class="flex items-end">
          <UCheckbox v-model="useVolatilityWindow" label="Volatility window (7d)" />
        </div>
        <div v-if="useVolatilityWindow">
          <label class="mb-1 block text-xs text-surface-400">Min volatility</label>
          <UInputNumber v-model="minVolatility" :step="0.01" size="sm" />
        </div>
        <div v-if="useVolatilityWindow">
          <label class="mb-1 block text-xs text-surface-400">Max volatility</label>
          <UInputNumber v-model="maxVolatility" :step="0.01" size="sm" />
        </div>
        <div class="flex items-end">
          <UCheckbox v-model="useRangeStability" label="Parabolic guard" />
        </div>
        <div v-if="useRangeStability">
          <label class="mb-1 block text-xs text-surface-400">Max 10d range-of-change</label>
          <UInputNumber v-model="maxRateOfChange" :step="0.5" :min="0.5" size="sm" />
        </div>
      </div>
      <p v-if="!hasFleetChain" class="mt-1 text-xs text-surface-500">
        <strong>Apply exclusion set</strong> removes blacklisted symbols — CoinGecko categories,
        pairs delisting on Binance or Bybit, and symbols this account cannot trade. Leave it on
        unless you specifically want the raw universe. The parabolic guard drops pairs whose 10-day
        high/low range exceeds the threshold. Volatility measures dispersion, not drift, so it
        cannot see a steady melt-up — this can.
      </p>
    </div>

    <!-- Filter / Special -->
    <div class="grid gap-5 lg:grid-cols-2">
      <div>
        <h3 class="mb-2 text-sm font-semibold">Filter</h3>
        <div class="space-y-1.5">
          <UCheckbox v-model="f.meme" label="Meme token" />
          <UCheckbox v-model="f.fantoken" label="Fan token" />
          <UCheckbox v-model="f.leveraged" label="Leveraged tokens" />
          <UCheckbox v-model="f.cryptopanic" label="CryptoPanic filter" />
          <UCheckbox v-model="f.nfi" label="NFI blacklist" />
        </div>
      </div>
      <div>
        <h3 class="mb-2 text-sm font-semibold">Special</h3>
        <div class="space-y-1.5">
          <UCheckbox v-model="f.bothx" label="Exists on Binance and Kucoin" />
          <UCheckbox v-model="f.threex" label="Exists on Binance, Kucoin and OKX" />
          <UCheckbox v-model="f.no_max_supply" label="No max supply (CoinGecko)" />
          <div class="flex items-center gap-2">
            <UCheckbox v-model="useFng" label="Crypto Fear & Greed at least" />
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
            Global gate: below this index the config serves no pairs at all.
          </p>
        </div>
      </div>
    </div>

    <!-- Indicator-based -->
    <div>
      <h3 class="mb-2 text-sm font-semibold">Exchange (indicator based)</h3>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label class="mb-1 block text-xs text-surface-400">EMA50 vs EMA200 (1h)</label>
          <USelect
            v-model="emaCross"
            :items="[
              { label: '— any —', value: '' },
              { label: 'EMA50 > EMA200', value: 'above' },
              { label: 'EMA50 < EMA200', value: 'below' },
            ]"
            size="sm"
          />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">SMI (4h)</label>
          <USelect
            v-model="smiState"
            :items="[
              { label: '— any —', value: '' },
              { label: 'Bullish', value: 'bullish' },
              { label: 'Bearish', value: 'bearish' },
            ]"
            size="sm"
          />
        </div>
        <div class="flex items-center gap-2">
          <UCheckbox v-model="useSpread" label="Max rolling spread (5m)" />
          <UInputNumber v-if="useSpread" v-model="spreadMax" :step="0.001" size="sm" class="w-28" />
        </div>
        <UCheckbox v-model="f.bb_squeeze" label="bb_width at 180-day low (1d)" />
        <UCheckbox v-model="f.macdhist_positive" label="macdhist > 0 (1d)" />
        <UCheckbox v-model="f.linreg" label="Positive linear regression (1d)" />
        <UCheckbox v-model="f.recent_pump" label="Recent pump (5m)" />
        <UCheckbox v-model="f.zero_volume" label="Has a zero-volume candle (5m)" />
        <UCheckbox v-model="f.nhnl" label="NHNL positive (30m)" />
      </div>
    </div>

    <!-- Ranged -->
    <div>
      <h3 class="mb-2 text-sm font-semibold">Ranged filters</h3>
      <p class="mb-2 text-xs text-surface-500">A max of <code>-1</code> means unbounded.</p>
      <div class="grid gap-3 sm:grid-cols-2">
        <div
          v-for="r in ranges"
          :key="r.key"
          class="flex items-center gap-2 rounded border border-surface-700 px-3 py-2"
        >
          <UCheckbox v-model="r.enabled" :label="r.label" class="flex-1" />
          <template v-if="r.enabled">
            <UInputNumber v-model="r.min" :step="0.01" size="sm" class="w-24" />
            <span class="text-xs text-surface-500">to</span>
            <UInputNumber v-model="r.max" :step="0.01" size="sm" class="w-24" />
          </template>
        </div>
      </div>
    </div>

    <!-- Sorting -->
    <div>
      <h3 class="mb-2 text-sm font-semibold">Sorting</h3>
      <p class="mb-2 text-xs text-surface-500">
        Rank by the first metric and cut to its limit, then re-rank <em>that subset</em> by the
        second. "Top 50 by volume, of those the 20 most oversold" needs both stages.
      </p>
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="sm:col-span-1">
          <label class="mb-1 block text-xs text-surface-400">Sort by</label>
          <USelectMenu v-model="sortKey" :items="sortOptions" value-key="value" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Order</label>
          <USelect v-model="sortOrder" :items="ORDERS" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Limit</label>
          <UInputNumber v-model="limit" :min="1" :max="1000" size="sm" />
        </div>
        <div class="sm:col-span-1">
          <label class="mb-1 block text-xs text-surface-400">Then sort by</label>
          <USelectMenu v-model="sort2Key" :items="sortOptions" value-key="value" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Order</label>
          <USelect v-model="sort2Order" :items="ORDERS" size="sm" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-surface-400">Limit</label>
          <UInputNumber v-model="limit2" :min="1" :max="1000" size="sm" />
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex flex-wrap items-center gap-2 border-t border-surface-700 pt-3">
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
