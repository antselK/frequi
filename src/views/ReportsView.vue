<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { timestampShort } from '@/utils/formatters/timeformat';
import { formatDate } from '@/utils/reportParsers';
import { logsChartLayout } from '@/utils/reportCharts';
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
import type { BotSummary, ReportLayoutSettings } from '@/types/vps';
import type { DwhCheckpoint, DwhLogCauseSummary, DwhLogCumulativePoint } from '@/types/vps';

type ReportCategory = 'system' | 'trades';
interface ReportOption {
  value: string;
  label: string;
  todo: string;
}

interface TimelinePoint {
  ts: string;
  at: string;
  count: number;
}

interface LogsCumulativeChartPoint {
  at: string;
  ts: string;
  generated: number;
  cumulative: number;
}

interface ChartTooltipState {
  visible: boolean;
  x: number;
  y: number;
  lines: string[];
}

type LogsChartMode = 'cumulative' | 'hourly';

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
  return activeBotIds.value.size === 0 || activeBotIds.value.has(botId);
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

const systemErrorTimelinePoints = ref<TimelinePoint[]>([]);
const logsCumulativeChartPoints = ref<LogsCumulativeChartPoint[]>([]);
const botDisplayById = ref<Map<number, BotDisplayMeta>>(new Map());
const systemSpikeSummary = ref<DwhLogCauseSummary | null>(null);
const logsSpikeSummary = ref<DwhLogCauseSummary | null>(null);
const systemDateFrom = ref(todayStr());
const systemDateTo = ref(todayStr());
const systemSpikeFromLocal = ref('');
const systemSpikeToLocal = ref('');
const systemSpikeLevels = ref('ERROR,WARNING');
const systemSpikeLimit = ref(20);
const logsDateFrom = ref(todayStr());
const logsDateTo = ref(todayStr());
const logsSpikeFromLocal = ref('');
const logsSpikeToLocal = ref('');
const logsSpikeLevels = ref('INFO,WARNING,ERROR');
const logsSpikeLimit = ref(20);
const logsFilterBotId = ref<number | null>(null);
const logsFilterLogger = ref('');
const logsFilterLevel = ref('');
const logsChartMode = ref<LogsChartMode>('cumulative');
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function dateFromToDays(dateFrom: string): number {
  const from = new Date(dateFrom + 'T00:00:00');
  const diffMs = Date.now() - from.getTime();
  return Math.max(1, Math.ceil(diffMs / 86400000));
}

const loadingSystemTimeline = ref(false);
const loadingSystemSpikeSummary = ref(false);
const loadingLogsCumulative = ref(false);
const loadingLogsSpikeSummary = ref(false);
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

const systemLoaded = ref(false);
const logsCumulativeLoaded = ref(false);
const systemSpikeLoaded = ref(false);
const logsSpikeLoaded = ref(false);
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

const logsChartModeOptions: { label: string; value: LogsChartMode }[] = [
  { label: 'Cumulative', value: 'cumulative' },
  { label: 'Per-hour', value: 'hourly' },
];

const maxSystemErrorCount = computed(() => {
  return Math.max(...systemErrorTimelinePoints.value.map((point) => point.count), 1);
});

const systemChartPolyline = computed(() => {
  const points = systemErrorTimelinePoints.value;
  if (!points.length) {
    return '';
  }
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(points.length - 1, 1);
  const maxY = Math.max(maxSystemErrorCount.value, 1);

  return points
    .map((point, idx) => {
      const x = leftPad + (idx / denominator) * plotWidth;
      const y = topPad + (1 - point.count / maxY) * plotHeight;
      return `${x},${y}`;
    })
    .join(' ');
});

const systemChartAreaPolyline = computed(() => {
  const line = systemChartPolyline.value;
  if (!line) {
    return '';
  }
  const first = line.split(' ')[0];
  const last = line.split(' ').slice(-1)[0];
  if (!first || !last) {
    return '';
  }
  return `${first} ${line} ${last.split(',')[0]},230 ${first.split(',')[0]},230`;
});

const systemChartCoordinates = computed(() => {
  const points = systemErrorTimelinePoints.value;
  if (!points.length) {
    return [] as { x: number; y: number; at: string; count: number }[];
  }
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(points.length - 1, 1);
  const maxY = Math.max(maxSystemErrorCount.value, 1);

  return points.map((point, idx) => {
    const x = leftPad + (idx / denominator) * plotWidth;
    const y = topPad + (1 - point.count / maxY) * plotHeight;
    return { x, y, at: point.at, count: point.count };
  });
});

