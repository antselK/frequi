<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useTableSort } from '@/composables/useTableSort';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { daysAgoStr, todayStr } from '@/utils/reportDates';
import { niceTickInterval } from '@/utils/reportCharts';
import type {
  DwhBotPerfRead,
  DwhBotPerfHistoryRead,
  DwhBotPerfRollingScoreRead,
} from '@/types/vps';

const { reportsError, isBotActive, showChartTooltip, hideChartTooltip } = useReportsContext();

// Bot Performance Analysis state
const botPerf = ref<DwhBotPerfRead | null>(null);
const botPerfLoaded = ref(false);
const loadingBotPerf = ref(false);
const botPerfDateFrom = ref(daysAgoStr(30));
const botPerfDateTo = ref(todayStr());
const botPerfSortCol = ref<
  | 'total_closed_trades'
  | 'win_rate_pct'
  | 'avg_profit_pct'
  | 'total_profit_abs'
  | 'avg_duration_hours'
  | 'avg_dca_orders'
  | 'trades_per_day'
  | 'days_active'
  | 'perf_score'
>('perf_score');
const botPerfSortAsc = ref(false);
const botPerfActiveTab = ref<'performance' | 'history'>('performance');
const botPerfHistory = ref<DwhBotPerfHistoryRead | null>(null);
const botPerfRollingScore = ref<DwhBotPerfRollingScoreRead | null>(null);
const botHistChartMode = ref<'equity' | 'score'>('equity');
const botPerfProjectionMode = ref<'usdt' | 'pct' | 'compounded'>('usdt');
const botPerfCapital = ref<number>(Number(localStorage.getItem('botPerfCapital')) || 1000);
watch(botPerfCapital, (v) => localStorage.setItem('botPerfCapital', String(v)));
const botHistEnabledBots = ref<Set<number>>(new Set());
const botHistHoverDate = ref<string | null>(null);

