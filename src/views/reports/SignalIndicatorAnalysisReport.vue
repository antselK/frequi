<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { profitColor } from '@/utils/reportColors';
import { vpsApi } from '@/composables/vpsApi';
import { daysAgoStr, todayStr } from '@/utils/reportDates';
import { formatDate } from '@/utils/reportParsers';
import { logsChartLayout } from '@/utils/reportCharts';
import type { DwhSignalIndicatorAnalysis, DwhSignalIndicatorTradeRow } from '@/types/vps';

const { reportsError, botSelectOptions, isBotActive, showChartTooltip, hideChartTooltip } =
  useReportsContext();

// Signal Indicator Analysis state
const signalIndData = ref<DwhSignalIndicatorAnalysis | null>(null);
const signalIndLoaded = ref(false);
const loadingSignalInd = ref(false);
const signalIndDateFrom = ref(daysAgoStr(30));
const signalIndDateTo = ref(todayStr());
const signalIndFilterBotId = ref<number | null>(null);
const signalIndFilterPair = ref('');
const signalIndFilterTag = ref('');
const signalIndSortCol = ref<string>('close_date');
const signalIndSortAsc = ref(false);
const signalIndChartIndicator = ref('rsi');
const signalIndChartYAxis = ref<'profit_pct' | 'quality_score'>('profit_pct');
const signalIndActiveTab = ref<'trades' | 'analytics'>('trades');
const signalIndAnalyticsSide = ref<'all' | 'long' | 'short'>('all');
const signalIndMatchFilter = ref<'all' | 'matched' | 'unmatched'>('all');
const signalIndSideFilter = ref<'both' | 'long' | 'short'>('both');
const signalIndTagOptions = [
  { label: 'All tags', value: '' },
  { label: 'long_bb_reversal', value: 'long_bb_reversal' },
  { label: 'long_bb_reversal_trail', value: 'long_bb_reversal_trail' },
  { label: 'long_bb_capped', value: 'long_bb_capped' },
  { label: 'long_bb_capped_trail', value: 'long_bb_capped_trail' },
  { label: 'short_bb_breakout', value: 'short_bb_breakout' },
  { label: 'short_bb_breakout_trail', value: 'short_bb_breakout_trail' },
  { label: 'short_chop_vol', value: 'short_chop_vol' },
  { label: 'short_chop_vol_trail', value: 'short_chop_vol_trail' },
];

// ── Signal Indicator Analysis computed ─────────────────────────────────────

const signalIndIndicatorOptions = [
  { label: 'RSI', value: 'rsi' },
  { label: 'HV', value: 'hv' },
  { label: 'ROCR 1h', value: 'rocr_1h' },
  { label: 'ROCR', value: 'rocr' },
  { label: 'HH 48 diff', value: 'hh_48_diff' },
  { label: 'LL 48 diff', value: 'll_48_diff' },
  { label: 'Chop', value: 'chop' },
  { label: 'BB Delta', value: 'bbdelta' },
  { label: 'Close Delta', value: 'closedelta' },
  { label: 'Tail', value: 'tail' },
  { label: 'Volume', value: 'volume' },
  { label: 'Fisher', value: 'fisher' },
  { label: 'Regime', value: 'regime_score' },
  { label: 'BTC Trend', value: 'btc_trend' },
  { label: 'ETH Trend', value: 'eth_trend' },
  { label: 'Rel Str', value: 'rel_str' },
];

const _sigIndDateCols = new Set<string>(['open_date', 'close_date']);

const signalIndItems = computed<DwhSignalIndicatorTradeRow[]>(() => {
  let rows = (signalIndData.value?.items ?? []).filter((r) => isBotActive(r.bot_id));
  const mf = signalIndMatchFilter.value;
  if (mf === 'matched') rows = rows.filter((r) => r.rsi !== null);
  else if (mf === 'unmatched') rows = rows.filter((r) => r.rsi === null);
  const sf = signalIndSideFilter.value;
  if (sf === 'long') rows = rows.filter((r) => r.is_short === false);
  else if (sf === 'short') rows = rows.filter((r) => r.is_short === true);
  const col = signalIndSortCol.value as keyof DwhSignalIndicatorTradeRow;
  const asc = signalIndSortAsc.value;
  return [...rows].sort((a, b) => {
    if (_sigIndDateCols.has(col)) {
      // ISO date strings sort lexicographically; null (open trades) is treated as the max,
      // so it sorts last when asc and first when desc.
      const av = a[col] as string | null;
      const bv = b[col] as string | null;
      const cmp = av === bv ? 0 : av === null ? 1 : bv === null ? -1 : av.localeCompare(bv);
      return asc ? cmp : -cmp;
    }
    const av = (a[col] as number | null) ?? (asc ? Infinity : -Infinity);
    const bv = (b[col] as number | null) ?? (asc ? Infinity : -Infinity);
    return asc ? (av < bv ? -1 : av > bv ? 1 : 0) : av > bv ? -1 : av < bv ? 1 : 0;
  });
});

const signalIndMatchedItems = computed(() =>
  signalIndItems.value.filter((r) => r.rsi !== null && !r.is_open),
);

const signalIndAvgQuality = computed(() => {
  const rows = signalIndMatchedItems.value.filter((r) => r.quality_score !== null);
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + (r.quality_score ?? 0), 0) / rows.length;
});

const signalIndAvgProfit = computed(() => {
  const rows = signalIndMatchedItems.value.filter((r) => r.profit_pct !== null);
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + (r.profit_pct ?? 0), 0) / rows.length;
});

const signalIndAvgDuration = computed(() => {
  const rows = signalIndMatchedItems.value.filter((r) => r.duration_hours !== null);
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + (r.duration_hours ?? 0), 0) / rows.length;
});

