<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { todayStr } from '@/utils/reportDates';
import { formatDate } from '@/utils/reportParsers';
import { logsChartLayout } from '@/utils/reportCharts';
import { timestampShort } from '@/utils/formatters/timeformat';
import type { DwhOrder, DwhTrade } from '@/types/vps';

const {
  botSelectOptions,
  activeBotIds,
  isBotActive,
  showChartTooltip,
  hideChartTooltip,
  reportsError,
} = useReportsContext();

// ─── Types specific to this report ─────────────────────────────────────────

type DrillChartMetric = 'profit_pct' | 'profit_abs' | 'duration';

// ─── Constants ─────────────────────────────────────────────────────────────

const drillChartMetricOptions: { label: string; value: DrillChartMetric }[] = [
  { label: 'Profit %', value: 'profit_pct' },
  { label: 'Profit USDT', value: 'profit_abs' },
  { label: 'Duration (min)', value: 'duration' },
];

// ─── State ─────────────────────────────────────────────────────────────────

const drillChartMetric = ref<DrillChartMetric>('profit_pct');
const drillDateFrom = ref(todayStr());
const drillDateTo = ref(todayStr());
const drillFilterBotId = ref<number | null>(null);
const drillFilterPair = ref('');
const drillFilterStrategy = ref('');
const drillFilterEntryReason = ref('');
const drillFilterExitReason = ref('');
const drillFilterSide = ref<'all' | 'long' | 'short'>('all');
const drillTrades = ref<DwhTrade[]>([]);
const drillTotal = ref(0);
const drillOffset = ref(0);
const drillPageSize = 100;
const drillExpandedKey = ref<string | null>(null);
const drillOrdersCache = ref<Map<string, DwhOrder[]>>(new Map());
const drillOrdersLoading = ref<Set<string>>(new Set());
const drillOrdersError = ref<Set<string>>(new Set());
const loadingDrilldown = ref(false);
const drillLoaded = ref(false);

// ─── Helpers ───────────────────────────────────────────────────────────────

function tradeDurationMinutes(trade: DwhTrade): number | null {
  if (!trade.open_date || !trade.close_date) return null;
  const diff = new Date(trade.close_date).getTime() - new Date(trade.open_date).getTime();
  return diff > 0 ? diff / 60000 : null;
}

// ─── Computeds ─────────────────────────────────────────────────────────────

const botFilterActive = computed(() => {
  const totalBots = Math.max(botSelectOptions.value.length - 1, 0);
  return totalBots > 0 && activeBotIds.value.size < totalBots;
});

const drillChartSeriesLabel = computed(() => {
  if (drillChartMetric.value === 'profit_pct') return 'Profit % (per trade, by close date)';
  if (drillChartMetric.value === 'profit_abs') return 'Profit USDT (per trade, by close date)';
  return 'Duration min (per trade, by close date)';
});

const drillTradesFiltered = computed(() => drillTrades.value.filter((t) => isBotActive(t.bot_id)));

const drillChartDateRangeLabel = computed(() => {
  const trades = drillTradesFiltered.value;
  if (!trades.length) return 'Date / Time: n/a';
  const sorted = [...trades].sort((a, b) =>
    (a.close_date ?? a.open_date ?? '').localeCompare(b.close_date ?? b.open_date ?? ''),
  );
  const fmt = (s: string | null) => {
    if (!s) return '?';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : timestampShort(d);
  };
  return `Date / Time: ${fmt(sorted[0]?.close_date ?? sorted[0]?.open_date ?? null)} → ${fmt(sorted[sorted.length - 1]?.close_date ?? sorted[sorted.length - 1]?.open_date ?? null)}`;
});

const drillChartYRange = computed(() => {
  const trades = drillTradesFiltered.value;
  if (!trades.length) return { min: 0, max: 1 };
  const values = trades
    .map((t) => {
      if (drillChartMetric.value === 'profit_pct')
        return t.profit_ratio !== null ? t.profit_ratio * 100 : null;
      if (drillChartMetric.value === 'profit_abs') return t.profit_abs;
      return tradeDurationMinutes(t);
    })
    .filter((v): v is number => v !== null);
  if (!values.length) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.1 || 0.5;
  return {
    min: drillChartMetric.value === 'duration' ? Math.max(min - pad, 0) : Math.min(min - pad, 0),
    max: max + pad,
  };
});