const systemChartYTicks = computed(() => {
  const ticks = 5;
  const maxY = Math.max(maxSystemErrorCount.value, 1);
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const ratio = i / ticks;
    const value = Math.round((1 - ratio) * maxY);
    const y = topPad + ratio * plotHeight;
    return { y, value };
  });
});

const systemChartXTicks = computed(() => {
  const coords = systemChartCoordinates.value;
  if (!coords.length) {
    return [] as { x: number; label: string }[];
  }
  const indexes = new Set<number>([0, Math.floor((coords.length - 1) / 2), coords.length - 1]);
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => {
      const point = coords[index];
      const date = new Date(systemErrorTimelinePoints.value[index]?.ts ?? '');
      const label = Number.isNaN(date.getTime()) ? (point?.at ?? '') : timestampShort(date);
      return { x: point?.x ?? 0, label };
    });
});

const systemChartDateRangeLabel = computed(() => {
  const points = systemErrorTimelinePoints.value;
  if (!points.length) {
    return 'Date / Time: n/a';
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return 'Date / Time: n/a';
  }
  return `Date / Time: ${first.at} → ${last.at}`;
});

const maxLogsCumulativeCount = computed(() => {
  if (logsChartMode.value === 'hourly') {
    return Math.max(...logsCumulativeChartPoints.value.map((point) => point.generated), 1);
  }
  return Math.max(...logsCumulativeChartPoints.value.map((point) => point.cumulative), 1);
});

const logsChartSeriesLabel = computed(() => {
  return logsChartMode.value === 'hourly'
    ? 'Generated logs (Count per hour)'
    : 'Cumulative logs (Count)';
});

const logsChartDateRangeLabel = computed(() => {
  const points = logsCumulativeChartPoints.value;
  if (!points.length) {
    return 'Date / Time: n/a';
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return 'Date / Time: n/a';
  }
  return `Date / Time: ${first.at} → ${last.at}`;
});

const logsChartPolyline = computed(() => {
  const points = logsCumulativeChartPoints.value;
  if (!points.length) {
    return '';
  }
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(points.length - 1, 1);
  const maxY = Math.max(maxLogsCumulativeCount.value, 1);

  return points
    .map((point, idx) => {
      const x = leftPad + (idx / denominator) * plotWidth;
      const chartValue = logsChartMode.value === 'hourly' ? point.generated : point.cumulative;
      const y = topPad + (1 - chartValue / maxY) * plotHeight;
      return `${x},${y}`;
    })
    .join(' ');
});

const logsChartCoordinates = computed(() => {
  const points = logsCumulativeChartPoints.value;
  if (!points.length) {
    return [] as { x: number; y: number; at: string; generated: number; cumulative: number }[];
  }
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(points.length - 1, 1);
  const maxY = Math.max(maxLogsCumulativeCount.value, 1);

  return points.map((point, idx) => {
    const x = leftPad + (idx / denominator) * plotWidth;
    const chartValue = logsChartMode.value === 'hourly' ? point.generated : point.cumulative;
    const y = topPad + (1 - chartValue / maxY) * plotHeight;
    return {
      x,
      y,
      at: point.at,
      generated: point.generated,
      cumulative: point.cumulative,
    };
  });
});

const logsChartYTicks = computed(() => {
  const ticks = 5;
  const maxY = Math.max(maxLogsCumulativeCount.value, 1);
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const ratio = i / ticks;
    const value = Math.round((1 - ratio) * maxY);
    const y = topPad + ratio * plotHeight;
    return { y, value };
  });
});

const logsChartXTicks = computed(() => {
  const coords = logsChartCoordinates.value;
  if (!coords.length) {
    return [] as { x: number; label: string }[];
  }
  const indexes = new Set<number>([0, Math.floor((coords.length - 1) / 2), coords.length - 1]);
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => {
      const point = coords[index];
      const date = new Date(logsCumulativeChartPoints.value[index]?.ts ?? '');
      const label = Number.isNaN(date.getTime()) ? (point?.at ?? '') : timestampShort(date);
      return { x: point?.x ?? 0, label };
    });
});