// Chart: scatter X=indicator, Y=profit or quality
const signalIndChartYRange = computed(() => {
  const rows = signalIndMatchedItems.value;
  const yKey = signalIndChartYAxis.value;
  const vals = rows.map((r) => r[yKey] as number | null).filter((v): v is number => v !== null);
  if (!vals.length) return { min: 0, max: 1 };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = (max - min) * 0.1 || 1;
  return { min: min - pad, max: max + pad };
});

const signalIndChartXRange = computed(() => {
  const rows = signalIndMatchedItems.value;
  const xKey = signalIndChartIndicator.value as keyof DwhSignalIndicatorTradeRow;
  const vals = rows.map((r) => r[xKey] as number | null).filter((v): v is number => v !== null);
  if (!vals.length) return { min: 0, max: 1 };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = (max - min) * 0.1 || 1;
  return { min: min - pad, max: max + pad };
});

const signalIndChartCoordinates = computed(() => {
  const rows = signalIndMatchedItems.value;
  const xKey = signalIndChartIndicator.value as keyof DwhSignalIndicatorTradeRow;
  const yKey = signalIndChartYAxis.value;
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const { min: xMin, max: xMax } = signalIndChartXRange.value;
  const { min: yMin, max: yMax } = signalIndChartYRange.value;
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  return rows
    .filter((r) => r[xKey] != null && r[yKey] != null)
    .map((r) => {
      const xVal = r[xKey] as number;
      const yVal = r[yKey] as number;
      const x = leftPad + ((xVal - xMin) / xRange) * plotWidth;
      const y = topPad + ((yMax - yVal) / yRange) * plotHeight;
      return {
        x,
        y,
        xVal,
        yVal,
        pair: r.pair ?? '?',
        tag: r.enter_tag ?? '?',
        profit: r.profit_pct,
        duration: r.duration_hours,
        dca: r.dca_order_count,
        quality: r.quality_score,
        positive: (r.profit_pct ?? 0) > 0,
      };
    });
});

const signalIndChartXTicks = computed(() => {
  const { min, max } = signalIndChartXRange.value;
  const { leftPad, width, rightPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const range = max - min || 1;
  const ticks = 5;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const val = min + (i / ticks) * range;
    const x = leftPad + ((val - min) / range) * plotWidth;
    return { x, label: val.toFixed(val >= 10 ? 1 : val >= 1 ? 2 : 4) };
  });
});

const signalIndChartYTicks = computed(() => {
  const { min, max } = signalIndChartYRange.value;
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  const range = max - min || 1;
  const ticks = 5;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const ratio = i / ticks;
    const val = max - ratio * range;
    const y = topPad + ratio * plotHeight;
    return { y, label: val.toFixed(1) };
  });
});

const signalIndChartZeroY = computed(() => {
  const { min, max } = signalIndChartYRange.value;
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  const range = max - min || 1;
  return topPad + ((max - 0) / range) * plotHeight;
});

function toggleSignalIndSort(col: string) {
  if (signalIndSortCol.value === col) {
    signalIndSortAsc.value = !signalIndSortAsc.value;
  } else {
    signalIndSortCol.value = col;
    signalIndSortAsc.value =
      col === 'duration_hours' || col === 'dca_order_count' || col === 'rsi' || col === 'open_date';
  }
}

function signalIndSortArrow(col: string): string {
  if (signalIndSortCol.value !== col) return '';
  return signalIndSortAsc.value ? ' \u2191' : ' \u2193';
}

// Analytics tab: combined indicator histograms (all bots pooled)
interface _SigIndHistBin {
  lo: number;
  hi: number;
  good: number;
  bad: number;
}
interface _SigIndHistBar {
  goodX: number;
  goodY: number;
  goodH: number;
  badX: number;
  badY: number;
  badH: number;
}
interface _SigIndHistogram {
  key: string;
  label: string;
  decimals: number;
  bins: _SigIndHistBin[];
  min: number;
  max: number;
  maxCount: number;
  svgBars: _SigIndHistBar[];
  svgXLabels: Array<{ x: number; val: string; stagger: boolean }>;
}
interface _SigIndBbCat {
  cat: string;
  good: number;
  bad: number;
  total: number;
}
interface SigIndCombinedAnalytics {
  tradeCount: number;
  goodCount: number;
  histograms: _SigIndHistogram[];
  bbCats: _SigIndBbCat[];
  bbMaxTotal: number;
}

const _sigIndAnalyticsKeys: Array<{
  key: keyof DwhSignalIndicatorTradeRow;
  label: string;
  decimals: number;
}> = [
  { key: 'rsi', label: 'RSI', decimals: 1 },
  { key: 'hv', label: 'HV', decimals: 2 },
  { key: 'rocr_1h', label: 'ROCR 1h', decimals: 4 },
  { key: 'rocr', label: 'ROCR', decimals: 4 },
  { key: 'hh_48_diff', label: 'HH48 diff', decimals: 2 },
  { key: 'll_48_diff', label: 'LL48 diff', decimals: 2 },
  { key: 'chop', label: 'Chop', decimals: 1 },
  { key: 'bbdelta', label: 'BB Delta', decimals: 4 },
  { key: 'closedelta', label: 'Close Delta', decimals: 4 },
  { key: 'tail', label: 'Tail', decimals: 4 },
  { key: 'volume', label: 'Volume', decimals: 0 },
  { key: 'fisher', label: 'Fisher', decimals: 4 },
  { key: 'regime_score', label: 'Regime', decimals: 1 },
  { key: 'btc_trend', label: 'BTC Trend', decimals: 1 },
  { key: 'eth_trend', label: 'ETH Trend', decimals: 1 },
  { key: 'rel_str', label: 'Rel Str', decimals: 1 },
];

const _SIG_BINS = 8;
const _SIG_SVG = { x0: 6, yBot: 122, plotH: 102, plotW: 268, slotW: 268 / 8, barW: 13 };