const drillChartYTicks = computed(() => {
  const ticks = 5;
  const { min, max } = drillChartYRange.value;
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const ratio = i / ticks;
    const value = max - ratio * (max - min);
    const y = topPad + ratio * plotHeight;
    const label =
      drillChartMetric.value === 'profit_pct'
        ? `${value.toFixed(1)}%`
        : drillChartMetric.value === 'profit_abs'
          ? value.toFixed(2)
          : value.toFixed(0);
    return { y, value, label };
  });
});

const drillChartZeroY = computed(() => {
  const { min, max } = drillChartYRange.value;
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  const range = max - min || 1;
  return topPad + ((max - 0) / range) * plotHeight;
});

const drillChartCoordinates = computed(() => {
  const trades = drillTradesFiltered.value;
  if (!trades.length)
    return [] as {
      x: number;
      y: number;
      at: string;
      tradeId: number;
      pair: string;
      value: number | null;
      positive: boolean;
    }[];
  const sorted = [...trades].sort((a, b) =>
    (a.close_date ?? a.open_date ?? '').localeCompare(b.close_date ?? b.open_date ?? ''),
  );
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(sorted.length - 1, 1);
  const { min, max } = drillChartYRange.value;
  const range = max - min || 1;
  return sorted.map((trade, idx) => {
    const rawVal: number | null =
      drillChartMetric.value === 'profit_pct'
        ? trade.profit_ratio !== null
          ? trade.profit_ratio * 100
          : null
        : drillChartMetric.value === 'profit_abs'
          ? trade.profit_abs
          : tradeDurationMinutes(trade);
    const val = rawVal ?? min;
    const x = leftPad + (idx / denominator) * plotWidth;
    const y = topPad + ((max - val) / range) * plotHeight;
    const dateStr = trade.close_date ?? trade.open_date ?? '';
    const d = new Date(dateStr);
    const at = Number.isNaN(d.getTime()) ? dateStr : timestampShort(d);
    return {
      x,
      y,
      at,
      tradeId: trade.source_trade_id,
      pair: trade.pair ?? '?',
      value: rawVal,
      positive: (rawVal ?? 0) >= 0,
    };
  });
});

const drillChartXTicks = computed(() => {
  const coords = drillChartCoordinates.value;
  if (!coords.length) return [] as { x: number; label: string }[];
  const indexes = new Set<number>([0, Math.floor((coords.length - 1) / 2), coords.length - 1]);
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => ({ x: coords[index]?.x ?? 0, label: coords[index]?.at ?? '' }));
});

// ─── Functions ─────────────────────────────────────────────────────────────

function clearDrilldownFilters() {
  drillDateFrom.value = todayStr();
  drillDateTo.value = todayStr();
  drillFilterBotId.value = null;
  drillFilterPair.value = '';
  drillFilterStrategy.value = '';
  drillFilterEntryReason.value = '';
  drillFilterExitReason.value = '';
  drillFilterSide.value = 'all';
}

async function loadDrilldownReport(append = false) {
  if (!drillDateFrom.value) drillDateFrom.value = todayStr();
  if (!drillDateTo.value) drillDateTo.value = todayStr();
  if (!append) {
    drillOffset.value = 0;
    drillTrades.value = [];
  }
  loadingDrilldown.value = true;
  try {
    const result = await vpsApi.dwhTrades({
      date_from: drillDateFrom.value,
      date_to: drillDateTo.value,
      bot_id: drillFilterBotId.value ?? undefined,
      pair: drillFilterPair.value.trim() || undefined,
      strategy: drillFilterStrategy.value.trim() || undefined,
      entry_reason: drillFilterEntryReason.value.trim() || undefined,
      exit_reason: drillFilterExitReason.value.trim() || undefined,
      is_short: drillFilterSide.value === 'all' ? undefined : drillFilterSide.value === 'short',
      limit: drillPageSize,
      offset: drillOffset.value,
    });
    drillTotal.value = result.total;
    if (append) {
      drillTrades.value = [...drillTrades.value, ...result.items];
    } else {
      drillTrades.value = result.items;
    }
    drillOffset.value += result.items.length;
    drillLoaded.value = true;
  } catch (error) {
    // Surface the failure instead of masking it as "No trades found". On a
    // failed "Load more" (append), keep the rows already on screen.
    reportsError.value = String(error);
    if (!append) {
      drillTrades.value = [];
      drillTotal.value = 0;
    }
  } finally {
    loadingDrilldown.value = false;
  }
}

