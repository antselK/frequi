<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { vpsApi } from '@/composables/vpsApi';
import { provideReportsContext } from '@/composables/useReportsContext';
import ReportsAdminDialog from '@/components/ReportsAdminDialog.vue';
import BotPerformanceReport from '@/views/reports/BotPerformanceReport.vue';
import EntryTagPerformanceReport from '@/views/reports/EntryTagPerformanceReport.vue';
import DcaAnalysisReport from '@/views/reports/DcaAnalysisReport.vue';
import TodDurationReport from '@/views/reports/TodDurationReport.vue';
import ReportStub from '@/views/reports/ReportStub.vue';
import MissedTradesReport from '@/views/reports/MissedTradesReport.vue';
import SignalOutcomesReport from '@/views/reports/SignalOutcomesReport.vue';
import TradeDrilldownReport from '@/views/reports/TradeDrilldownReport.vue';
import TrailingBenefitReport from '@/views/reports/TrailingBenefitReport.vue';
import SignalIndicatorAnalysisReport from '@/views/reports/SignalIndicatorAnalysisReport.vue';
import ConfluenceScoreReport from '@/views/reports/ConfluenceScoreReport.vue';
import SystemErrorsReport from '@/views/reports/SystemErrorsReport.vue';
import LogsCumulativeReport from '@/views/reports/LogsCumulativeReport.vue';
import type { BotSummary, ReportLayoutSettings } from '@/types/vps';
import type { DwhCheckpoint } from '@/types/vps';

type ReportCategory = 'system' | 'trades';
interface ReportOption {
  value: string;
  label: string;
  todo: string;
}

interface ChartTooltipState {
  visible: boolean;
  x: number;
  y: number;
  lines: string[];
}

interface BotDisplayMeta {
  vpsName: string;
  containerName: string;
}

const _categoryDefs: { value: ReportCategory; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'trades', label: 'Trades' },
];