function _buildSigIndHistograms(
  goodRows: DwhSignalIndicatorTradeRow[],
  badRows: DwhSignalIndicatorTradeRow[],
): _SigIndHistogram[] {
  return _sigIndAnalyticsKeys.flatMap(({ key, label, decimals }) => {
    const gv = goodRows.map((r) => r[key] as number | null).filter((v): v is number => v !== null);
    const bv = badRows.map((r) => r[key] as number | null).filter((v): v is number => v !== null);
    const all = [...gv, ...bv];
    if (!all.length) return [];
    const mn = Math.min(...all),
      mx = Math.max(...all);
    const bs = (mx - mn) / _SIG_BINS || 1;
    const bins: _SigIndHistBin[] = Array.from({ length: _SIG_BINS }, (_, i) => {
      const lo = mn + i * bs;
      const hi = i === _SIG_BINS - 1 ? mx + 0.001 : lo + bs;
      return {
        lo,
        hi,
        good: gv.filter((v) => v >= lo && v < hi).length,
        bad: bv.filter((v) => v >= lo && v < hi).length,
      };
    });
    const maxCount = Math.max(...bins.map((b) => b.good + b.bad), 1);
    const svgBars: _SigIndHistBar[] = bins.map((b, i) => {
      const gH = (b.good / maxCount) * _SIG_SVG.plotH;
      const bH = (b.bad / maxCount) * _SIG_SVG.plotH;
      const sx = _SIG_SVG.x0 + i * _SIG_SVG.slotW;
      return {
        goodX: sx + 1,
        goodY: _SIG_SVG.yBot - gH,
        goodH: gH,
        badX: sx + 1 + _SIG_SVG.barW + 1,
        badY: _SIG_SVG.yBot - bH,
        badH: bH,
      };
    });
    const fmtDec = Math.min(decimals, 3);
    // All 9 bin boundaries so the user can read exact ranges; stagger odd/even to avoid overlap
    const svgXLabels = Array.from({ length: _SIG_BINS + 1 }, (_, i) => ({
      x: _SIG_SVG.x0 + i * _SIG_SVG.slotW,
      val: (mn + (i / _SIG_BINS) * (mx - mn)).toFixed(fmtDec),
      stagger: i % 2 !== 0,
    }));
    return [
      {
        key: key as string,
        label,
        decimals,
        bins,
        min: mn,
        max: mx,
        maxCount,
        svgBars,
        svgXLabels,
      },
    ];
  });
}

const signalIndAnalyticsData = computed<SigIndCombinedAnalytics | null>(() => {
  const allRows = signalIndMatchedItems.value;
  const avgScore = signalIndAvgQuality.value;
  if (!allRows.length || avgScore === null) return null;

  const side = signalIndAnalyticsSide.value;
  const rows =
    side === 'all'
      ? allRows
      : side === 'long'
        ? allRows.filter((r) => !r.is_short)
        : allRows.filter((r) => r.is_short);

  if (!rows.length) return null;

  // quality_score is "higher = better" — profit% × 2 − duration_h × 0.1 − (dca − 1), mirroring
  // the Bot Performance score (backend reports.py). An at-or-above-average score is a good
  // entry. Null scores (open trades) fall to the bad side.
  const isGood = (r: (typeof rows)[0]) => (r.quality_score ?? -Infinity) >= avgScore!;
  const goodRows = rows.filter(isGood);
  const badRows = rows.filter((r) => !isGood(r));

  const histograms = _buildSigIndHistograms(goodRows, badRows);

  const bbMap = new Map<string, { good: number; bad: number }>();
  for (const r of rows) {
    if (!r.bb_pos) continue;
    const e = bbMap.get(r.bb_pos) ?? { good: 0, bad: 0 };
    if (isGood(r)) e.good++;
    else e.bad++;
    bbMap.set(r.bb_pos, e);
  }
  const bbCats: _SigIndBbCat[] = Array.from(bbMap.entries())
    .map(([cat, c]) => ({ cat, ...c, total: c.good + c.bad }))
    .sort((a, b) => b.total - a.total);
  const bbMaxTotal = Math.max(...bbCats.map((c) => c.total), 1);

  return { tradeCount: rows.length, goodCount: goodRows.length, histograms, bbCats, bbMaxTotal };
});

// Unmatched trade stats (closed trades with no indicator snapshot)
const signalIndUnmatchedItems = computed(() =>
  (signalIndData.value?.items ?? []).filter(
    (r) => r.rsi === null && !r.is_open && isBotActive(r.bot_id),
  ),
);

const signalIndUnmatchedAvgProfit = computed(() => {
  const rows = signalIndUnmatchedItems.value.filter((r) => r.profit_pct !== null);
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + (r.profit_pct ?? 0), 0) / rows.length;
});

const signalIndUnmatchedWinRate = computed(() => {
  const rows = signalIndUnmatchedItems.value.filter((r) => r.profit_pct !== null);
  if (!rows.length) return null;
  return (rows.filter((r) => (r.profit_pct ?? 0) > 0).length / rows.length) * 100;
});

const signalIndUnmatchedAvgDuration = computed(() => {
  const rows = signalIndUnmatchedItems.value.filter((r) => r.duration_hours !== null);
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + (r.duration_hours ?? 0), 0) / rows.length;
});