function drillTradeKey(trade: DwhTrade): string {
  return `${trade.bot_id}|${trade.source_trade_id}`;
}

async function loadDrillOrders(trade: DwhTrade) {
  const key = drillTradeKey(trade);
  if (drillOrdersLoading.value.has(key)) return;
  drillOrdersLoading.value = new Set([...drillOrdersLoading.value, key]);
  if (drillOrdersError.value.has(key)) {
    const cleared = new Set(drillOrdersError.value);
    cleared.delete(key);
    drillOrdersError.value = cleared;
  }
  try {
    const orders = await vpsApi.dwhTradeOrders(trade.id);
    const newMap = new Map(drillOrdersCache.value);
    newMap.set(key, orders);
    drillOrdersCache.value = newMap;
  } catch {
    // Don't cache on failure — flag an error so the row can be retried instead of
    // permanently showing "No orders found" (which is indistinguishable from a real
    // empty result if we cached []).
    drillOrdersError.value = new Set([...drillOrdersError.value, key]);
  } finally {
    const newSet = new Set(drillOrdersLoading.value);
    newSet.delete(key);
    drillOrdersLoading.value = newSet;
  }
}

async function toggleDrillTradeExpand(trade: DwhTrade) {
  const key = drillTradeKey(trade);
  if (drillExpandedKey.value === key) {
    drillExpandedKey.value = null;
    return;
  }
  drillExpandedKey.value = key;
  if (!drillOrdersCache.value.has(key) && !drillOrdersLoading.value.has(key)) {
    await loadDrillOrders(trade);
  }
}

function isDrillTradeExpanded(trade: DwhTrade): boolean {
  return drillExpandedKey.value === drillTradeKey(trade);
}

