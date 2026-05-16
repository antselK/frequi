<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { daysAgoStr, todayStr } from '@/utils/reportDates';
import { formatDate } from '@/utils/reportParsers';
import { logsChartLayout } from '@/utils/reportCharts';
import { timestampShort } from '@/utils/formatters/timeformat';
import type { DwhMissedSignal, DwhMissedSignalList } from '@/types/vps';

const { reportsError, botSelectOptions, isBotActive, showChartTooltip, hideChartTooltip } =
  useReportsContext();

// ─── Types specific to this report ─────────────────────────────────────────

type MissedChartMode = 'cumulative' | 'hourly';

interface MissedChartPoint {
  hourKey: string;
  at: string;
  count: number;
  cumulative: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const SIGNAL_OUTCOME_REASON_LABELS: Record<string, string> = {
  trailing_entry: 'Trailing entry',
  eth_volatility: 'ETH volatility',
  funding_rate: 'Funding rate',
  price_momentum: 'Price momentum',
  slippage: 'Slippage',
  time_filter: 'Time filter',
  long_disabled: 'Long disabled',
  deep_dca_block: 'Deep DCA block',
  trade_rejected: 'Trade rejected',
  entry_error: 'Entry error',
  insufficient_data: 'Insufficient data',
  other: 'Other',
};

const missedChartModeOptions: { label: string; value: MissedChartMode }[] = [
  { label: 'Cumulative', value: 'cumulative' },
  { label: 'Per-hour', value: 'hourly' },
];

const signalOutcomeFilterOptions = [
  { label: 'All outcomes', value: 'all' },
  { label: 'Win', value: 'win' },
  { label: 'No trigger', value: 'no_trigger' },
  { label: 'Live', value: 'live' },
  { label: 'Pending', value: 'pending' },
  { label: 'Error', value: 'error' },
];

// ─── State ─────────────────────────────────────────────────────────────────

const signalOutcomes = ref<DwhMissedSignalList | null>(null);
const signalOutcomesDateFrom = ref(daysAgoStr(1));
const signalOutcomesDateTo = ref(todayStr());
const signalOutcomesFilterBotId = ref<number | null>(null);
const signalOutcomesFilterPair = ref('');
const signalOutcomesFilterVps = ref('');
const signalOutcomesFilterSide = ref<'both' | 'long' | 'short'>('both');
const signalOutcomesFilterOutcome = ref('all');
const signalOutcomesProfitThreshold = ref(2.0);
const selectedSignalOutcomeReasons = ref<string[]>([]);
const signalOutcomesChartMode = ref<MissedChartMode>('cumulative');
const loadingSignalOutcomes = ref(false);
const loadingParseMissedSignals = ref(false);
const loadingFetchOutcomes = ref(false);
const signalOutcomesLoaded = ref(false);

// Signal Outcomes computed stats
const signalOutcomeItems = computed<DwhMissedSignal[]>(() =>
  (signalOutcomes.value?.items ?? []).filter((s) => isBotActive(s.bot_id)),
);

const signalOutcomesFilteredByFields = computed<DwhMissedSignal[]>(() => {
  const pairNeedle = signalOutcomesFilterPair.value.trim().toLowerCase();
  const vpsNeedle = signalOutcomesFilterVps.value.trim().toLowerCase();
  return signalOutcomeItems.value.filter((s) => {
    if (pairNeedle && !s.pair.toLowerCase().includes(pairNeedle)) return false;
    if (vpsNeedle && !(s.vps_name ?? '').toLowerCase().includes(vpsNeedle)) return false;
    if (signalOutcomesFilterSide.value !== 'both') {
      if (!s.direction || s.direction !== signalOutcomesFilterSide.value) return false;
    }
    return true;
  });
});

const signalOutcomeReasonStats = computed<{ reasonCounts: Map<string, number>; total: number }>(
  () => {
    const reasonCounts = new Map<string, number>();
    for (const s of signalOutcomesFilteredByFields.value) {
      const code = s.block_reason ?? 'other';
      reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
    }
    return { reasonCounts, total: signalOutcomesFilteredByFields.value.length };
  },
);

const signalOutcomeTrailingCount = computed(
  () => signalOutcomeReasonStats.value.reasonCounts.get('trailing_entry') ?? 0,
);

function signalOutcomeReasonSharePct(count: number): string {
  const total = signalOutcomeReasonStats.value.total;
  if (!total) return '0.0';
  return ((count / total) * 100).toFixed(1);
}

const signalOutcomesEvaluated = computed(() =>
  signalOutcomesFiltered.value.filter(
    (s) => s.outcome_fetched_at !== null && s.fetch_error === null,
  ),
);

const signalOutcomesProfitable = computed(() =>
  signalOutcomesEvaluated.value.filter(
    (s) => (s.max_gain_pct ?? 0) >= signalOutcomesProfitThreshold.value,
  ),
);

const signalOutcomesProfitablePct = computed(() => {
  const evaluated = signalOutcomesEvaluated.value.length;
  if (!evaluated) return '0.0';
  return ((signalOutcomesProfitable.value.length / evaluated) * 100).toFixed(1);
});

const signalOutcomesPendingCount = computed(() => signalOutcomes.value?.pending_outcomes ?? 0);

const signalOutcomesFiltered = computed<DwhMissedSignal[]>(() => {
  let items = signalOutcomesFilteredByFields.value;
  if (selectedSignalOutcomeReasons.value.length) {
    const sel = new Set(selectedSignalOutcomeReasons.value);
    items = items.filter((s) => sel.has(s.block_reason ?? 'other'));
  }
  const filter = signalOutcomesFilterOutcome.value;
  if (filter === 'all') return items;
  return items.filter((sig) => {
    if (filter === 'error') return !!sig.fetch_error;
    if (filter === 'pending') return sig.outcome_fetched_at === null && !sig.fetch_error;
    if (sig.fetch_error || sig.outcome_fetched_at === null) return false;
    const isWin = (sig.max_gain_pct ?? 0) >= signalOutcomesProfitThreshold.value;
    if (filter === 'win') return isWin;
    const partial = isPartialOutcome(sig);
    if (filter === 'live') return !isWin && partial;
    if (filter === 'no_trigger') return !isWin && !partial;
    return true;
  });
});

/** True when a signal has been fetched but its outcome window hasn't elapsed yet. */
function isPartialOutcome(sig: DwhMissedSignal): boolean {
  if (!sig.outcome_fetched_at || sig.fetch_error) return false;
  const windowEndMs = new Date(sig.signal_ts).getTime() + sig.outcome_window_hours * 3_600_000;
  return Date.now() < windowEndMs;
}

// ── Signal Outcomes Chart ────────────────────────────────────────────────

const signalOutcomesChartPoints = computed<MissedChartPoint[]>(() => {
  const items = signalOutcomesFiltered.value;
  if (!items.length) return [];
  const bucketMap = new Map<string, number>();
  for (const s of items) {
    const key = s.signal_ts.slice(0, 13);
    bucketMap.set(key, (bucketMap.get(key) ?? 0) + 1);
  }
  const sorted = Array.from(bucketMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  let cumulative = 0;
  return sorted.map(([key, count]) => {
    cumulative += count;
    const date = new Date(key + ':00:00');
    const at = Number.isNaN(date.getTime()) ? key : timestampShort(date);
    return { hourKey: key, at, count, cumulative };
  });
});

const maxSignalOutcomesChartCount = computed(() => {
  if (!signalOutcomesChartPoints.value.length) return 1;
  if (signalOutcomesChartMode.value === 'hourly')
    return Math.max(...signalOutcomesChartPoints.value.map((p) => p.count), 1);
  return Math.max(...signalOutcomesChartPoints.value.map((p) => p.cumulative), 1);
});

const signalOutcomesChartPolyline = computed(() => {
  const pts = signalOutcomesChartPoints.value;
  if (!pts.length) return '';
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(pts.length - 1, 1);
  const maxY = maxSignalOutcomesChartCount.value;
  return pts
    .map((pt, idx) => {
      const x = leftPad + (idx / denominator) * plotWidth;
      const val = signalOutcomesChartMode.value === 'hourly' ? pt.count : pt.cumulative;
      const y = topPad + (1 - val / maxY) * plotHeight;
      return `${x},${y}`;
    })
    .join(' ');
});

const signalOutcomesChartAreaPolyline = computed(() => {
  const line = signalOutcomesChartPolyline.value;
  if (!line) return '';
  const first = line.split(' ')[0];
  const last = line.split(' ').slice(-1)[0];
  if (!first || !last) return '';
  return `${first} ${line} ${last.split(',')[0]},230 ${first.split(',')[0]},230`;
});

const signalOutcomesChartCoordinates = computed(() => {
  const pts = signalOutcomesChartPoints.value;
  if (!pts.length)
    return [] as { x: number; y: number; at: string; count: number; cumulative: number }[];
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(pts.length - 1, 1);
  const maxY = maxSignalOutcomesChartCount.value;
  return pts.map((pt, idx) => {
    const x = leftPad + (idx / denominator) * plotWidth;
    const val = signalOutcomesChartMode.value === 'hourly' ? pt.count : pt.cumulative;
    const y = topPad + (1 - val / maxY) * plotHeight;
    return { x, y, at: pt.at, count: pt.count, cumulative: pt.cumulative };
  });
});

const signalOutcomesChartYTicks = computed(() => {
  const ticks = 5;
  const maxY = maxSignalOutcomesChartCount.value;
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const ratio = i / ticks;
    const value = Math.round((1 - ratio) * maxY);
    const y = topPad + ratio * plotHeight;
    return { y, value };
  });
});