const logsChartAreaPolyline = computed(() => {
  const line = logsChartPolyline.value;
  if (!line) {
    return '';
  }
  const first = line.split(' ')[0];
  const last = line.split(' ').slice(-1)[0];
  if (!first || !last) {
    return '';
  }
  return `${first} ${line} ${last.split(',')[0]},230 ${first.split(',')[0]},230`;
});

const totalSystemErrorCount = computed(() => {
  return systemErrorTimelinePoints.value.reduce((sum, point) => sum + point.count, 0);
});

const systemSpikeTopOccurrences = computed(() => {
  return (systemSpikeSummary.value?.buckets ?? []).reduce((sum, item) => sum + item.occurrences, 0);
});

const logsSpikeTopOccurrences = computed(() => {
  return (logsSpikeSummary.value?.buckets ?? []).reduce((sum, item) => sum + item.occurrences, 0);
});

function normalizeIntInput(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.floor(parsed);
  if (normalized < min || normalized > max) {
    return fallback;
  }
  return normalized;
}

function toLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function buildSpikeWindowFromPeak() {
  const points = systemErrorTimelinePoints.value;
  if (!points.length) {
    return;
  }

  let peak = points[0];
  for (const point of points) {
    if (point.count > (peak?.count ?? 0)) {
      peak = point;
    }
  }

  if (!peak) {
    return;
  }

  const peakTs = new Date(peak.ts);
  if (Number.isNaN(peakTs.getTime())) {
    return;
  }
  const from = new Date(peakTs.getTime() - 60 * 60 * 1000);
  const to = new Date(peakTs.getTime() + 60 * 60 * 1000);
  systemSpikeFromLocal.value = toLocalDateTimeInput(from.toISOString());
  systemSpikeToLocal.value = toLocalDateTimeInput(to.toISOString());
}

function buildLogsSpikeWindowFromPeak() {
  const points = logsCumulativeChartPoints.value;
  if (!points.length) {
    return;
  }

  let peak = points[0];
  for (const point of points) {
    if (point.generated > (peak?.generated ?? 0)) {
      peak = point;
    }
  }

  if (!peak) {
    return;
  }

  const peakTs = new Date(peak.ts);
  if (Number.isNaN(peakTs.getTime())) {
    return;
  }
  const from = new Date(peakTs.getTime() - 60 * 60 * 1000);
  const to = new Date(peakTs.getTime() + 60 * 60 * 1000);
  logsSpikeFromLocal.value = toLocalDateTimeInput(from.toISOString());
  logsSpikeToLocal.value = toLocalDateTimeInput(to.toISOString());
}

async function loadSystemSpikeSummary() {
  loadingSystemSpikeSummary.value = true;
  reportsError.value = '';
  try {
    const fromDate = new Date(systemSpikeFromLocal.value);
    const toDate = new Date(systemSpikeToLocal.value);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new Error('Please select a valid From and To datetime for spike analysis.');
    }
    if (fromDate >= toDate) {
      throw new Error('Spike analysis window must have From earlier than To.');
    }

    systemSpikeLimit.value = normalizeIntInput(systemSpikeLimit.value, 20, 1, 200);
    systemSpikeSummary.value = await vpsApi.dwhLogCauseSummary({
      from_ts: fromDate.toISOString(),
      to_ts: toDate.toISOString(),
      levels: systemSpikeLevels.value.trim() || undefined,
      limit: systemSpikeLimit.value,
    });
    systemSpikeLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    systemSpikeSummary.value = null;
  } finally {
    loadingSystemSpikeSummary.value = false;
  }
}

async function loadLogsSpikeSummary() {
  loadingLogsSpikeSummary.value = true;
  reportsError.value = '';
  try {
    const fromDate = new Date(logsSpikeFromLocal.value);
    const toDate = new Date(logsSpikeToLocal.value);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new Error('Please select a valid From and To datetime for logs spike analysis.');
    }
    if (fromDate >= toDate) {
      throw new Error('Logs spike window must have From earlier than To.');
    }

    logsSpikeLimit.value = normalizeIntInput(logsSpikeLimit.value, 20, 1, 200);
    logsSpikeSummary.value = await vpsApi.dwhLogCauseSummary({
      from_ts: fromDate.toISOString(),
      to_ts: toDate.toISOString(),
      bot_id: logsFilterBotId.value ?? undefined,
      logger: logsFilterLogger.value.trim() || undefined,
      levels: logsSpikeLevels.value.trim() || undefined,
      limit: logsSpikeLimit.value,
    });
    logsSpikeLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    logsSpikeSummary.value = null;
  } finally {
    loadingLogsSpikeSummary.value = false;
  }
}

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