const _subcategoryDefs: Record<ReportCategory, ReportOption[]> = {
  system: [
    {
      value: 'system-errors',
      label: 'System errors timeline',
      todo: 'System error trend aggregated from DWH anomaly signatures.',
    },
    {
      value: 'logs-cumulative',
      label: 'Cumulative logs chart',
      todo: 'Cumulative count of DWH log entries generated over time.',
    },
  ],
  trades: [
    {
      value: 'trade-drilldown',
      label: 'Trade drill-down report',
      todo: 'Search and filter trades by bot, pair, strategy, entry tag, exit reason, and side. Expand any trade to view its order history and timeline. Includes summary stats and an equity chart.',
    },
    {
      value: 'missed-trades',
      label: 'Missed trades report',
      todo: 'Missed/rejected trade events parsed from DWH anomaly samples.',
    },
    {
      value: 'trailing-benefit',
      label: 'Trailing entries benefit',
      todo: 'Analyzes trailing entry quality across all _trail trades. Each row shows one closed trade with the trailing profit % at entry (how far price pulled back from peak), offset %, duration, and price levels (Start / Lowlimit / Uplimit). Use this to tune Printer.py trailing parameters: max_short/max_long (max allowed negative profit at entry), max_stop (abort threshold, must stay above max_long/short), default_offset (pullback depth to trigger entry), and trailing_expire_seconds (max trailing window before force-entry).',
    },
    {
      value: 'signal-outcomes',
      label: 'Signal outcome analysis',
      todo: 'Missed entry signals with price outcome over the analysis window — shows what would have happened.',
    },
    // ── Tier 1: high value, pure SQL ──────────────────────────────────────
    {
      value: 'bot-performance',
      label: 'Bot Performance Analysis',
      todo: 'Per-bot performance overview with composite score. Score = avg profit% × 2 − avg duration × 0.1 − (avg DCA orders − 1) × 1 (higher is better). Covers closed trade count, win rate, avg profit, total PnL, avg duration, DCA frequency, trades/day, best pair. Projections tab shows daily/monthly/yearly estimates in USDT or % (toggle) — % mode uses avg trade profit% × trades/day, comparable across bots regardless of capital.',
    },
    {
      value: 'entry-tag-performance',
      label: 'Entry tag performance',
      todo: 'Groups dwh_trades by enter_tag. Shows win rate, avg profit, avg duration, and total profit per tag.',
    },
    {
      value: 'exit-reason-distribution',
      label: '📋 Exit reason distribution',
      todo: 'TODO: How often does trailing stop fire vs other exits? Group dwh_trades by exit_reason → count, avg profit_ratio, % share.',
    },
    {
      value: 'equity-curve',
      label: '📋 Equity curve & drawdown',
      todo: 'TODO: Cumulative profit_abs over time per bot. Sum close_date profit_abs, compute rolling max drawdown.',
    },
    {
      value: 'bot-comparison',
      label: '📋 Bot comparison dashboard',
      todo: 'TODO: All bots side-by-side: trades/day, win rate, avg profit%, total PnL, avg duration. Source: dwh_trades grouped by bot_id.',
    },
    {
      value: 'pair-performance',
      label: '📋 Pair-level performance',
      todo: 'TODO: Which pairs are most profitable? Group dwh_trades by pair → win rate, avg profit%, trade count, total abs profit.',
    },
    // ── Tier 2: minor extra work ──────────────────────────────────────────
    {
      value: 'dca-analysis',
      label: 'DCA / multi-order analysis',
      todo: 'Joins dwh_trades and dwh_orders to group trades by buy-order count. Compares single-entry vs DCA: win rate, avg profit, avg duration.',
    },
    {
      value: 'signal-indicator-analysis',
      label: 'Signal Indicator Analysis',
      todo: 'Correlates each trade with its [SIGNAL_FLASH] indicator snapshot (captured at signal time, up to 20 min before entry). Trades tab: scatter chart (indicator vs profit/score) + sortable trade table. Analytics tab: per-bot indicator histograms showing good vs bad trade distributions — good = score ≥ avg. Use the Analytics tab to find indicator value ranges that produce more profitable, faster, lower-DCA trades, then reconfigure Printer.py entry filters. Score = profit% × 2 − duration (h) × 0.1 − (DCA orders − 1) × 1. Higher is better. Mirrors the Bot Performance score formula. Indicators: RSI (momentum), HV (volatility %), ROCR 1h / ROCR (rate of change), HH48 / LL48 (48h high/low distance %), Chop (choppiness index), BB (Bollinger band position).',
    },
    {
      value: 'confluence-score',
      label: 'Confluence Score',
      todo: 'Data-driven confluence score (0–100) built from the [SIGNAL_FLASH] indicators. For each entry tag the model learns which indicator value bands go with high-quality trades (good = quality ≥ tag median) and weights each indicator by how strongly it separates good from bad — flat indicators get zero weight (so e.g. short_chop_vol, whose indicators barely move quality, scores on its few useful ones only). A trade/signal’s score = weighted fraction of indicators inside their favorable band. Quality = profit% × 2 − duration(h) × 0.1 − (DCA − 1); win/loss is useless here (~98% of trades eventually ROI-exit). The Validation table shows avg quality/profit per score bucket — it should rise with confluence. Click Recalibrate to retrain from all history as new trades accumulate; a nightly job also retrains automatically. The model is stored in app_settings (key confluence-model).',
    },
    {
      value: 'trade-duration',
      label: '📋 Trade duration vs profit',
      todo: 'TODO: Scatter: duration (hours) vs profit_ratio, colored by exit_reason. Helps spot if quick trades outperform long ones.',
    },
    {
      value: 'slippage-quality',
      label: '📋 Slippage & fill quality',
      todo: 'TODO: dwh_orders.average vs dwh_trades.open_rate per pair/bot — are fills close to signal price? Which pairs slip most?',
    },
    {
      value: 'fee-impact',
      label: '📋 Fee impact',
      todo: 'TODO: Sum dwh_orders.fee_base per trade vs gross profit_abs. What % of profit goes to fees per bot/pair?',
    },
    // ── Tier 3: interesting, lower urgency ───────────────────────────────
    {
      value: 'tod-duration',
      label: 'Time-of-Day Duration',
      todo: 'Per-UTC-hour trade duration stats: avg/median duration, % trades completing ≤1h and % stuck ≥8h, avg profit%, and win rate. Filters: date range, enter tag, direction. Use to identify hours with structurally slow/stuck trades and inform time-filter windows in the strategy.',
    },
    {
      value: 'entry-exit-matrix',
      label: '📋 Entry tag × exit reason matrix',
      todo: 'TODO: Pivot table: rows = enter_tag, cols = exit_reason, cells = avg profit_ratio. Shows which tags exit cleanly via trailing vs stoploss.',
    },
    {
      value: 'error-trade-correlation',
      label: '📋 Error ↔ trade correlation',
      todo: 'TODO: Do anomaly spikes correlate with missed trades or bad fills? Join dwh_anomaly_hourly_rollups with dwh_missed_signals by hour+bot.',
    },
  ],
};