const signalOutcomesChartXTicks = computed(() => {
  const coords = signalOutcomesChartCoordinates.value;
  if (!coords.length) return [] as { x: number; label: string }[];
  const indexes = new Set<number>([0, Math.floor((coords.length - 1) / 2), coords.length - 1]);
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => ({ x: coords[index]?.x ?? 0, label: coords[index]?.at ?? '' }));
});

// ── End Signal Outcomes Chart ─────────────────────────────────────────────

async function loadSignalOutcomes() {
  loadingSignalOutcomes.value = true;
  reportsError.value = '';
  try {
    // Fetch all pages — client-side filtering requires the full dataset
    const pageSize = 2000;
    let offset = 0;
    let total = Infinity;
    let pendingOutcomes = 0;
    const allItems: DwhMissedSignal[] = [];
    while (offset < total) {
      const page = await vpsApi.dwhMissedSignals(
        signalOutcomesDateFrom.value || undefined,
        signalOutcomesDateTo.value || undefined,
        signalOutcomesFilterBotId.value ?? undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        pageSize,
        offset,
      );
      total = page.total;
      pendingOutcomes = page.pending_outcomes;
      allItems.push(...page.items);
      offset += pageSize;
    }
    signalOutcomes.value = { total, pending_outcomes: pendingOutcomes, items: allItems };
    signalOutcomesLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    signalOutcomes.value = null;
  } finally {
    loadingSignalOutcomes.value = false;
  }
}