onMounted(() => {
  if (!drillLoaded.value) {
    void loadDrilldownReport();
  }
});
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <!-- Header + filters -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">Trade Drill-down (DWH)</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="drillDateFrom" type="date" size="sm" class="w-36" />
        <UInput v-model="drillDateTo" type="date" size="sm" class="w-36" />
        <USelect
          v-model="drillFilterBotId"
          :items="botSelectOptions"
          placeholder="All bots"
          size="sm"
          class="w-56"
        />
        <UInput
          v-model="drillFilterPair"
          size="sm"
          class="w-40"
          placeholder="Pair (e.g. BTC/USDT)"
        />
        <UInput v-model="drillFilterStrategy" size="sm" class="w-36" placeholder="Strategy" />
        <UInput v-model="drillFilterEntryReason" size="sm" class="w-36" placeholder="Entry tag" />
        <UInput v-model="drillFilterExitReason" size="sm" class="w-36" placeholder="Exit reason" />
        <USelect
          v-model="drillFilterSide"
          :items="[
            { label: 'All sides', value: 'all' },
            { label: 'Long', value: 'long' },
            { label: 'Short', value: 'short' },
          ]"
          size="sm"
          class="w-28"
        />
        <UButton
          label="Clear"
          size="sm"
          color="neutral"
          variant="outline"
          @click="clearDrilldownFilters"
        />
        <UButton
          label="Refresh"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loadingDrilldown"
          @click="loadDrilldownReport(false)"
        />
      </div>
    </div>

    <!-- Summary tags -->
    <div v-if="drillTradesFiltered.length" class="flex flex-wrap gap-2">
      <UBadge
        :label="`Showing: ${drillTradesFiltered.length} / ${drillTotal}${botFilterActive ? ' (bot filter active)' : ''}`"
        color="info"
      />
      <UBadge
        :label="`Avg profit: ${drillTradesFiltered.filter((t) => t.profit_ratio !== null).length ? ((drillTradesFiltered.reduce((s, t) => s + (t.profit_ratio ?? 0), 0) / drillTradesFiltered.filter((t) => t.profit_ratio !== null).length) * 100).toFixed(2) + '%' : 'n/a'}`"
        color="warning"
      />
      <UBadge
        :label="`Profitable: ${drillTradesFiltered.filter((t) => (t.profit_ratio ?? 0) > 0).length} / ${drillTradesFiltered.filter((t) => t.profit_ratio !== null).length}`"
        color="warning"
      />
      <UBadge
        :label="`Total profit: ${drillTradesFiltered.reduce((s, t) => s + (t.profit_abs ?? 0), 0).toFixed(2)} USDT`"
        color="warning"
      />
    </div>

    <!-- Chart -->
    <div v-if="drillTradesFiltered.length" class="space-y-1">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-3 text-xs text-surface-400">
          <span>{{ drillChartSeriesLabel }}</span>
          <span>{{ drillChartDateRangeLabel }}</span>
        </div>
        <USelect
          v-model="drillChartMetric"
          :items="drillChartMetricOptions"
          size="sm"
          class="w-40"
        />
      </div>
      <svg viewBox="0 0 920 260" class="w-full h-64">
        <defs>
          <linearGradient id="drillAreaGradientPos" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#34d399" stop-opacity="0.25" />
            <stop offset="100%" stop-color="#34d399" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <!-- Y-axis grid + labels -->
        <g>
          <line
            v-for="(tick, idx) in drillChartYTicks"
            :key="`dgy-${idx}`"
            x1="46"
            :y1="tick.y"
            x2="900"
            :y2="tick.y"
            stroke="#334155"
            stroke-width="1"
            stroke-dasharray="4 4"
          />
          <text
            v-for="(tick, idx) in drillChartYTicks"
            :key="`dty-${idx}`"
            :x="42"
            :y="tick.y + 4"
            text-anchor="end"
            fill="#94a3b8"
            font-size="10"
          >
            {{ tick.label }}
          </text>
        </g>
        <!-- Zero line (profit modes) -->
        <line
          v-if="drillChartMetric !== 'duration'"
          x1="46"
          :y1="drillChartZeroY"
          x2="900"
          :y2="drillChartZeroY"
          stroke="#64748b"
          stroke-width="1"
        />
        <!-- Axes -->
        <line x1="46" y1="230" x2="900" y2="230" stroke="#475569" stroke-width="1" />
        <line x1="46" y1="14" x2="46" y2="230" stroke="#475569" stroke-width="1" />
        <!-- Axis labels -->
        <text x="8" y="24" fill="#94a3b8" font-size="11">
          {{
            drillChartMetric === 'profit_pct'
              ? '%'
              : drillChartMetric === 'profit_abs'
                ? 'USDT'
                : 'min'
          }}
        </text>
        <text x="473" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">
          Trade close date
        </text>
        <!-- X ticks -->
        <text
          v-for="(tick, idx) in drillChartXTicks"
          :key="`dtx-${idx}`"
          :x="tick.x"
          y="245"
          text-anchor="middle"
          fill="#94a3b8"
          font-size="10"
        >
          {{ tick.label }}
        </text>
        <!-- Dots -->
        <circle
          v-for="(point, idx) in drillChartCoordinates"
          :key="`dc-${idx}`"
          :cx="point.x"
          :cy="point.y"
          r="4"
          :fill="
            point.value === null
              ? '#475569'
              : drillChartMetric === 'duration'
                ? '#60a5fa'
                : point.positive
                  ? '#34d399'
                  : '#f87171'
          "
          class="cursor-pointer"
          @mousemove="
            showChartTooltip($event, [
              `Trade #${point.tradeId} · ${point.pair}`,
              point.at,
              drillChartMetric === 'profit_pct'
                ? point.value !== null
                  ? `Profit: ${point.value.toFixed(2)}%`
                  : 'Profit: n/a'
                : drillChartMetric === 'profit_abs'
                  ? point.value !== null
                    ? `Profit: ${point.value.toFixed(2)} USDT`
                    : 'Profit: n/a'
                  : point.value !== null
                    ? `Duration: ${point.value.toFixed(1)} min`
                    : 'Duration: n/a',
            ])
          "
          @mouseleave="hideChartTooltip"
        >
          <title>{{ `Trade #${point.tradeId} · ${point.pair}` }}</title>
        </circle>
      </svg>
    </div>

    <!-- Empty state -->
    <div v-if="!drillTrades.length" class="text-sm text-surface-400">
      {{ loadingDrilldown ? 'Loading trades...' : 'No trades found for selected filters.' }}
    </div>

    <!-- Table -->
    <div v-else class="overflow-x-auto w-full">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="border-b border-surface-600 text-left">
            <th class="py-2 pe-3">#</th>
            <th class="py-2 pe-3">Bot</th>
            <th class="py-2 pe-3">Pair</th>
            <th class="py-2 pe-3">Side</th>
            <th class="py-2 pe-3">Entry tag</th>
            <th class="py-2 pe-3">Exit reason</th>
            <th class="py-2 pe-3">Open date</th>
            <th class="py-2 pe-3">Close date</th>
            <th class="py-2 pe-3 text-right">Duration</th>
            <th class="py-2 pe-3 text-right">Profit %</th>
            <th class="py-2 pe-3 text-right">Profit USDT</th>
            <th class="py-2 pe-3 text-right">DCA orders</th>
            <th class="py-2 pe-3 text-right">Anomalies</th>
            <th class="py-2 text-center">Detail</th>
          </tr>
        </thead>
        <tbody>
          <template
            v-for="trade in drillTradesFiltered"
            :key="`${trade.bot_id}-${trade.source_trade_id}`"
          >
            <tr class="border-b border-surface-700/70 align-top">
              <td class="py-2 pe-3 whitespace-nowrap">{{ trade.source_trade_id }}</td>
              <td class="py-2 pe-3 whitespace-nowrap">
                <div class="font-medium">{{ trade.vps_name ?? '—' }}</div>
                <div class="text-xs text-surface-400">
                  {{ trade.container_name ?? '—' }} · ID {{ trade.bot_id }}
                </div>
              </td>
              <td class="py-2 pe-3 whitespace-nowrap font-medium">
                {{ trade.pair ?? '—' }}
              </td>
              <td class="py-2 pe-3 whitespace-nowrap">
                <span :class="trade.is_short ? 'text-red-400' : 'text-green-400'">
                  {{ trade.is_short ? 'Short' : 'Long' }}
                </span>
              </td>
              <td class="py-2 pe-3 whitespace-nowrap text-surface-300">
                {{ trade.enter_tag ?? '—' }}
              </td>
              <td class="py-2 pe-3 whitespace-nowrap text-surface-300">
                {{ trade.exit_reason ?? (trade.is_open ? 'Open' : '—') }}
              </td>
              <td class="py-2 pe-3 whitespace-nowrap text-surface-400">
                {{ trade.open_date ? formatDate(trade.open_date) : '—' }}
              </td>
              <td class="py-2 pe-3 whitespace-nowrap text-surface-400">
                {{ trade.close_date ? formatDate(trade.close_date) : trade.is_open ? 'Open' : '—' }}
              </td>
              <td class="py-2 pe-3 whitespace-nowrap text-right text-surface-400">
                {{
                  tradeDurationMinutes(trade) !== null
                    ? `${tradeDurationMinutes(trade)!.toFixed(0)} min`
                    : '—'
                }}
              </td>
              <td
                class="py-2 pe-3 whitespace-nowrap text-right font-medium"
                :class="
                  trade.profit_ratio === null
                    ? 'text-surface-400'
                    : trade.profit_ratio >= 0
                      ? 'text-green-400'
                      : 'text-red-400'
                "
              >
                {{
                  trade.profit_ratio !== null ? `${(trade.profit_ratio * 100).toFixed(2)}%` : '—'
                }}
              </td>
              <td
                class="py-2 pe-3 whitespace-nowrap text-right"
                :class="
                  trade.profit_abs === null
                    ? 'text-surface-400'
                    : trade.profit_abs >= 0
                      ? 'text-green-400'
                      : 'text-red-400'
                "
              >
                {{ trade.profit_abs !== null ? trade.profit_abs.toFixed(3) : '—' }}
              </td>
              <td class="py-2 pe-3 whitespace-nowrap text-right font-mono text-xs">
                <span v-if="trade.dca_order_count > 1" class="text-primary-400 font-medium">{{
                  trade.dca_order_count
                }}</span>
                <span v-else-if="trade.dca_order_count === 1" class="text-surface-400">1</span>
                <span v-else class="text-surface-600">—</span>
              </td>
              <td class="py-2 pe-3 whitespace-nowrap text-right">
                <span v-if="trade.anomaly_count > 0" class="text-yellow-400 font-medium">{{
                  trade.anomaly_count
                }}</span>
                <span v-else class="text-surface-600">0</span>
              </td>
              <td class="py-2 text-center align-top">
                <button
                  class="px-2 py-1 rounded border border-surface-600 text-xs hover:bg-surface-800"
                  :disabled="drillOrdersLoading.has(drillTradeKey(trade))"
                  @click="toggleDrillTradeExpand(trade)"
                >
                  {{
                    drillOrdersLoading.has(drillTradeKey(trade))
                      ? '...'
                      : isDrillTradeExpanded(trade)
                        ? 'Hide'
                        : 'Show'
                  }}
                </button>
              </td>
            </tr>
            <tr
              v-if="isDrillTradeExpanded(trade)"
              class="border-b border-surface-800 bg-surface-950/40"
            >
              <td colspan="14" class="py-3 px-2">
                <div class="space-y-1 max-h-72 overflow-y-auto">
                  <div
                    v-if="drillOrdersError.has(drillTradeKey(trade))"
                    class="text-xs text-red-400 py-1 flex items-center gap-2"
                  >
                    <span>Failed to load orders for this trade.</span>
                    <button
                      class="px-2 py-0.5 rounded border border-surface-600 hover:bg-surface-800"
                      :disabled="drillOrdersLoading.has(drillTradeKey(trade))"
                      @click="loadDrillOrders(trade)"
                    >
                      Retry
                    </button>
                  </div>
                  <div
                    v-else-if="drillOrdersLoading.has(drillTradeKey(trade))"
                    class="text-xs text-surface-400 py-1"
                  >
                    Loading orders…
                  </div>
                  <div
                    v-else-if="!drillOrdersCache.get(drillTradeKey(trade))?.length"
                    class="text-xs text-surface-400 py-1"
                  >
                    No orders found for this trade.
                  </div>
                  <table v-else class="w-full text-xs border-collapse">
                    <thead>
                      <tr class="border-b border-surface-700 text-left">
                        <th class="py-1 pe-2">Date</th>
                        <th class="py-1 pe-2">Side</th>
                        <th class="py-1 pe-2">Type</th>
                        <th class="py-1 pe-2">Status</th>
                        <th class="py-1 pe-2">Tag</th>
                        <th class="py-1 pe-2 text-right">Amount</th>
                        <th class="py-1 pe-2 text-right">Filled</th>
                        <th class="py-1 pe-2 text-right">Avg price</th>
                        <th class="py-1 text-right">Fee</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(order, oi) in drillOrdersCache.get(drillTradeKey(trade))"
                        :key="`drill-order-${order.id}-${oi}`"
                        class="border-b border-surface-800/50 align-top"
                      >
                        <td class="py-1 pe-2 whitespace-nowrap">
                          {{ order.order_date ? formatDate(order.order_date) : '—' }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap">
                          <span
                            :class="order.side === 'sell' ? 'text-red-400' : 'text-green-400'"
                            >{{ order.side ?? '—' }}</span
                          >
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap text-surface-300">
                          {{ order.order_type ?? '—' }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap text-surface-300">
                          {{ order.status ?? '—' }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap text-surface-400">
                          {{ order.order_tag ?? '—' }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap text-right">
                          {{ order.amount !== null ? order.amount.toFixed(4) : '—' }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap text-right">
                          {{ order.filled !== null ? order.filled.toFixed(4) : '—' }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap text-right">
                          {{
                            order.average !== null
                              ? order.average.toFixed(4)
                              : order.price !== null
                                ? order.price.toFixed(4)
                                : '—'
                          }}
                        </td>
                        <td class="py-1 whitespace-nowrap text-right text-surface-400">
                          {{ order.fee_base !== null ? order.fee_base.toFixed(6) : '—' }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- Load more -->
    <div
      v-if="drillTrades.length && drillTrades.length < drillTotal"
      class="flex items-center gap-3"
    >
      <UButton
        :label="`Load more (${drillTotal - drillTrades.length} remaining)`"
        size="sm"
        color="neutral"
        variant="outline"
        :loading="loadingDrilldown"
        @click="loadDrilldownReport(true)"
      />
    </div>
  </div>
</template>