// Format a duration in hours as "H:MMh". Rounds via total minutes so 2.999h → "3:00h"
// rather than the "2:60h" produced by rounding the minute part independently.
function formatDurationHM(hours: number | null): string {
  if (hours === null) return '—';
  const totalMin = Math.round(hours * 60);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}h`;
}

// Bot Performance computed
const botPerfItemsFiltered = computed(() =>
  (botPerf.value?.items ?? []).filter((r) => isBotActive(r.bot_id)),
);
const botPerfItems = useTableSort(botPerfItemsFiltered, botPerfSortCol, botPerfSortAsc);
const botPerfTotalClosed = computed(() =>
  botPerfItemsFiltered.value.reduce((s, r) => s + r.total_closed_trades, 0),
);
const botPerfTotalOpen = computed(() =>
  botPerfItemsFiltered.value.reduce((s, r) => s + r.total_open_trades, 0),
);
const botPerfTotalPnl = computed(() =>
  botPerfItemsFiltered.value.reduce((s, r) => s + r.total_profit_abs, 0),
);
const botPerfBestBot = computed(() => {
  const rows = botPerfItemsFiltered.value;
  if (!rows.length) return null;
  return rows.reduce((best, r) => {
    if (r.perf_score === null) return best;
    if (best.perf_score === null || r.perf_score > best.perf_score) return r;
    return best;
  });
});

// Bot History chart data
const BH_W = 900,
  BH_H = 280,
  BH_ML = 65,
  BH_MR = 20,
  BH_MT = 20,
  BH_MB = 45;
const BH_COLORS = [
  '#4ade80',
  '#60a5fa',
  '#f472b6',
  '#facc15',
  '#a78bfa',
  '#fb923c',
  '#34d399',
  '#f87171',
  '#38bdf8',
];

const botHistChartData = computed(() => {
  const mode = botHistChartMode.value;
  const enabled = botHistEnabledBots.value;

  // Build unified data points from whichever source is active
  interface RawPt {
    date: string;
    bot_id: number;
    container_name: string | null;
    vps_name: string | null;
    value: number;
    trades: number;
    extraLabel: string;
  }
  let rawItems: RawPt[];

  if (mode === 'equity') {
    rawItems = (botPerfHistory.value?.items ?? []).map((i) => ({
      date: i.date,
      bot_id: i.bot_id,
      container_name: i.container_name,
      vps_name: i.vps_name,
      value: i.cumulative_profit_abs,
      trades: i.trades,
      extraLabel: `${i.cumulative_profit_abs >= 0 ? '+' : ''}${i.cumulative_profit_abs.toFixed(2)} USDT (+${i.profit_abs.toFixed(2)} today, ${i.trades} trades)`,
    }));
  } else {
    rawItems = (botPerfRollingScore.value?.items ?? []).map((i) => ({
      date: i.date,
      bot_id: i.bot_id,
      container_name: i.container_name,
      vps_name: i.vps_name,
      value: i.score,
      trades: i.trade_count,
      extraLabel: `score ${i.score >= 0 ? '+' : ''}${i.score.toFixed(2)} (${i.trade_count} trades, avg ${i.avg_profit_pct >= 0 ? '+' : ''}${i.avg_profit_pct.toFixed(2)}%)`,
    }));
  }

  // Filter to enabled bots (legend toggle) AND global bot filter
  const globalFiltered = rawItems.filter((i) => isBotActive(i.bot_id));
  const filtered =
    enabled.size > 0 ? globalFiltered.filter((i) => enabled.has(i.bot_id)) : globalFiltered;
  if (!filtered.length) return null;

  const plotW = BH_W - BH_ML - BH_MR;
  const plotH = BH_H - BH_MT - BH_MB;

  const allDates = [...new Set(filtered.map((i) => i.date))].sort();
  const firstMs = new Date(allDates[0]).getTime();
  const lastMs = new Date(allDates[allDates.length - 1]).getTime();
  const spanMs = Math.max(lastMs - firstMs, 86_400_000);
  const dateToX = (d: string) => BH_ML + ((new Date(d).getTime() - firstMs) / spanMs) * plotW;

  const allValues = filtered.map((i) => i.value);
  const rawMin = Math.min(mode === 'equity' ? 0 : Math.min(...allValues), ...allValues);
  const rawMax = Math.max(mode === 'equity' ? 1 : Math.max(...allValues), ...allValues);
  const yRange = rawMax - rawMin;
  // When every point is identical (e.g. a single pivot date in score mode) yRange is 0;
  // fall back to a nonzero pad so valToY's denominator never collapses to 0 (NaN coords).
  const yPad = (yRange || Math.abs(rawMax) || 1) * 0.12;
  const yMin = rawMin - yPad;
  const yMax = rawMax + yPad;
  const valToY = (v: number) => BH_MT + plotH * (1 - (v - yMin) / (yMax - yMin));

  // Y ticks
  const yStep = niceTickInterval(yMin, yMax, 5);
  const yTicks: { y: number; value: number }[] = [];
  let tv = Math.ceil(yMin / yStep) * yStep;
  while (tv <= yMax + yStep * 0.01) {
    yTicks.push({ y: Math.round(valToY(tv) * 10) / 10, value: tv });
    tv = Math.round((tv + yStep) * 1e9) / 1e9;
  }

  // X ticks (up to 6 labels)
  const xTickCount = Math.min(allDates.length, 6);
  const xTicks: { x: number; label: string; date: string }[] = [];
  for (let i = 0; i < xTickCount; i++) {
    const idx = Math.round((i / Math.max(xTickCount - 1, 1)) * (allDates.length - 1));
    const d = allDates[idx];
    xTicks.push({ x: Math.round(dateToX(d) * 10) / 10, label: d.slice(5), date: d });
  }

  const datePositions = allDates.map((d) => ({ date: d, x: dateToX(d) }));

  // Series per bot — assign stable color by bot_id order from full (unfiltered) data
  const allBotIds = [...new Set(rawItems.map((i) => i.bot_id))].sort((a, b) => a - b);
  const colorByBot = new Map(allBotIds.map((id, idx) => [id, BH_COLORS[idx % BH_COLORS.length]]));

  const byBot = new Map<number, RawPt[]>();
  for (const item of filtered) {
    if (!byBot.has(item.bot_id)) byBot.set(item.bot_id, []);
    byBot.get(item.bot_id)!.push(item);
  }
  const series = [...byBot.entries()].map(([botId, botItems]) => {
    const sorted = [...botItems].sort((a, b) => a.date.localeCompare(b.date));
    const name = sorted[0]?.container_name ?? `Bot ${botId}`;
    const vpsName = sorted[0]?.vps_name ?? '';
    const color = colorByBot.get(botId) ?? BH_COLORS[0];
    const points = sorted.map((item) => ({
      x: Math.round(dateToX(item.date) * 10) / 10,
      y: Math.round(valToY(item.value) * 10) / 10,
      date: item.date,
      value: item.value,
      extraLabel: item.extraLabel,
    }));
    const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(' ');
    return { botId, name, vpsName, color, points, polylinePoints };
  });

  const zeroY = Math.round(valToY(0) * 10) / 10;
  const showZero = zeroY >= BH_MT && zeroY <= BH_MT + plotH;

  return { series, yTicks, xTicks, datePositions, zeroY, showZero };
});

const botHistHoverX = computed(() => {
  const d = botHistHoverDate.value;
  if (!d || !botHistChartData.value) return null;
  return botHistChartData.value.datePositions.find((dp) => dp.date === d)?.x ?? null;
});

const botHistHoverPoints = computed(() => {
  const d = botHistHoverDate.value;
  const cd = botHistChartData.value;
  if (!d || !cd) return [] as { name: string; color: string; x: number; y: number }[];
  return cd.series.flatMap((s) => {
    const pt = s.points.find((p) => p.date === d);
    return pt ? [{ name: s.name, color: s.color, x: pt.x, y: pt.y }] : [];
  });
});

function botHistOnMouseMove(event: MouseEvent) {
  const cd = botHistChartData.value;
  if (!cd) return;
  const svg = event.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  const svgX = (event.clientX - rect.left) * (BH_W / rect.width);

  // Find nearest date by X
  let nearest: string | null = null;
  let minDist = Infinity;
  for (const dp of cd.datePositions) {
    const dist = Math.abs(dp.x - svgX);
    if (dist < minDist) {
      minDist = dist;
      nearest = dp.date;
    }
  }
  if (nearest === null) {
    botHistHoverDate.value = null;
    hideChartTooltip();
    return;
  }

  botHistHoverDate.value = nearest;
  const lines: string[] = [nearest];
  for (const hp of cd.series) {
    const pt = hp.points.find((p) => p.date === nearest);
    if (pt) lines.push(`${hp.name}${hp.vpsName ? ' / ' + hp.vpsName : ''}: ${pt.extraLabel}`);
  }
  showChartTooltip(event, lines);
}
function botHistOnMouseLeave() {
  botHistHoverDate.value = null;
  hideChartTooltip();
}

// All bots across both data sources — used for the legend so bots show even when de-selected
const botHistAllBots = computed(() => {
  const equityItems = (botPerfHistory.value?.items ?? []).filter((i) => isBotActive(i.bot_id));
  const scoreItems = (botPerfRollingScore.value?.items ?? []).filter((i) => isBotActive(i.bot_id));
  const seen = new Set<number>();
  const bots: { botId: number; name: string; vpsName: string; color: string }[] = [];
  const allIds = [...new Set([...equityItems, ...scoreItems].map((i) => i.bot_id))].sort(
    (a, b) => a - b,
  );
  const colorByBot = new Map(allIds.map((id, idx) => [id, BH_COLORS[idx % BH_COLORS.length]]));
  for (const item of [...equityItems, ...scoreItems]) {
    if (seen.has(item.bot_id)) continue;
    seen.add(item.bot_id);
    bots.push({
      botId: item.bot_id,
      name: item.container_name ?? `Bot ${item.bot_id}`,
      vpsName: item.vps_name ?? '',
      color: colorByBot.get(item.bot_id) ?? BH_COLORS[0],
    });
  }
  return bots.sort((a, b) => a.botId - b.botId);
});

function botHistToggleBot(botId: number) {
  const s = new Set(botHistEnabledBots.value);
  if (s.has(botId)) {
    s.delete(botId);
  } else {
    s.add(botId);
  }
  botHistEnabledBots.value = s;
}

async function loadBotPerf() {
  loadingBotPerf.value = true;
  reportsError.value = '';
  try {
    const [perf, hist, rolling] = await Promise.all([
      vpsApi.dwhBotPerformance(
        botPerfDateFrom.value || undefined,
        botPerfDateTo.value || undefined,
      ),
      vpsApi.dwhBotPerfHistory(
        botPerfDateFrom.value || undefined,
        botPerfDateTo.value || undefined,
      ),
      vpsApi.dwhBotPerfRollingScore(
        botPerfDateFrom.value || undefined,
        botPerfDateTo.value || undefined,
      ),
    ]);
    botPerf.value = perf;
    botPerfHistory.value = hist;
    botPerfRollingScore.value = rolling;
    // Init all bots as enabled
    const allBotIds = new Set([
      ...hist.items.map((i) => i.bot_id),
      ...rolling.items.map((i) => i.bot_id),
    ]);
    botHistEnabledBots.value = allBotIds;
    botPerfLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    botPerf.value = null;
    botPerfHistory.value = null;
    botPerfRollingScore.value = null;
  } finally {
    loadingBotPerf.value = false;
  }
}

onMounted(() => {
  if (!botPerfLoaded.value) {
    void loadBotPerf();
  }
});
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <!-- Header + filters -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">Bot Performance Analysis</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="botPerfDateFrom" type="date" size="sm" class="w-36" />
        <span class="text-surface-400 text-xs">to</span>
        <UInput v-model="botPerfDateTo" type="date" size="sm" class="w-36" />
        <UButton
          label="Load"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loadingBotPerf"
          @click="loadBotPerf"
        />
      </div>
    </div>

    <!-- Summary cards -->
    <div v-if="botPerfLoaded && botPerf" class="flex flex-wrap gap-3 text-sm">
      <div class="rounded border border-surface-600 px-3 py-2 min-w-24 text-center">
        <div class="text-lg font-bold">{{ botPerf.total_bots }}</div>
        <div class="text-xs text-surface-400">Bots</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-24 text-center">
        <div class="text-lg font-bold">{{ botPerfTotalClosed }}</div>
        <div class="text-xs text-surface-400">Closed trades</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-24 text-center">
        <div class="text-lg font-bold">{{ botPerfTotalOpen }}</div>
        <div class="text-xs text-surface-400">Open now</div>
      </div>
      <div
        class="rounded border px-3 py-2 min-w-36 text-center"
        :class="botPerfTotalPnl >= 0 ? 'border-green-700' : 'border-red-700'"
      >
        <div
          class="text-lg font-bold"
          :class="botPerfTotalPnl >= 0 ? 'text-green-400' : 'text-red-400'"
        >
          {{ botPerfTotalPnl >= 0 ? '+' : '' }}{{ botPerfTotalPnl.toFixed(2) }} USDT
        </div>
        <div class="text-xs text-surface-400">Total PnL</div>
      </div>
      <div
        v-if="botPerfBestBot"
        class="rounded border border-primary-700 px-3 py-2 min-w-40 text-center"
      >
        <div class="text-sm font-bold text-primary-400 truncate">
          {{ botPerfBestBot.container_name ?? `Bot ${botPerfBestBot.bot_id}` }}
        </div>
        <div class="text-xs text-surface-400">
          Best score ({{ botPerfBestBot.perf_score?.toFixed(1) }})
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div v-if="botPerfLoaded && botPerfItems.length > 0" class="space-y-4">
      <div class="flex gap-0 border-b border-surface-600">
        <button
          v-for="tab in [
            { key: 'performance', label: 'Performance' },
            { key: 'history', label: 'History' },
          ]"
          :key="tab.key"
          class="px-4 py-2 text-sm border-b-2 transition-colors"
          :class="
            botPerfActiveTab === tab.key
              ? 'border-primary-500 text-primary-400 font-medium'
              : 'border-transparent text-surface-400 hover:text-surface-200'
          "
          @click="botPerfActiveTab = tab.key as 'performance' | 'history'"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Performance tab (removed) -->
      <div v-if="false" class="overflow-x-auto w-full">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="border-b border-surface-600 text-left text-surface-300">
              <th class="py-2 pe-3 whitespace-nowrap">Bot</th>
              <th class="py-2 pe-3 whitespace-nowrap">Strategy</th>
              <th class="py-2 pe-3 whitespace-nowrap">Exchange</th>
              <th
                class="py-2 pe-3 whitespace-nowrap text-right cursor-pointer select-none"
                :class="botPerfSortCol === 'total_closed_trades' ? 'text-primary-400' : ''"
                @click="
                  botPerfSortCol === 'total_closed_trades'
                    ? (botPerfSortAsc = !botPerfSortAsc)
                    : ((botPerfSortCol = 'total_closed_trades'), (botPerfSortAsc = false))
                "
              >
                Closed
                {{ botPerfSortCol === 'total_closed_trades' ? (botPerfSortAsc ? '↑' : '↓') : '' }}
              </th>
              <th class="py-2 pe-3 whitespace-nowrap text-right">Open</th>
              <th
                class="py-2 pe-3 whitespace-nowrap text-right cursor-pointer select-none"
                :class="botPerfSortCol === 'win_rate_pct' ? 'text-primary-400' : ''"
                @click="
                  botPerfSortCol === 'win_rate_pct'
                    ? (botPerfSortAsc = !botPerfSortAsc)
                    : ((botPerfSortCol = 'win_rate_pct'), (botPerfSortAsc = false))
                "
              >
                Win%
                {{ botPerfSortCol === 'win_rate_pct' ? (botPerfSortAsc ? '↑' : '↓') : '' }}
              </th>
              <th
                class="py-2 pe-3 whitespace-nowrap text-right cursor-pointer select-none"
                :class="botPerfSortCol === 'avg_profit_pct' ? 'text-primary-400' : ''"
                @click="
                  botPerfSortCol === 'avg_profit_pct'
                    ? (botPerfSortAsc = !botPerfSortAsc)
                    : ((botPerfSortCol = 'avg_profit_pct'), (botPerfSortAsc = false))
                "
              >
                Avg Profit%
                {{ botPerfSortCol === 'avg_profit_pct' ? (botPerfSortAsc ? '↑' : '↓') : '' }}
              </th>
              <th
                class="py-2 pe-3 whitespace-nowrap text-right cursor-pointer select-none"
                :class="botPerfSortCol === 'total_profit_abs' ? 'text-primary-400' : ''"
                @click="
                  botPerfSortCol === 'total_profit_abs'
                    ? (botPerfSortAsc = !botPerfSortAsc)
                    : ((botPerfSortCol = 'total_profit_abs'), (botPerfSortAsc = false))
                "
              >
                Total PnL
                {{ botPerfSortCol === 'total_profit_abs' ? (botPerfSortAsc ? '↑' : '↓') : '' }}
              </th>
              <th
                class="py-2 pe-3 whitespace-nowrap text-right cursor-pointer select-none"
                :class="botPerfSortCol === 'avg_duration_hours' ? 'text-primary-400' : ''"
                @click="
                  botPerfSortCol === 'avg_duration_hours'
                    ? (botPerfSortAsc = !botPerfSortAsc)
                    : ((botPerfSortCol = 'avg_duration_hours'), (botPerfSortAsc = false))
                "
              >
                Avg Dur
                {{ botPerfSortCol === 'avg_duration_hours' ? (botPerfSortAsc ? '↑' : '↓') : '' }}
              </th>
              <th
                class="py-2 pe-3 whitespace-nowrap text-right cursor-pointer select-none"
                :class="botPerfSortCol === 'avg_dca_orders' ? 'text-primary-400' : ''"
                @click="
                  botPerfSortCol === 'avg_dca_orders'
                    ? (botPerfSortAsc = !botPerfSortAsc)
                    : ((botPerfSortCol = 'avg_dca_orders'), (botPerfSortAsc = false))
                "
              >
                Avg DCA
                {{ botPerfSortCol === 'avg_dca_orders' ? (botPerfSortAsc ? '↑' : '↓') : '' }}
              </th>
              <th
                class="py-2 pe-3 whitespace-nowrap text-right cursor-pointer select-none"
                :class="botPerfSortCol === 'trades_per_day' ? 'text-primary-400' : ''"
                @click="
                  botPerfSortCol === 'trades_per_day'
                    ? (botPerfSortAsc = !botPerfSortAsc)
                    : ((botPerfSortCol = 'trades_per_day'), (botPerfSortAsc = false))
                "
              >
                /day
                {{ botPerfSortCol === 'trades_per_day' ? (botPerfSortAsc ? '↑' : '↓') : '' }}
              </th>
              <th
                class="py-2 pe-3 whitespace-nowrap text-right cursor-pointer select-none"
                :class="botPerfSortCol === 'days_active' ? 'text-primary-400' : ''"
                @click="
                  botPerfSortCol === 'days_active'
                    ? (botPerfSortAsc = !botPerfSortAsc)
                    : ((botPerfSortCol = 'days_active'), (botPerfSortAsc = false))
                "
              >
                Days active
                {{ botPerfSortCol === 'days_active' ? (botPerfSortAsc ? '↑' : '↓') : '' }}
              </th>
              <th
                class="py-2 pe-3 whitespace-nowrap text-right cursor-pointer select-none"
                :class="botPerfSortCol === 'perf_score' ? 'text-primary-400' : ''"
                @click="
                  botPerfSortCol === 'perf_score'
                    ? (botPerfSortAsc = !botPerfSortAsc)
                    : ((botPerfSortCol = 'perf_score'), (botPerfSortAsc = false))
                "
              >
                Score
                {{ botPerfSortCol === 'perf_score' ? (botPerfSortAsc ? '↑' : '↓') : '' }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in botPerfItems"
              :key="row.bot_id"
              class="border-b border-surface-700/70 hover:bg-surface-700/30"
            >
              <td class="py-2 pe-3">
                <div class="font-mono text-xs font-medium">
                  {{ row.container_name ?? `Bot ${row.bot_id}` }}
                  <span class="text-surface-500 font-normal ml-1">{{ row.vps_name }}</span>
                </div>
                <div v-if="row.best_pair" class="text-xs text-surface-400 mt-0.5">
                  Best: {{ row.best_pair }}
                  <span
                    v-if="row.best_pair_profit_abs !== null"
                    :class="row.best_pair_profit_abs >= 0 ? 'text-green-500' : 'text-red-400'"
                  >
                    ({{ row.best_pair_profit_abs >= 0 ? '+' : ''
                    }}{{ row.best_pair_profit_abs.toFixed(2) }})
                  </span>
                </div>
              </td>
              <td class="py-2 pe-3 font-mono text-xs text-surface-300">
                {{ row.strategy ?? '—' }}
              </td>
              <td class="py-2 pe-3 font-mono text-xs text-surface-300">
                {{ row.exchange ?? '—' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.total_closed_trades }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs text-surface-400">
                {{ row.total_open_trades > 0 ? row.total_open_trades : '—' }}
              </td>
              <td
                class="py-2 pe-3 text-right font-mono text-xs"
                :class="row.win_rate_pct >= 50 ? 'text-green-400' : 'text-red-400'"
              >
                {{ row.win_rate_pct.toFixed(1) }}%
                <div class="text-surface-500 font-normal">{{ row.wins }}/{{ row.losses }}</div>
              </td>
              <td
                class="py-2 pe-3 text-right font-mono text-xs"
                :class="row.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'"
              >
                {{ row.avg_profit_pct >= 0 ? '+' : '' }}{{ row.avg_profit_pct.toFixed(2) }}%
              </td>
              <td
                class="py-2 pe-3 text-right font-mono text-xs font-semibold"
                :class="row.total_profit_abs >= 0 ? 'text-green-400' : 'text-red-400'"
              >
                {{ row.total_profit_abs >= 0 ? '+' : '' }}{{ row.total_profit_abs.toFixed(2) }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs text-surface-300">
                {{ formatDurationHM(row.avg_duration_hours) }}
              </td>
              <td
                class="py-2 pe-3 text-right font-mono text-xs"
                :class="
                  row.avg_dca_orders <= 1.2
                    ? 'text-green-400'
                    : row.avg_dca_orders <= 2.0
                      ? 'text-yellow-400'
                      : 'text-red-400'
                "
              >
                {{ row.avg_dca_orders.toFixed(2) }}x
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs text-surface-300">
                {{ row.trades_per_day.toFixed(1) }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs text-surface-300">
                {{ row.days_active !== null ? `${row.days_active.toFixed(1)}d` : '—' }}
              </td>
              <td class="py-2 pe-3 text-right">
                <span
                  v-if="row.perf_score !== null"
                  class="inline-block px-2 py-0.5 rounded font-mono text-xs font-semibold"
                  :class="
                    row.perf_score >= 8
                      ? 'bg-green-900/40 text-green-300 border border-green-700'
                      : row.perf_score >= 3
                        ? 'bg-yellow-900/30 text-yellow-300 border border-yellow-700'
                        : 'bg-red-900/30 text-red-300 border border-red-700'
                  "
                >
                  {{ row.perf_score.toFixed(1) }}
                </span>
                <span v-else class="text-surface-500 text-xs">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="text-xs text-surface-500 mt-2">
          Score = avg profit% × 2 − avg duration × 0.1 − (avg DCA − 1) × 1. Higher is better. Green
          ≥ 8 · Yellow ≥ 3 · Red &lt; 3.
        </p>
      </div>

      <!-- Performance tab -->
      <div v-if="botPerfActiveTab === 'performance'" class="space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <p class="text-xs text-surface-400 italic">
            <template v-if="botPerfProjectionMode === 'usdt'">
              Linear extrapolation from closed trade history within the selected date range. Based
              on total PnL ÷ days active. Past performance does not predict future results.
            </template>
            <template v-else-if="botPerfProjectionMode === 'pct'">
              Daily PnL as % of starting capital. Linear extrapolation. Past performance does not
              predict future results.
            </template>
            <template v-else>
              Compounded daily rate: (1 + daily%)^N − 1. Assumes profits reinvested. Past
              performance does not predict future results.
            </template>
          </p>
          <div class="flex items-center gap-2 shrink-0">
            <div class="flex gap-0 rounded border border-surface-600 overflow-hidden text-xs">
              <button
                class="px-3 py-1 transition-colors"
                :class="
                  botPerfProjectionMode === 'usdt'
                    ? 'bg-surface-600 text-white'
                    : 'text-surface-400 hover:text-surface-200'
                "
                @click="botPerfProjectionMode = 'usdt'"
              >
                USDT
              </button>
              <button
                class="px-3 py-1 transition-colors"
                :class="
                  botPerfProjectionMode === 'pct'
                    ? 'bg-surface-600 text-white'
                    : 'text-surface-400 hover:text-surface-200'
                "
                @click="botPerfProjectionMode = 'pct'"
              >
                %
              </button>
              <button
                class="px-3 py-1 transition-colors"
                :class="
                  botPerfProjectionMode === 'compounded'
                    ? 'bg-surface-600 text-white'
                    : 'text-surface-400 hover:text-surface-200'
                "
                @click="botPerfProjectionMode = 'compounded'"
              >
                Compounded
              </button>
            </div>
            <div v-if="botPerfProjectionMode !== 'usdt'" class="flex items-center gap-1 text-xs">
              <span class="text-surface-400">Capital (USDT):</span>
              <UInputNumber v-model="botPerfCapital" :min="1" size="sm" class="w-20" />
            </div>
          </div>
        </div>
        <div class="overflow-x-auto w-full">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="border-b border-surface-600 text-left text-surface-300">
                <th class="py-2 pe-3 whitespace-nowrap">Bot</th>
                <th class="py-2 pe-3 whitespace-nowrap">Strategy</th>
                <th class="py-2 pe-3 whitespace-nowrap">Exchange</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Closed</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Open</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Win%</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Avg Profit%</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Total PnL</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Avg Dur</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Avg DCA</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">/day</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Days active</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Score</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">
                  {{ botPerfProjectionMode === 'usdt' ? 'Daily est. USDT' : 'Daily est. %' }}
                </th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">
                  {{ botPerfProjectionMode === 'usdt' ? 'Monthly est. USDT' : 'Monthly est. %' }}
                </th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">
                  {{ botPerfProjectionMode === 'usdt' ? 'Yearly est. USDT' : 'Yearly est. %' }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in botPerfItems"
                :key="`proj-${row.bot_id}`"
                class="border-b border-surface-700/70 hover:bg-surface-700/30"
              >
                <td class="py-2 pe-3">
                  <div class="font-mono text-xs font-medium">
                    {{ row.container_name ?? `Bot ${row.bot_id}` }}
                  </div>
                  <div class="text-xs text-surface-500">{{ row.vps_name }}</div>
                </td>
                <td class="py-2 pe-3 font-mono text-xs text-surface-300">
                  {{ row.strategy ?? '—' }}
                </td>
                <td class="py-2 pe-3 font-mono text-xs text-surface-300">
                  {{ row.exchange ?? '—' }}
                </td>
                <td class="py-2 pe-3 text-right font-mono text-xs">
                  {{ row.total_closed_trades }}
                </td>
                <td class="py-2 pe-3 text-right font-mono text-xs text-surface-400">
                  {{ row.total_open_trades > 0 ? row.total_open_trades : '—' }}
                </td>
                <td
                  class="py-2 pe-3 text-right font-mono text-xs"
                  :class="row.win_rate_pct >= 50 ? 'text-green-400' : 'text-red-400'"
                >
                  {{ row.win_rate_pct.toFixed(1) }}%
                  <div class="text-surface-500 font-normal">{{ row.wins }}/{{ row.losses }}</div>
                </td>
                <td
                  class="py-2 pe-3 text-right font-mono text-xs"
                  :class="row.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'"
                >
                  {{ row.avg_profit_pct >= 0 ? '+' : '' }}{{ row.avg_profit_pct.toFixed(2) }}%
                </td>
                <td
                  class="py-2 pe-3 text-right font-mono text-xs font-semibold"
                  :class="row.total_profit_abs >= 0 ? 'text-green-400' : 'text-red-400'"
                >
                  {{ row.total_profit_abs >= 0 ? '+' : '' }}{{ row.total_profit_abs.toFixed(2) }}
                </td>
                <td class="py-2 pe-3 text-right font-mono text-xs text-surface-300">
                  {{ formatDurationHM(row.avg_duration_hours) }}
                </td>
                <td
                  class="py-2 pe-3 text-right font-mono text-xs"
                  :class="
                    row.avg_dca_orders <= 1.2
                      ? 'text-green-400'
                      : row.avg_dca_orders <= 2.0
                        ? 'text-yellow-400'
                        : 'text-red-400'
                  "
                >
                  {{ row.avg_dca_orders.toFixed(2) }}x
                </td>
                <td class="py-2 pe-3 text-right font-mono text-xs text-surface-300">
                  {{ row.trades_per_day.toFixed(1) }}
                </td>
                <td class="py-2 pe-3 text-right font-mono text-xs text-surface-300">
                  {{ row.days_active !== null ? `${row.days_active.toFixed(1)}d` : '—' }}
                </td>
                <td class="py-2 pe-3 text-right">
                  <span
                    v-if="row.perf_score !== null"
                    class="inline-block px-2 py-0.5 rounded font-mono text-xs font-semibold"
                    :class="
                      row.perf_score >= 8
                        ? 'bg-green-900/40 text-green-300 border border-green-700'
                        : row.perf_score >= 3
                          ? 'bg-yellow-900/30 text-yellow-300 border border-yellow-700'
                          : 'bg-red-900/30 text-red-300 border border-red-700'
                    "
                  >
                    {{ row.perf_score.toFixed(1) }}
                  </span>
                  <span v-else class="text-surface-500 text-xs">—</span>
                </td>
                <!-- USDT columns -->
                <template v-if="botPerfProjectionMode === 'usdt'">
                  <td
                    class="py-2 pe-3 text-right font-mono text-xs"
                    :class="(row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'"
                  >
                    {{
                      row.daily_profit_usdt !== null
                        ? `${row.daily_profit_usdt >= 0 ? '+' : ''}${row.daily_profit_usdt.toFixed(2)}`
                        : '—'
                    }}
                  </td>
                  <td
                    class="py-2 pe-3 text-right font-mono text-xs font-semibold"
                    :class="
                      (row.monthly_projected_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                    "
                  >
                    {{
                      row.monthly_projected_usdt !== null
                        ? `${row.monthly_projected_usdt >= 0 ? '+' : ''}${row.monthly_projected_usdt.toFixed(2)}`
                        : '—'
                    }}
                  </td>
                  <td
                    class="py-2 pe-3 text-right font-mono text-xs"
                    :class="
                      (row.yearly_projected_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                    "
                  >
                    {{
                      row.yearly_projected_usdt !== null
                        ? `${row.yearly_projected_usdt >= 0 ? '+' : ''}${row.yearly_projected_usdt.toFixed(2)}`
                        : '—'
                    }}
                  </td>
                </template>
                <!-- % columns: daily_profit_usdt / capital × 100 -->
                <template v-else-if="botPerfProjectionMode === 'pct'">
                  <td
                    class="py-2 pe-3 text-right font-mono text-xs"
                    :class="(row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'"
                  >
                    {{
                      row.daily_profit_usdt !== null
                        ? (() => {
                            const c = Math.max(botPerfCapital, 1);
                            const v = (row.daily_profit_usdt / c) * 100;
                            return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
                          })()
                        : '—'
                    }}
                  </td>
                  <td
                    class="py-2 pe-3 text-right font-mono text-xs font-semibold"
                    :class="
                      (row.monthly_projected_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                    "
                  >
                    {{
                      row.monthly_projected_usdt !== null
                        ? (() => {
                            const c = Math.max(botPerfCapital, 1);
                            const v = (row.monthly_projected_usdt / c) * 100;
                            return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
                          })()
                        : '—'
                    }}
                  </td>
                  <td
                    class="py-2 pe-3 text-right font-mono text-xs"
                    :class="
                      (row.yearly_projected_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                    "
                  >
                    {{
                      row.yearly_projected_usdt !== null
                        ? (() => {
                            const c = Math.max(botPerfCapital, 1);
                            const v = (row.yearly_projected_usdt / c) * 100;
                            return `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;
                          })()
                        : '—'
                    }}
                  </td>
                </template>
                <!-- Compounded columns: (1 + daily_rate)^N - 1 -->
                <template v-else>
                  <td
                    class="py-2 pe-3 text-right font-mono text-xs"
                    :class="(row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'"
                  >
                    {{
                      row.daily_profit_usdt !== null
                        ? (() => {
                            const c = Math.max(botPerfCapital, 1);
                            const v = (row.daily_profit_usdt / c) * 100;
                            return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
                          })()
                        : '—'
                    }}
                  </td>
                  <td
                    class="py-2 pe-3 text-right font-mono text-xs font-semibold"
                    :class="(row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'"
                  >
                    {{
                      row.daily_profit_usdt !== null
                        ? (() => {
                            const c = Math.max(botPerfCapital, 1);
                            const d = row.daily_profit_usdt / c;
                            const v = (Math.pow(1 + d, 30) - 1) * 100;
                            return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
                          })()
                        : '—'
                    }}
                  </td>
                  <td
                    class="py-2 pe-3 text-right font-mono text-xs"
                    :class="(row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'"
                  >
                    {{
                      row.daily_profit_usdt !== null
                        ? (() => {
                            const c = Math.max(botPerfCapital, 1);
                            const d = row.daily_profit_usdt / c;
                            const v = (Math.pow(1 + d, 365) - 1) * 100;
                            return `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;
                          })()
                        : '—'
                    }}
                  </td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- History tab -->
      <div v-if="botPerfActiveTab === 'history'" class="space-y-3">
        <!-- Chart mode toggle + description -->
        <div class="flex items-center gap-3 flex-wrap">
          <div class="flex gap-0 rounded border border-surface-600 overflow-hidden text-xs">
            <button
              class="px-3 py-1 transition-colors"
              :class="
                botHistChartMode === 'equity'
                  ? 'bg-primary-600 text-white'
                  : 'text-surface-400 hover:text-surface-200'
              "
              @click="botHistChartMode = 'equity'"
            >
              Equity curve
            </button>
            <button
              class="px-3 py-1 transition-colors border-l border-surface-600"
              :class="
                botHistChartMode === 'score'
                  ? 'bg-primary-600 text-white'
                  : 'text-surface-400 hover:text-surface-200'
              "
              @click="botHistChartMode = 'score'"
            >
              Rolling 7d score
            </button>
          </div>
          <p class="text-xs text-surface-400 italic">
            <template v-if="botHistChartMode === 'equity'"
              >Cumulative closed-trade PnL per bot. Steeper slope = better recent
              performance.</template
            >
            <template v-else
              >Score = avg profit% × 2 − avg duration × 0.1 − (avg DCA − 1) × 1, computed over the
              trailing 7 days of closed trades.</template
            >
          </p>
        </div>

        <div v-if="botHistChartData && botHistChartData.series.length > 0">
          <svg
            :viewBox="`0 0 ${BH_W} ${BH_H}`"
            class="w-full"
            style="max-height: 320px"
            @mousemove="botHistOnMouseMove"
            @mouseleave="botHistOnMouseLeave"
          >
            <!-- Horizontal grid lines -->
            <line
              v-for="tick in botHistChartData.yTicks"
              :key="`hy-${tick.value}`"
              :x1="BH_ML"
              :y1="tick.y"
              :x2="BH_W - BH_MR"
              :y2="tick.y"
              stroke="#334155"
              stroke-width="1"
            />
            <!-- Y-axis tick labels -->
            <text
              v-for="tick in botHistChartData.yTicks"
              :key="`hyl-${tick.value}`"
              :x="BH_ML - 6"
              :y="tick.y + 4"
              text-anchor="end"
              fill="#94a3b8"
              font-size="10"
            >
              {{
                tick.value >= 0
                  ? `+${tick.value.toFixed(botHistChartMode === 'score' ? 1 : 0)}`
                  : tick.value.toFixed(botHistChartMode === 'score' ? 1 : 0)
              }}
            </text>
            <!-- Zero line -->
            <line
              v-if="botHistChartData.showZero"
              :x1="BH_ML"
              :y1="botHistChartData.zeroY"
              :x2="BH_W - BH_MR"
              :y2="botHistChartData.zeroY"
              stroke="#64748b"
              stroke-width="1.5"
              stroke-dasharray="4 3"
            />
            <!-- X-axis tick labels -->
            <text
              v-for="tick in botHistChartData.xTicks"
              :key="`hxl-${tick.date}`"
              :x="tick.x"
              :y="BH_H - BH_MB + 14"
              text-anchor="middle"
              fill="#94a3b8"
              font-size="10"
            >
              {{ tick.label }}
            </text>
            <!-- Lines per bot -->
            <polyline
              v-for="series in botHistChartData.series"
              :key="`bhline-${series.botId}`"
              :points="series.polylinePoints"
              :stroke="series.color"
              stroke-width="2"
              fill="none"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <!-- Hover crosshair -->
            <line
              v-if="botHistHoverX !== null"
              :x1="botHistHoverX"
              :y1="BH_MT"
              :x2="botHistHoverX"
              :y2="BH_H - BH_MB"
              stroke="#94a3b8"
              stroke-width="1"
              stroke-dasharray="3 3"
              pointer-events="none"
            />
            <!-- Hover dots -->
            <circle
              v-for="pt in botHistHoverPoints"
              :key="`bhpt-${pt.name}`"
              :cx="pt.x"
              :cy="pt.y"
              r="4"
              :fill="pt.color"
              stroke="#0f172a"
              stroke-width="1.5"
              pointer-events="none"
            />
            <!-- Axes -->
            <line
              :x1="BH_ML"
              :y1="BH_MT"
              :x2="BH_ML"
              :y2="BH_H - BH_MB"
              stroke="#475569"
              stroke-width="1"
            />
            <line
              :x1="BH_ML"
              :y1="BH_H - BH_MB"
              :x2="BH_W - BH_MR"
              :y2="BH_H - BH_MB"
              stroke="#475569"
              stroke-width="1"
            />
          </svg>

          <!-- Clickable legend with VPS name -->
          <div class="flex flex-wrap gap-x-3 gap-y-1.5 mt-2">
            <button
              v-for="bot in botHistAllBots"
              :key="`bhl-${bot.botId}`"
              class="flex items-center gap-1.5 text-xs rounded px-2 py-0.5 border border-surface-600 transition-opacity"
              :class="botHistEnabledBots.has(bot.botId) ? 'opacity-100' : 'opacity-35'"
              :style="{ borderLeftColor: bot.color, borderLeftWidth: '3px' }"
              @click="botHistToggleBot(bot.botId)"
            >
              <span class="font-mono font-medium text-surface-200">{{ bot.name }}</span>
              <span v-if="bot.vpsName" class="text-surface-500">{{ bot.vpsName }}</span>
            </button>
          </div>
          <p class="text-xs text-surface-600 mt-1">Click to show/hide bots</p>
        </div>
        <div v-else class="text-surface-400 text-sm text-center py-8">
          No history data available for the selected date range.
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else-if="botPerfLoaded" class="text-surface-400 text-sm text-center py-6">
      No closed trades found for the selected date range.
    </div>
  </div>
</template>