function clearSignalOutcomeFilters() {
  signalOutcomesFilterPair.value = '';
  signalOutcomesFilterVps.value = '';
  signalOutcomesFilterSide.value = 'both';
  selectedSignalOutcomeReasons.value = [];
  signalOutcomesFilterOutcome.value = 'all';
}

async function runParseMissedSignals(fullRescan = false, gapFill = false) {
  loadingParseMissedSignals.value = true;
  try {
    const res = await vpsApi.parseMissedSignals(fullRescan, gapFill);
    if (!res.accepted) {
      reportsError.value = 'Parse already running';
      return;
    }
    // Poll until background worker finishes (max 2 minutes)
    const MAX_POLLS = 60;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const status = await vpsApi.getMissedSignalsParseStatus();
      if (!status.running) {
        if (status.error) reportsError.value = `Parse failed: ${status.error}`;
        break;
      }
      if (i === MAX_POLLS - 1) {
        reportsError.value = 'Parse timed out after 2 minutes — check status manually';
      }
    }
    await loadSignalOutcomes();
  } catch (error) {
    reportsError.value = String(error);
  } finally {
    loadingParseMissedSignals.value = false;
  }
}

async function runFetchOutcomes() {
  loadingFetchOutcomes.value = true;
  try {
    await vpsApi.fetchMissedSignalOutcomes();
    await loadSignalOutcomes();
  } catch (error) {
    reportsError.value = String(error);
  } finally {
    loadingFetchOutcomes.value = false;
  }
}

