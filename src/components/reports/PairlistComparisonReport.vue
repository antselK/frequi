<script setup lang="ts">
import { computed, ref } from 'vue';

import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { niceTickInterval } from '@/utils/reportCharts';
import { daysAgoStr, todayStr } from '@/utils/reportDates';
import type { DwhPairlistComparison } from '@/types/vps';

const { reportsError, botSelectOptions, showChartTooltip, hideChartTooltip } = useReportsContext();

const data = ref<DwhPairlistComparison | null>(null);
const loaded = ref(false);
const loading = ref(false);
const dateFrom = ref(daysAgoStr(30));
const dateTo = ref(todayStr());
const filterExchange = ref<string>('all');
const filterBotId = ref<number | null>(null);
const chartMode = ref<'pnl' | 'trades' | 'quality'>('pnl');
const hiddenConfigs = ref<Set<string>>(new Set());
const sortCol = ref<'covered_trades' | 'profit_abs' | 'median_quality' | 'profit_per_pair_day'>(
  'profit_abs',
);
const sortAsc = ref(false);

const exchangeOptions = [
  { label: 'All venues', value: 'all' },
  { label: 'Bybit', value: 'bybit' },
  { label: 'Hyperliquid', value: 'hyperliquid' },
  { label: 'Kraken Futures', value: 'krakenfutures' },
];
const chartModeOptions = [
  { label: 'Cumulative PnL', value: 'pnl' },
  { label: 'Cumulative trades', value: 'trades' },
  { label: 'Avg quality', value: 'quality' },
];

async function load() {
  try {
    loading.value = true;
    data.value = await vpsApi.dwhPairlistComparison(
      dateFrom.value,
      dateTo.value,
      filterExchange.value,
      filterBotId.value,
    );
    loaded.value = true;
  } catch (err) {
    reportsError.value = String(err);
  } finally {
    loading.value = false;
  }
}

function toggleConfig(configId: string) {
  const next = new Set(hiddenConfigs.value);
  if (next.has(configId)) next.delete(configId);
  else next.add(configId);
  hiddenConfigs.value = next;
}

function setSort(col: typeof sortCol.value) {
  if (sortCol.value === col) sortAsc.value = !sortAsc.value;
  else {
    sortCol.value = col;
    sortAsc.value = false;
  }
}

const summaryRows = computed(() => {
  if (!data.value) return [];
  const rows = [...data.value.summary];
  rows.sort((a, b) => {
    const av = (a[sortCol.value] ?? 0) as number;
    const bv = (b[sortCol.value] ?? 0) as number;
    return sortAsc.value ? av - bv : bv - av;
  });
  return rows;
});

/** Grid grouped by pairlist, so a config's bots sit together. */
const gridGroups = computed(() => {
  if (!data.value) return [];
  const byConfig = new Map<string, typeof data.value.grid>();
  for (const cell of data.value.grid) {
    if (!byConfig.has(cell.config_id)) byConfig.set(cell.config_id, []);
    byConfig.get(cell.config_id)!.push(cell);
  }
  return [...byConfig.entries()]
    .map(([configId, cells]) => ({
      configId,
      cells: [...cells].sort((a, b) => b.profit_abs - a.profit_abs),
    }))
    .sort((a, b) => a.configId.localeCompare(b.configId));
});

// --- chart ---------------------------------------------------------------
const W = 920;
const H = 300;
const ML = 56;
const MR = 150;
const MT = 14;
const MB = 30;
const COLORS = [
  '#60a5fa',
  '#f472b6',
  '#34d399',
  '#fbbf24',
  '#a78bfa',
  '#fb923c',
  '#22d3ee',
  '#f87171',
  '#a3e635',
  '#e879f9',
];

const hoverDate = ref<string | null>(null);