const signalIndUnmatchedBreakdown = computed(() => {
  const rows = signalIndData.value?.items ?? [];
  if (!rows.length) return null;
  const botMap = new Map<string, { total: number; matched: number }>();
  const tagMap = new Map<string, { total: number; matched: number }>();
  for (const r of rows) {
    if (r.is_open || !isBotActive(r.bot_id)) continue;
    const botKey = `${r.vps_name ?? '?'} / ${r.container_name ?? '?'} (${r.bot_id})`;
    const tagKey = r.enter_tag ?? '(none)';
    const isMatched = r.rsi !== null;
    const be = botMap.get(botKey) ?? { total: 0, matched: 0 };
    be.total++;
    if (isMatched) be.matched++;
    botMap.set(botKey, be);
    const te = tagMap.get(tagKey) ?? { total: 0, matched: 0 };
    te.total++;
    if (isMatched) te.matched++;
    tagMap.set(tagKey, te);
  }
  const byBot = Array.from(botMap.entries())
    .map(([label, c]) => ({
      label,
      total: c.total,
      matched: c.matched,
      unmatched: c.total - c.matched,
      rate: Math.round((c.matched / c.total) * 100),
    }))
    .sort((a, b) => b.unmatched - a.unmatched);
  const byTag = Array.from(tagMap.entries())
    .map(([tag, c]) => ({
      tag,
      total: c.total,
      matched: c.matched,
      unmatched: c.total - c.matched,
      rate: Math.round((c.matched / c.total) * 100),
    }))
    .sort((a, b) => b.unmatched - a.unmatched);
  return { byBot, byTag };
});

// ── End Signal Indicator Analysis computed ──────────────────────────────────

async function loadSignalIndicatorAnalysis() {
  loadingSignalInd.value = true;
  reportsError.value = '';
  try {
    signalIndData.value = await vpsApi.dwhSignalIndicatorAnalysis(
      signalIndDateFrom.value || undefined,
      signalIndDateTo.value || undefined,
      signalIndFilterBotId.value ?? undefined,
      signalIndFilterPair.value || undefined,
      signalIndFilterTag.value || undefined,
    );
    signalIndLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    signalIndData.value = null;
  } finally {
    loadingSignalInd.value = false;
  }
}