onMounted(() => {
  if (!signalOutcomesLoaded.value) {
    void loadSignalOutcomes();
  }
});
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <!-- Header + filters -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">Signal Outcome Analysis</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="signalOutcomesDateFrom" type="date" size="sm" class="w-36" />
        <UInput v-model="signalOutcomesDateTo" type="date" size="sm" class="w-36" />
        <USelect
          v-model="signalOutcomesFilterBotId"
          :items="botSelectOptions"
          placeholder="All bots"
          size="sm"
          class="w-56"
        />
        <UInput v-model="signalOutcomesFilterPair" size="sm" class="w-40" placeholder="Pair" />
        <UInput v-model="signalOutcomesFilterVps" size="sm" class="w-32" placeholder="VPS" />
        <!-- Side toggle -->
        <div class="flex gap-0 rounded border border-surface-600 overflow-hidden text-xs">
          <button
            v-for="sf in [
              { key: 'both', label: 'Both' },
              { key: 'long', label: 'Long' },
              { key: 'short', label: 'Short' },
            ]"
            :key="sf.key"
            class="px-2 py-1 transition-colors"
            :class="
              signalOutcomesFilterSide === sf.key
                ? 'bg-primary-600 text-white'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
            "
            @click="signalOutcomesFilterSide = sf.key as 'both' | 'long' | 'short'"
          >
            {{ sf.label }}
          </button>
        </div>
        <USelect
          v-model="signalOutcomesFilterOutcome"
          :items="signalOutcomeFilterOptions"
          size="sm"
          class="w-32"
        />
        <UInputNumber
          v-model="signalOutcomesProfitThreshold"
          :min="0.1"
          :max="100"
          :step="0.5"
          :format-options="{ minimumFractionDigits: 1, maximumFractionDigits: 1 }"
          size="sm"
          class="w-14"
          title="Win threshold (%)"
        />
        <UButton
          label="Clear"
          size="sm"
          color="neutral"
          variant="outline"
          @click="clearSignalOutcomeFilters"
        />
        <UButton
          label="Load"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loadingSignalOutcomes"
          @click="loadSignalOutcomes"
        />
      </div>
    </div>

    <!-- Reason buttons -->
    <div v-if="signalOutcomesLoaded" class="flex flex-wrap gap-2">
      <UButton
        :label="`Signals: ${signalOutcomeReasonStats.total}`"
        size="sm"
        color="info"
        variant="outline"
        @click="selectedSignalOutcomeReasons = []"
      />
      <UButton
        v-for="[code, count] in [...signalOutcomeReasonStats.reasonCounts.entries()].filter(
          ([c]) => c !== 'trailing_entry',
        )"
        :key="code"
        :label="`${SIGNAL_OUTCOME_REASON_LABELS[code] ?? code}: ${count} (${signalOutcomeReasonSharePct(count)}%)`"
        size="sm"
        color="warning"
        :variant="selectedSignalOutcomeReasons.includes(code) ? 'solid' : 'outline'"
        @click="
          selectedSignalOutcomeReasons.includes(code)
            ? (selectedSignalOutcomeReasons = selectedSignalOutcomeReasons.filter(
                (r) => r !== code,
              ))
            : selectedSignalOutcomeReasons.push(code)
        "
      />
      <UButton
        :label="`Trailing-entry misses: ${signalOutcomeTrailingCount} (${signalOutcomeReasonSharePct(signalOutcomeTrailingCount)}%)`"
        size="sm"
        color="warning"
        :variant="selectedSignalOutcomeReasons.includes('trailing_entry') ? 'solid' : 'outline'"
        @click="
          selectedSignalOutcomeReasons.includes('trailing_entry')
            ? (selectedSignalOutcomeReasons = selectedSignalOutcomeReasons.filter(
                (r) => r !== 'trailing_entry',
              ))
            : selectedSignalOutcomeReasons.push('trailing_entry')
        "
      />
    </div>

    <!-- Signal Outcomes Chart -->
    <div v-if="signalOutcomesChartPoints.length" class="space-y-1">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-3 text-xs text-surface-400">
          <span>{{
            signalOutcomesChartMode === 'hourly'
              ? 'Signals (Count per hour)'
              : 'Signals (Cumulative)'
          }}</span>
        </div>
        <USelect
          v-model="signalOutcomesChartMode"
          :items="missedChartModeOptions"
          size="sm"
          class="w-36"
        />
      </div>
      <svg viewBox="0 0 920 260" class="w-full h-64">
        <defs>
          <linearGradient id="signalOutcomesAreaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.35" />
            <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.03" />
          </linearGradient>
        </defs>
        <!-- Y-axis grid lines and labels -->
        <g>
          <line
            v-for="(tick, idx) in signalOutcomesChartYTicks"
            :key="`sogy-${idx}`"
            x1="40"
            :y1="tick.y"
            x2="900"
            :y2="tick.y"
            stroke="#334155"
            stroke-width="1"
            stroke-dasharray="4 4"
          />
          <text
            v-for="(tick, idx) in signalOutcomesChartYTicks"
            :key="`soty-${idx}`"
            :x="36"
            :y="tick.y + 4"
            text-anchor="end"
            fill="#94a3b8"
            font-size="10"
          >
            {{ tick.value }}
          </text>
        </g>
        <!-- Axes -->
        <line x1="40" y1="230" x2="900" y2="230" stroke="#475569" stroke-width="1" />
        <line x1="40" y1="14" x2="40" y2="230" stroke="#475569" stroke-width="1" />
        <!-- Axis labels -->
        <text x="8" y="24" fill="#94a3b8" font-size="11">Count</text>
        <text x="450" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">Date / Time</text>
        <!-- X-axis tick labels -->
        <text
          v-for="(tick, idx) in signalOutcomesChartXTicks"
          :key="`sotx-${idx}`"
          :x="tick.x"
          y="245"
          text-anchor="middle"
          fill="#94a3b8"
          font-size="10"
        >
          {{ tick.label }}
        </text>
        <!-- Area fill -->
        <polygon
          :points="signalOutcomesChartAreaPolyline"
          fill="url(#signalOutcomesAreaGradient)"
        />
        <!-- Line -->
        <polyline
          :points="signalOutcomesChartPolyline"
          fill="none"
          stroke="#60a5fa"
          stroke-width="2"
          stroke-linejoin="round"
        />
        <!-- Interactive hover points -->
        <circle
          v-for="(point, idx) in signalOutcomesChartCoordinates"
          :key="`soc-${idx}`"
          :cx="point.x"
          :cy="point.y"
          r="4"
          fill="#cbd5e1"
          class="cursor-pointer"
          @mousemove="
            showChartTooltip($event, [
              point.at,
              signalOutcomesChartMode === 'hourly'
                ? `Signals: ${point.count}`
                : `Cumulative signals: ${point.cumulative}`,
            ])
          "
          @mouseleave="hideChartTooltip"
        >
          <title>
            {{
              signalOutcomesChartMode === 'hourly'
                ? `Signals: ${point.count}`
                : `Cumulative signals: ${point.cumulative}`
            }}
          </title>
        </circle>
      </svg>
    </div>

    <!-- Admin actions -->
    <div class="flex flex-wrap gap-2 text-xs">
      <UButton
        label="Parse signals"
        size="sm"
        color="neutral"
        variant="outline"
        :loading="loadingParseMissedSignals"
        title="Scan new log events and store as missed signals"
        @click="runParseMissedSignals(false)"
      />
      <UButton
        label="Re-scan all"
        size="sm"
        color="neutral"
        variant="outline"
        :loading="loadingParseMissedSignals"
        title="Find and process log events not yet captured as missed signals (skips already-analyzed events)"
        @click="runParseMissedSignals(false, true)"
      />
      <UButton
        label="Fetch outcomes"
        size="sm"
        color="neutral"
        variant="outline"
        :loading="loadingFetchOutcomes"
        title="Fetch OHLCV data for signals older than 48h to compute outcome"
        @click="runFetchOutcomes"
      />
    </div>

    <!-- Summary stats -->
    <div v-if="signalOutcomesLoaded && signalOutcomes" class="flex flex-wrap gap-3 text-sm">
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold">{{ signalOutcomes.total }}</div>
        <div class="text-xs text-surface-400">Total signals</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold">{{ signalOutcomesEvaluated.length }}</div>
        <div class="text-xs text-surface-400">Evaluated</div>
      </div>
      <div class="rounded border border-green-700 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold text-green-400">
          {{ signalOutcomesProfitable.length }}
          <span class="text-sm font-normal">({{ signalOutcomesProfitablePct }}%)</span>
        </div>
        <div class="text-xs text-surface-400">Win (≥{{ signalOutcomesProfitThreshold }}%)</div>
      </div>
      <div
        v-if="signalOutcomesPendingCount > 0"
        class="rounded border border-yellow-700 px-3 py-2 min-w-28 text-center"
      >
        <div class="text-lg font-bold text-yellow-400">
          {{ signalOutcomesPendingCount }}
        </div>
        <div class="text-xs text-surface-400">Awaiting outcome fetch</div>
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-if="signalOutcomesLoaded && signalOutcomeItems.length === 0"
      class="text-sm text-surface-400 py-4 text-center"
    >
      No signals found. Run "Parse signals" after an ingestion to populate this report.
    </div>

    <!-- Table -->
    <div v-if="signalOutcomeItems.length > 0" class="overflow-x-auto w-full">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="border-b border-surface-600 text-left">
            <th class="py-2 pe-3">Time</th>
            <th class="py-2 pe-3">Bot</th>
            <th class="py-2 pe-3">Pair</th>
            <th class="py-2 pe-3">Reason</th>
            <th class="py-2 pe-3">Strategy</th>
            <th class="py-2 pe-3">Side</th>
            <th class="py-2 pe-3">Entry price</th>
            <th class="py-2 pe-3 text-green-400">Max gain</th>
            <th class="py-2 pe-3 text-red-400">Max loss</th>
            <th class="py-2">Outcome</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="sig in signalOutcomesFiltered"
            :key="sig.id"
            class="border-b border-surface-700/70 align-top"
          >
            <td class="py-2 pe-3 whitespace-nowrap">
              {{ formatDate(sig.signal_ts) }}
            </td>
            <td class="py-2 pe-3 whitespace-nowrap">
              <div class="font-medium">{{ sig.vps_name ?? `Bot ${sig.bot_id}` }}</div>
              <div class="text-xs text-surface-400">
                {{ sig.container_name }} · #{{ sig.bot_id }}
              </div>
            </td>
            <td class="py-2 pe-3 whitespace-nowrap font-mono">{{ sig.pair }}</td>
            <td class="py-2 pe-3 whitespace-nowrap text-xs text-surface-300">
              {{ sig.block_reason }}
            </td>
            <td class="py-2 pe-3 whitespace-nowrap text-xs text-surface-300">
              {{ sig.strategy ?? '—' }}
            </td>
            <td class="py-2 pe-3 whitespace-nowrap text-xs">
              <span
                v-if="sig.direction === 'long'"
                class="px-1.5 py-0.5 rounded text-green-400 bg-green-900/40 font-medium"
                >Long</span
              >
              <span
                v-else-if="sig.direction === 'short'"
                class="px-1.5 py-0.5 rounded text-red-400 bg-red-900/40 font-medium"
                >Short</span
              >
              <span v-else class="text-surface-500">—</span>
            </td>
            <td class="py-2 pe-3 whitespace-nowrap font-mono text-xs">
              <template v-if="sig.signal_price !== null">
                {{ sig.signal_price.toFixed(4) }}
                <span class="text-surface-500 ms-1">(log)</span>
              </template>
              <template v-else-if="sig.candle_open_at_signal !== null">
                {{ sig.candle_open_at_signal.toFixed(4) }}
                <span class="text-surface-500 ms-1">(candle)</span>
              </template>
              <span v-else class="text-surface-500">—</span>
            </td>
            <td class="py-2 pe-3 whitespace-nowrap font-mono text-xs">
              <span v-if="sig.max_gain_pct !== null" class="text-green-400"
                >+{{ sig.max_gain_pct.toFixed(2) }}%</span
              >
              <span v-else class="text-surface-500">—</span>
            </td>
            <td class="py-2 pe-3 whitespace-nowrap font-mono text-xs">
              <span v-if="sig.max_loss_pct !== null" class="text-red-400"
                >{{ sig.max_loss_pct.toFixed(2) }}%</span
              >
              <span v-else class="text-surface-500">—</span>
            </td>
            <td class="py-2 whitespace-nowrap text-xs">
              <span v-if="sig.fetch_error" class="text-orange-400" :title="sig.fetch_error"
                >Error</span
              >
              <span v-else-if="sig.outcome_fetched_at === null" class="text-surface-500"
                >Pending</span
              >
              <template v-else-if="(sig.max_gain_pct ?? 0) >= signalOutcomesProfitThreshold">
                <span class="text-green-400 font-medium">Win</span>
                <span
                  v-if="isPartialOutcome(sig)"
                  class="text-yellow-400 ms-1"
                  title="Window still open — outcome may improve"
                  >⟳</span
                >
              </template>
              <template v-else>
                <span
                  v-if="isPartialOutcome(sig)"
                  class="text-yellow-400 font-medium"
                  :title="`${sig.outcome_window_hours}h window still open`"
                  >Live</span
                >
                <span v-else class="text-red-400 font-medium">No trigger</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <div
        v-if="signalOutcomes && signalOutcomes.total > signalOutcomeItems.length"
        class="mt-2 text-xs text-surface-400"
      >
        Showing {{ signalOutcomeItems.length }} of {{ signalOutcomes.total }} signals
      </div>
    </div>
  </div>
</template>