async function loadSystemErrorsTimeline() {
  loadingSystemTimeline.value = true;
  reportsError.value = '';
  try {
    if (!systemDateFrom.value) systemDateFrom.value = todayStr();
    if (!systemDateTo.value) systemDateTo.value = todayStr();
    const systemDaysComputed = dateFromToDays(systemDateFrom.value);
    const anomalies = await vpsApi.dwhAnomalies(systemDaysComputed, 30);
    const targetAnomalies = anomalies
      .filter((item) => ['error', 'warning'].includes(item.level.toLowerCase()))
      .slice(0, 8);

    if (!targetAnomalies.length) {
      systemErrorTimelinePoints.value = [];
      systemLoaded.value = true;
      return;
    }

    const trends = await Promise.all(
      targetAnomalies.map((item) =>
        vpsApi.dwhAnomalyTrend(item.signature_hash, systemDaysComputed),
      ),
    );

    const bucketMap = new Map<string, number>();
    for (const trend of trends) {
      for (const point of trend) {
        bucketMap.set(point.bucket_ts, (bucketMap.get(point.bucket_ts) ?? 0) + point.occurrences);
      }
    }

    systemErrorTimelinePoints.value = Array.from(bucketMap.entries())
      .map(([at, count]) => ({ ts: at, at: formatDate(at), count }))
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    if (!systemSpikeFromLocal.value || !systemSpikeToLocal.value) {
      buildSpikeWindowFromPeak();
    }

    if (!systemSpikeLoaded.value && systemSpikeFromLocal.value && systemSpikeToLocal.value) {
      await loadSystemSpikeSummary();
    }

    systemLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    systemErrorTimelinePoints.value = [];
  } finally {
    loadingSystemTimeline.value = false;
  }
}

async function loadLogsCumulativeChart() {
  loadingLogsCumulative.value = true;
  reportsError.value = '';
  try {
    if (!logsDateFrom.value) logsDateFrom.value = todayStr();
    if (!logsDateTo.value) logsDateTo.value = todayStr();
    const logsDaysComputed = Math.min(dateFromToDays(logsDateFrom.value), 90);
    const normalizedBotId = Number.isFinite(Number(logsFilterBotId.value))
      ? Math.max(0, Math.floor(Number(logsFilterBotId.value)))
      : 0;
    logsFilterBotId.value = normalizedBotId > 0 ? normalizedBotId : null;

    const rows: DwhLogCumulativePoint[] = await vpsApi.dwhLogsCumulative({
      hours: logsDaysComputed * 24,
      bot_id: normalizedBotId > 0 ? normalizedBotId : undefined,
      logger: logsFilterLogger.value.trim() || undefined,
      level: logsFilterLevel.value.trim().toUpperCase() || undefined,
    });

    logsCumulativeChartPoints.value = rows
      .map((row) => ({
        at: formatDate(row.bucket_ts),
        ts: row.bucket_ts,
        generated: row.log_count,
        cumulative: row.cumulative_count,
      }))
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    if (!logsSpikeFromLocal.value || !logsSpikeToLocal.value) {
      buildLogsSpikeWindowFromPeak();
    }

    if (!logsSpikeLoaded.value && logsSpikeFromLocal.value && logsSpikeToLocal.value) {
      await loadLogsSpikeSummary();
    }

    logsCumulativeLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    logsCumulativeChartPoints.value = [];
  } finally {
    loadingLogsCumulative.value = false;
  }
}

async function ensureDataForSubcategory(subCategory: string) {
  if (subCategory === 'system-errors' && !systemLoaded.value) {
    await loadSystemErrorsTimeline();
    return;
  }
  if (subCategory === 'logs-cumulative' && !logsCumulativeLoaded.value) {
    await loadLogsCumulativeChart();
    return;
  }
}

watch(selectedCategory, () => {
  const firstOption = availableSubCategories.value[0];
  selectedSubCategory.value = firstOption?.value ?? '';
});

watch(
  selectedSubCategory,
  async (next) => {
    reportsError.value = '';
    await ensureDataForSubcategory(next);
  },
  { immediate: true },
);