onMounted(() => {
  if (!signalIndLoaded.value) {
    void loadSignalIndicatorAnalysis();
  }
});
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <!-- Header + filters -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">Signal Indicator Analysis</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="signalIndDateFrom" type="date" size="sm" class="w-36" />
        <UInput v-model="signalIndDateTo" type="date" size="sm" class="w-36" />
        <USelect
          v-model="signalIndFilterBotId"
          :items="botSelectOptions"
          placeholder="All bots"
          size="sm"
          class="w-56"
        />
        <UInput v-model="signalIndFilterPair" size="sm" class="w-36" placeholder="Pair" />
        <USelect
          v-model="signalIndFilterTag"
          :items="signalIndTagOptions"
          size="sm"
          class="w-52"
          placeholder="All tags"
        />
        <!-- Match filter toggle -->
        <div class="flex gap-0 rounded border border-surface-600 overflow-hidden text-xs">
          <button
            v-for="mf in [
              { key: 'all', label: 'All' },
              { key: 'matched', label: 'Matched' },
              { key: 'unmatched', label: 'Unmatched' },
            ]"
            :key="mf.key"
            class="px-2 py-1 transition-colors"
            :class="
              signalIndMatchFilter === mf.key
                ? 'bg-primary-600 text-white'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
            "
            @click="signalIndMatchFilter = mf.key as 'all' | 'matched' | 'unmatched'"
          >
            {{ mf.label }}
          </button>
        </div>
        <!-- Side filter toggle -->
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
              signalIndSideFilter === sf.key
                ? 'bg-primary-600 text-white'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
            "
            @click="signalIndSideFilter = sf.key as 'both' | 'long' | 'short'"
          >
            {{ sf.label }}
          </button>
        </div>
        <UButton
          label="Load"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loadingSignalInd"
          @click="loadSignalIndicatorAnalysis"
        />
      </div>
    </div>

    <!-- Coverage note -->
    <div v-if="signalIndLoaded && signalIndData" class="text-xs text-surface-400">
      {{ signalIndData.matched_trades }} of {{ signalIndData.total_trades }} trades have indicator
      snapshots (closed trades only)
      <span v-if="signalIndData.total_trades > 0">
        ({{ signalIndData.match_rate_pct.toFixed(0) }}% match rate)
      </span>
    </div>

    <!-- Summary cards -->
    <div v-if="signalIndLoaded && signalIndData" class="space-y-2">
      <!-- Matched row -->
      <div class="flex flex-wrap gap-3 text-sm items-center">
        <span class="text-xs text-surface-500 w-20 shrink-0">Matched:</span>
        <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
          <div class="text-lg font-bold">{{ signalIndData.matched_trades }}</div>
          <div class="text-xs text-surface-400">Matched trades</div>
        </div>
        <div
          v-if="signalIndAvgProfit !== null"
          class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center"
        >
          <div class="text-lg font-bold font-mono" :class="profitColor(signalIndAvgProfit)">
            {{ signalIndAvgProfit >= 0 ? '+' : '' }}{{ signalIndAvgProfit.toFixed(2) }}%
          </div>
          <div class="text-xs text-surface-400">Avg profit</div>
        </div>
        <div
          v-if="signalIndAvgDuration !== null"
          class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center"
        >
          <div class="text-lg font-bold font-mono">{{ signalIndAvgDuration.toFixed(1) }}h</div>
          <div class="text-xs text-surface-400">Avg duration</div>
        </div>
        <div
          v-if="signalIndAvgQuality !== null"
          class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center"
        >
          <div class="text-lg font-bold font-mono">
            {{ signalIndAvgQuality.toFixed(1) }}
          </div>
          <div class="text-xs text-surface-400">Avg quality score</div>
        </div>
      </div>
      <!-- Unmatched row -->
      <div
        v-if="signalIndUnmatchedItems.length > 0"
        class="flex flex-wrap gap-3 text-sm items-center"
      >
        <span class="text-xs text-surface-500 w-20 shrink-0">Unmatched:</span>
        <div class="rounded border border-surface-600/50 px-3 py-2 min-w-28 text-center">
          <div class="text-lg font-bold text-surface-300">
            {{ signalIndUnmatchedItems.length }}
          </div>
          <div class="text-xs text-surface-500">No snapshot</div>
        </div>
        <div
          v-if="signalIndUnmatchedAvgProfit !== null"
          class="rounded border border-surface-600/50 px-3 py-2 min-w-28 text-center"
        >
          <div
            class="text-lg font-bold font-mono"
            :class="profitColor(signalIndUnmatchedAvgProfit)"
          >
            {{ signalIndUnmatchedAvgProfit >= 0 ? '+' : ''
            }}{{ signalIndUnmatchedAvgProfit.toFixed(2) }}%
          </div>
          <div class="text-xs text-surface-500">Avg profit</div>
        </div>
        <div
          v-if="signalIndUnmatchedWinRate !== null"
          class="rounded border border-surface-600/50 px-3 py-2 min-w-28 text-center"
        >
          <div class="text-lg font-bold font-mono text-surface-300">
            {{ signalIndUnmatchedWinRate.toFixed(0) }}%
          </div>
          <div class="text-xs text-surface-500">Win rate</div>
        </div>
        <div
          v-if="signalIndUnmatchedAvgDuration !== null"
          class="rounded border border-surface-600/50 px-3 py-2 min-w-28 text-center"
        >
          <div class="text-lg font-bold font-mono text-surface-300">
            {{ signalIndUnmatchedAvgDuration.toFixed(1) }}h
          </div>
          <div class="text-xs text-surface-500">Avg duration</div>
        </div>
      </div>
    </div>

    <!-- Tabs: Trades | Analytics -->
    <div class="flex gap-0 border-b border-surface-600">
      <button
        v-for="tab in [
          { key: 'trades', label: 'Trades' },
          { key: 'analytics', label: 'Analytics' },
        ]"
        :key="tab.key"
        class="px-4 py-2 text-sm border-b-2 transition-colors"
        :class="
          signalIndActiveTab === tab.key
            ? 'border-primary-400 text-primary-400'
            : 'border-transparent text-surface-400 hover:text-surface-200'
        "
        @click="signalIndActiveTab = tab.key as 'trades' | 'analytics'"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- Trades tab -->
    <div v-if="signalIndActiveTab === 'trades'" class="space-y-4">
      <!-- Scatter chart -->
      <div v-if="signalIndChartCoordinates.length > 0" class="space-y-2">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2">
            <span class="text-xs text-surface-400">X axis:</span>
            <select
              v-model="signalIndChartIndicator"
              class="text-xs bg-surface-800 border border-surface-600 rounded px-2 py-1 text-surface-200"
            >
              <option v-for="opt in signalIndIndicatorOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs text-surface-400">Y axis:</span>
            <select
              v-model="signalIndChartYAxis"
              class="text-xs bg-surface-800 border border-surface-600 rounded px-2 py-1 text-surface-200"
            >
              <option value="profit_pct">Profit %</option>
              <option value="quality_score">Quality score</option>
            </select>
          </div>
          <div class="flex items-center gap-3 text-xs text-surface-400">
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-green-400"></span> Profit &gt; 0
            </span>
            <span class="flex items-center gap-1">
              <span class="inline-block w-2 h-2 rounded-full bg-red-400"></span> Loss
            </span>
          </div>
        </div>
        <svg viewBox="0 0 920 260" class="w-full h-64">
          <!-- Y-axis grid + labels -->
          <line
            v-for="(tick, idx) in signalIndChartYTicks"
            :key="`sigy-${idx}`"
            x1="46"
            :y1="tick.y"
            x2="900"
            :y2="tick.y"
            stroke="#334155"
            stroke-width="1"
            stroke-dasharray="4 4"
          />
          <text
            v-for="(tick, idx) in signalIndChartYTicks"
            :key="`sigty-${idx}`"
            :x="42"
            :y="tick.y + 4"
            text-anchor="end"
            fill="#94a3b8"
            font-size="10"
          >
            {{ tick.label }}
          </text>
          <!-- Zero line for profit mode -->
          <line
            v-if="signalIndChartYAxis === 'profit_pct'"
            x1="46"
            :y1="signalIndChartZeroY"
            x2="900"
            :y2="signalIndChartZeroY"
            stroke="#64748b"
            stroke-width="1"
          />
          <!-- Axes -->
          <line x1="46" y1="230" x2="900" y2="230" stroke="#475569" stroke-width="1" />
          <line x1="46" y1="14" x2="46" y2="230" stroke="#475569" stroke-width="1" />
          <!-- X ticks -->
          <text
            v-for="(tick, idx) in signalIndChartXTicks"
            :key="`sigtx-${idx}`"
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
            v-for="(point, idx) in signalIndChartCoordinates"
            :key="`sigc-${idx}`"
            :cx="point.x"
            :cy="point.y"
            r="4"
            :fill="point.positive ? '#34d399' : '#f87171'"
            class="cursor-pointer"
            @mousemove="
              showChartTooltip($event, [
                `${point.pair} (${point.tag})`,
                `Profit: ${point.profit !== null ? point.profit.toFixed(2) + '%' : 'n/a'}`,
                `Duration: ${point.duration !== null ? point.duration.toFixed(1) + 'h' : 'n/a'}`,
                `DCA: ${point.dca} | Score: ${point.quality !== null ? point.quality.toFixed(1) : 'n/a'}`,
              ])
            "
            @mouseleave="hideChartTooltip"
          >
            <title>{{ point.pair }} {{ point.tag }}</title>
          </circle>
        </svg>
      </div>

      <!-- Empty state -->
      <div
        v-if="signalIndLoaded && signalIndItems.length === 0"
        class="text-sm text-surface-400 py-4 text-center"
      >
        No trades found for the selected filters.
      </div>

      <!-- Sortable table -->
      <div v-if="signalIndItems.length > 0" class="overflow-x-auto w-full">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="border-b border-surface-600 text-left">
              <th class="py-2 pe-3">Bot</th>
              <th class="py-2 pe-3">Pair</th>
              <th class="py-2 pe-3">Tag</th>
              <th class="py-2 pe-3">Side</th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'open_date' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('open_date')"
              >
                Open{{ signalIndSortArrow('open_date') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'close_date' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('close_date')"
              >
                Close{{ signalIndSortArrow('close_date') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'profit_pct' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('profit_pct')"
              >
                Profit %{{ signalIndSortArrow('profit_pct') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'duration_hours' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('duration_hours')"
              >
                Duration{{ signalIndSortArrow('duration_hours') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'dca_order_count' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('dca_order_count')"
              >
                DCA{{ signalIndSortArrow('dca_order_count') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'quality_score' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('quality_score')"
              >
                Score{{ signalIndSortArrow('quality_score') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'rsi' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('rsi')"
              >
                RSI{{ signalIndSortArrow('rsi') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'hv' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('hv')"
              >
                HV{{ signalIndSortArrow('hv') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'rocr_1h' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('rocr_1h')"
              >
                ROCR 1h{{ signalIndSortArrow('rocr_1h') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'rocr' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('rocr')"
              >
                ROCR{{ signalIndSortArrow('rocr') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'hh_48_diff' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('hh_48_diff')"
              >
                HH48{{ signalIndSortArrow('hh_48_diff') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'll_48_diff' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('ll_48_diff')"
              >
                LL48{{ signalIndSortArrow('ll_48_diff') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'chop' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('chop')"
              >
                Chop{{ signalIndSortArrow('chop') }}
              </th>
              <th class="py-2 pe-3">BB</th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'bbdelta' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('bbdelta')"
              >
                BBΔ{{ signalIndSortArrow('bbdelta') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'closedelta' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('closedelta')"
              >
                CloseΔ{{ signalIndSortArrow('closedelta') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'tail' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('tail')"
              >
                Tail{{ signalIndSortArrow('tail') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'volume' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('volume')"
              >
                Vol{{ signalIndSortArrow('volume') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'fisher' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('fisher')"
              >
                Fisher{{ signalIndSortArrow('fisher') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'regime_score' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('regime_score')"
              >
                Regime{{ signalIndSortArrow('regime_score') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'btc_trend' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('btc_trend')"
              >
                BTC{{ signalIndSortArrow('btc_trend') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'eth_trend' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('eth_trend')"
              >
                ETH{{ signalIndSortArrow('eth_trend') }}
              </th>
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                :class="signalIndSortCol === 'rel_str' ? 'text-primary-400' : ''"
                @click="toggleSignalIndSort('rel_str')"
              >
                RelStr{{ signalIndSortArrow('rel_str') }}
              </th>
              <th class="py-2 pe-3 whitespace-nowrap text-right">Spread%</th>
              <th class="py-2 pe-3 whitespace-nowrap text-right">BidVol</th>
              <th class="py-2 pe-3 whitespace-nowrap text-right">AskVol</th>
              <th class="py-2 pe-3 whitespace-nowrap text-right">OBImbal</th>
              <th class="py-2 pe-3">Exit</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in signalIndItems"
              :key="row.trade_id"
              class="border-b border-surface-700/70"
              :class="[
                row.rsi === null && signalIndMatchFilter !== 'unmatched' ? 'opacity-40' : '',
                row.is_open ? 'bg-surface-800/50' : '',
              ]"
            >
              <td class="py-2 pe-3 text-xs whitespace-nowrap">
                <div class="font-medium">{{ row.vps_name ?? '-' }}</div>
                <div class="text-xs text-surface-400">
                  {{ row.container_name ?? '-' }} · ID {{ row.bot_id }}
                </div>
              </td>
              <td class="py-2 pe-3 font-mono text-xs whitespace-nowrap">
                {{ row.pair ?? '?' }}
              </td>
              <td class="py-2 pe-3 font-mono text-xs whitespace-nowrap">
                {{ row.enter_tag ?? '?' }}
              </td>
              <td class="py-2 pe-3 text-xs whitespace-nowrap">
                <span
                  class="px-1.5 py-0.5 rounded text-xs font-medium"
                  :class="
                    row.is_short ? 'bg-red-900/50 text-red-300' : 'bg-green-900/50 text-green-300'
                  "
                  >{{ row.is_short ? 'Short' : 'Long' }}</span
                >
              </td>
              <td class="py-2 pe-3 font-mono text-xs whitespace-nowrap">
                {{ row.open_date ? formatDate(row.open_date) : '-' }}
              </td>
              <td class="py-2 pe-3 font-mono text-xs whitespace-nowrap">
                {{ row.is_open ? 'Open' : row.close_date ? formatDate(row.close_date) : '-' }}
              </td>
              <td
                class="py-2 pe-3 text-right font-mono text-xs"
                :class="
                  row.is_open
                    ? 'text-surface-500 italic'
                    : (row.profit_pct ?? 0) >= 0
                      ? 'text-green-400'
                      : 'text-red-400'
                "
              >
                {{
                  row.is_open
                    ? 'Pending'
                    : row.profit_pct !== null
                      ? (row.profit_pct >= 0 ? '+' : '') + row.profit_pct.toFixed(2) + '%'
                      : '-'
                }}
              </td>
              <td
                class="py-2 pe-3 text-right font-mono text-xs"
                :class="row.is_open ? 'text-surface-500 italic' : ''"
              >
                {{
                  row.is_open
                    ? 'Pending'
                    : row.duration_hours !== null
                      ? row.duration_hours.toFixed(1) + 'h'
                      : '-'
                }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.dca_order_count }}
              </td>
              <td
                class="py-2 pe-3 text-right font-mono text-xs"
                :class="
                  row.is_open
                    ? 'text-surface-500 italic'
                    : (row.quality_score ?? -Infinity) >= (signalIndAvgQuality ?? Infinity)
                      ? 'text-green-400'
                      : ''
                "
              >
                {{
                  row.is_open
                    ? 'Pending'
                    : row.quality_score !== null
                      ? row.quality_score.toFixed(1)
                      : '-'
                }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.rsi !== null ? row.rsi.toFixed(1) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.hv !== null ? row.hv.toFixed(2) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.rocr_1h !== null ? row.rocr_1h.toFixed(4) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.rocr !== null ? row.rocr.toFixed(4) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.hh_48_diff !== null ? row.hh_48_diff.toFixed(2) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.ll_48_diff !== null ? row.ll_48_diff.toFixed(2) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.chop !== null ? row.chop.toFixed(1) : '-' }}
              </td>
              <td class="py-2 pe-3 font-mono text-xs">{{ row.bb_pos ?? '-' }}</td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.bbdelta !== null ? row.bbdelta.toFixed(4) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.closedelta !== null ? row.closedelta.toFixed(4) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.tail !== null ? row.tail.toFixed(4) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.volume !== null ? row.volume.toFixed(0) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.fisher !== null ? row.fisher.toFixed(4) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.regime_score !== null ? row.regime_score.toFixed(1) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.btc_trend !== null ? row.btc_trend.toFixed(1) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.eth_trend !== null ? row.eth_trend.toFixed(1) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.rel_str !== null ? row.rel_str.toFixed(1) : '-' }}
              </td>
              <td
                class="py-2 pe-3 text-right font-mono text-xs"
                :class="
                  row.ob_spread_pct !== null
                    ? row.ob_spread_pct < 0.05
                      ? 'text-green-400'
                      : row.ob_spread_pct < 0.15
                        ? 'text-yellow-400'
                        : 'text-red-400'
                    : ''
                "
              >
                {{ row.ob_spread_pct !== null ? row.ob_spread_pct.toFixed(4) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.ob_bid_vol !== null ? row.ob_bid_vol.toFixed(0) : '-' }}
              </td>
              <td class="py-2 pe-3 text-right font-mono text-xs">
                {{ row.ob_ask_vol !== null ? row.ob_ask_vol.toFixed(0) : '-' }}
              </td>
              <td
                class="py-2 pe-3 text-right font-mono text-xs"
                :class="
                  row.ob_imbalance !== null
                    ? row.is_short
                      ? row.ob_imbalance < 0.5
                        ? 'text-green-400'
                        : 'text-red-400'
                      : row.ob_imbalance > 0.5
                        ? 'text-green-400'
                        : 'text-red-400'
                    : ''
                "
              >
                {{ row.ob_imbalance !== null ? row.ob_imbalance.toFixed(3) : '-' }}
              </td>
              <td class="py-2 pe-3 font-mono text-xs whitespace-nowrap">
                {{ row.is_open ? 'Open' : (row.exit_reason ?? '-') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <!-- /Trades tab -->

    <!-- Analytics tab -->
    <div v-else class="space-y-4 pt-2">
      <!-- Empty state -->
      <div v-if="signalIndAnalyticsData === null" class="text-sm text-surface-400 py-4 text-center">
        Load data to see analytics. Trades must have indicator snapshots (closed trades matched to
        [SIGNAL_FLASH] logs).
      </div>

      <template v-else>
        <!-- Summary + legend row -->
        <div class="flex flex-wrap items-center gap-4 text-xs text-surface-400">
          <span class="text-surface-200 font-medium">
            {{ signalIndAnalyticsData.tradeCount }} trades &mdash; threshold: score &ge;
            <span class="font-mono">{{
              signalIndAvgQuality !== null ? signalIndAvgQuality.toFixed(1) : '?'
            }}</span>
          </span>
          <span class="flex items-center gap-1"
            ><span class="inline-block w-3 h-3 rounded-sm bg-green-400"></span> Good:
            {{ signalIndAnalyticsData.goodCount }}</span
          >
          <span class="flex items-center gap-1"
            ><span class="inline-block w-3 h-3 rounded-sm bg-red-400"></span> Bad:
            {{ signalIndAnalyticsData.tradeCount - signalIndAnalyticsData.goodCount }}</span
          >
          <span class="text-surface-500"
            >All bots combined &mdash; green = where good entries cluster</span
          >
          <!-- Side toggle -->
          <div class="ml-auto flex gap-0 rounded border border-surface-600 overflow-hidden text-xs">
            <button
              v-for="s in [
                { key: 'all', label: 'All' },
                { key: 'long', label: 'Long' },
                { key: 'short', label: 'Short' },
              ]"
              :key="s.key"
              class="px-3 py-1 transition-colors"
              :class="
                signalIndAnalyticsSide === s.key
                  ? 'bg-primary-600 text-white'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
              "
              @click="signalIndAnalyticsSide = s.key as 'all' | 'long' | 'short'"
            >
              {{ s.label }}
            </button>
          </div>
        </div>

        <!-- Indicator histograms grid -->
        <div class="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <!-- Numeric indicator histogram -->
          <div
            v-for="hist in signalIndAnalyticsData.histograms"
            :key="hist.key"
            class="bg-surface-800/60 border border-surface-700/50 rounded p-2"
          >
            <div class="text-xs font-medium text-surface-200 mb-1">{{ hist.label }}</div>
            <svg viewBox="0 0 274 160" class="w-full">
              <!-- X axis line -->
              <line x1="6" y1="122" x2="268" y2="122" stroke="#475569" stroke-width="1" />
              <!-- Bars -->
              <template v-for="(bar, i) in hist.svgBars" :key="i">
                <rect
                  v-if="bar.goodH > 0.5"
                  :x="bar.goodX"
                  :y="bar.goodY"
                  :width="13"
                  :height="bar.goodH"
                  fill="#34d399"
                  rx="1"
                />
                <rect
                  v-if="bar.badH > 0.5"
                  :x="bar.badX"
                  :y="bar.badY"
                  :width="13"
                  :height="bar.badH"
                  fill="#f87171"
                  rx="1"
                />
              </template>
              <!-- X boundary labels — staggered to avoid overlap -->
              <text
                v-for="(lbl, i) in hist.svgXLabels"
                :key="i"
                :x="lbl.x"
                :y="lbl.stagger ? 148 : 134"
                text-anchor="middle"
                fill="#94a3b8"
                font-size="8"
              >
                {{ lbl.val }}
              </text>
              <!-- Tick marks at each boundary -->
              <line
                v-for="(lbl, i) in hist.svgXLabels"
                :key="`t${i}`"
                :x1="lbl.x"
                y1="122"
                :x2="lbl.x"
                :y2="lbl.stagger ? 130 : 126"
                stroke="#475569"
                stroke-width="1"
              />
            </svg>
          </div>

          <!-- BB position categorical -->
          <div
            v-if="signalIndAnalyticsData.bbCats.length > 0"
            class="bg-surface-800/60 border border-surface-700/50 rounded p-2"
          >
            <div class="text-xs font-medium text-surface-200 mb-2">BB position</div>
            <div class="space-y-2">
              <div v-for="cat in signalIndAnalyticsData.bbCats" :key="cat.cat">
                <div class="flex items-center gap-1 text-xs mb-0.5">
                  <span class="text-surface-300 w-24 truncate">{{ cat.cat }}</span>
                  <span class="ml-auto text-surface-500">{{ cat.total }}</span>
                </div>
                <div class="flex h-2.5 gap-0.5">
                  <div
                    class="bg-green-400 rounded-sm h-full min-w-0"
                    :style="{
                      width: (cat.good / signalIndAnalyticsData!.bbMaxTotal) * 100 + '%',
                    }"
                    :title="`Good: ${cat.good}`"
                  />
                  <div
                    class="bg-red-400 rounded-sm h-full min-w-0"
                    :style="{
                      width: (cat.bad / signalIndAnalyticsData!.bbMaxTotal) * 100 + '%',
                    }"
                    :title="`Bad: ${cat.bad}`"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Unmatched breakdown section -->
        <div
          v-if="signalIndUnmatchedBreakdown"
          class="space-y-3 pt-3 border-t border-surface-700/50"
        >
          <div class="text-xs font-medium text-surface-300">
            Unmatched Trade Breakdown (closed trades without indicator snapshot)
          </div>
          <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <!-- By Bot -->
            <div>
              <div class="text-xs text-surface-500 mb-2">By Bot</div>
              <table class="w-full text-xs">
                <thead>
                  <tr class="text-surface-500 border-b border-surface-700">
                    <th class="text-left pb-1 font-normal">Bot</th>
                    <th class="text-right pb-1 font-normal">Total</th>
                    <th class="text-right pb-1 font-normal">Matched</th>
                    <th class="text-right pb-1 font-normal">Unmatched</th>
                    <th class="text-right pb-1 font-normal">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="brow in signalIndUnmatchedBreakdown.byBot"
                    :key="brow.label"
                    class="border-b border-surface-800 hover:bg-surface-800/40"
                  >
                    <td class="py-1 pr-2 text-surface-300 font-mono">{{ brow.label }}</td>
                    <td class="py-1 text-right text-surface-400">{{ brow.total }}</td>
                    <td class="py-1 text-right text-green-500">{{ brow.matched }}</td>
                    <td
                      class="py-1 text-right"
                      :class="brow.unmatched > 0 ? 'text-yellow-400' : 'text-surface-500'"
                    >
                      {{ brow.unmatched }}
                    </td>
                    <td
                      class="py-1 text-right font-mono"
                      :class="
                        brow.rate >= 80
                          ? 'text-green-400'
                          : brow.rate >= 50
                            ? 'text-yellow-400'
                            : 'text-red-400'
                      "
                    >
                      {{ brow.rate }}%
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- By Enter Tag -->
            <div>
              <div class="text-xs text-surface-500 mb-2">By Enter Tag</div>
              <table class="w-full text-xs">
                <thead>
                  <tr class="text-surface-500 border-b border-surface-700">
                    <th class="text-left pb-1 font-normal">Tag</th>
                    <th class="text-right pb-1 font-normal">Total</th>
                    <th class="text-right pb-1 font-normal">Matched</th>
                    <th class="text-right pb-1 font-normal">Unmatched</th>
                    <th class="text-right pb-1 font-normal">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="trow in signalIndUnmatchedBreakdown.byTag"
                    :key="trow.tag"
                    class="border-b border-surface-800 hover:bg-surface-800/40"
                  >
                    <td class="py-1 pr-2 text-surface-300 font-mono">{{ trow.tag }}</td>
                    <td class="py-1 text-right text-surface-400">{{ trow.total }}</td>
                    <td class="py-1 text-right text-green-500">{{ trow.matched }}</td>
                    <td
                      class="py-1 text-right"
                      :class="trow.unmatched > 0 ? 'text-yellow-400' : 'text-surface-500'"
                    >
                      {{ trow.unmatched }}
                    </td>
                    <td
                      class="py-1 text-right font-mono"
                      :class="
                        trow.rate >= 80
                          ? 'text-green-400'
                          : trow.rate >= 50
                            ? 'text-yellow-400'
                            : 'text-red-400'
                      "
                    >
                      {{ trow.rate }}%
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </template>
    </div>
    <!-- /Analytics tab -->
  </div>
</template>