// ── Report layout (ordering + visibility, persisted in backend) ────────────
const reportLayout = ref<ReportLayoutSettings | null>(null);
const reportsAdminVisible = ref(false);

// ── Global bot filter ─────────────────────────────────────────────────────
const allManagedBots = ref<BotSummary[]>([]);
const activeBotIds = ref<Set<number>>(new Set());

const botFilterActive = computed(
  () => allManagedBots.value.length > 0 && activeBotIds.value.size < allManagedBots.value.length,
);

function toggleBot(id: number) {
  const s = new Set(activeBotIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  activeBotIds.value = s;
}
function selectAllBots() {
  activeBotIds.value = new Set(allManagedBots.value.map((b) => b.id));
}
function clearAllBots() {
  activeBotIds.value = new Set();
}

function isBotActive(botId: number): boolean {
  // Empty selection = no bots (matches the all-chips-deselected + "● filtered"
  // rendering). selectAllBots() seeds the full set on mount, so an empty set is
  // only ever reached by an explicit "None"/untick-all action, not the default.
  return activeBotIds.value.has(botId);
}

const botSelectOptions = computed(() => [
  { label: 'All bots', value: null as number | null },
  ...allManagedBots.value.map((b) => ({
    label: `${b.container_name} — ${b.vps_name}${b.strategy ? ' · ' + b.strategy : ''}`,
    value: b.id as number | null,
  })),
]);

const categoryOptions = computed(() => {
  if (!reportLayout.value) return _categoryDefs;
  const order = reportLayout.value.categoryOrder;
  return [..._categoryDefs].sort((a, b) => {
    const ai = order.indexOf(a.value);
    const bi = order.indexOf(b.value);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
});

const subCategoryOptionsByCategory = computed((): Record<ReportCategory, ReportOption[]> => {
  if (!reportLayout.value) return _subcategoryDefs;
  const result = {} as Record<ReportCategory, ReportOption[]>;
  for (const cat of _categoryDefs) {
    const catKey = cat.value;
    const catSettings = reportLayout.value.subcategories?.[catKey];
    if (!catSettings) {
      result[catKey] = _subcategoryDefs[catKey];
      continue;
    }
    const order = catSettings.order;
    const hidden = new Set(catSettings.hidden ?? []);
    const sorted = [..._subcategoryDefs[catKey]].sort((a, b) => {
      const ai = order.indexOf(a.value);
      const bi = order.indexOf(b.value);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    result[catKey] = sorted.filter((s) => !hidden.has(s.value));
  }
  return result;
});

async function loadReportLayout() {
  try {
    const layout = await vpsApi.getReportLayout();
    reportLayout.value = layout;
    // Re-validate selections after layout is applied
    const available = subCategoryOptionsByCategory.value[selectedCategory.value];
    if (available && !available.find((s) => s.value === selectedSubCategory.value)) {
      selectedSubCategory.value = available[0]?.value ?? '';
    }
  } catch {
    // Fail silently — defaults remain in effect
  }
}

function handleLayoutSaved(layout: ReportLayoutSettings) {
  reportLayout.value = layout;
  const available = subCategoryOptionsByCategory.value[selectedCategory.value];
  if (available && !available.find((s) => s.value === selectedSubCategory.value)) {
    selectedSubCategory.value = available[0]?.value ?? '';
  }
}
// ──────────────────────────────────────────────────────────────────────────

const botDisplayById = ref<Map<number, BotDisplayMeta>>(new Map());

const reportsError = ref('');

provideReportsContext({
  reportsError,
  botSelectOptions,
  activeBotIds,
  isBotActive,
  getBotVpsName,
  getBotContainerName,
  showChartTooltip,
  hideChartTooltip,
  ensureBotDisplayMapLoaded,
});

const chartTooltip = ref<ChartTooltipState>({
  visible: false,
  x: 0,
  y: 0,
  lines: [],
});

const selectedCategory = ref<ReportCategory>('system');
const selectedSubCategory = ref('system-errors');

const availableSubCategories = computed(
  () => subCategoryOptionsByCategory.value[selectedCategory.value],
);

const selectedSubCategoryDefinition = computed(() => {
  return availableSubCategories.value.find((item) => item.value === selectedSubCategory.value);
});

function showChartTooltip(event: MouseEvent, lines: string[]) {
  chartTooltip.value = {
    visible: true,
    x: event.clientX + 12,
    y: event.clientY - 12,
    lines,
  };
}

function hideChartTooltip() {
  chartTooltip.value.visible = false;
}

function buildBotDisplayMap(checkpoints: DwhCheckpoint[]): Map<number, BotDisplayMeta> {
  const mapped = new Map<number, BotDisplayMeta>();
  for (const checkpoint of checkpoints) {
    if (mapped.has(checkpoint.bot_id)) {
      continue;
    }
    mapped.set(checkpoint.bot_id, {
      vpsName: checkpoint.vps_name || '—',
      containerName: checkpoint.container_name || '—',
    });
  }
  return mapped;
}

async function ensureBotDisplayMapLoaded() {
  if (botDisplayById.value.size) {
    return;
  }
  try {
    const summary = await vpsApi.dwhSummary();
    botDisplayById.value = buildBotDisplayMap(summary.checkpoints ?? []);
  } catch {
    botDisplayById.value = new Map();
  }
}

function getBotVpsName(botId: number): string {
  return botDisplayById.value.get(botId)?.vpsName ?? '—';
}

function getBotContainerName(botId: number): string {
  return botDisplayById.value.get(botId)?.containerName ?? '—';
}

watch(selectedCategory, () => {
  const firstOption = availableSubCategories.value[0];
  selectedSubCategory.value = firstOption?.value ?? '';
});

watch(selectedSubCategory, () => {
  reportsError.value = '';
});

onMounted(async () => {
  try {
    allManagedBots.value = (await vpsApi.allBots()).filter((b) => b.enabled);
    selectAllBots();
  } catch {
    /* non-critical — filter strip stays hidden */
  }
  await loadReportLayout();
});
</script>

<template>
  <div class="mx-auto mt-3 p-4 w-[98vw] max-w-[98vw] flex flex-col gap-4">
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="font-semibold">Reports</span>
          <UButton label="Reports Admin" @click="reportsAdminVisible = true" />
        </div>
      </template>
      <template #default>
        <div class="flex flex-col gap-4">
          <div class="flex flex-wrap gap-3">
            <div class="flex flex-col gap-1 min-w-52">
              <label class="text-sm">Category</label>
              <USelect v-model="selectedCategory" :items="categoryOptions" size="sm" />
            </div>

            <div class="flex flex-col gap-1 min-w-64">
              <label class="text-sm">Sub category</label>
              <USelect v-model="selectedSubCategory" :items="availableSubCategories" size="sm" />
            </div>
          </div>

          <!-- Global Bot Filter Strip -->
          <div
            v-if="allManagedBots.length > 0"
            class="flex flex-wrap items-center gap-2 py-2 border-b border-surface-700/60"
          >
            <span class="text-surface-400 text-xs shrink-0">Bots:</span>
            <button
              v-for="bot in allManagedBots"
              :key="bot.id"
              class="px-2 py-0.5 rounded border text-xs transition-colors whitespace-nowrap"
              :class="
                activeBotIds.has(bot.id)
                  ? 'bg-primary-600/20 border-primary-500/60 text-primary-300'
                  : 'border-surface-700 text-surface-600 line-through opacity-50'
              "
              :title="`#${bot.id} · ${bot.container_name} · ${bot.exchange ?? ''}`"
              @click="toggleBot(bot.id)"
            >
              {{ bot.vps_name }} ({{ bot.container_name }} · {{ bot.strategy ?? '?' }})
            </button>
            <button
              class="text-xs text-surface-400 hover:text-surface-200 px-1"
              @click="selectAllBots"
            >
              All
            </button>
            <span class="text-surface-700">|</span>
            <button
              class="text-xs text-surface-400 hover:text-surface-200 px-1"
              @click="clearAllBots"
            >
              None
            </button>
            <span v-if="botFilterActive" class="text-xs text-yellow-400/70 ml-1">● filtered</span>
          </div>

          <div class="border border-surface-400 rounded-sm p-4 space-y-2">
            <h4 class="text-lg font-semibold">
              {{ selectedSubCategoryDefinition?.label || 'No report selected' }}
            </h4>
            <p class="text-surface-600 dark:text-surface-300">
              {{ selectedSubCategoryDefinition?.todo || 'TODO: Report section placeholder.' }}
            </p>
            <p v-if="reportsError" class="text-sm text-red-400">{{ reportsError }}</p>
          </div>

          <SystemErrorsReport v-if="selectedSubCategory === 'system-errors'" />

          <LogsCumulativeReport v-if="selectedSubCategory === 'logs-cumulative'" />

          <MissedTradesReport v-if="selectedSubCategory === 'missed-trades'" />

          <SignalOutcomesReport v-if="selectedSubCategory === 'signal-outcomes'" />

          <!-- ============================================================ -->
          <!-- Stub report pages — Tier 1                               -->
          <!-- ============================================================ -->

          <EntryTagPerformanceReport v-if="selectedSubCategory === 'entry-tag-performance'" />

          <ReportStub
            v-if="selectedSubCategory === 'exit-reason-distribution'"
            title="Exit Reason Distribution"
            tier="1"
            :show-pair-filter="true"
          >
            <template #description>
              Groups closed trades by
              <code class="bg-surface-700 px-1 rounded">exit_reason</code> and shows count, avg
              profit %, and % share. Answers:
              <em
                >how often does the trailing stop fire vs stoploss vs ROI? Are we exiting well?</em
              >
            </template>
            <template #what>
              <div class="text-surface-400">• Bar chart: exit_reason by count + avg profit</div>
              <div class="text-surface-400">• Pie/donut: % share by exit reason</div>
              <div class="text-surface-400">
                • Table: reason | count | % share | avg profit% | avg profit abs
              </div>
              <div class="text-surface-400">• Filter by bot, date range, pair</div>
            </template>
            <template #how>
              <div class="text-surface-400">
                • Backend:
                <code class="bg-surface-800 px-1 rounded"
                  >GET /dwh/reports/exit-reason-distribution</code
                >
              </div>
              <div class="text-surface-400">
                • Query:
                <code class="bg-surface-800 px-1 rounded"
                  >SELECT exit_reason, COUNT(*), AVG(profit_ratio) FROM dwh_trades WHERE close_date
                  IS NOT NULL GROUP BY exit_reason</code
                >
              </div>
              <div class="text-surface-400">
                • Printer.py key exit reasons: trailing_stop_loss, roi, stop_loss, force_sell
              </div>
              <div class="text-surface-400">
                • Frontend: table + optional SVG bar chart reusing existing chart patterns
              </div>
            </template>
          </ReportStub>

          <ReportStub
            v-if="selectedSubCategory === 'equity-curve'"
            title="Equity Curve & Drawdown"
            tier="1"
          >
            <template #description>
              Plots cumulative <code class="bg-surface-700 px-1 rounded">profit_abs</code> over time
              per bot, with rolling max drawdown. Answers:
              <em>is each bot growing its account? When were the worst drawdown periods?</em>
            </template>
            <template #what>
              <div class="text-surface-400">
                • Line chart: cumulative profit_abs over close_date, one line per bot
              </div>
              <div class="text-surface-400">• Shaded area below line = drawdown depth</div>
              <div class="text-surface-400">
                • Summary: total PnL, max drawdown, recovery factor per bot
              </div>
              <div class="text-surface-400">• Bot toggle to show/hide individual lines</div>
            </template>
            <template #how>
              <div class="text-surface-400">
                • Backend: return sorted
                <code class="bg-surface-800 px-1 rounded">(close_date, bot_id, profit_abs)</code>
                rows
              </div>
              <div class="text-surface-400">
                • Frontend: compute running sum + rolling max in JS, then render with SVG polyline
                (pattern exists in system errors chart)
              </div>
              <div class="text-surface-400">• Drawdown = (running_max - current) / running_max</div>
              <div class="text-surface-400">• One API call, all bots; group client-side</div>
            </template>
          </ReportStub>

          <ReportStub
            v-if="selectedSubCategory === 'bot-comparison'"
            title="Bot Comparison Dashboard"
            tier="1"
            :show-bot-filter="false"
          >
            <template #description>
              All bots side-by-side with key performance metrics. Answers:
              <em>which bots are outperforming? Which are dragging down results?</em>
            </template>
            <template #what>
              <div class="text-surface-400">
                • Table: Bot | VPS | Trades | Trades/day | Win rate | Avg profit% | Total PnL | Avg
                duration
              </div>
              <div class="text-surface-400">
                • Color-coded: green/red for win rate and avg profit
              </div>
              <div class="text-surface-400">• Sortable columns</div>
              <div class="text-surface-400">• Date range filter</div>
            </template>
            <template #how>
              <div class="text-surface-400">
                • Backend:
                <code class="bg-surface-800 px-1 rounded"
                  >SELECT bot_id, COUNT(*), AVG(profit_ratio), SUM(profit_abs), ... FROM dwh_trades
                  GROUP BY bot_id</code
                >
              </div>
              <div class="text-surface-400">
                • Join managed_bots + vps_servers for display names
              </div>
              <div class="text-surface-400">
                • Frontend: sortable table, stat cards for fleet-level totals
              </div>
              <div class="text-surface-400">
                • Reuse
                <code class="bg-surface-800 px-1 rounded">getBotVpsName / getBotContainerName</code>
                helpers
              </div>
            </template>
          </ReportStub>

          <ReportStub
            v-if="selectedSubCategory === 'pair-performance'"
            title="Pair-Level Performance"
            tier="1"
            :show-pair-filter="true"
          >
            <template #description>
              Groups closed trades by <code class="bg-surface-700 px-1 rounded">pair</code> and
              shows win rate, avg profit, trade count, total abs profit. Answers:
              <em
                >which pairs are consistently profitable? Which should be removed from the
                pairlist?</em
              >
            </template>
            <template #what>
              <div class="text-surface-400">
                • Table: Pair | trades | win rate | avg profit% | total PnL | avg duration
              </div>
              <div class="text-surface-400">• Sort by total PnL or win rate</div>
              <div class="text-surface-400">• Filter by bot, date range</div>
              <div class="text-surface-400">• Highlight top 5 / bottom 5 pairs</div>
            </template>
            <template #how>
              <div class="text-surface-400">
                • Backend:
                <code class="bg-surface-800 px-1 rounded"
                  >SELECT pair, COUNT(*), SUM(profit_abs), AVG(profit_ratio) FROM dwh_trades WHERE
                  close_date IS NOT NULL GROUP BY pair ORDER BY SUM(profit_abs) DESC</code
                >
              </div>
              <div class="text-surface-400">
                • Optional bot_id filter to see per-bot pair performance
              </div>
              <div class="text-surface-400">• Frontend: sortable table, color-coded PnL column</div>
            </template>
          </ReportStub>

          <!-- ============================================================ -->
          <!-- Stub report pages — Tier 2                               -->
          <!-- ============================================================ -->

          <DcaAnalysisReport v-if="selectedSubCategory === 'dca-analysis'" />

          <SignalIndicatorAnalysisReport
            v-if="selectedSubCategory === 'signal-indicator-analysis'"
          />

          <ConfluenceScoreReport v-if="selectedSubCategory === 'confluence-score'" />

          <ReportStub
            v-if="selectedSubCategory === 'trade-duration'"
            title="Trade Duration vs Profit"
            tier="2"
            :show-pair-filter="true"
          >
            <template #description>
              Scatter plot of trade duration (hours) vs profit_ratio, colored by exit reason.
              Answers:
              <em
                >do short trades outperform long ones? Are long-held trades more likely to
                stop-loss?</em
              >
            </template>
            <template #what>
              <div class="text-surface-400">
                • SVG scatter: x = duration (h), y = profit_ratio, color = exit_reason
              </div>
              <div class="text-surface-400">
                • Buckets: &lt;1h | 1–4h | 4–12h | 12–24h | &gt;24h → avg profit per bucket
              </div>
              <div class="text-surface-400">• Filter by bot, pair, date range, exit reason</div>
            </template>
            <template #how>
              <div class="text-surface-400">
                • Backend: return (open_date, close_date, profit_ratio, exit_reason) — duration
                computed client-side
              </div>
              <div class="text-surface-400">
                •
                <code class="bg-surface-800 px-1 rounded"
                  >duration_h = (close_date - open_date).seconds / 3600</code
                >
              </div>
              <div class="text-surface-400">
                • Frontend: SVG scatter reusing coordinate system from existing charts
              </div>
              <div class="text-surface-400">
                • Color map: trailing_stop=green, stop_loss=red, roi=blue, other=gray
              </div>
            </template>
          </ReportStub>

          <ReportStub
            v-if="selectedSubCategory === 'slippage-quality'"
            title="Slippage & Fill Quality"
            tier="2"
            :show-pair-filter="true"
          >
            <template #description>
              Compares <code class="bg-surface-700 px-1 rounded">dwh_orders.average</code> (actual
              fill) vs <code class="bg-surface-700 px-1 rounded">dwh_trades.open_rate</code> (signal
              price) per pair/bot. Answers:
              <em
                >are we getting filled near the signal price, or is slippage eating into
                profits?</em
              >
            </template>
            <template #what>
              <div class="text-surface-400">
                • Table: pair | avg slippage% | max slippage% | trade count
              </div>
              <div class="text-surface-400">
                • slippage% = (fill_price - signal_price) / signal_price × 100
              </div>
              <div class="text-surface-400">• Sorted by worst avg slippage</div>
              <div class="text-surface-400">• Alert: pairs with avg slippage &gt; 0.1%</div>
            </template>
            <template #how>
              <div class="text-surface-400">
                • Join dwh_orders (ft_order_side='buy', status='closed') with dwh_trades on trade_id
              </div>
              <div class="text-surface-400">
                •
                <code class="bg-surface-800 px-1 rounded"
                  >slippage = (orders.average - trades.open_rate) / trades.open_rate</code
                >
              </div>
              <div class="text-surface-400">
                • Check dwh_orders has average column populated before building
              </div>
              <div class="text-surface-400">• Backend aggregation; frontend table only</div>
            </template>
          </ReportStub>

          <ReportStub v-if="selectedSubCategory === 'fee-impact'" title="Fee Impact" tier="2">
            <template #description>
              Sums <code class="bg-surface-700 px-1 rounded">dwh_orders.fee_base</code> per trade
              and compares against gross
              <code class="bg-surface-700 px-1 rounded">profit_abs</code>. Answers:
              <em>what % of gross profit goes to fees? Which bots/pairs pay the most in fees?</em>
            </template>
            <template #what>
              <div class="text-surface-400">
                • Summary: total fees paid, total gross profit, net efficiency %
              </div>
              <div class="text-surface-400">
                • Table: bot | total fees | gross PnL | fee % of profit
              </div>
              <div class="text-surface-400">
                • Per-pair breakdown: which pairs cost the most in fees
              </div>
            </template>
            <template #how>
              <div class="text-surface-400">
                •
                <code class="bg-surface-800 px-1 rounded"
                  >SELECT trade_id, SUM(fee_base) FROM dwh_orders GROUP BY trade_id</code
                >
              </div>
              <div class="text-surface-400">• Join result with dwh_trades.profit_abs</div>
              <div class="text-surface-400">
                •
                <code class="bg-surface-800 px-1 rounded"
                  >fee_pct = total_fees / (profit_abs + total_fees) × 100</code
                >
              </div>
              <div class="text-surface-400">
                • Check fee_base column is populated in dwh_orders before building
              </div>
            </template>
          </ReportStub>

          <!-- ============================================================ -->
          <!-- Stub report pages — Tier 3                               -->
          <!-- ============================================================ -->

          <TodDurationReport v-if="selectedSubCategory === 'tod-duration'" />

          <ReportStub
            v-if="selectedSubCategory === 'entry-exit-matrix'"
            title="Entry Tag × Exit Reason Matrix"
            tier="3"
          >
            <template #description>
              Pivot table: rows = enter_tag, cols = exit_reason, cells = avg profit_ratio and trade
              count. Answers:
              <em>which entry tags lead to clean trailing-stop exits vs stop-loss exits?</em>
            </template>
            <template #what>
              <div class="text-surface-400">• Pivot grid: enter_tag rows × exit_reason cols</div>
              <div class="text-surface-400">
                • Each cell: avg profit% (color coded) + trade count
              </div>
              <div class="text-surface-400">• Row totals + column totals</div>
              <div class="text-surface-400">
                • Empty cells = gray (no trades for that combination)
              </div>
            </template>
            <template #how>
              <div class="text-surface-400">
                • Backend:
                <code class="bg-surface-800 px-1 rounded"
                  >SELECT enter_tag, exit_reason, AVG(profit_ratio), COUNT(*) FROM dwh_trades WHERE
                  close_date IS NOT NULL GROUP BY 1, 2</code
                >
              </div>
              <div class="text-surface-400">
                • Frontend: pivot client-side — collect unique tags/reasons, build 2D map
              </div>
              <div class="text-surface-400">
                • Render as CSS grid or table; color each cell by avg profit
              </div>
            </template>
          </ReportStub>

          <ReportStub
            v-if="selectedSubCategory === 'error-trade-correlation'"
            title="Error ↔ Trade Correlation"
            tier="3"
          >
            <template #description>
              Correlates anomaly spikes from
              <code class="bg-surface-700 px-1 rounded">dwh_anomaly_hourly_rollups</code> with
              missed signals or bad fills in the same time window. Answers:
              <em>when bots log lots of errors, do they also miss more trades or fill worse?</em>
            </template>
            <template #what>
              <div class="text-surface-400">
                • Dual-axis timeline: error count (red) + missed signal count (blue) per hour
              </div>
              <div class="text-surface-400">
                • Correlation score: Pearson correlation between error rate and missed trade rate
              </div>
              <div class="text-surface-400">• Highlight hours where both spike together</div>
            </template>
            <template #how>
              <div class="text-surface-400">
                • Join dwh_anomaly_hourly_rollups with dwh_missed_signals bucketed to the same hour
              </div>
              <div class="text-surface-400">
                • Backend: return hourly series of (hour, error_count, missed_count)
              </div>
              <div class="text-surface-400">
                • Frontend: dual SVG polyline reusing existing timeline chart pattern
              </div>
              <div class="text-surface-400">
                • This report requires both anomaly rollups AND missed_signals to be populated
              </div>
            </template>
          </ReportStub>

          <TradeDrilldownReport v-if="selectedSubCategory === 'trade-drilldown'" />

          <TrailingBenefitReport v-if="selectedSubCategory === 'trailing-benefit'" />

          <BotPerformanceReport v-if="selectedSubCategory === 'bot-performance'" />

          <div
            v-if="chartTooltip.visible"
            class="fixed z-50 pointer-events-none rounded border border-surface-600 bg-surface-900 px-2 py-1 text-xs text-surface-100 shadow-lg"
            :style="{ left: `${chartTooltip.x}px`, top: `${chartTooltip.y}px` }"
          >
            <div v-for="(line, idx) in chartTooltip.lines" :key="`tip-${idx}`">
              {{ line }}
            </div>
          </div>
        </div>
      </template>
    </UCard>

    <ReportsAdminDialog
      v-model:visible="reportsAdminVisible"
      :category-defs="_categoryDefs"
      :subcategory-defs="_subcategoryDefs"
      @saved="handleLayoutSaved"
    />
  </div>
</template>