const chart = computed(() => {
  const d = data.value;
  if (!d || d.series.length === 0) return null;

  const visible = d.series.filter((p) => !hiddenConfigs.value.has(p.config_id));
  if (visible.length === 0) return null;

  const valueOf = (p: (typeof visible)[number]) =>
    chartMode.value === 'pnl'
      ? p.cumulative_profit_abs
      : chartMode.value === 'trades'
        ? p.cumulative_trades
        : (p.avg_quality ?? 0);

  const dates = [...new Set(visible.map((p) => p.date))].sort();
  if (dates.length === 0) return null;

  const plotW = W - ML - MR;
  const plotH = H - MT - MB;
  const firstMs = new Date(dates[0]).getTime();
  const lastMs = new Date(dates[dates.length - 1]).getTime();
  // A single day would make spanMs 0 and every x coordinate NaN.
  const spanMs = lastMs - firstMs || 1;
  const dateToX = (s: string) => ML + ((new Date(s).getTime() - firstMs) / spanMs) * plotW;

  const values = visible.map(valueOf);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const pad = (rawMax - rawMin || Math.abs(rawMax) || 1) * 0.12;
  const yMin = rawMin - pad;
  const yMax = rawMax + pad;
  const valToY = (v: number) => MT + plotH * (1 - (v - yMin) / (yMax - yMin));

  const step = niceTickInterval(yMin, yMax, 5);
  const yTicks: { y: number; value: number }[] = [];
  let tv = Math.ceil(yMin / step) * step;
  while (tv <= yMax + step * 0.01) {
    yTicks.push({ y: Math.round(valToY(tv) * 10) / 10, value: tv });
    tv = Math.round((tv + step) * 1e9) / 1e9;
  }

  const tickCount = Math.min(dates.length, 6);
  const xTicks = Array.from({ length: tickCount }, (_, i) => {
    const idx = Math.round((i / Math.max(tickCount - 1, 1)) * (dates.length - 1));
    return { x: Math.round(dateToX(dates[idx]) * 10) / 10, label: dates[idx].slice(5) };
  });

  const configIds = [...new Set(d.series.map((p) => p.config_id))].sort();
  const byConfig = new Map<string, typeof visible>();
  for (const p of visible) {
    if (!byConfig.has(p.config_id)) byConfig.set(p.config_id, []);
    byConfig.get(p.config_id)!.push(p);
  }

  const series = [...byConfig.entries()].map(([configId, pts]) => {
    const sorted = [...pts].sort((a, b) => a.date.localeCompare(b.date));
    const points = sorted.map((p) => ({
      x: Math.round(dateToX(p.date) * 10) / 10,
      y: Math.round(valToY(valueOf(p)) * 10) / 10,
      date: p.date,
      value: valueOf(p),
    }));
    return {
      configId,
      color: COLORS[configIds.indexOf(configId) % COLORS.length],
      points,
      polyline: points.map((p) => `${p.x},${p.y}`).join(' '),
    };
  });

  const zeroY = Math.round(valToY(0) * 10) / 10;
  return {
    series,
    yTicks,
    xTicks,
    zeroY,
    showZero: zeroY >= MT && zeroY <= MT + plotH,
    datePositions: dates.map((s) => ({ date: s, x: dateToX(s) })),
  };
});

const legendEntries = computed(() => {
  if (!data.value) return [];
  const ids = [...new Set(data.value.series.map((p) => p.config_id))].sort();
  return ids.map((configId, i) => ({
    configId,
    color: COLORS[i % COLORS.length],
    hidden: hiddenConfigs.value.has(configId),
  }));
});

const hoverX = computed(() => {
  if (!hoverDate.value || !chart.value) return null;
  return chart.value.datePositions.find((p) => p.date === hoverDate.value)?.x ?? null;
});

function onMouseMove(event: MouseEvent) {
  const cd = chart.value;
  if (!cd) return;
  const svg = event.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  const svgX = ((event.clientX - rect.left) * W) / rect.width;

  let nearest: string | null = null;
  let best = Infinity;
  for (const dp of cd.datePositions) {
    const dist = Math.abs(dp.x - svgX);
    if (dist < best) {
      best = dist;
      nearest = dp.date;
    }
  }
  if (!nearest) return;
  hoverDate.value = nearest;

  const unit = chartMode.value === 'pnl' ? ' USDT' : chartMode.value === 'trades' ? '' : '';
  const lines = [nearest];
  for (const s of cd.series) {
    const pt = s.points.find((p) => p.date === nearest);
    if (pt)
      lines.push(`${s.configId}: ${pt.value.toFixed(chartMode.value === 'trades' ? 0 : 2)}${unit}`);
  }
  showChartTooltip(event, lines);
}