onMounted(async () => {
  try {
    allManagedBots.value = (await vpsApi.allBots()).filter((b) => b.enabled);
    selectAllBots();
  } catch {
    /* non-critical — filter strip stays hidden */
  }
  await loadReportLayout();
  await ensureDataForSubcategory(selectedSubCategory.value);
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

          <div
            v-if="selectedSubCategory === 'system-errors'"
            class="border border-surface-400 rounded-sm p-4 space-y-3"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">System Errors Timeline (DWH)</h5>
              <div class="flex items-center gap-2">
                <UInput v-model="systemDateFrom" type="date" size="sm" class="w-36" />
                <UInput v-model="systemDateTo" type="date" size="sm" class="w-36" />
                <UButton
                  label="Refresh"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :loading="loadingSystemTimeline"
                  @click="loadSystemErrorsTimeline"
                />
              </div>
            </div>
            <p class="text-sm text-surface-400">
              Total events in selected window: {{ totalSystemErrorCount }}
            </p>
            <div v-if="!systemErrorTimelinePoints.length" class="text-sm text-surface-400">
              {{
                loadingSystemTimeline ? 'Loading timeline...' : 'No error timeline data available.'
              }}
            </div>
            <div v-else class="space-y-3">
              <div
                class="flex flex-wrap items-center justify-between gap-3 text-xs text-surface-400"
              >
                <div class="flex items-center gap-2">
                  <span class="inline-block w-7 h-0.5 bg-red-500" />
                  <span>System errors (Count)</span>
                </div>
                <span>{{ systemChartDateRangeLabel }}</span>
              </div>

              <div class="rounded border border-surface-700 bg-surface-900/40 p-2">
                <svg viewBox="0 0 920 260" class="w-full h-72">
                  <defs>
                    <linearGradient id="systemErrorsAreaGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#ef4444" stop-opacity="0.35" />
                      <stop offset="100%" stop-color="#ef4444" stop-opacity="0.03" />
                    </linearGradient>
                  </defs>
                  <g>
                    <line
                      v-for="(tick, idx) in systemChartYTicks"
                      :key="`sys-y-grid-${idx}`"
                      x1="40"
                      :y1="tick.y"
                      x2="900"
                      :y2="tick.y"
                      stroke="#334155"
                      stroke-width="0.5"
                      stroke-dasharray="3 3"
                    />
                    <text
                      v-for="(tick, idx) in systemChartYTicks"
                      :key="`sys-y-label-${idx}`"
                      x="36"
                      :y="tick.y + 3"
                      text-anchor="end"
                      fill="#94a3b8"
                      font-size="10"
                    >
                      {{ tick.value }}
                    </text>
                  </g>
                  <line x1="40" y1="230" x2="900" y2="230" stroke="#475569" stroke-width="1" />
                  <line x1="40" y1="14" x2="40" y2="230" stroke="#475569" stroke-width="1" />
                  <text x="8" y="24" fill="#94a3b8" font-size="11">Count</text>
                  <text x="450" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">
                    Date / Time
                  </text>
                  <text
                    v-for="(tick, idx) in systemChartXTicks"
                    :key="`sys-x-label-${idx}`"
                    :x="tick.x"
                    y="244"
                    text-anchor="middle"
                    fill="#94a3b8"
                    font-size="10"
                  >
                    {{ tick.label }}
                  </text>
                  <polygon
                    :points="systemChartAreaPolyline"
                    fill="url(#systemErrorsAreaGradient)"
                  />
                  <polyline
                    :points="systemChartPolyline"
                    fill="none"
                    stroke="#ef4444"
                    stroke-width="2"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                  <circle
                    v-for="(point, idx) in systemChartCoordinates"
                    :key="`system-point-${idx}`"
                    :cx="point.x"
                    :cy="point.y"
                    r="5"
                    fill="#fecaca"
                    class="cursor-pointer"
                    @mousemove="
                      showChartTooltip($event, [point.at, `System errors: ${point.count}`])
                    "
                    @mouseleave="hideChartTooltip"
                  >
                    <title>
                      {{ point.at }}
                      {{ `System errors: ${point.count}` }}
                    </title>
                  </circle>
                </svg>
              </div>

              <div class="rounded border border-surface-700 bg-surface-900/40 p-3 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <h6 class="font-semibold">Spike Cause Summary</h6>
                  <div class="flex flex-wrap items-center gap-2">
                    <UInput
                      v-model="systemSpikeFromLocal"
                      type="datetime-local"
                      size="sm"
                      class="w-56"
                    />
                    <UInput
                      v-model="systemSpikeToLocal"
                      type="datetime-local"
                      size="sm"
                      class="w-56"
                    />
                    <UInput
                      v-model="systemSpikeLevels"
                      size="sm"
                      class="w-40"
                      placeholder="Levels"
                    />
                    <UInputNumber
                      v-model="systemSpikeLimit"
                      :min="1"
                      :max="200"
                      size="sm"
                      class="w-16"
                    />
                    <UButton
                      label="Use Peak"
                      size="sm"
                      color="neutral"
                      variant="outline"
                      @click="buildSpikeWindowFromPeak"
                    />
                    <UButton
                      label="Analyze"
                      size="sm"
                      color="neutral"
                      variant="outline"
                      :loading="loadingSystemSpikeSummary"
                      @click="loadSystemSpikeSummary"
                    />
                  </div>
                </div>

                <p class="text-xs text-surface-400">
                  Top repeated log messages for selected window (default levels: ERROR,WARNING).
                  <template v-if="systemSpikeSummary">
                    Window total events: {{ systemSpikeSummary.total_events }}.
                  </template>
                </p>

                <div v-if="!systemSpikeSummary?.buckets?.length" class="text-sm text-surface-400">
                  {{
                    loadingSystemSpikeSummary
                      ? 'Analyzing spike window...'
                      : 'No grouped causes found for this timeframe.'
                  }}
                </div>

                <div v-else class="overflow-x-auto">
                  <table class="w-full text-sm border-collapse">
                    <thead>
                      <tr class="border-b border-surface-600 text-left">
                        <th class="py-2 pe-2">Occurrences</th>
                        <th class="py-2 pe-2">Share</th>
                        <th class="py-2 pe-2">Logger</th>
                        <th class="py-2 pe-2">Level</th>
                        <th class="py-2">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(item, idx) in systemSpikeSummary.buckets"
                        :key="`spike-cause-${idx}`"
                        class="border-b border-surface-700/70 align-top"
                      >
                        <td class="py-2 pe-2 whitespace-nowrap">{{ item.occurrences }}</td>
                        <td class="py-2 pe-2 whitespace-nowrap">
                          {{
                            systemSpikeSummary.total_events
                              ? (
                                  (item.occurrences / systemSpikeSummary.total_events) *
                                  100
                                ).toFixed(1)
                              : '0.0'
                          }}%
                        </td>
                        <td class="py-2 pe-2 whitespace-nowrap">{{ item.logger }}</td>
                        <td class="py-2 pe-2 whitespace-nowrap">{{ item.level }}</td>
                        <td class="py-2 break-words">{{ item.message }}</td>
                      </tr>
                    </tbody>
                    <tfoot>
                      <tr class="border-t border-surface-600">
                        <td class="py-2 pe-2 font-semibold">{{ systemSpikeTopOccurrences }}</td>
                        <td class="py-2 pe-2 text-surface-400" colspan="4">
                          Covered by top causes:
                          {{
                            systemSpikeSummary.total_events
                              ? (
                                  (systemSpikeTopOccurrences / systemSpikeSummary.total_events) *
                                  100
                                ).toFixed(1)
                              : '0.0'
                          }}%
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              <div class="overflow-x-auto">
                <table class="w-full text-sm border-collapse">
                  <thead>
                    <tr class="border-b border-surface-600 text-left">
                      <th class="py-2 pe-2">Time</th>
                      <th class="py-2">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(point, idx) in systemErrorTimelinePoints.slice(-24)"
                      :key="`sys-row-${point.ts}-${idx}`"
                      class="border-b border-surface-700/70 align-top"
                    >
                      <td class="py-2 pe-2 whitespace-nowrap">{{ point.at }}</td>
                      <td class="py-2 whitespace-nowrap">{{ point.count }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div
            v-if="selectedSubCategory === 'logs-cumulative'"
            class="border border-surface-400 rounded-sm p-4 space-y-3"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">Cumulative Logs Generated</h5>
              <div class="flex flex-wrap items-center gap-2">
                <UInput v-model="logsDateFrom" type="date" size="sm" class="w-36" />
                <UInput v-model="logsDateTo" type="date" size="sm" class="w-36" />
                <USelect
                  v-model="logsFilterBotId"
                  :items="botSelectOptions"
                  placeholder="All bots"
                  size="sm"
                  class="w-56"
                />
                <UInput
                  v-model="logsFilterLogger"
                  size="sm"
                  class="w-40"
                  placeholder="Logger (e.g. Printer)"
                />
                <UInput v-model="logsFilterLevel" size="sm" class="w-28" placeholder="Level" />
                <UButton
                  label="Refresh"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :loading="loadingLogsCumulative"
                  @click="loadLogsCumulativeChart"
                />
              </div>
            </div>

            <p class="text-sm text-surface-400">
              <template v-if="logsChartMode === 'hourly'">
                Peak per-hour logs in range: {{ maxLogsCumulativeCount }}
              </template>
              <template v-else>
                Total generated logs in range:
                {{
                  logsCumulativeChartPoints.length
                    ? logsCumulativeChartPoints[logsCumulativeChartPoints.length - 1].cumulative
                    : 0
                }}
              </template>
            </p>

            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm text-surface-400">Chart mode</span>
              <USelect
                v-model="logsChartMode"
                :items="logsChartModeOptions"
                size="sm"
                class="w-40"
              />
            </div>

            <div v-if="!logsCumulativeChartPoints.length" class="text-sm text-surface-400">
              {{
                loadingLogsCumulative
                  ? 'Loading cumulative logs...'
                  : 'No log data available for selected filters.'
              }}
            </div>

            <div v-else class="space-y-3">
              <div
                class="flex flex-wrap items-center justify-between gap-3 text-xs text-surface-400"
              >
                <div class="flex items-center gap-2">
                  <span class="inline-block w-7 h-0.5 bg-[#60a5fa]" />
                  <span>{{ logsChartSeriesLabel }}</span>
                </div>
                <span>{{ logsChartDateRangeLabel }}</span>
              </div>

              <div class="rounded border border-surface-700 bg-surface-900/40 p-2">
                <svg viewBox="0 0 920 260" class="w-full h-72">
                  <defs>
                    <linearGradient id="logsAreaGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.35" />
                      <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.03" />
                    </linearGradient>
                  </defs>
                  <g>
                    <line
                      v-for="(tick, idx) in logsChartYTicks"
                      :key="`y-grid-${idx}`"
                      x1="40"
                      :y1="tick.y"
                      x2="900"
                      :y2="tick.y"
                      stroke="#334155"
                      stroke-width="0.5"
                      stroke-dasharray="3 3"
                    />
                    <text
                      v-for="(tick, idx) in logsChartYTicks"
                      :key="`y-label-${idx}`"
                      x="36"
                      :y="tick.y + 3"
                      text-anchor="end"
                      fill="#94a3b8"
                      font-size="10"
                    >
                      {{ tick.value }}
                    </text>
                  </g>
                  <line x1="40" y1="230" x2="900" y2="230" stroke="#475569" stroke-width="1" />
                  <line x1="40" y1="14" x2="40" y2="230" stroke="#475569" stroke-width="1" />
                  <text x="8" y="24" fill="#94a3b8" font-size="11">Count</text>
                  <text x="450" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">
                    Date / Time
                  </text>
                  <text
                    v-for="(tick, idx) in logsChartXTicks"
                    :key="`x-label-${idx}`"
                    :x="tick.x"
                    y="244"
                    text-anchor="middle"
                    fill="#94a3b8"
                    font-size="10"
                  >
                    {{ tick.label }}
                  </text>
                  <polygon :points="logsChartAreaPolyline" fill="url(#logsAreaGradient)" />
                  <polyline
                    :points="logsChartPolyline"
                    fill="none"
                    stroke="#60a5fa"
                    stroke-width="2"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                  />
                  <circle
                    v-for="(point, idx) in logsChartCoordinates"
                    :key="`chart-point-${idx}`"
                    :cx="point.x"
                    :cy="point.y"
                    r="5"
                    fill="#cbd5e1"
                    class="cursor-pointer"
                    @mousemove="
                      showChartTooltip($event, [
                        point.at,
                        logsChartMode === 'hourly'
                          ? `Generated logs: ${point.generated}`
                          : `Cumulative logs: ${point.cumulative}`,
                      ])
                    "
                    @mouseleave="hideChartTooltip"
                  >
                    <title>
                      {{ point.at }}
                      {{
                        logsChartMode === 'hourly'
                          ? `Generated logs: ${point.generated}`
                          : `Cumulative logs: ${point.cumulative}`
                      }}
                    </title>
                  </circle>
                </svg>
              </div>

              <div class="rounded border border-surface-700 bg-surface-900/40 p-3 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <h6 class="font-semibold">Logs Spike Cause Summary</h6>
                  <div class="flex flex-wrap items-center gap-2">
                    <UInput
                      v-model="logsSpikeFromLocal"
                      type="datetime-local"
                      size="sm"
                      class="w-56"
                    />
                    <UInput
                      v-model="logsSpikeToLocal"
                      type="datetime-local"
                      size="sm"
                      class="w-56"
                    />
                    <UInput v-model="logsSpikeLevels" size="sm" class="w-44" placeholder="Levels" />
                    <UInputNumber
                      v-model="logsSpikeLimit"
                      :min="1"
                      :max="200"
                      size="sm"
                      class="w-16"
                    />
                    <UButton
                      label="Use Peak"
                      size="sm"
                      color="neutral"
                      variant="outline"
                      @click="buildLogsSpikeWindowFromPeak"
                    />
                    <UButton
                      label="Analyze"
                      size="sm"
                      color="neutral"
                      variant="outline"
                      :loading="loadingLogsSpikeSummary"
                      @click="loadLogsSpikeSummary"
                    />
                  </div>
                </div>

                <p class="text-xs text-surface-400">
                  Top repeated log messages for selected logs window. Uses current Bot ID and Logger
                  filters from this report.
                  <template v-if="logsSpikeSummary">
                    Window total events: {{ logsSpikeSummary.total_events }}.
                  </template>
                </p>

                <div v-if="!logsSpikeSummary?.buckets?.length" class="text-sm text-surface-400">
                  {{
                    loadingLogsSpikeSummary
                      ? 'Analyzing logs spike window...'
                      : 'No grouped causes found for this timeframe.'
                  }}
                </div>

                <div v-else class="overflow-x-auto">
                  <table class="w-full text-sm border-collapse">
                    <thead>
                      <tr class="border-b border-surface-600 text-left">
                        <th class="py-2 pe-2">Occurrences</th>
                        <th class="py-2 pe-2">Share</th>
                        <th class="py-2 pe-2">Logger</th>
                        <th class="py-2 pe-2">Level</th>
                        <th class="py-2">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(item, idx) in logsSpikeSummary.buckets"
                        :key="`logs-spike-cause-${idx}`"
                        class="border-b border-surface-700/70 align-top"
                      >
                        <td class="py-2 pe-2 whitespace-nowrap">{{ item.occurrences }}</td>
                        <td class="py-2 pe-2 whitespace-nowrap">
                          {{
                            logsSpikeSummary.total_events
                              ? ((item.occurrences / logsSpikeSummary.total_events) * 100).toFixed(
                                  1,
                                )
                              : '0.0'
                          }}%
                        </td>
                        <td class="py-2 pe-2 whitespace-nowrap">{{ item.logger }}</td>
                        <td class="py-2 pe-2 whitespace-nowrap">{{ item.level }}</td>
                        <td class="py-2 break-words">{{ item.message }}</td>
                      </tr>
                    </tbody>
                    <tfoot>
                      <tr class="border-t border-surface-600">
                        <td class="py-2 pe-2 font-semibold">{{ logsSpikeTopOccurrences }}</td>
                        <td class="py-2 pe-2 text-surface-400" colspan="4">
                          Covered by top causes:
                          {{
                            logsSpikeSummary.total_events
                              ? (
                                  (logsSpikeTopOccurrences / logsSpikeSummary.total_events) *
                                  100
                                ).toFixed(1)
                              : '0.0'
                          }}%
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              <div class="overflow-x-auto">
                <table class="w-full text-sm border-collapse">
                  <thead>
                    <tr class="border-b border-surface-600 text-left">
                      <th class="py-2 pe-2">Time</th>
                      <th class="py-2 pe-2">Generated logs</th>
                      <th class="py-2">Cumulative logs</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(point, idx) in logsCumulativeChartPoints.slice(-24)"
                      :key="`${point.ts}-${idx}`"
                      class="border-b border-surface-700/70 align-top"
                    >
                      <td class="py-2 pe-2 whitespace-nowrap">{{ point.at }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ point.generated }}</td>
                      <td class="py-2 whitespace-nowrap">{{ point.cumulative }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

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