function onMouseLeave() {
  hoverDate.value = null;
  hideChartTooltip();
}

function fmt(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">Pairlist Comparison</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="dateFrom" type="date" size="sm" class="w-36" />
        <span class="text-surface-400 text-xs">to</span>
        <UInput v-model="dateTo" type="date" size="sm" class="w-36" />
        <USelect v-model="filterExchange" :items="exchangeOptions" size="sm" class="w-40" />
        <USelect
          v-model="filterBotId"
          :items="botSelectOptions"
          placeholder="All bots"
          size="sm"
          class="w-56"
        />
        <UButton
          label="Load"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loading"
          @click="load"
        />
      </div>
    </div>

    <!-- Data-availability banner. This report is forward-only: a trade is scoreable
         only if a snapshot was in force when it OPENED, and recording began
         2026-09-21. Everything before that is permanently unscoreable. -->
    <UAlert
      v-if="loaded && data && data.scoreable_trades === 0"
      color="warning"
      title="No scoreable trades yet"
      :description="`Pair-set recording began ${data.snapshot_start?.slice(0, 16) ?? 'recently'} (${data.snapshot_count} snapshots). A trade can only be scored if a snapshot was in force when it opened, so the ${data.unscoreable_trades} trades that opened earlier can never be scored. This fills in on its own as new trades open and close.`"
    />
    <UAlert
      v-else-if="loaded && data && !data.persistence.testable"
      color="info"
      title="Ranking not yet testable"
      :description="`${data.persistence.reason}. Until the split-half test can run, treat the ordering below as provisional — a ranking that holds in one window and not the next is exactly how earlier pairlist studies produced confident wrong answers.`"
    />
    <UAlert
      v-else-if="loaded && data && data.persistence.testable && !data.persistence.stable"
      color="error"
      :title="`Ranking is NOT stable (Spearman ${fmt(data.persistence.spearman)})`"
      description="The two halves of this window disagree about which pairlists are best. Do not act on the ordering below."
    />
    <UAlert
      v-else-if="loaded && data && data.persistence.stable"
      color="success"
      :title="`Ranking replicates across halves (Spearman ${fmt(data.persistence.spearman)})`"
      :description="`First half: ${data.persistence.first_half_order.join(' > ')} — second half: ${data.persistence.second_half_order.join(' > ')}`"
    />

    <div v-if="loaded && data" class="flex flex-wrap gap-3 text-sm">
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold">{{ data.scoreable_trades }}</div>
        <div class="text-xs text-surface-400">Scoreable trades</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold text-surface-400">{{ data.unscoreable_trades }}</div>
        <div class="text-xs text-surface-400">Before recording</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold">{{ data.summary.length }}</div>
        <div class="text-xs text-surface-400">Pairlists</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold">{{ data.snapshot_count }}</div>
        <div class="text-xs text-surface-400">Snapshots</div>
      </div>
    </div>

    <!-- Chart -->
    <div v-if="chart" class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <USelect v-model="chartMode" :items="chartModeOptions" size="sm" class="w-48" />
        <span class="text-xs text-surface-400">Click a pairlist in the legend to hide it</span>
      </div>
      <div class="overflow-x-auto w-full">
        <svg
          :viewBox="`0 0 ${W} ${H}`"
          class="w-full min-w-[720px]"
          @mousemove="onMouseMove"
          @mouseleave="onMouseLeave"
        >
          <line
            v-for="t in chart.yTicks"
            :key="`g${t.value}`"
            :x1="ML"
            :x2="W - MR"
            :y1="t.y"
            :y2="t.y"
            stroke="currentColor"
            class="text-surface-700"
            stroke-width="0.5"
          />
          <text
            v-for="t in chart.yTicks"
            :key="`yl${t.value}`"
            :x="ML - 6"
            :y="t.y + 3"
            text-anchor="end"
            class="fill-surface-400 text-[9px]"
          >
            {{ t.value.toFixed(0) }}
          </text>
          <line
            v-if="chart.showZero"
            :x1="ML"
            :x2="W - MR"
            :y1="chart.zeroY"
            :y2="chart.zeroY"
            stroke="currentColor"
            class="text-surface-500"
            stroke-width="1"
          />
          <text
            v-for="t in chart.xTicks"
            :key="`xl${t.x}`"
            :x="t.x"
            :y="H - 10"
            text-anchor="middle"
            class="fill-surface-400 text-[9px]"
          >
            {{ t.label }}
          </text>
          <line
            v-if="hoverX !== null"
            :x1="hoverX"
            :x2="hoverX"
            :y1="MT"
            :y2="H - MB"
            stroke="currentColor"
            class="text-surface-500"
            stroke-width="0.5"
            stroke-dasharray="3 3"
          />
          <polyline
            v-for="s in chart.series"
            :key="s.configId"
            fill="none"
            :stroke="s.color"
            stroke-width="1.8"
            :points="s.polyline"
          />
        </svg>
      </div>
      <div class="flex flex-wrap gap-3 text-xs">
        <button
          v-for="entry in legendEntries"
          :key="entry.configId"
          class="flex items-center gap-1.5 cursor-pointer"
          :class="entry.hidden ? 'opacity-40' : ''"
          @click="toggleConfig(entry.configId)"
        >
          <span
            class="inline-block w-3 h-0.5 rounded"
            :style="{ backgroundColor: entry.color }"
          ></span>
          <span class="font-mono">{{ entry.configId }}</span>
        </button>
      </div>
    </div>

    <!-- Per-pairlist summary -->
    <div v-if="summaryRows.length > 0" class="overflow-x-auto w-full">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="border-b border-surface-600 text-left text-surface-300">
            <th class="py-2 pe-3 whitespace-nowrap">Pairlist</th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="sortCol === 'covered_trades' ? 'text-primary-400' : ''"
              @click="setSort('covered_trades')"
            >
              Trades {{ sortCol === 'covered_trades' ? (sortAsc ? '↑' : '↓') : '' }}
            </th>
            <th class="py-2 pe-3 whitespace-nowrap text-right">Coverage</th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="sortCol === 'profit_abs' ? 'text-primary-400' : ''"
              @click="setSort('profit_abs')"
            >
              PnL {{ sortCol === 'profit_abs' ? (sortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="sortCol === 'median_quality' ? 'text-primary-400' : ''"
              @click="setSort('median_quality')"
            >
              Med quality {{ sortCol === 'median_quality' ? (sortAsc ? '↑' : '↓') : '' }}
            </th>
            <th class="py-2 pe-3 whitespace-nowrap text-right" title="Trades worse than -300 USDT">
              Tail
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="sortCol === 'profit_per_pair_day' ? 'text-primary-400' : ''"
              title="PnL per pair-day the list was serving — corrects for list size"
              @click="setSort('profit_per_pair_day')"
            >
              PnL/pair-day {{ sortCol === 'profit_per_pair_day' ? (sortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 whitespace-nowrap text-right"
              title="Median quality of the trades this list did NOT cover. A list earns its keep only if covered beats excluded."
            >
              Excluded med q
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in summaryRows"
            :key="row.config_id"
            class="border-b border-surface-700/70 hover:bg-surface-700/30"
          >
            <td class="py-1.5 pe-3 font-mono text-xs">
              {{ row.config_id }}
              <UBadge
                v-if="row.as_run_bot_ids.length > 0"
                label="as run"
                color="success"
                variant="subtle"
                size="xs"
                class="ms-1"
              />
            </td>
            <td class="py-1.5 pe-3 text-right">{{ row.covered_trades }}</td>
            <td class="py-1.5 pe-3 text-right font-mono text-xs text-surface-400">
              {{ fmt(row.coverage_pct, 1) }}%
            </td>
            <td
              class="py-1.5 pe-3 text-right font-mono"
              :class="row.profit_abs >= 0 ? 'text-green-400' : 'text-red-400'"
            >
              {{ fmt(row.profit_abs) }}
            </td>
            <td
              class="py-1.5 pe-3 text-right font-mono"
              :class="(row.median_quality ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'"
            >
              {{ fmt(row.median_quality) }}
            </td>
            <td
              class="py-1.5 pe-3 text-right font-mono"
              :class="row.tail_events > 0 ? 'text-red-400' : 'text-surface-400'"
            >
              {{ row.tail_events }}
            </td>
            <td class="py-1.5 pe-3 text-right font-mono text-xs">
              {{ fmt(row.profit_per_pair_day, 3) }}
            </td>
            <td class="py-1.5 pe-3 text-right font-mono text-xs text-surface-400">
              {{ fmt(row.excluded_median_quality) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pairlist x bot grid -->
    <div v-if="gridGroups.length > 0" class="space-y-3">
      <h6 class="font-semibold text-sm">Per bot</h6>
      <p class="text-xs text-surface-400">
        A green <span class="text-green-400">as run</span> row is a real measurement — that bot is
        wired to that pairlist. Every other row is counterfactual: the bot's trades filtered to the
        pairs the list was serving at the time. Useful, but not evidence of live behaviour, because
        a bot actually on that list would have hit different <code>max_open_trades</code>
        concurrency and taken a different set.
      </p>
      <div
        v-for="group in gridGroups"
        :key="group.configId"
        class="border border-surface-700 rounded-sm p-3"
      >
        <div class="font-mono text-xs mb-2">{{ group.configId }}</div>
        <div class="overflow-x-auto w-full">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="border-b border-surface-600 text-left text-surface-300">
                <th class="py-2 pe-3 whitespace-nowrap">Bot</th>
                <th class="py-2 pe-3 whitespace-nowrap">Strategy</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Trades</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">PnL</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Avg %</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Med quality</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Tail</th>
                <th class="py-2 pe-3 whitespace-nowrap text-right">Worst</th>
                <th
                  class="py-2 pe-3 whitespace-nowrap text-right"
                  title="Trades reaching 8+ entries"
                >
                  Deep DCA
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="cell in group.cells"
                :key="`${cell.config_id}-${cell.bot_id}`"
                class="border-b border-surface-700/70 hover:bg-surface-700/30"
                :class="cell.as_run ? '' : 'opacity-60'"
              >
                <td class="py-1.5 pe-3 whitespace-nowrap">
                  {{ cell.container_name ?? `Bot ${cell.bot_id}` }}
                  <span class="text-xs text-surface-400">{{ cell.vps_name }}</span>
                  <UBadge
                    v-if="cell.as_run"
                    label="as run"
                    color="success"
                    variant="subtle"
                    size="xs"
                    class="ms-1"
                  />
                </td>
                <td class="py-1.5 pe-3 font-mono text-xs text-surface-300">
                  {{ cell.strategy ?? '—' }}
                </td>
                <td class="py-1.5 pe-3 text-right">{{ cell.trades }}</td>
                <td
                  class="py-1.5 pe-3 text-right font-mono"
                  :class="cell.profit_abs >= 0 ? 'text-green-400' : 'text-red-400'"
                >
                  {{ fmt(cell.profit_abs) }}
                </td>
                <td
                  class="py-1.5 pe-3 text-right font-mono"
                  :class="(cell.avg_profit_pct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'"
                >
                  {{ fmt(cell.avg_profit_pct) }}%
                </td>
                <td class="py-1.5 pe-3 text-right font-mono">{{ fmt(cell.median_quality) }}</td>
                <td
                  class="py-1.5 pe-3 text-right font-mono"
                  :class="cell.tail_events > 0 ? 'text-red-400' : 'text-surface-400'"
                >
                  {{ cell.tail_events }}
                </td>
                <td class="py-1.5 pe-3 text-right font-mono text-xs">
                  {{ fmt(cell.worst_trade_abs) }}
                </td>
                <td class="py-1.5 pe-3 text-right font-mono text-xs">{{ cell.deep_dca_trades }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div v-else-if="loaded && data && data.scoreable_trades > 0" class="text-surface-400 text-sm">
      No pairlist coverage for the selected filters.
    </div>
    <div v-else-if="!loaded" class="text-surface-400 text-sm">
      Press Load to compare pairlists over the selected range.
    </div>
  </div>
</template>
