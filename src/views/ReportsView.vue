<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { timestampms, timestampShort } from '@/utils/formatters/timeformat';
import { vpsApi } from '@/composables/vpsApi';
import type {
  DwhAnomaly,
  DwhCheckpoint,
  DwhIngestionRun,
  DwhIngestionRunResult,
  DwhLogCauseSummary,
  DwhLogCumulativePoint,
  DwhMissedSignal,
  DwhMissedSignalList,
  DwhTrade,
  DwhEntryTagStat,
  DwhEntryTagPerformanceList,
  DwhDcaStat,
  DwhDcaAnalysisList,
} from '@/types/vps';

type ReportCategory = 'system' | 'trades';
type MissedTradeReasonCode =
  | 'deep_dca_block'
  | 'long_disabled'
  | 'time_filter'
  | 'eth_volatility'
  | 'funding_rate_unfavorable'
  | 'funding_rate_too_high'
  | 'funding_rate_too_low'
  | 'funding_rate_guard'
  | 'price_momentum'
  | 'slippage'
  | 'trailing_entry'
  | 'insufficient_data'
  | 'entry_error'
  | 'trade_rejected'
  | 'other';

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

interface IngestTimelinePoint {
  at: string;
  insertedLogs: number;
  addedErrors: number;
  addedStrategyLogs: number;
  botsFailed: number;
  status: DwhIngestionRun['status'];
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
type MissedChartMode = 'cumulative' | 'hourly';
type TrailingChartMetric = 'profit' | 'duration';
type DrillChartMetric = 'profit_pct' | 'profit_abs' | 'duration';

interface ParsedLogEvent {
  eventTs: string;
  at: string;
  level: string;
  logger: string;
  message: string;
  botId: number;
  pair: string;
  reasonCode: MissedTradeReasonCode;
  reason: string;
  details: string | null;
}

interface ReasonSummaryItem {
  reasonCode: MissedTradeReasonCode;
  reason: string;
  count: number;
}

interface BotDisplayMeta {
  vpsName: string;
  containerName: string;
}

type TrailingSide = 'long' | 'short' | 'unknown';

interface TrailingTriggerEvent {
  eventTs: string;
  at: string;
  botId: number;
  pair: string;
  side: TrailingSide;
  profitPct: number | null;
  offsetPct: number | null;
  durationMinutes: number | null;
  startValue: number | null;
  currentValue: number | null;
  lowLimitValue: number | null;
  upLimitValue: number | null;
  tradeId: number | null;
  enteredAt: string | null;
  enteredTs: string | null;
  matchSource: 'none' | 'closed_trail' | 'trade_fallback' | 'rpc_hint' | 'trade_only';
  logger: string;
  message: string;
}

interface TrailingTradeRow {
  tradeId: number;
  tradeDbId: number;
  botId: number;
  pair: string;
  side: TrailingSide;
  enterTag: string | null;
  openDate: string | null;
  closeDate: string | null;
  openRate: number | null;
  closeRate: number | null;
  snapshotProfitPct: number | null;
  snapshotOffsetPct: number | null;
  snapshotDurationMinutes: number | null;
  snapshotStartValue: number | null;
  snapshotCurrentValue: number | null;
  snapshotLowLimitValue: number | null;
  snapshotUpLimitValue: number | null;
  logCount: number;
  matchSource: TrailingTriggerEvent['matchSource'];
  logEntries: TrailingTriggerEvent[];
}

interface RpcTradeHint {
  eventTs: string;
  botId: number;
  pair: string;
  tradeId: number;
}

const MISSED_TRADE_REASON_LABELS: Record<MissedTradeReasonCode, string> = {
  deep_dca_block: 'Deep DCA block',
  long_disabled: 'Long trades disabled',
  time_filter: 'Time filter block',
  eth_volatility: 'ETH volatility block',
  funding_rate_unfavorable: 'Unfavorable funding rate',
  funding_rate_too_high: 'Funding rate too high',
  funding_rate_too_low: 'Funding rate too low',
  funding_rate_guard: 'Funding rate filter',
  price_momentum: 'Insufficient momentum',
  slippage: 'Slippage block',
  trailing_entry: 'Trailing entry conditions',
  insufficient_data: 'Insufficient data',
  entry_error: 'Entry error',
  trade_rejected: 'Trade rejected',
  other: 'Unclassified',
};

const categoryOptions: { value: ReportCategory; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'trades', label: 'Trades' },
];

const subCategoryOptionsByCategory: Record<ReportCategory, ReportOption[]> = {
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
      todo: 'TODO: Add trade search/filter (bot, pair, strategy, etc.) and drill-down view.',
    },
    {
      value: 'missed-trades',
      label: 'Missed trades report',
      todo: 'Missed/rejected trade events parsed from DWH anomaly samples.',
    },
    {
      value: 'trailing-benefit',
      label: 'Trailing entries benefit',
      todo: 'Trailing trigger events with profit/duration summaries from DWH anomaly samples.',
    },
    {
      value: 'signal-outcomes',
      label: 'Signal outcome analysis',
      todo: 'Missed trade signals with 24h price outcome from Bybit — shows what would have happened.',
    },
    // ── Tier 1: high value, pure SQL ──────────────────────────────────────
    {
      value: 'entry-tag-performance',
      label: 'Entry tag performance',
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
      value: 'time-of-day-heatmap',
      label: '📋 Time-of-day heatmap',
      todo: 'TODO: 7×24 grid (weekday × hour) colored by avg profit_ratio. Identify best/worst times to trade. Source: dwh_trades.open_date.',
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

const systemErrorTimelinePoints = ref<TimelinePoint[]>([]);
const dwhIngestTimeline = ref<IngestTimelinePoint[]>([]);
const logsCumulativeChartPoints = ref<LogsCumulativeChartPoint[]>([]);
const missedTradeEvents = ref<ParsedLogEvent[]>([]);
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
const missedChartMode = ref<MissedChartMode>('cumulative');
const trailingChartMetric = ref<TrailingChartMetric>('profit');
const drillChartMetric = ref<DrillChartMetric>('profit_pct');
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function dateFromToDays(dateFrom: string): number {
  const from = new Date(dateFrom + 'T00:00:00');
  const diffMs = Date.now() - from.getTime();
  return Math.max(1, Math.ceil(diffMs / 86400000));
}
function candleBucketMs(eventTs: string): number {
  return Math.floor(new Date(eventTs).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
}
const missedDateFrom = ref(todayStr());
const missedDateTo = ref(todayStr());
const missedFilterBotId = ref<number | null>(null);
const missedFilterPair = ref('');
const missedFilterVps = ref('');
const selectedReasonFilters = ref<MissedTradeReasonCode[]>([]);
const trailingDateFrom = ref(todayStr());
const trailingDateTo = ref(todayStr());
const trailingFilterBotId = ref<number | null>(null);
const trailingFilterTradeId = ref<number | null>(null);
const trailingFilterPair = ref('');
const trailingFilterVps = ref('');
const trailingFilterContainer = ref('');
const trailingFilterSide = ref<'all' | TrailingSide>('all');
const trailingFilterMatchSource = ref<'all' | TrailingTriggerEvent['matchSource']>('all');
const trailingTradeRows = ref<TrailingTradeRow[]>([]);
const trailingExpandedTradeKey = ref<string | null>(null);
const missedExpandedGroupKey = ref<string | null>(null);

// Trade drill-down
const drillDateFrom = ref(todayStr());
const drillDateTo = ref(todayStr());
const drillFilterBotId = ref<number | null>(null);
const drillFilterPair = ref('');
const drillFilterStrategy = ref('');
const drillFilterEntryReason = ref('');
const drillFilterExitReason = ref('');
const drillFilterSide = ref<'all' | 'long' | 'short'>('all');
const drillTrades = ref<import('@/types/vps').DwhTrade[]>([]);
const drillTotal = ref(0);
const drillOffset = ref(0);
const drillPageSize = 100;

// Signal Outcomes state
const signalOutcomes = ref<DwhMissedSignalList | null>(null);
const signalOutcomesDateFrom = ref(daysAgoStr(1));
const signalOutcomesDateTo = ref(todayStr());
const signalOutcomesFilterBotId = ref<number | null>(null);
const signalOutcomesFilterPair = ref('');
const signalOutcomesFilterReason = ref('');
const loadingSignalOutcomes = ref(false);
const loadingParseMissedSignals = ref(false);
const loadingFetchOutcomes = ref(false);
const signalOutcomesLoaded = ref(false);

// Entry Tag Performance state
const entryTagPerformance = ref<DwhEntryTagPerformanceList | null>(null);
const entryTagLoaded = ref(false);
const loadingEntryTag = ref(false);
const entryTagDateFrom = ref(daysAgoStr(30));
const entryTagDateTo = ref(todayStr());
const entryTagFilterBotId = ref<number | null>(null);
const entryTagMinTrades = ref(1);
const entryTagSortCol = ref<'trades' | 'wins' | 'win_rate_pct' | 'avg_profit_pct' | 'avg_duration_hours' | 'total_profit_abs'>('trades');
const entryTagSortAsc = ref(false);

// DCA Analysis state
const dcaAnalysis = ref<DwhDcaAnalysisList | null>(null);
const dcaLoaded = ref(false);
const loadingDca = ref(false);
const dcaDateFrom = ref(daysAgoStr(30));
const dcaDateTo = ref(todayStr());
const dcaFilterBotId = ref<number | null>(null);
const dcaSortCol = ref<'order_count' | 'trades' | 'wins' | 'win_rate_pct' | 'avg_profit_pct' | 'avg_duration_hours' | 'total_profit_abs'>('order_count');
const dcaSortAsc = ref(true);

// Shared filter state for stub (planned) reports — replaced per-report when built
const stubDateFrom = ref(todayStr());
const stubDateTo = ref(todayStr());
const stubFilterBotId = ref<number | null>(null);
const stubFilterPair = ref('');

const loadingSystemTimeline = ref(false);
const loadingSystemSpikeSummary = ref(false);
const loadingIngestTimeline = ref(false);
const loadingLogsCumulative = ref(false);
const loadingLogsSpikeSummary = ref(false);
const loadingMissedTrades = ref(false);
const loadingTrailingBenefit = ref(false);
const loadingDrilldown = ref(false);
const reportsError = ref('');
const systemLoaded = ref(false);
const ingestLoaded = ref(false);
const logsCumulativeLoaded = ref(false);
const missedLoaded = ref(false);
const trailingLoaded = ref(false);
const drillLoaded = ref(false);
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

const availableSubCategories = computed(() => subCategoryOptionsByCategory[selectedCategory.value]);

const selectedSubCategoryDefinition = computed(() => {
  return availableSubCategories.value.find((item) => item.value === selectedSubCategory.value);
});

const logsChartModeOptions: { label: string; value: LogsChartMode }[] = [
  { label: 'Cumulative', value: 'cumulative' },
  { label: 'Per-hour', value: 'hourly' },
];

const logsChartLayout = {
  width: 920,
  height: 260,
  leftPad: 40,
  rightPad: 20,
  topPad: 14,
  bottomPad: 30,
};

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
      const label = Number.isNaN(date.getTime())
        ? point?.at ?? ''
        : timestampShort(date);
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
  return logsChartMode.value === 'hourly' ? 'Generated logs (Count per hour)' : 'Cumulative logs (Count)';
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
      const label = Number.isNaN(date.getTime())
        ? point?.at ?? ''
        : timestampShort(date);
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

// ── Missed Trades Chart ────────────────────────────────────────────────────

interface MissedChartPoint {
  hourKey: string;
  at: string;
  count: number;
  cumulative: number;
}

const missedChartModeOptions: { label: string; value: MissedChartMode }[] = [
  { label: 'Cumulative', value: 'cumulative' },
  { label: 'Per-hour', value: 'hourly' },
];

const missedChartPoints = computed<MissedChartPoint[]>(() => {
  const events = parsedMissedTradeEvents.value;
  if (!events.length) return [];
  const bucketMap = new Map<string, number>();
  for (const ev of events) {
    const key = ev.eventTs.slice(0, 13); // "YYYY-MM-DDTHH"
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

const maxMissedChartCount = computed(() => {
  if (!missedChartPoints.value.length) return 1;
  if (missedChartMode.value === 'hourly') {
    return Math.max(...missedChartPoints.value.map((p) => p.count), 1);
  }
  return Math.max(...missedChartPoints.value.map((p) => p.cumulative), 1);
});

const missedChartSeriesLabel = computed(() => {
  return missedChartMode.value === 'hourly'
    ? 'Missed trades (Count per hour)'
    : 'Missed trades (Cumulative)';
});

const missedChartDateRangeLabel = computed(() => {
  const pts = missedChartPoints.value;
  if (!pts.length) return 'Date / Time: n/a';
  return `Date / Time: ${pts[0]!.at} → ${pts[pts.length - 1]!.at}`;
});

const missedChartPolyline = computed(() => {
  const pts = missedChartPoints.value;
  if (!pts.length) return '';
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(pts.length - 1, 1);
  const maxY = maxMissedChartCount.value;
  return pts
    .map((pt, idx) => {
      const x = leftPad + (idx / denominator) * plotWidth;
      const val = missedChartMode.value === 'hourly' ? pt.count : pt.cumulative;
      const y = topPad + (1 - val / maxY) * plotHeight;
      return `${x},${y}`;
    })
    .join(' ');
});

const missedChartAreaPolyline = computed(() => {
  const line = missedChartPolyline.value;
  if (!line) return '';
  const first = line.split(' ')[0];
  const last = line.split(' ').slice(-1)[0];
  if (!first || !last) return '';
  return `${first} ${line} ${last.split(',')[0]},230 ${first.split(',')[0]},230`;
});

const missedChartCoordinates = computed(() => {
  const pts = missedChartPoints.value;
  if (!pts.length) return [] as { x: number; y: number; at: string; count: number; cumulative: number }[];
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(pts.length - 1, 1);
  const maxY = maxMissedChartCount.value;
  return pts.map((pt, idx) => {
    const x = leftPad + (idx / denominator) * plotWidth;
    const val = missedChartMode.value === 'hourly' ? pt.count : pt.cumulative;
    const y = topPad + (1 - val / maxY) * plotHeight;
    return { x, y, at: pt.at, count: pt.count, cumulative: pt.cumulative };
  });
});

const missedChartYTicks = computed(() => {
  const ticks = 5;
  const maxY = maxMissedChartCount.value;
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const ratio = i / ticks;
    const value = Math.round((1 - ratio) * maxY);
    const y = topPad + ratio * plotHeight;
    return { y, value };
  });
});

const missedChartXTicks = computed(() => {
  const coords = missedChartCoordinates.value;
  if (!coords.length) return [] as { x: number; label: string }[];
  const indexes = new Set<number>([0, Math.floor((coords.length - 1) / 2), coords.length - 1]);
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => ({ x: coords[index]?.x ?? 0, label: coords[index]?.at ?? '' }));
});

// ── End Missed Trades Chart ────────────────────────────────────────────────

const filteredMissedTradeEventsByBotPair = computed(() => {
  const pairNeedle = missedFilterPair.value.trim().toLowerCase();
  const vpsNeedle = missedFilterVps.value.trim().toLowerCase();
  const botFilter = Number(missedFilterBotId.value);
  const botFilterEnabled = Number.isFinite(botFilter) && botFilter > 0;

  return missedTradeEvents.value.filter((event) => {
    const botMatches = !botFilterEnabled || event.botId === botFilter;
    const pairMatches = !pairNeedle || event.pair.toLowerCase().includes(pairNeedle);
    const vpsMatches = !vpsNeedle || getBotVpsName(event.botId).toLowerCase().includes(vpsNeedle);
    return botMatches && pairMatches && vpsMatches;
  });
});

const parsedMissedTradeEvents = computed(() => {
  if (!selectedReasonFilters.value.length) {
    return filteredMissedTradeEventsByBotPair.value;
  }

  const selected = new Set(selectedReasonFilters.value);
  return filteredMissedTradeEventsByBotPair.value.filter((event) => selected.has(event.reasonCode));
});

interface MissedTradeGroup {
  key: string;
  bucketMs: number;
  representative: ParsedLogEvent;
  events: ParsedLogEvent[];
}
const groupedMissedTradeEvents = computed<MissedTradeGroup[]>(() => {
  const groups = new Map<string, MissedTradeGroup>();
  for (const event of parsedMissedTradeEvents.value) {
    const bucket = candleBucketMs(event.eventTs);
    const key = `${event.botId}|${event.pair}|${bucket}`;
    if (!groups.has(key)) groups.set(key, { key, bucketMs: bucket, representative: event, events: [] });
    groups.get(key)!.events.push(event);
  }
  return Array.from(groups.values()).sort((a, b) => b.bucketMs - a.bucketMs);
});

const missedTradeSummaryByReason = computed<ReasonSummaryItem[]>(() => {
  const grouped = new Map<MissedTradeReasonCode, number>();

  for (const event of filteredMissedTradeEventsByBotPair.value) {
    grouped.set(event.reasonCode, (grouped.get(event.reasonCode) ?? 0) + 1);
  }

  return Array.from(grouped.entries()).map(([reasonCode, count]) => ({
    reasonCode,
    reason: MISSED_TRADE_REASON_LABELS[reasonCode],
    count,
  }));
});

const missedTradeReasonButtons = computed<ReasonSummaryItem[]>(() => {
  return missedTradeSummaryByReason.value.filter((item) => item.reasonCode !== 'trailing_entry');
});

const trailingEntryMissCount = computed(() => {
  return filteredMissedTradeEventsByBotPair.value.filter((event) => event.reasonCode === 'trailing_entry').length;
});

const trailingEntryMissPct = computed(() => {
  const total = filteredMissedTradeEventsByBotPair.value.length;
  if (!total) {
    return '0.0';
  }
  return ((trailingEntryMissCount.value / total) * 100).toFixed(1);
});

// Signal Outcomes computed stats
const signalOutcomeItems = computed<DwhMissedSignal[]>(() => signalOutcomes.value?.items ?? []);

const signalOutcomesEvaluated = computed(() =>
  signalOutcomeItems.value.filter((s) => s.outcome_fetched_at !== null && s.fetch_error === null),
);

const signalOutcomesProfitable = computed(() =>
  signalOutcomesEvaluated.value.filter((s) => (s.max_gain_pct ?? 0) >= 7.2),
);

const signalOutcomesProfitablePct = computed(() => {
  const evaluated = signalOutcomesEvaluated.value.length;
  if (!evaluated) return '0.0';
  return ((signalOutcomesProfitable.value.length / evaluated) * 100).toFixed(1);
});

const signalOutcomesPendingCount = computed(() => signalOutcomes.value?.pending_outcomes ?? 0);

// Entry Tag Performance computed
const entryTagItems = computed<DwhEntryTagStat[]>(() => {
  const rows = entryTagPerformance.value?.items ?? [];
  const col = entryTagSortCol.value;
  const asc = entryTagSortAsc.value;
  return [...rows].sort((a, b) => {
    const av = a[col] ?? -Infinity;
    const bv = b[col] ?? -Infinity;
    return asc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
  });
});
const entryTagBestWinRate = computed(() => {
  const rows = entryTagPerformance.value?.items ?? [];
  if (!rows.length) return null;
  return rows.reduce((best, r) => r.win_rate_pct > best.win_rate_pct ? r : best);
});
const entryTagBestAvgProfit = computed(() => {
  const rows = entryTagPerformance.value?.items ?? [];
  if (!rows.length) return null;
  return rows.reduce((best, r) => r.avg_profit_pct > best.avg_profit_pct ? r : best);
});

// DCA Analysis computed
const dcaItems = computed<DwhDcaStat[]>(() => {
  const rows = dcaAnalysis.value?.items ?? [];
  const col = dcaSortCol.value;
  const asc = dcaSortAsc.value;
  return [...rows].sort((a, b) => {
    const av = a[col] ?? -Infinity;
    const bv = b[col] ?? -Infinity;
    return asc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
  });
});
const dcaSingleEntry = computed(() => dcaAnalysis.value?.items.find(r => r.order_count === 1) ?? null);
const dcaMultiEntry = computed(() => {
  const rows = dcaAnalysis.value?.items.filter(r => r.order_count > 1) ?? [];
  if (!rows.length) return null;
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  const totalWins = rows.reduce((s, r) => s + r.wins, 0);
  const totalProfit = rows.reduce((s, r) => s + r.total_profit_abs, 0);
  const avgProfit = rows.reduce((s, r) => s + r.avg_profit_pct * r.trades, 0) / totalTrades;
  return { trades: totalTrades, wins: totalWins, win_rate_pct: totalWins / totalTrades * 100, avg_profit_pct: avgProfit, total_profit_abs: totalProfit };
});

const filteredTrailingTradeRows = computed(() => {
  const pairNeedle = trailingFilterPair.value.trim().toLowerCase();
  const vpsNeedle = trailingFilterVps.value.trim().toLowerCase();
  const containerNeedle = trailingFilterContainer.value.trim().toLowerCase();
  const botFilter = Number(trailingFilterBotId.value);
  const tradeFilter = Number(trailingFilterTradeId.value);
  const botFilterEnabled = Number.isFinite(botFilter) && botFilter > 0;
  const tradeFilterEnabled = Number.isFinite(tradeFilter) && tradeFilter > 0;
  const sideFilter = trailingFilterSide.value;
  const matchSourceFilter = trailingFilterMatchSource.value;

  return trailingTradeRows.value.filter((row) => {
    const botMatches = !botFilterEnabled || row.botId === botFilter;
    const tradeMatches = !tradeFilterEnabled || row.tradeId === tradeFilter;
    const pairMatches = !pairNeedle || row.pair.toLowerCase().includes(pairNeedle);
    const vpsName = getBotVpsName(row.botId).toLowerCase();
    const containerName = getBotContainerName(row.botId).toLowerCase();
    const vpsMatches = !vpsNeedle || vpsName.includes(vpsNeedle);
    const containerMatches = !containerNeedle || containerName.includes(containerNeedle);
    const sideMatches = sideFilter === 'all' || row.side === sideFilter;
    const matchSourceMatches = matchSourceFilter === 'all' || row.matchSource === matchSourceFilter;
    return botMatches && tradeMatches && pairMatches && vpsMatches && containerMatches && sideMatches && matchSourceMatches;
  });
});

const trailingTradeCount = computed(() => filteredTrailingTradeRows.value.length);

const trailingTotalLogCount = computed(() => {
  return filteredTrailingTradeRows.value.reduce((sum, row) => sum + row.logCount, 0);
});

const trailingAvgProfitPct = computed(() => {
  const values = filteredTrailingTradeRows.value
    .map((row) => row.snapshotProfitPct)
    .filter((v): v is number => v !== null);
  if (!values.length) {
    return 'n/a';
  }
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return `${avg.toFixed(2)}%`;
});

const trailingPositiveShare = computed(() => {
  const values = filteredTrailingTradeRows.value
    .map((row) => row.snapshotProfitPct)
    .filter((v): v is number => v !== null);
  if (!values.length) {
    return 'n/a';
  }
  const positives = values.filter((v) => v > 0).length;
  return `${((positives / values.length) * 100).toFixed(1)}%`;
});

const trailingAvgDurationMinutes = computed(() => {
  const values = filteredTrailingTradeRows.value
    .map((row) => row.snapshotDurationMinutes)
    .filter((v): v is number => v !== null);
  if (!values.length) {
    return 'n/a';
  }
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  return `${avg.toFixed(1)} min`;
});

const trailingProfitBuckets = computed(() => {
  const values = filteredTrailingTradeRows.value
    .map((row) => row.snapshotProfitPct)
    .filter((v): v is number => v !== null);

  const total = values.length;
  if (!total) {
    return {
      lossCount: 0,
      nearFlatCount: 0,
      gainCount: 0,
      lossShare: '0.0',
      nearFlatShare: '0.0',
      gainShare: '0.0',
    };
  }

  const lossCount = values.filter((v) => v < 0).length;
  const nearFlatCount = values.filter((v) => v >= 0 && v <= 0.2).length;
  const gainCount = values.filter((v) => v > 0.2).length;

  return {
    lossCount,
    nearFlatCount,
    gainCount,
    lossShare: ((lossCount / total) * 100).toFixed(1),
    nearFlatShare: ((nearFlatCount / total) * 100).toFixed(1),
    gainShare: ((gainCount / total) * 100).toFixed(1),
  };
});

const trailingMatchSourceCounts = computed(() => {
  const counts = { closed_trail: 0, trade_fallback: 0, rpc_hint: 0, trade_only: 0, none: 0 };
  for (const row of filteredTrailingTradeRows.value) {
    counts[row.matchSource]++;
  }
  return counts;
});

// ── Trailing Benefit Chart ─────────────────────────────────────────────────

const trailingChartMetricOptions: { label: string; value: TrailingChartMetric }[] = [
  { label: 'Snapshot Profit %', value: 'profit' },
  { label: 'Duration (min)', value: 'duration' },
];

interface TrailingChartPoint {
  at: string;
  tradeId: number;
  pair: string;
  profit: number | null;
  duration: number | null;
}

const trailingChartPoints = computed<TrailingChartPoint[]>(() => {
  return filteredTrailingTradeRows.value
    .filter((row) => row.openDate !== null)
    .map((row) => ({
      at: row.openDate!,
      tradeId: row.tradeId,
      pair: row.pair,
      profit: row.snapshotProfitPct,
      duration: row.snapshotDurationMinutes,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
});

const trailingChartSeriesLabel = computed(() => {
  return trailingChartMetric.value === 'profit'
    ? 'Snapshot Profit % (per trade, by open date)'
    : 'Duration min (per trade, by open date)';
});

const trailingChartDateRangeLabel = computed(() => {
  const pts = trailingChartPoints.value;
  if (!pts.length) return 'Date / Time: n/a';
  const fmt = (s: string) => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : timestampShort(d);
  };
  return `Date / Time: ${fmt(pts[0]!.at)} → ${fmt(pts[pts.length - 1]!.at)}`;
});

// Y range for the active metric — includes negative values for profit
const trailingChartYRange = computed(() => {
  const pts = trailingChartPoints.value;
  if (!pts.length) return { min: 0, max: 1 };
  const values = pts
    .map((p) => (trailingChartMetric.value === 'profit' ? p.profit : p.duration))
    .filter((v): v is number => v !== null);
  if (!values.length) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Add 10% padding; for profit ensure 0 is visible
  const pad = (max - min) * 0.1 || 0.5;
  return {
    min: trailingChartMetric.value === 'profit' ? Math.min(min - pad, 0) : Math.max(min - pad, 0),
    max: max + pad,
  };
});

const trailingChartYTicks = computed(() => {
  const ticks = 5;
  const { min, max } = trailingChartYRange.value;
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const ratio = i / ticks;
    const value = max - ratio * (max - min);
    const y = topPad + ratio * plotHeight;
    const label =
      trailingChartMetric.value === 'profit'
        ? `${value >= 0 ? '' : ''}${value.toFixed(1)}%`
        : value.toFixed(0);
    return { y, value, label };
  });
});

// Zero-line Y position (only relevant for profit metric)
const trailingChartZeroY = computed(() => {
  const { min, max } = trailingChartYRange.value;
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  const range = max - min || 1;
  return topPad + ((max - 0) / range) * plotHeight;
});

const trailingChartCoordinates = computed(() => {
  const pts = trailingChartPoints.value;
  if (!pts.length) return [] as { x: number; y: number; at: string; tradeId: number; pair: string; value: number | null; positive: boolean }[];
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(pts.length - 1, 1);
  const { min, max } = trailingChartYRange.value;
  const range = max - min || 1;
  return pts.map((pt, idx) => {
    const rawVal = trailingChartMetric.value === 'profit' ? pt.profit : pt.duration;
    const val = rawVal ?? min; // place nulls at bottom
    const x = leftPad + (idx / denominator) * plotWidth;
    const y = topPad + ((max - val) / range) * plotHeight;
    const at = (() => { const d = new Date(pt.at); return Number.isNaN(d.getTime()) ? pt.at : timestampShort(d); })();
    return { x, y, at, tradeId: pt.tradeId, pair: pt.pair, value: rawVal, positive: (rawVal ?? 0) >= 0 };
  });
});

const trailingChartXTicks = computed(() => {
  const coords = trailingChartCoordinates.value;
  if (!coords.length) return [] as { x: number; label: string }[];
  const indexes = new Set<number>([0, Math.floor((coords.length - 1) / 2), coords.length - 1]);
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => ({ x: coords[index]?.x ?? 0, label: coords[index]?.at ?? '' }));
});

// ── End Trailing Benefit Chart ─────────────────────────────────────────────

// ── Trade Drill-down Chart ─────────────────────────────────────────────────

const drillChartMetricOptions: { label: string; value: DrillChartMetric }[] = [
  { label: 'Profit %', value: 'profit_pct' },
  { label: 'Profit USDT', value: 'profit_abs' },
  { label: 'Duration (min)', value: 'duration' },
];

function tradeDurationMinutes(trade: import('@/types/vps').DwhTrade): number | null {
  if (!trade.open_date || !trade.close_date) return null;
  const diff = new Date(trade.close_date).getTime() - new Date(trade.open_date).getTime();
  return diff > 0 ? diff / 60000 : null;
}

const drillChartSeriesLabel = computed(() => {
  if (drillChartMetric.value === 'profit_pct') return 'Profit % (per trade, by close date)';
  if (drillChartMetric.value === 'profit_abs') return 'Profit USDT (per trade, by close date)';
  return 'Duration min (per trade, by close date)';
});

const drillChartDateRangeLabel = computed(() => {
  const trades = drillTrades.value;
  if (!trades.length) return 'Date / Time: n/a';
  const sorted = [...trades].sort((a, b) => (a.close_date ?? a.open_date ?? '').localeCompare(b.close_date ?? b.open_date ?? ''));
  const fmt = (s: string | null) => {
    if (!s) return '?';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : timestampShort(d);
  };
  return `Date / Time: ${fmt(sorted[0]?.close_date ?? sorted[0]?.open_date ?? null)} → ${fmt(sorted[sorted.length - 1]?.close_date ?? sorted[sorted.length - 1]?.open_date ?? null)}`;
});

const drillChartYRange = computed(() => {
  const trades = drillTrades.value;
  if (!trades.length) return { min: 0, max: 1 };
  const values = trades
    .map((t) => {
      if (drillChartMetric.value === 'profit_pct') return t.profit_ratio !== null ? t.profit_ratio * 100 : null;
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
    let label = '';
    if (drillChartMetric.value === 'profit_pct') label = `${value.toFixed(1)}%`;
    else if (drillChartMetric.value === 'profit_abs') label = value.toFixed(2);
    else label = value.toFixed(0);
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
  const trades = drillTrades.value;
  if (!trades.length) return [] as { x: number; y: number; at: string; tradeId: number; pair: string; value: number | null; positive: boolean }[];
  const sorted = [...trades].sort((a, b) => (a.close_date ?? a.open_date ?? '').localeCompare(b.close_date ?? b.open_date ?? ''));
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(sorted.length - 1, 1);
  const { min, max } = drillChartYRange.value;
  const range = max - min || 1;
  return sorted.map((trade, idx) => {
    let rawVal: number | null = null;
    if (drillChartMetric.value === 'profit_pct') rawVal = trade.profit_ratio !== null ? trade.profit_ratio * 100 : null;
    else if (drillChartMetric.value === 'profit_abs') rawVal = trade.profit_abs;
    else rawVal = tradeDurationMinutes(trade);
    const val = rawVal ?? min;
    const x = leftPad + (idx / denominator) * plotWidth;
    const y = topPad + ((max - val) / range) * plotHeight;
    const dateStr = trade.close_date ?? trade.open_date ?? '';
    const d = new Date(dateStr);
    const at = Number.isNaN(d.getTime()) ? dateStr : timestampShort(d);
    return { x, y, at, tradeId: trade.source_trade_id, pair: trade.pair ?? '?', value: rawVal, positive: (rawVal ?? 0) >= 0 };
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

// ── End Trade Drill-down Chart ─────────────────────────────────────────────

function reasonSharePct(count: number): string {
  const total = filteredMissedTradeEventsByBotPair.value.length;
  if (!total) {
    return '0.0';
  }
  return ((count / total) * 100).toFixed(1);
}

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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return timestampms(date);
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

function classifyMissedTradeReason(message: string): {
  reasonCode: MissedTradeReasonCode;
  reason: string;
} {
  const loweredMessage = message.toLowerCase();
  if (
    loweredMessage.includes('blocking new entry') ||
    loweredMessage.includes('blocking new trades:') ||
    loweredMessage.includes('deep dca')
  ) {
    return {
      reasonCode: 'deep_dca_block',
      reason: MISSED_TRADE_REASON_LABELS.deep_dca_block,
    };
  }
  if (loweredMessage.includes('can_long is disabled') || loweredMessage.includes('long trade rejected')) {
    return {
      reasonCode: 'long_disabled',
      reason: MISSED_TRADE_REASON_LABELS.long_disabled,
    };
  }
  if (loweredMessage.includes('time filter active') || loweredMessage.includes('due to unfavorable time')) {
    return {
      reasonCode: 'time_filter',
      reason: MISSED_TRADE_REASON_LABELS.time_filter,
    };
  }
  if (loweredMessage.includes('eth volatility too high')) {
    return {
      reasonCode: 'eth_volatility',
      reason: MISSED_TRADE_REASON_LABELS.eth_volatility,
    };
  }
  if (loweredMessage.includes('insufficient price momentum')) {
    return {
      reasonCode: 'price_momentum',
      reason: MISSED_TRADE_REASON_LABELS.price_momentum,
    };
  }
  if (
    loweredMessage.includes('slippage too high') ||
    loweredMessage.includes('bad slippage') ||
    loweredMessage.includes('rejecting short stoploss exit') ||
    loweredMessage.includes('rejecting long stoploss exit')
  ) {
    return {
      reasonCode: 'slippage',
      reason: MISSED_TRADE_REASON_LABELS.slippage,
    };
  }
  if (
    loweredMessage.includes('start trailing long') ||
    loweredMessage.includes('start trailing short') ||
    loweredMessage.includes('stop trailing long') ||
    loweredMessage.includes('stop trailing short') ||
    loweredMessage.includes('update trailing long') ||
    loweredMessage.includes('update trailing short') ||
    loweredMessage.includes('trailing long for') ||
    loweredMessage.includes('trailing short for') ||
    loweredMessage.includes('triggering long') ||
    loweredMessage.includes('triggering short') ||
    loweredMessage.includes('price too high') ||
    loweredMessage.includes('price too low') ||
    loweredMessage.includes('offset returned none')
  ) {
    return {
      reasonCode: 'trailing_entry',
      reason: MISSED_TRADE_REASON_LABELS.trailing_entry,
    };
  }
  if (loweredMessage.includes('unfavorable funding rate')) {
    return {
      reasonCode: 'funding_rate_unfavorable',
      reason: MISSED_TRADE_REASON_LABELS.funding_rate_unfavorable,
    };
  }
  if (loweredMessage.includes('funding rate too high')) {
    return {
      reasonCode: 'funding_rate_too_high',
      reason: MISSED_TRADE_REASON_LABELS.funding_rate_too_high,
    };
  }
  if (loweredMessage.includes('funding rate too low')) {
    return {
      reasonCode: 'funding_rate_too_low',
      reason: MISSED_TRADE_REASON_LABELS.funding_rate_too_low,
    };
  }
  if (loweredMessage.includes('funding rate')) {
    return {
      reasonCode: 'funding_rate_guard',
      reason: MISSED_TRADE_REASON_LABELS.funding_rate_guard,
    };
  }
  if (loweredMessage.includes('insufficient data')) {
    return {
      reasonCode: 'insufficient_data',
      reason: MISSED_TRADE_REASON_LABELS.insufficient_data,
    };
  }
  if (loweredMessage.includes('entry confirmation error') || loweredMessage.includes('confirm_trade_entry error')) {
    return {
      reasonCode: 'entry_error',
      reason: MISSED_TRADE_REASON_LABELS.entry_error,
    };
  }
  if (loweredMessage.includes('trade rejected')) {
    return {
      reasonCode: 'trade_rejected',
      reason: MISSED_TRADE_REASON_LABELS.trade_rejected,
    };
  }
  return {
    reasonCode: 'other',
    reason: MISSED_TRADE_REASON_LABELS.other,
  };
}

function extractPair(message: string): string {
  const pairMatch = message.match(/for\s+([A-Z0-9]+\/[A-Z0-9]+(?::[A-Z0-9]+)?)/i);
  return pairMatch?.[1] ?? 'n/a';
}

function extractDecisionDetails(message: string): string | null {
  const loweredMessage = message.toLowerCase();
  const percentCompareMatch = message.match(/(-?\d+(?:\.\d+)?)%\s*([<>])\s*(-?\d+(?:\.\d+)?)%/);
  if (percentCompareMatch && loweredMessage.includes('funding rate')) {
    const comparator = percentCompareMatch[2] === '<' ? 'below' : 'above';
    return `Funding rate ${percentCompareMatch[1]}% ${comparator} limit ${percentCompareMatch[3]}%`;
  }

  if (loweredMessage.includes('blocking new entry') || loweredMessage.includes('blocking new trades:')) {
    const dcaPairMatch = message.match(/:\s*([A-Z0-9]+\/[A-Z0-9]+(?::[A-Z0-9]+)?)\s+has\s+(\d+)\s+DCA.*?total entries:\s*(\d+)/i);
    if (dcaPairMatch) {
      return `${dcaPairMatch[1]} has ${dcaPairMatch[2]} DCA (${dcaPairMatch[3]} entries)`;
    }
    return 'Existing trade reached deep DCA level';
  }

  if (loweredMessage.includes('can_long is disabled')) {
    return 'Long entries disabled (can_long=false)';
  }

  if (loweredMessage.includes('time filter active') || loweredMessage.includes('due to unfavorable time')) {
    const timeMatch = message.match(/on\s+(\w+)\s+due to unfavorable time:\s*(\d{2}):?\w*/i);
    if (timeMatch) {
      return `${timeMatch[1]} ${timeMatch[2]}:XX UTC`;
    }
    return 'Day/time filter window active';
  }

  if (loweredMessage.includes('eth volatility too high')) {
    const ethMatch = message.match(/(\d+(?:\.\d+)?)%\s*>\s*(\d+(?:\.\d+)?)%\s*\(over\s*(\d+)h\)/i);
    if (ethMatch) {
      return `ETH vol ${ethMatch[1]}% > ${ethMatch[2]}% (${ethMatch[3]}h)`;
    }
    return 'ETH volatility exceeded threshold';
  }

  if (loweredMessage.includes('insufficient price momentum')) {
    const momentumMatch = message.match(/(\d+(?:\.\d+)?)%\s*<\s*(\d+(?:\.\d+)?)%\s*over\s*(\d+)\s*candles/i);
    if (momentumMatch) {
      return `Momentum ${momentumMatch[1]}% below threshold ${momentumMatch[2]}% over ${momentumMatch[3]} candles`;
    }
    return 'Price momentum below configured threshold';
  }

  if (loweredMessage.includes('slippage too high') || loweredMessage.includes('bad slippage')) {
    const slippageMatch = message.match(/slippage\s+([0-9]+(?:\.[0-9]+)?)%\s*>?=\s*([0-9]+(?:\.[0-9]+)?)%/i);
    if (slippageMatch) {
      return `Slippage ${slippageMatch[1]}% exceeded limit ${slippageMatch[2]}%`;
    }
    return 'Slippage exceeded configured limit';
  }

  if (loweredMessage.includes('start trailing long') || loweredMessage.includes('start trailing short')) {
    const priceMatch = message.match(/at\s+(\d+(?:\.\d+)?)/);
    const side = loweredMessage.includes('trailing long') ? 'long' : 'short';
    return priceMatch ? `Start trailing ${side} @ ${priceMatch[1]}` : `Start trailing ${side}`;
  }
  if (loweredMessage.includes('stop trailing long') || loweredMessage.includes('stop trailing short')) {
    const side = loweredMessage.includes('trailing long') ? 'long' : 'short';
    if (loweredMessage.includes('offset returned none')) {
      return `Stop trailing ${side}: offset=None`;
    }
    if (loweredMessage.includes('above max stop') || loweredMessage.includes('below max stop')) {
      return `Stop trailing ${side}: price beyond max stop`;
    }
    return `Stop trailing ${side}`;
  }
  if (loweredMessage.includes('update trailing long') || loweredMessage.includes('update trailing short')) {
    const side = loweredMessage.includes('trailing long') ? 'long' : 'short';
    return `Update trailing ${side} limit`;
  }
  if (loweredMessage.includes('triggering long') || loweredMessage.includes('triggering short')) {
    const side = loweredMessage.includes('triggering long') ? 'long' : 'short';
    const profitMatch = message.match(/\((-?\d+(?:\.\d+)?)\s*%\)/);
    return profitMatch ? `Trailing ${side} triggered (${profitMatch[1]}%)` : `Trailing ${side} triggered`;
  }
  if (loweredMessage.includes('trailing long for') || loweredMessage.includes('trailing short for')) {
    const side = loweredMessage.includes('trailing long') ? 'long' : 'short';
    const profitMatch = message.match(/Profit:\s*(-?\d+(?:\.\d+)?)%/i);
    return profitMatch ? `Trailing ${side} status (${profitMatch[1]}%)` : `Trailing ${side} status`;
  }
  if (loweredMessage.includes('price too high') || loweredMessage.includes('price too low')) {
    return 'Trailing: price outside entry range';
  }
  if (loweredMessage.includes('offset returned none')) {
    return 'Trailing stopped: offset=None';
  }

  const match = message.match(/(-?\d+(?:\.\d+)?)%\s*<\s*(-?\d+(?:\.\d+)?)%/);
  if (match) {
    return `Funding rate ${match[1]}% below limit ${match[2]}%`;
  }

  if (loweredMessage.includes('insufficient data')) {
    return 'Not enough candle data for analysis';
  }

  if (loweredMessage.includes('entry confirmation error') || loweredMessage.includes('confirm_trade_entry error')) {
    const errMatch = message.match(/error.*?:\s*(.*)$/i);
    const errMsg = errMatch?.[1]?.trim();
    return errMsg ? `Error: ${errMsg}` : 'Exception in entry confirmation';
  }

  if (loweredMessage.includes('trade rejected')) {
    const reasonMatch = message.match(/trade rejected.*?:\s*(.*)$/i);
    const extractedReason = reasonMatch?.[1]?.trim();
    return extractedReason ? `Rejected: ${extractedReason}` : 'Trade rejected';
  }

  if (loweredMessage.includes('funding rate')) {
    return 'Funding-rate related guard triggered';
  }

  return null;
}

function formatMissedTradeMessage(message: string): string {
  const loweredMessage = message.toLowerCase();
  const match = message.match(/(-?\d+(?:\.\d+)?)%\s*([<>])\s*(-?\d+(?:\.\d+)?)%/);
  if (match && loweredMessage.includes('funding rate')) {
    return `FR: ${match[1]}% , Threshold: ${match[3]}%`;
  }
  return message;
}

function parseLabeledNumber(message: string, label: string): number | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = message.match(new RegExp(`${escapedLabel}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)\\s*%?`, 'i'));
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDurationMinutes(message: string): number | null {
  const durationMatch = message.match(/duration\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?/i);
  if (!durationMatch) {
    return null;
  }
  const value = Number(durationMatch[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  const unit = (durationMatch[2] ?? '').toLowerCase();
  if (unit.startsWith('h')) {
    return value * 60;
  }
  if (unit.startsWith('s')) {
    return value / 60;
  }
  return value;
}

function extractTrailingSide(message: string): TrailingSide {
  const loweredMessage = message.toLowerCase();
  if (loweredMessage.includes('triggering long') || loweredMessage.includes('trailing long')) {
    return 'long';
  }
  if (loweredMessage.includes('triggering short') || loweredMessage.includes('trailing short')) {
    return 'short';
  }
  return 'unknown';
}

function extractPairFlexible(message: string): string {
  const directPair = extractPair(message);
  if (directPair !== 'n/a') {
    return directPair;
  }
  const genericPairMatch = message.match(/([A-Z0-9]+\/[A-Z0-9]+(?::[A-Z0-9]+)?)/i);
  return genericPairMatch?.[1] ?? 'n/a';
}

function normalizePairForMatch(pair: string | null | undefined): string {
  if (!pair) {
    return '';
  }
  return pair.trim().toLowerCase();
}

function simplifyPairForMatch(pair: string | null | undefined): string {
  return normalizePairForMatch(pair).split(':')[0] ?? '';
}

function isTrailEnterTag(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.endsWith('_trail') || normalized.includes('_trail_') || normalized.includes('trail');
}

function parseTradeIdFromMessage(message: string): number | null {
  const match = message.match(/trade_id['"]?\s*[:=]\s*(\d+)/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRpcTradeHints(samplesBySignature: Array<Array<{ event_ts: string; bot_id: number; message: string }>>): RpcTradeHint[] {
  const hints: RpcTradeHint[] = [];
  for (const samples of samplesBySignature) {
    for (const sample of samples) {
      const loweredMessage = sample.message.toLowerCase();
      if (!loweredMessage.includes('trade_id') || !loweredMessage.includes('pair')) {
        continue;
      }
      if (!/['"]type['"]\s*:\s*['"]?entry['"]?/i.test(sample.message)) {
        continue;
      }
      const tradeId = parseTradeIdFromMessage(sample.message);
      const pair = extractPairFlexible(sample.message);
      if (!tradeId || pair === 'n/a') {
        continue;
      }
      hints.push({
        eventTs: sample.event_ts,
        botId: sample.bot_id,
        pair,
        tradeId,
      });
    }
  }
  return hints;
}

async function loadRpcTradeHints(days: number): Promise<RpcTradeHint[]> {
  const anomalies = await vpsApi.dwhAnomalies(days, 500);
  const rpcSignatures = anomalies
    .filter(
      (item) =>
        item.logger.toLowerCase().includes('freqtrade.rpc.rpc_manager') ||
        item.signature.toLowerCase().includes('sending rpc message'),
    )
    .slice(0, 40);

  if (!rpcSignatures.length) {
    return [];
  }

  const rpcSamples = await Promise.all(rpcSignatures.map((item) => vpsApi.dwhAnomalySamples(item.signature_hash, 80)));
  const hints = buildRpcTradeHints(rpcSamples);
  const dedupe = new Map<string, RpcTradeHint>();
  for (const hint of hints) {
    dedupe.set(`${hint.tradeId}|${hint.botId}|${normalizePairForMatch(hint.pair)}|${hint.eventTs}`, hint);
  }
  return Array.from(dedupe.values());
}

function matchTrailingEventRpcTradeHint(event: TrailingTriggerEvent, rpcHints: RpcTradeHint[]): TrailingTriggerEvent {
  const eventTs = new Date(event.eventTs).getTime();
  if (!Number.isFinite(eventTs)) {
    return event;
  }

  const normalizedPair = normalizePairForMatch(event.pair);
  const simplifiedPair = simplifyPairForMatch(event.pair);

  let bestHint: RpcTradeHint | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const hint of rpcHints) {
    if (hint.botId !== event.botId) {
      continue;
    }
    const hintPairNorm = normalizePairForMatch(hint.pair);
    const samePair = hintPairNorm === normalizedPair || simplifyPairForMatch(hint.pair) === simplifiedPair;
    if (!samePair) {
      continue;
    }

    const hintTs = new Date(hint.eventTs).getTime();
    if (!Number.isFinite(hintTs)) {
      continue;
    }
    const deltaMs = hintTs - eventTs;
    if (deltaMs < -5 * 60 * 1000 || deltaMs > 20 * 60 * 1000) {
      continue;
    }

    const score = Math.abs(deltaMs) + (deltaMs < 0 ? 4_000 : 0);
    if (score < bestScore) {
      bestScore = score;
      bestHint = hint;
    }
  }

  if (!bestHint) {
    return event;
  }

  return {
    ...event,
    tradeId: bestHint.tradeId,
    enteredTs: bestHint.eventTs,
    enteredAt: formatDate(bestHint.eventTs),
    matchSource: 'rpc_hint',
  };
}

function indexTradesByBotPair(trades: DwhTrade[]): Map<string, DwhTrade[]> {
  const mapped = new Map<string, DwhTrade[]>();
  for (const trade of trades) {
    const normalizedPair = normalizePairForMatch(trade.pair);
    if (!normalizedPair) {
      continue;
    }
    const key = `${trade.bot_id}|${normalizedPair}`;
    const bucket = mapped.get(key) ?? [];
    bucket.push(trade);
    mapped.set(key, bucket);
  }

  for (const [key, bucket] of mapped.entries()) {
    bucket.sort((a, b) => {
      const aTs = a.open_date ? new Date(a.open_date).getTime() : 0;
      const bTs = b.open_date ? new Date(b.open_date).getTime() : 0;
      return aTs - bTs;
    });
    mapped.set(key, bucket);
  }

  return mapped;
}

function pickClosestTradeByTime(eventTs: string, trades: DwhTrade[]): DwhTrade | null {
  const eventTime = new Date(eventTs).getTime();
  if (!Number.isFinite(eventTime)) {
    return null;
  }

  const futureCandidates = trades
    .filter((trade) => {
      if (!trade.open_date) {
        return false;
      }
      const tradeTime = new Date(trade.open_date).getTime();
      if (!Number.isFinite(tradeTime)) {
        return false;
      }
      const deltaMs = tradeTime - eventTime;
      return deltaMs >= 0 && deltaMs <= 12 * 60 * 60 * 1000;
    })
    .sort((a, b) => {
      const aTs = a.open_date ? new Date(a.open_date).getTime() : Number.POSITIVE_INFINITY;
      const bTs = b.open_date ? new Date(b.open_date).getTime() : Number.POSITIVE_INFINITY;
      return aTs - bTs;
    });

  if (futureCandidates.length) {
    return futureCandidates[0] ?? null;
  }

  const recentPastCandidates = trades
    .filter((trade) => {
      if (!trade.open_date) {
        return false;
      }
      const tradeTime = new Date(trade.open_date).getTime();
      if (!Number.isFinite(tradeTime)) {
        return false;
      }
      const deltaMs = tradeTime - eventTime;
      return deltaMs < 0 && deltaMs >= -10 * 60 * 1000;
    })
    .sort((a, b) => {
      const aTs = a.open_date ? new Date(a.open_date).getTime() : 0;
      const bTs = b.open_date ? new Date(b.open_date).getTime() : 0;
      return bTs - aTs;
    });

  return recentPastCandidates[0] ?? null;
}

function matchTrailingEventTrade(event: TrailingTriggerEvent, tradeIndex: Map<string, DwhTrade[]>): TrailingTriggerEvent {
  const normalizedPair = normalizePairForMatch(event.pair);
  const simplifiedPair = simplifyPairForMatch(event.pair);
  const directKey = `${event.botId}|${normalizedPair}`;

  let candidateTrades = tradeIndex.get(directKey) ?? [];
  if (!candidateTrades.length && simplifiedPair) {
    candidateTrades = Array.from(tradeIndex.entries())
      .filter(([key]) => key.startsWith(`${event.botId}|`) && simplifyPairForMatch(key.split('|')[1]) === simplifiedPair)
      .flatMap(([, trades]) => trades);
  }

  const matchedTrade = pickClosestTradeByTime(event.eventTs, candidateTrades);
  if (!matchedTrade) {
    return {
      ...event,
      tradeId: null,
      enteredAt: null,
      enteredTs: null,
      matchSource: 'none',
    };
  }

  return {
    ...event,
    tradeId: matchedTrade.source_trade_id,
    enteredTs: matchedTrade.open_date,
    enteredAt: matchedTrade.open_date ? formatDate(matchedTrade.open_date) : null,
    matchSource: 'trade_fallback',
  };
}

async function loadTrailingTrades(days: number): Promise<DwhTrade[]> {
  const pageSize = 500;
  const maxRows = 2000;
  const collected: DwhTrade[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total && collected.length < maxRows) {
    const page = await vpsApi.dwhTrades({
      days,
      limit: pageSize,
      offset,
    });
    total = page.total;
    if (!page.items.length) {
      break;
    }
    collected.push(...page.items);
    offset += page.items.length;
    if (page.items.length < pageSize) {
      break;
    }
  }

  return collected;
}

function isTrailingTriggerMessage(loweredMessage: string): boolean {
  if (loweredMessage.includes('update trailing ')) {
    return false;
  }
  return (
    loweredMessage.includes('trailing short for ') ||
    loweredMessage.includes('trailing long for ') ||
    loweredMessage.includes('triggering long') ||
    loweredMessage.includes('triggering short') ||
    loweredMessage.includes('price ok for ')
  );
}

function parseTrailingTriggerEvent(sample: {
  event_ts: string;
  bot_id: number;
  logger: string;
  message: string;
}): TrailingTriggerEvent {
  return {
    eventTs: sample.event_ts,
    at: formatDate(sample.event_ts),
    botId: sample.bot_id,
    pair: extractPairFlexible(sample.message),
    side: extractTrailingSide(sample.message),
    profitPct: parseLabeledNumber(sample.message, 'Profit'),
    offsetPct: parseLabeledNumber(sample.message, 'Offset'),
    durationMinutes: parseDurationMinutes(sample.message),
    startValue: parseLabeledNumber(sample.message, 'Start'),
    currentValue: parseLabeledNumber(sample.message, 'Current'),
    lowLimitValue: parseLabeledNumber(sample.message, 'Lowlimit'),
    upLimitValue: parseLabeledNumber(sample.message, 'Uplimit'),
    tradeId: null,
    enteredAt: null,
    enteredTs: null,
    matchSource: 'none',
    logger: sample.logger,
    message: sample.message,
  };
}

async function fetchTrailingAuditLogs(
  botIds: number[],
  hours: number,
): Promise<Array<{ event_ts: string; bot_id: number; logger: string; message: string }>> {
  const keywords = ['trailing', 'triggering', 'Price OK'];
  const pageLimit = 500;

  async function fetchPages(botId: number, keyword: string) {
    const collected: Array<{ event_ts: string; bot_id: number; logger: string; message: string }> = [];
    let offset = 0;
    for (;;) {
      const result = await vpsApi.dwhAuditMessages({
        hours,
        bot_id: botId,
        logger: 'Printer',
        q: keyword,
        limit: pageLimit,
        offset,
      });
      for (const msg of result.items) {
        collected.push({
          event_ts: msg.event_ts,
          bot_id: msg.bot_id,
          logger: msg.logger,
          message: msg.message,
        });
      }
      offset += result.items.length;
      if (result.items.length < pageLimit || offset >= result.total) {
        break;
      }
    }
    return collected;
  }

  const tasks = botIds.flatMap((botId) =>
    keywords.map((keyword) => fetchPages(botId, keyword)),
  );
  const results = await Promise.all(tasks);
  return results.flat();
}

function pickSnapshotLog(
  logs: TrailingTriggerEvent[],
  tradeOpenDate: string | null,
): TrailingTriggerEvent | null {
  if (!logs.length) {
    return null;
  }
  if (!tradeOpenDate) {
    return logs[logs.length - 1] ?? null;
  }
  const openTime = new Date(tradeOpenDate).getTime();
  if (!Number.isFinite(openTime)) {
    return logs[logs.length - 1] ?? null;
  }
  let best: TrailingTriggerEvent | null = null;
  for (const log of logs) {
    const logTime = new Date(log.eventTs).getTime();
    if (Number.isFinite(logTime) && logTime <= openTime) {
      best = log;
    }
  }
  return best ?? logs[0] ?? null;
}

function determineBestMatchSource(
  logs: TrailingTriggerEvent[],
): TrailingTriggerEvent['matchSource'] {
  const priority: Record<TrailingTriggerEvent['matchSource'], number> = {
    closed_trail: 4,
    trade_fallback: 3,
    rpc_hint: 2,
    trade_only: 1,
    none: 0,
  };
  let best: TrailingTriggerEvent['matchSource'] = 'none';
  for (const log of logs) {
    if (priority[log.matchSource] > priority[best]) {
      best = log.matchSource;
    }
  }
  return best;
}

function isStrategyUserDenyMessage(loweredMessage: string): boolean {
  return (
    loweredMessage.includes('user denied entry') ||
    loweredMessage.includes('entry denied by strategy/user rule') ||
    loweredMessage.includes('strategy/user deny') ||
    loweredMessage.includes('strategy_user_deny')
  );
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

function isReasonSelected(reasonCode: MissedTradeReasonCode): boolean {
  return selectedReasonFilters.value.includes(reasonCode);
}

function toggleReasonFilter(reasonCode: MissedTradeReasonCode) {
  if (isReasonSelected(reasonCode)) {
    selectedReasonFilters.value = selectedReasonFilters.value.filter((item) => item !== reasonCode);
    return;
  }
  selectedReasonFilters.value = [...selectedReasonFilters.value, reasonCode];
}

function clearMissedTradeFilters() {
  missedDateFrom.value = todayStr();
  missedDateTo.value = todayStr();
  missedFilterBotId.value = null;
  missedFilterPair.value = '';
  missedFilterVps.value = '';
  selectedReasonFilters.value = [];
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
      targetAnomalies.map((item) => vpsApi.dwhAnomalyTrend(item.signature_hash, systemDaysComputed)),
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

function mapRunResult(run: DwhIngestionRun): DwhIngestionRunResult {
  return run.result ?? {
    bots_scanned: 0,
    bots_synced: 0,
    bots_failed: 0,
    inserted_trades: 0,
    updated_trades: 0,
    inserted_orders: 0,
    updated_orders: 0,
    inserted_log_events: 0,
    inserted_error_logs: 0,
    inserted_strategy_logs: 0,
    log_rows_scanned: 0,
    high_volume_warning: false,
    updated_anomalies: 0,
    errors: [],
  };
}

async function loadDwhIngestTimeline() {
  loadingIngestTimeline.value = true;
  reportsError.value = '';
  try {
    const runs = await vpsApi.dwhIngestionRuns(20);
    dwhIngestTimeline.value = runs.map((run) => {
      const result = mapRunResult(run);
      return {
        at: formatDate(run.started_at),
        insertedLogs: result.inserted_log_events,
        addedErrors: result.inserted_error_logs,
        addedStrategyLogs: result.inserted_strategy_logs,
        botsFailed: result.bots_failed,
        status: run.status,
      };
    });
    ingestLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    dwhIngestTimeline.value = [];
  } finally {
    loadingIngestTimeline.value = false;
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

function isMissedTradeMessage(loweredText: string): boolean {
  if (loweredText.includes('[ok]')) {
    return false;
  }
  // Exclude tick-by-tick trailing debug logs (massive volume, not actionable)
  if (
    loweredText.includes('update trailing long') ||
    loweredText.includes('update trailing short') ||
    (loweredText.includes('trailing long for') && loweredText.includes('duration:')) ||
    (loweredText.includes('trailing short for') && loweredText.includes('duration:'))
  ) {
    return false;
  }
  return (
    loweredText.includes('trade rejected') ||
    loweredText.includes('blocking new entry') ||
    loweredText.includes('blocking new trades:') ||
    loweredText.includes('can_long is disabled') ||
    loweredText.includes('time filter active') ||
    loweredText.includes('due to unfavorable time') ||
    loweredText.includes('eth volatility too high') ||
    loweredText.includes('insufficient price momentum') ||
    loweredText.includes('slippage too high') ||
    loweredText.includes('bad slippage') ||
    loweredText.includes('start trailing long') ||
    loweredText.includes('start trailing short') ||
    loweredText.includes('stop trailing long') ||
    loweredText.includes('stop trailing short') ||
    loweredText.includes('triggering long') ||
    loweredText.includes('triggering short') ||
    loweredText.includes('price too high') ||
    loweredText.includes('price too low') ||
    loweredText.includes('funding rate') ||
    loweredText.includes('unfavorable funding') ||
    loweredText.includes('insufficient data') ||
    loweredText.includes('entry confirmation error')
  );
}

function isMissedTradeSignature(item: DwhAnomaly): boolean {
  const text = `${item.signature} ${item.logger}`.toLowerCase();
  if (isStrategyUserDenyMessage(text)) {
    return false;
  }
  return isMissedTradeMessage(text);
}

async function loadMissedTradesReport() {
  loadingMissedTrades.value = true;
  missedExpandedGroupKey.value = null;
  reportsError.value = '';
  try {
    await ensureBotDisplayMapLoaded();
    if (!missedDateFrom.value) missedDateFrom.value = todayStr();
    if (!missedDateTo.value) missedDateTo.value = todayStr();

    const samples = await vpsApi.dwhMissedTrades(missedDateFrom.value, missedDateTo.value, 2000);

    const dedupe = new Map<string, ParsedLogEvent>();
    for (const sample of samples) {
      const loweredMessage = sample.message.toLowerCase();
      if (isStrategyUserDenyMessage(loweredMessage)) {
        continue;
      }

      const event: ParsedLogEvent = {
        eventTs: sample.event_ts,
        at: formatDate(sample.event_ts),
        level: sample.level,
        logger: sample.logger,
        message: formatMissedTradeMessage(sample.message),
        botId: sample.bot_id,
        pair: extractPair(sample.message),
        ...classifyMissedTradeReason(sample.message),
        details: extractDecisionDetails(sample.message),
      };
      dedupe.set(`${sample.event_ts}|${sample.logger}|${sample.message}`, event);
    }

    missedTradeEvents.value = Array.from(dedupe.values()).sort(
      (a, b) => new Date(b.eventTs).getTime() - new Date(a.eventTs).getTime(),
    );
    selectedReasonFilters.value = selectedReasonFilters.value.filter((reasonCode) =>
      missedTradeSummaryByReason.value.some((item) => item.reasonCode === reasonCode),
    );
    missedLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    missedTradeEvents.value = [];
  } finally {
    loadingMissedTrades.value = false;
  }
}

async function loadSignalOutcomes() {
  loadingSignalOutcomes.value = true;
  reportsError.value = '';
  try {
    signalOutcomes.value = await vpsApi.dwhMissedSignals(
      signalOutcomesDateFrom.value || undefined,
      signalOutcomesDateTo.value || undefined,
      signalOutcomesFilterBotId.value ?? undefined,
      signalOutcomesFilterPair.value || undefined,
      signalOutcomesFilterReason.value || undefined,
    );
    signalOutcomesLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    signalOutcomes.value = null;
  } finally {
    loadingSignalOutcomes.value = false;
  }
}

async function runParseMissedSignals() {
  loadingParseMissedSignals.value = true;
  try {
    await vpsApi.parseMissedSignals();
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

async function loadEntryTagPerformance() {
  loadingEntryTag.value = true;
  reportsError.value = '';
  try {
    entryTagPerformance.value = await vpsApi.dwhEntryTagPerformance(
      entryTagDateFrom.value || undefined,
      entryTagDateTo.value || undefined,
      entryTagFilterBotId.value ?? undefined,
      entryTagMinTrades.value,
    );
    entryTagLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    entryTagPerformance.value = null;
  } finally {
    loadingEntryTag.value = false;
  }
}

async function loadDcaAnalysis() {
  loadingDca.value = true;
  reportsError.value = '';
  try {
    dcaAnalysis.value = await vpsApi.dwhDcaAnalysis(
      dcaDateFrom.value || undefined,
      dcaDateTo.value || undefined,
      dcaFilterBotId.value ?? undefined,
    );
    dcaLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    dcaAnalysis.value = null;
  } finally {
    loadingDca.value = false;
  }
}

function clearTrailingBenefitFilters() {
  trailingDateFrom.value = todayStr();
  trailingDateTo.value = todayStr();
  trailingFilterBotId.value = null;
  trailingFilterTradeId.value = null;
  trailingFilterPair.value = '';
  trailingFilterVps.value = '';
  trailingFilterContainer.value = '';
  trailingFilterSide.value = 'all';
  trailingFilterMatchSource.value = 'all';
  trailingExpandedTradeKey.value = null;
}

function toggleTrailingTradeExpand(botId: number, tradeId: number) {
  const key = `${botId}|${tradeId}`;
  trailingExpandedTradeKey.value = trailingExpandedTradeKey.value === key ? null : key;
}

function isTrailingTradeExpanded(botId: number, tradeId: number): boolean {
  return trailingExpandedTradeKey.value === `${botId}|${tradeId}`;
}

function toggleMissedGroup(key: string) {
  missedExpandedGroupKey.value = missedExpandedGroupKey.value === key ? null : key;
}

function isMissedGroupExpanded(key: string): boolean {
  return missedExpandedGroupKey.value === key;
}

async function loadTrailingBenefitReport() {
  loadingTrailingBenefit.value = true;
  reportsError.value = '';
  try {
    await ensureBotDisplayMapLoaded();
    if (!trailingDateFrom.value) trailingDateFrom.value = todayStr();
    if (!trailingDateTo.value) trailingDateTo.value = todayStr();
    const trailingDaysComputed = dateFromToDays(trailingDateFrom.value);

    // Step 1: Fetch trades FIRST (reversed data flow)
    const allTrades = await loadTrailingTrades(trailingDaysComputed);
    const closedTrailTrades = allTrades.filter(
      (trade) => !trade.is_open && isTrailEnterTag(trade.enter_tag),
    );

    // Step 2: Fetch trailing logs per bot via direct audit message queries
    // (replaces anomaly signature → samples approach for full coverage)
    const uniqueBotIds = [...new Set(closedTrailTrades.map((t) => t.bot_id))];
    const hours = Math.min(trailingDaysComputed * 24, 720);
    const [allAuditMessages, rpcTradeHints] = await Promise.all([
      fetchTrailingAuditLogs(uniqueBotIds, hours),
      loadRpcTradeHints(trailingDaysComputed),
    ]);

    // Step 3: Parse all log messages and match to trades
    const closedTrailTradeIndex = indexTradesByBotPair(closedTrailTrades);
    const tradeIndex = indexTradesByBotPair(allTrades);
    const dedupe = new Map<string, TrailingTriggerEvent>();

    for (const msg of allAuditMessages) {
      const loweredMessage = msg.message.toLowerCase();
      if (!isTrailingTriggerMessage(loweredMessage)) {
        continue;
      }
      const parsedEvent = parseTrailingTriggerEvent(msg);
      const closedTrailMatchedRaw = matchTrailingEventTrade(parsedEvent, closedTrailTradeIndex);
      const closedTrailMatched =
        closedTrailMatchedRaw.tradeId === null
          ? closedTrailMatchedRaw
          : { ...closedTrailMatchedRaw, matchSource: 'closed_trail' as const };
      const broadTradeMatched =
        closedTrailMatched.tradeId === null
          ? matchTrailingEventTrade(closedTrailMatched, tradeIndex)
          : closedTrailMatched;
      const event =
        broadTradeMatched.tradeId === null
          ? matchTrailingEventRpcTradeHint(broadTradeMatched, rpcTradeHints)
          : broadTradeMatched;
      dedupe.set(`${msg.event_ts}|${msg.logger}|${msg.message}`, event);
    }
    const allLogEvents = Array.from(dedupe.values());

    // Step 4: Group log events by trade key
    const logsByTradeKey = new Map<string, TrailingTriggerEvent[]>();
    for (const event of allLogEvents) {
      if (event.tradeId !== null) {
        const key = `${event.botId}|${event.tradeId}`;
        const bucket = logsByTradeKey.get(key) ?? [];
        bucket.push(event);
        logsByTradeKey.set(key, bucket);
      }
    }
    for (const bucket of logsByTradeKey.values()) {
      bucket.sort((a, b) => new Date(a.eventTs).getTime() - new Date(b.eventTs).getTime());
    }

    // Step 5: Build TrailingTradeRow[] from closed _trail trades
    const rows: TrailingTradeRow[] = closedTrailTrades.map((trade) => {
      const key = `${trade.bot_id}|${trade.source_trade_id}`;
      const logs = logsByTradeKey.get(key) ?? [];
      const snapshot = pickSnapshotLog(logs, trade.open_date);

      return {
        tradeId: trade.source_trade_id,
        tradeDbId: trade.id,
        botId: trade.bot_id,
        pair: trade.pair ?? 'n/a',
        side: trade.is_short === true ? 'short' : trade.is_short === false ? 'long' : 'unknown',
        enterTag: trade.enter_tag,
        openDate: trade.open_date,
        closeDate: trade.close_date,
        openRate: trade.open_rate,
        closeRate: trade.close_rate,
        snapshotProfitPct: snapshot?.profitPct ?? null,
        snapshotOffsetPct: snapshot?.offsetPct ?? null,
        snapshotDurationMinutes: snapshot?.durationMinutes ?? null,
        snapshotStartValue: snapshot?.startValue ?? null,
        snapshotCurrentValue: snapshot?.currentValue ?? null,
        snapshotLowLimitValue: snapshot?.lowLimitValue ?? null,
        snapshotUpLimitValue: snapshot?.upLimitValue ?? null,
        logCount: logs.length,
        matchSource: logs.length > 0 ? determineBestMatchSource(logs) : 'trade_only',
        logEntries: logs,
      };
    });

    rows.sort((a, b) => {
      const aTs = a.openDate ? new Date(a.openDate).getTime() : 0;
      const bTs = b.openDate ? new Date(b.openDate).getTime() : 0;
      return bTs - aTs;
    });

    trailingTradeRows.value = rows;
    trailingLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    trailingTradeRows.value = [];
  } finally {
    loadingTrailingBenefit.value = false;
  }
}

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
  } catch {
    drillTrades.value = [];
    drillTotal.value = 0;
  } finally {
    loadingDrilldown.value = false;
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
  if (subCategory === 'missed-trades' && !missedLoaded.value) {
    await loadMissedTradesReport();
    return;
  }
  if (subCategory === 'trailing-benefit' && !trailingLoaded.value) {
    await loadTrailingBenefitReport();
    return;
  }
  if (subCategory === 'trade-drilldown' && !drillLoaded.value) {
    await loadDrilldownReport();
  }
}

watch(selectedCategory, () => {
  const firstOption = availableSubCategories.value[0];
  selectedSubCategory.value = firstOption?.value ?? '';
});

watch(
  selectedSubCategory,
  async (next) => {
    await ensureDataForSubcategory(next);
  },
  { immediate: true },
);

onMounted(async () => {
  await ensureDataForSubcategory(selectedSubCategory.value);
});
</script>

<template>
  <div class="mx-auto mt-3 p-4 w-[98vw] max-w-[98vw] flex flex-col gap-4">
    <Card>
      <template #title>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span>Reports</span>
          <Button label="Reports Admin" />
        </div>
      </template>
      <template #content>
        <div class="flex flex-col gap-4">
          <div class="flex flex-wrap gap-3">
            <div class="flex flex-col gap-1 min-w-52">
              <label class="text-sm">Category</label>
              <Select
                v-model="selectedCategory"
                :options="categoryOptions"
                option-label="label"
                option-value="value"
                size="small"
              />
            </div>

            <div class="flex flex-col gap-1 min-w-64">
              <label class="text-sm">Sub category</label>
              <Select
                v-model="selectedSubCategory"
                :options="availableSubCategories"
                option-label="label"
                option-value="value"
                size="small"
              />
            </div>
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
                <InputText v-model="systemDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="systemDateTo" type="date" size="small" class="w-36" />
                <Button
                  label="Refresh"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="loadingSystemTimeline"
                  @click="loadSystemErrorsTimeline"
                />
              </div>
            </div>
            <p class="text-sm text-surface-400">Total events in selected window: {{ totalSystemErrorCount }}</p>
            <div v-if="!systemErrorTimelinePoints.length" class="text-sm text-surface-400">
              {{ loadingSystemTimeline ? 'Loading timeline...' : 'No error timeline data available.' }}
            </div>
            <div v-else class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-surface-400">
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
                  <text x="450" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">Date / Time</text>
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
                  <polygon :points="systemChartAreaPolyline" fill="url(#systemErrorsAreaGradient)" />
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
                    @mousemove="showChartTooltip($event, [point.at, `System errors: ${point.count}`])"
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
                    <InputText v-model="systemSpikeFromLocal" type="datetime-local" size="small" class="w-56" />
                    <InputText v-model="systemSpikeToLocal" type="datetime-local" size="small" class="w-56" />
                    <InputText v-model="systemSpikeLevels" size="small" class="w-40" placeholder="Levels" />
                    <InputNumber v-model="systemSpikeLimit" :min="1" :max="200" size="small" input-class="w-16" />
                    <Button
                      label="Use Peak"
                      size="small"
                      severity="secondary"
                      outlined
                      @click="buildSpikeWindowFromPeak"
                    />
                    <Button
                      label="Analyze"
                      size="small"
                      severity="secondary"
                      outlined
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
                  {{ loadingSystemSpikeSummary ? 'Analyzing spike window...' : 'No grouped causes found for this timeframe.' }}
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
                          {{ systemSpikeSummary.total_events ? ((item.occurrences / systemSpikeSummary.total_events) * 100).toFixed(1) : '0.0' }}%
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
                          Covered by top causes: {{ systemSpikeSummary.total_events ? ((systemSpikeTopOccurrences / systemSpikeSummary.total_events) * 100).toFixed(1) : '0.0' }}%
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
                <InputText v-model="logsDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="logsDateTo" type="date" size="small" class="w-36" />
                <InputNumber
                  v-model="logsFilterBotId"
                  :min="1"
                  size="small"
                  input-class="w-20"
                  placeholder="Bot ID"
                />
                <InputText v-model="logsFilterLogger" size="small" class="w-40" placeholder="Logger (e.g. Printer)" />
                <InputText v-model="logsFilterLevel" size="small" class="w-28" placeholder="Level" />
                <Button
                  label="Refresh"
                  size="small"
                  severity="secondary"
                  outlined
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
                Total generated logs in range: {{ logsCumulativeChartPoints.length ? logsCumulativeChartPoints[logsCumulativeChartPoints.length - 1].cumulative : 0 }}
              </template>
            </p>

            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm text-surface-400">Chart mode</span>
              <Select
                v-model="logsChartMode"
                :options="logsChartModeOptions"
                option-label="label"
                option-value="value"
                size="small"
                class="w-40"
              />
            </div>

            <div v-if="!logsCumulativeChartPoints.length" class="text-sm text-surface-400">
              {{ loadingLogsCumulative ? 'Loading cumulative logs...' : 'No log data available for selected filters.' }}
            </div>

            <div v-else class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-surface-400">
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
                  <text x="450" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">Date / Time</text>
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
                    @mousemove="showChartTooltip($event, [point.at, logsChartMode === 'hourly' ? `Generated logs: ${point.generated}` : `Cumulative logs: ${point.cumulative}`])"
                    @mouseleave="hideChartTooltip"
                  >
                    <title>
                      {{ point.at }}
                      {{ logsChartMode === 'hourly' ? `Generated logs: ${point.generated}` : `Cumulative logs: ${point.cumulative}` }}
                    </title>
                  </circle>
                </svg>
              </div>

              <div class="rounded border border-surface-700 bg-surface-900/40 p-3 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <h6 class="font-semibold">Logs Spike Cause Summary</h6>
                  <div class="flex flex-wrap items-center gap-2">
                    <InputText v-model="logsSpikeFromLocal" type="datetime-local" size="small" class="w-56" />
                    <InputText v-model="logsSpikeToLocal" type="datetime-local" size="small" class="w-56" />
                    <InputText v-model="logsSpikeLevels" size="small" class="w-44" placeholder="Levels" />
                    <InputNumber v-model="logsSpikeLimit" :min="1" :max="200" size="small" input-class="w-16" />
                    <Button
                      label="Use Peak"
                      size="small"
                      severity="secondary"
                      outlined
                      @click="buildLogsSpikeWindowFromPeak"
                    />
                    <Button
                      label="Analyze"
                      size="small"
                      severity="secondary"
                      outlined
                      :loading="loadingLogsSpikeSummary"
                      @click="loadLogsSpikeSummary"
                    />
                  </div>
                </div>

                <p class="text-xs text-surface-400">
                  Top repeated log messages for selected logs window. Uses current Bot ID and Logger filters from this report.
                  <template v-if="logsSpikeSummary">
                    Window total events: {{ logsSpikeSummary.total_events }}.
                  </template>
                </p>

                <div v-if="!logsSpikeSummary?.buckets?.length" class="text-sm text-surface-400">
                  {{ loadingLogsSpikeSummary ? 'Analyzing logs spike window...' : 'No grouped causes found for this timeframe.' }}
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
                          {{ logsSpikeSummary.total_events ? ((item.occurrences / logsSpikeSummary.total_events) * 100).toFixed(1) : '0.0' }}%
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
                          Covered by top causes: {{ logsSpikeSummary.total_events ? ((logsSpikeTopOccurrences / logsSpikeSummary.total_events) * 100).toFixed(1) : '0.0' }}%
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

          <div
            v-if="selectedSubCategory === 'missed-trades'"
            class="border border-surface-400 rounded-sm p-4 space-y-4"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">Missed Trades Report (DWH)</h5>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="missedDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="missedDateTo" type="date" size="small" class="w-36" />
                <InputNumber
                  v-model="missedFilterBotId"
                  :min="1"
                  size="small"
                  input-class="w-20"
                  placeholder="Bot ID"
                />
                <InputText v-model="missedFilterPair" size="small" class="w-40" placeholder="Pair (e.g. JTO/USDT)" />
                <InputText v-model="missedFilterVps" size="small" class="w-32" placeholder="VPS" />
                <Button
                  label="Clear"
                  size="small"
                  severity="secondary"
                  outlined
                  @click="clearMissedTradeFilters"
                />
                <Button
                  label="Refresh"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="loadingMissedTrades"
                  @click="loadMissedTradesReport"
                />
              </div>
            </div>

            <div class="flex flex-wrap gap-2">
              <Button
                :label="`Total events: ${parsedMissedTradeEvents.length}`"
                size="small"
                severity="contrast"
                outlined
                @click="selectedReasonFilters = []"
              />
              <Button
                v-for="item in missedTradeReasonButtons"
                :key="item.reasonCode"
                :label="`${item.reason}: ${item.count} (${reasonSharePct(item.count)}%)`"
                size="small"
                severity="warn"
                :outlined="!isReasonSelected(item.reasonCode)"
                @click="toggleReasonFilter(item.reasonCode)"
              />
              <Button
                :label="`Trailing-entry misses: ${trailingEntryMissCount} (${trailingEntryMissPct}%)`"
                size="small"
                severity="warn"
                :outlined="!isReasonSelected('trailing_entry')"
                @click="toggleReasonFilter('trailing_entry')"
              />
            </div>

            <!-- Missed Trades Chart -->
            <div v-if="parsedMissedTradeEvents.length" class="space-y-1">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-3 text-xs text-surface-400">
                  <span>{{ missedChartSeriesLabel }}</span>
                  <span>{{ missedChartDateRangeLabel }}</span>
                </div>
                <Select
                  v-model="missedChartMode"
                  :options="missedChartModeOptions"
                  option-label="label"
                  option-value="value"
                  size="small"
                  class="w-36"
                />
              </div>
              <svg viewBox="0 0 920 260" class="w-full h-64">
                <defs>
                  <linearGradient id="missedAreaGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.35" />
                    <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.03" />
                  </linearGradient>
                </defs>
                <!-- Y-axis grid lines and labels -->
                <g>
                  <line
                    v-for="(tick, idx) in missedChartYTicks"
                    :key="`mgy-${idx}`"
                    x1="40"
                    :y1="tick.y"
                    x2="900"
                    :y2="tick.y"
                    stroke="#334155"
                    stroke-width="1"
                    stroke-dasharray="4 4"
                  />
                  <text
                    v-for="(tick, idx) in missedChartYTicks"
                    :key="`mty-${idx}`"
                    :x="36"
                    :y="tick.y + 4"
                    text-anchor="end"
                    fill="#94a3b8"
                    font-size="10"
                  >{{ tick.value }}</text>
                </g>
                <!-- Axes -->
                <line x1="40" y1="230" x2="900" y2="230" stroke="#475569" stroke-width="1" />
                <line x1="40" y1="14" x2="40" y2="230" stroke="#475569" stroke-width="1" />
                <!-- Axis labels -->
                <text x="8" y="24" fill="#94a3b8" font-size="11">Count</text>
                <text x="450" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">Date / Time</text>
                <!-- X-axis tick labels -->
                <text
                  v-for="(tick, idx) in missedChartXTicks"
                  :key="`mtx-${idx}`"
                  :x="tick.x"
                  y="245"
                  text-anchor="middle"
                  fill="#94a3b8"
                  font-size="10"
                >{{ tick.label }}</text>
                <!-- Area fill -->
                <polygon :points="missedChartAreaPolyline" fill="url(#missedAreaGradient)" />
                <!-- Line -->
                <polyline
                  :points="missedChartPolyline"
                  fill="none"
                  stroke="#60a5fa"
                  stroke-width="2"
                  stroke-linejoin="round"
                />
                <!-- Interactive hover points -->
                <circle
                  v-for="(point, idx) in missedChartCoordinates"
                  :key="`mc-${idx}`"
                  :cx="point.x"
                  :cy="point.y"
                  r="4"
                  fill="#cbd5e1"
                  class="cursor-pointer"
                  @mousemove="showChartTooltip($event, [point.at, missedChartMode === 'hourly' ? `Missed trades: ${point.count}` : `Cumulative missed: ${point.cumulative}`])"
                  @mouseleave="hideChartTooltip"
                >
                  <title>{{ missedChartMode === 'hourly' ? `Missed trades: ${point.count}` : `Cumulative missed: ${point.cumulative}` }}</title>
                </circle>
              </svg>
            </div>

            <div v-if="!groupedMissedTradeEvents.length" class="text-sm text-surface-400">
              {{ loadingMissedTrades ? 'Loading missed trades...' : 'No missed trade events found.' }}
            </div>

            <div v-else class="overflow-x-auto w-full">
              <table class="w-full text-sm border-collapse">
                <thead>
                  <tr class="border-b border-surface-600 text-left">
                    <th class="py-2 pe-2">Time (candle)</th>
                    <th class="py-2 pe-2">Bot</th>
                    <th class="py-2 pe-2">Pair</th>
                    <th class="py-2 pe-2">Reasons</th>
                    <th class="py-2 pe-2 text-center">Events</th>
                    <th class="py-2 text-center">Show</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="group in groupedMissedTradeEvents" :key="group.key">
                    <!-- Grouped summary row -->
                    <tr class="border-b border-surface-700/70 align-top">
                      <td class="py-2 pe-2 whitespace-nowrap">
                        {{ group.representative.at }}
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">
                        <div class="font-medium">{{ getBotVpsName(group.representative.botId) }}</div>
                        <div class="text-xs text-surface-400">
                          {{ getBotContainerName(group.representative.botId) }} · #{{ group.representative.botId }}
                        </div>
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap font-mono">{{ group.representative.pair }}</td>
                      <td class="py-2 pe-2">
                        <span
                          v-for="rc in [...new Set(group.events.map((e) => e.reasonCode))]"
                          :key="rc"
                          class="inline-block text-xs text-surface-300 bg-surface-700 rounded px-1 me-1 mb-0.5 whitespace-nowrap"
                        >{{ rc }}</span>
                      </td>
                      <td class="py-2 pe-2 text-center whitespace-nowrap text-surface-400 text-xs">
                        {{ group.events.length }}
                      </td>
                      <td class="py-2 text-center">
                        <button
                          class="px-2 py-1 rounded border border-surface-600 text-xs hover:bg-surface-800"
                          @click="toggleMissedGroup(group.key)"
                        >
                          {{ isMissedGroupExpanded(group.key) ? 'Hide' : 'Show' }}
                        </button>
                      </td>
                    </tr>
                    <!-- Expanded detail sub-table -->
                    <tr v-if="isMissedGroupExpanded(group.key)" class="border-b border-surface-800 bg-surface-950/40">
                      <td colspan="6" class="py-3 px-2">
                        <div class="max-h-72 overflow-y-auto">
                          <table class="w-full text-xs border-collapse">
                            <thead>
                              <tr class="border-b border-surface-700 text-left">
                                <th class="py-1 pe-2">Time</th>
                                <th class="py-1 pe-2">Reason code</th>
                                <th class="py-1 pe-2">Reason</th>
                                <th class="py-1 pe-2">Details</th>
                                <th class="py-1">Message</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr
                                v-for="(event, idx) in group.events"
                                :key="`detail-${group.key}-${idx}`"
                                class="border-b border-surface-800/50 align-top"
                              >
                                <td class="py-1 pe-2 whitespace-nowrap">{{ event.at }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ event.reasonCode }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ event.reason }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ event.details ?? '—' }}</td>
                                <td class="py-1 break-words">{{ event.message }}</td>
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
          </div>

          <!-- ============================================================ -->
          <!-- Signal Outcome Analysis                                     -->
          <!-- ============================================================ -->
          <div
            v-if="selectedSubCategory === 'signal-outcomes'"
            class="border border-surface-400 rounded-sm p-4 space-y-4"
          >
            <!-- Header + filters -->
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">Signal Outcome Analysis</h5>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="signalOutcomesDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="signalOutcomesDateTo" type="date" size="small" class="w-36" />
                <InputNumber
                  v-model="signalOutcomesFilterBotId"
                  :min="1"
                  size="small"
                  input-class="w-20"
                  placeholder="Bot ID"
                />
                <InputText
                  v-model="signalOutcomesFilterPair"
                  size="small"
                  class="w-36"
                  placeholder="Pair"
                />
                <InputText
                  v-model="signalOutcomesFilterReason"
                  size="small"
                  class="w-36"
                  placeholder="Reason code"
                />
                <Button
                  label="Load"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="loadingSignalOutcomes"
                  @click="loadSignalOutcomes"
                />
              </div>
            </div>

            <!-- Admin actions -->
            <div class="flex flex-wrap gap-2 text-xs">
              <Button
                label="Parse signals"
                size="small"
                severity="secondary"
                outlined
                :loading="loadingParseMissedSignals"
                title="Scan new log events and store as missed signals"
                @click="runParseMissedSignals"
              />
              <Button
                label="Fetch outcomes"
                size="small"
                severity="secondary"
                outlined
                :loading="loadingFetchOutcomes"
                title="Fetch 24h OHLCV from Bybit for signals older than 24h"
                @click="runFetchOutcomes"
              />
            </div>

            <!-- Summary stats -->
            <div
              v-if="signalOutcomesLoaded && signalOutcomes"
              class="flex flex-wrap gap-3 text-sm"
            >
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
                <div class="text-xs text-surface-400">Would trigger trailing stop (≥7.2%)</div>
              </div>
              <div
                v-if="signalOutcomesPendingCount > 0"
                class="rounded border border-yellow-700 px-3 py-2 min-w-28 text-center"
              >
                <div class="text-lg font-bold text-yellow-400">{{ signalOutcomesPendingCount }}</div>
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
                    <th class="py-2 pe-3">Entry price</th>
                    <th class="py-2 pe-3 text-green-400">Max gain</th>
                    <th class="py-2 pe-3 text-red-400">Max loss</th>
                    <th class="py-2">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="sig in signalOutcomeItems"
                    :key="sig.id"
                    class="border-b border-surface-700/70 align-top"
                  >
                    <td class="py-2 pe-3 whitespace-nowrap">
                      {{ timestampShort(sig.signal_ts) }}
                    </td>
                    <td class="py-2 pe-3 whitespace-nowrap">
                      <div class="font-medium">{{ sig.vps_name ?? `Bot ${sig.bot_id}` }}</div>
                      <div class="text-xs text-surface-400">{{ sig.container_name }} · #{{ sig.bot_id }}</div>
                    </td>
                    <td class="py-2 pe-3 whitespace-nowrap font-mono">{{ sig.pair }}</td>
                    <td class="py-2 pe-3 whitespace-nowrap text-xs text-surface-300">
                      {{ sig.block_reason }}
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
                      <span
                        v-if="sig.max_gain_pct !== null"
                        class="text-green-400"
                      >+{{ sig.max_gain_pct.toFixed(2) }}%</span>
                      <span v-else class="text-surface-500">—</span>
                    </td>
                    <td class="py-2 pe-3 whitespace-nowrap font-mono text-xs">
                      <span
                        v-if="sig.max_loss_pct !== null"
                        class="text-red-400"
                      >{{ sig.max_loss_pct.toFixed(2) }}%</span>
                      <span v-else class="text-surface-500">—</span>
                    </td>
                    <td class="py-2 whitespace-nowrap text-xs">
                      <span
                        v-if="sig.fetch_error"
                        class="text-orange-400"
                        :title="sig.fetch_error"
                      >Error</span>
                      <span
                        v-else-if="sig.outcome_fetched_at === null"
                        class="text-surface-500"
                      >Pending</span>
                      <span
                        v-else-if="(sig.max_gain_pct ?? 0) >= 7.2"
                        class="text-green-400 font-medium"
                      >Win</span>
                      <span
                        v-else
                        class="text-red-400 font-medium"
                      >No trigger</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="signalOutcomes && signalOutcomes.total > signalOutcomeItems.length" class="mt-2 text-xs text-surface-400">
                Showing {{ signalOutcomeItems.length }} of {{ signalOutcomes.total }} signals
              </div>
            </div>
          </div>

          <!-- ============================================================ -->
          <!-- Stub report pages — Tier 1                               -->
          <!-- ============================================================ -->

          <!-- ============================================================ -->
          <!-- Entry Tag Performance                                        -->
          <!-- ============================================================ -->
          <div
            v-if="selectedSubCategory === 'entry-tag-performance'"
            class="border border-surface-400 rounded-sm p-4 space-y-4"
          >
            <!-- Header + filters -->
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">Entry Tag Performance</h5>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="entryTagDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="entryTagDateTo" type="date" size="small" class="w-36" />
                <InputNumber
                  v-model="entryTagFilterBotId"
                  :min="1"
                  size="small"
                  input-class="w-20"
                  placeholder="Bot ID"
                />
                <InputNumber
                  v-model="entryTagMinTrades"
                  :min="1"
                  size="small"
                  input-class="w-20"
                  placeholder="Min trades"
                />
                <Button
                  label="Load"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="loadingEntryTag"
                  @click="loadEntryTagPerformance"
                />
              </div>
            </div>

            <!-- Summary stats -->
            <div
              v-if="entryTagLoaded && entryTagPerformance"
              class="flex flex-wrap gap-3 text-sm"
            >
              <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
                <div class="text-lg font-bold">{{ entryTagPerformance.total_tags }}</div>
                <div class="text-xs text-surface-400">Unique tags</div>
              </div>
              <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
                <div class="text-lg font-bold">{{ entryTagPerformance.items.reduce((s, r) => s + r.trades, 0) }}</div>
                <div class="text-xs text-surface-400">Total trades</div>
              </div>
              <div
                v-if="entryTagBestWinRate"
                class="rounded border border-green-700 px-3 py-2 min-w-36 text-center"
              >
                <div class="text-lg font-bold text-green-400">
                  {{ entryTagBestWinRate.win_rate_pct.toFixed(1) }}%
                </div>
                <div class="text-xs text-surface-400">Best win rate ({{ entryTagBestWinRate.enter_tag ?? 'null' }})</div>
              </div>
              <div
                v-if="entryTagBestAvgProfit"
                class="rounded border border-green-700 px-3 py-2 min-w-36 text-center"
              >
                <div class="text-lg font-bold text-green-400">
                  {{ entryTagBestAvgProfit.avg_profit_pct > 0 ? '+' : '' }}{{ entryTagBestAvgProfit.avg_profit_pct.toFixed(2) }}%
                </div>
                <div class="text-xs text-surface-400">Best avg profit ({{ entryTagBestAvgProfit.enter_tag ?? 'null' }})</div>
              </div>
            </div>

            <!-- Empty state -->
            <div
              v-if="entryTagLoaded && entryTagItems.length === 0"
              class="text-sm text-surface-400 py-4 text-center"
            >
              No closed trades found for the selected filters.
            </div>

            <!-- Table -->
            <div v-if="entryTagItems.length > 0" class="overflow-x-auto w-full">
              <table class="w-full text-sm border-collapse">
                <thead>
                  <tr class="border-b border-surface-600 text-left">
                    <th class="py-2 pe-3">Tag</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="entryTagSortCol === 'trades' ? 'text-primary-400' : ''"
                      @click="entryTagSortCol === 'trades' ? (entryTagSortAsc = !entryTagSortAsc) : ((entryTagSortCol = 'trades'), (entryTagSortAsc = false))"
                    >Trades {{ entryTagSortCol === 'trades' ? (entryTagSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="entryTagSortCol === 'wins' ? 'text-primary-400' : ''"
                      @click="entryTagSortCol === 'wins' ? (entryTagSortAsc = !entryTagSortAsc) : ((entryTagSortCol = 'wins'), (entryTagSortAsc = false))"
                    >Wins {{ entryTagSortCol === 'wins' ? (entryTagSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="entryTagSortCol === 'win_rate_pct' ? 'text-primary-400' : ''"
                      @click="entryTagSortCol === 'win_rate_pct' ? (entryTagSortAsc = !entryTagSortAsc) : ((entryTagSortCol = 'win_rate_pct'), (entryTagSortAsc = false))"
                    >Win rate {{ entryTagSortCol === 'win_rate_pct' ? (entryTagSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="entryTagSortCol === 'avg_profit_pct' ? 'text-primary-400' : ''"
                      @click="entryTagSortCol === 'avg_profit_pct' ? (entryTagSortAsc = !entryTagSortAsc) : ((entryTagSortCol = 'avg_profit_pct'), (entryTagSortAsc = false))"
                    >Avg profit {{ entryTagSortCol === 'avg_profit_pct' ? (entryTagSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="entryTagSortCol === 'avg_duration_hours' ? 'text-primary-400' : ''"
                      @click="entryTagSortCol === 'avg_duration_hours' ? (entryTagSortAsc = !entryTagSortAsc) : ((entryTagSortCol = 'avg_duration_hours'), (entryTagSortAsc = false))"
                    >Avg duration {{ entryTagSortCol === 'avg_duration_hours' ? (entryTagSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 cursor-pointer select-none whitespace-nowrap"
                      :class="entryTagSortCol === 'total_profit_abs' ? 'text-primary-400' : ''"
                      @click="entryTagSortCol === 'total_profit_abs' ? (entryTagSortAsc = !entryTagSortAsc) : ((entryTagSortCol = 'total_profit_abs'), (entryTagSortAsc = false))"
                    >Total profit {{ entryTagSortCol === 'total_profit_abs' ? (entryTagSortAsc ? '↑' : '↓') : '' }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in entryTagItems"
                    :key="row.enter_tag ?? '__null__'"
                    class="border-b border-surface-700/70"
                  >
                    <td class="py-2 pe-3 font-mono text-xs">{{ row.enter_tag ?? '(none)' }}</td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">{{ row.trades }}</td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">{{ row.wins }}</td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">
                      <span :class="row.win_rate_pct >= 50 ? 'text-green-400' : 'text-red-400'">
                        {{ row.win_rate_pct.toFixed(1) }}%
                      </span>
                    </td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">
                      <span :class="row.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'">
                        {{ row.avg_profit_pct >= 0 ? '+' : '' }}{{ row.avg_profit_pct.toFixed(2) }}%
                      </span>
                    </td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">
                      <span v-if="row.avg_duration_hours !== null">{{ row.avg_duration_hours.toFixed(1) }}h</span>
                      <span v-else class="text-surface-500">—</span>
                    </td>
                    <td class="py-2 text-right font-mono text-xs">
                      <span :class="row.total_profit_abs >= 0 ? 'text-green-400' : 'text-red-400'">
                        {{ row.total_profit_abs >= 0 ? '+' : '' }}{{ row.total_profit_abs.toFixed(2) }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="selectedSubCategory === 'exit-reason-distribution'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Exit Reason Distribution</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 1</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="stubFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <InputText v-model="stubFilterPair" size="small" class="w-36" placeholder="Pair" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              Groups closed trades by <code class="bg-surface-700 px-1 rounded">exit_reason</code> and shows count, avg profit %, and % share.
              Answers: <em>how often does the trailing stop fire vs stoploss vs ROI? Are we exiting well?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• Bar chart: exit_reason by count + avg profit</div>
                <div class="text-surface-400">• Pie/donut: % share by exit reason</div>
                <div class="text-surface-400">• Table: reason | count | % share | avg profit% | avg profit abs</div>
                <div class="text-surface-400">• Filter by bot, date range, pair</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• Backend: <code class="bg-surface-800 px-1 rounded">GET /dwh/reports/exit-reason-distribution</code></div>
                <div class="text-surface-400">• Query: <code class="bg-surface-800 px-1 rounded">SELECT exit_reason, COUNT(*), AVG(profit_ratio) FROM dwh_trades WHERE close_date IS NOT NULL GROUP BY exit_reason</code></div>
                <div class="text-surface-400">• Printer.py key exit reasons: trailing_stop_loss, roi, stop_loss, force_sell</div>
                <div class="text-surface-400">• Frontend: table + optional SVG bar chart reusing existing chart patterns</div>
              </div>
            </div>
          </div>

          <div v-if="selectedSubCategory === 'equity-curve'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Equity Curve & Drawdown</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 1</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="stubFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              Plots cumulative <code class="bg-surface-700 px-1 rounded">profit_abs</code> over time per bot, with rolling max drawdown.
              Answers: <em>is each bot growing its account? When were the worst drawdown periods?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• Line chart: cumulative profit_abs over close_date, one line per bot</div>
                <div class="text-surface-400">• Shaded area below line = drawdown depth</div>
                <div class="text-surface-400">• Summary: total PnL, max drawdown, recovery factor per bot</div>
                <div class="text-surface-400">• Bot toggle to show/hide individual lines</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• Backend: return sorted <code class="bg-surface-800 px-1 rounded">(close_date, bot_id, profit_abs)</code> rows</div>
                <div class="text-surface-400">• Frontend: compute running sum + rolling max in JS, then render with SVG polyline (pattern exists in system errors chart)</div>
                <div class="text-surface-400">• Drawdown = (running_max - current) / running_max</div>
                <div class="text-surface-400">• One API call, all bots; group client-side</div>
              </div>
            </div>
          </div>

          <div v-if="selectedSubCategory === 'bot-comparison'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Bot Comparison Dashboard</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 1</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              All bots side-by-side with key performance metrics.
              Answers: <em>which bots are outperforming? Which are dragging down results?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• Table: Bot | VPS | Trades | Trades/day | Win rate | Avg profit% | Total PnL | Avg duration</div>
                <div class="text-surface-400">• Color-coded: green/red for win rate and avg profit</div>
                <div class="text-surface-400">• Sortable columns</div>
                <div class="text-surface-400">• Date range filter</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• Backend: <code class="bg-surface-800 px-1 rounded">SELECT bot_id, COUNT(*), AVG(profit_ratio), SUM(profit_abs), ... FROM dwh_trades GROUP BY bot_id</code></div>
                <div class="text-surface-400">• Join managed_bots + vps_servers for display names</div>
                <div class="text-surface-400">• Frontend: sortable table, stat cards for fleet-level totals</div>
                <div class="text-surface-400">• Reuse <code class="bg-surface-800 px-1 rounded">getBotVpsName / getBotContainerName</code> helpers</div>
              </div>
            </div>
          </div>

          <div v-if="selectedSubCategory === 'pair-performance'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Pair-Level Performance</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 1</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="stubFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <InputText v-model="stubFilterPair" size="small" class="w-36" placeholder="Pair" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              Groups closed trades by <code class="bg-surface-700 px-1 rounded">pair</code> and shows win rate, avg profit, trade count, total abs profit.
              Answers: <em>which pairs are consistently profitable? Which should be removed from the pairlist?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• Table: Pair | trades | win rate | avg profit% | total PnL | avg duration</div>
                <div class="text-surface-400">• Sort by total PnL or win rate</div>
                <div class="text-surface-400">• Filter by bot, date range</div>
                <div class="text-surface-400">• Highlight top 5 / bottom 5 pairs</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• Backend: <code class="bg-surface-800 px-1 rounded">SELECT pair, COUNT(*), SUM(profit_abs), AVG(profit_ratio) FROM dwh_trades WHERE close_date IS NOT NULL GROUP BY pair ORDER BY SUM(profit_abs) DESC</code></div>
                <div class="text-surface-400">• Optional bot_id filter to see per-bot pair performance</div>
                <div class="text-surface-400">• Frontend: sortable table, color-coded PnL column</div>
              </div>
            </div>
          </div>

          <!-- ============================================================ -->
          <!-- Stub report pages — Tier 2                               -->
          <!-- ============================================================ -->

          <div v-if="selectedSubCategory === 'dca-analysis'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <!-- Header + filters -->
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">DCA / Multi-Order Analysis</h5>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="dcaDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="dcaDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="dcaFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <Button
                  label="Load"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="loadingDca"
                  @click="loadDcaAnalysis"
                />
              </div>
            </div>

            <!-- Coverage note -->
            <div v-if="dcaLoaded && dcaAnalysis" class="text-xs text-surface-400">
              {{ dcaAnalysis.trades_with_orders.toLocaleString() }} of {{ dcaAnalysis.total_closed_trades.toLocaleString() }} closed trades have order data
              <span v-if="dcaAnalysis.total_closed_trades > 0">
                ({{ Math.round(dcaAnalysis.trades_with_orders / dcaAnalysis.total_closed_trades * 100) }}% coverage)
              </span>
            </div>

            <!-- Single vs DCA summary cards -->
            <div v-if="dcaLoaded && dcaAnalysis && dcaAnalysis.items.length > 0" class="flex flex-wrap gap-3 text-sm">
              <div v-if="dcaSingleEntry" class="rounded border border-surface-600 px-3 py-2 min-w-40 text-center">
                <div class="text-xs text-surface-400 mb-1">Single entry (1 order)</div>
                <div class="text-lg font-bold">{{ dcaSingleEntry.trades }}</div>
                <div class="text-xs text-surface-400">trades</div>
                <div class="mt-1 font-mono text-sm" :class="dcaSingleEntry.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'">
                  {{ dcaSingleEntry.avg_profit_pct >= 0 ? '+' : '' }}{{ dcaSingleEntry.avg_profit_pct.toFixed(2) }}% avg
                </div>
                <div class="font-mono text-xs" :class="dcaSingleEntry.win_rate_pct >= 50 ? 'text-green-400' : 'text-red-400'">
                  {{ dcaSingleEntry.win_rate_pct.toFixed(1) }}% win rate
                </div>
              </div>
              <div v-if="dcaMultiEntry" class="rounded border border-primary-700 px-3 py-2 min-w-40 text-center">
                <div class="text-xs text-surface-400 mb-1">DCA (2+ orders)</div>
                <div class="text-lg font-bold">{{ dcaMultiEntry.trades }}</div>
                <div class="text-xs text-surface-400">trades</div>
                <div class="mt-1 font-mono text-sm" :class="dcaMultiEntry.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'">
                  {{ dcaMultiEntry.avg_profit_pct >= 0 ? '+' : '' }}{{ dcaMultiEntry.avg_profit_pct.toFixed(2) }}% avg
                </div>
                <div class="font-mono text-xs" :class="dcaMultiEntry.win_rate_pct >= 50 ? 'text-green-400' : 'text-red-400'">
                  {{ dcaMultiEntry.win_rate_pct.toFixed(1) }}% win rate
                </div>
              </div>
              <div
                v-if="dcaSingleEntry && dcaMultiEntry"
                class="rounded border border-surface-600 px-3 py-2 min-w-40 text-center"
              >
                <div class="text-xs text-surface-400 mb-1">DCA vs single edge</div>
                <div
                  class="text-lg font-bold font-mono"
                  :class="dcaMultiEntry.avg_profit_pct - dcaSingleEntry.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'"
                >
                  {{ (dcaMultiEntry.avg_profit_pct - dcaSingleEntry.avg_profit_pct) >= 0 ? '+' : '' }}{{ (dcaMultiEntry.avg_profit_pct - dcaSingleEntry.avg_profit_pct).toFixed(2) }}%
                </div>
                <div class="text-xs text-surface-400">avg profit diff</div>
                <div
                  class="font-mono text-xs"
                  :class="(dcaMultiEntry.win_rate_pct - dcaSingleEntry.win_rate_pct) >= 0 ? 'text-green-400' : 'text-red-400'"
                >
                  {{ (dcaMultiEntry.win_rate_pct - dcaSingleEntry.win_rate_pct) >= 0 ? '+' : '' }}{{ (dcaMultiEntry.win_rate_pct - dcaSingleEntry.win_rate_pct).toFixed(1) }}% win rate diff
                </div>
              </div>
            </div>

            <!-- Empty state -->
            <div
              v-if="dcaLoaded && dcaItems.length === 0"
              class="text-sm text-surface-400 py-4 text-center"
            >
              No closed trades with order data found for the selected filters.
            </div>

            <!-- Table -->
            <div v-if="dcaItems.length > 0" class="overflow-x-auto w-full">
              <table class="w-full text-sm border-collapse">
                <thead>
                  <tr class="border-b border-surface-600 text-left">
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="dcaSortCol === 'order_count' ? 'text-primary-400' : ''"
                      @click="dcaSortCol === 'order_count' ? (dcaSortAsc = !dcaSortAsc) : ((dcaSortCol = 'order_count'), (dcaSortAsc = true))"
                    >Buy orders {{ dcaSortCol === 'order_count' ? (dcaSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="dcaSortCol === 'trades' ? 'text-primary-400' : ''"
                      @click="dcaSortCol === 'trades' ? (dcaSortAsc = !dcaSortAsc) : ((dcaSortCol = 'trades'), (dcaSortAsc = false))"
                    >Trades {{ dcaSortCol === 'trades' ? (dcaSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="dcaSortCol === 'wins' ? 'text-primary-400' : ''"
                      @click="dcaSortCol === 'wins' ? (dcaSortAsc = !dcaSortAsc) : ((dcaSortCol = 'wins'), (dcaSortAsc = false))"
                    >Wins {{ dcaSortCol === 'wins' ? (dcaSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="dcaSortCol === 'win_rate_pct' ? 'text-primary-400' : ''"
                      @click="dcaSortCol === 'win_rate_pct' ? (dcaSortAsc = !dcaSortAsc) : ((dcaSortCol = 'win_rate_pct'), (dcaSortAsc = false))"
                    >Win rate {{ dcaSortCol === 'win_rate_pct' ? (dcaSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="dcaSortCol === 'avg_profit_pct' ? 'text-primary-400' : ''"
                      @click="dcaSortCol === 'avg_profit_pct' ? (dcaSortAsc = !dcaSortAsc) : ((dcaSortCol = 'avg_profit_pct'), (dcaSortAsc = false))"
                    >Avg profit {{ dcaSortCol === 'avg_profit_pct' ? (dcaSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                      :class="dcaSortCol === 'avg_duration_hours' ? 'text-primary-400' : ''"
                      @click="dcaSortCol === 'avg_duration_hours' ? (dcaSortAsc = !dcaSortAsc) : ((dcaSortCol = 'avg_duration_hours'), (dcaSortAsc = false))"
                    >Avg duration {{ dcaSortCol === 'avg_duration_hours' ? (dcaSortAsc ? '↑' : '↓') : '' }}</th>
                    <th
                      class="py-2 cursor-pointer select-none whitespace-nowrap"
                      :class="dcaSortCol === 'total_profit_abs' ? 'text-primary-400' : ''"
                      @click="dcaSortCol === 'total_profit_abs' ? (dcaSortAsc = !dcaSortAsc) : ((dcaSortCol = 'total_profit_abs'), (dcaSortAsc = false))"
                    >Total profit {{ dcaSortCol === 'total_profit_abs' ? (dcaSortAsc ? '↑' : '↓') : '' }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in dcaItems"
                    :key="row.order_count"
                    class="border-b border-surface-700/70"
                    :class="row.order_count === 1 ? 'bg-surface-800/30' : ''"
                  >
                    <td class="py-2 pe-3 font-mono text-xs font-semibold">
                      {{ row.order_count === 1 ? '1 (single)' : row.order_count }}
                    </td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">{{ row.trades }}</td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">{{ row.wins }}</td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">
                      <span :class="row.win_rate_pct >= 50 ? 'text-green-400' : 'text-red-400'">
                        {{ row.win_rate_pct.toFixed(1) }}%
                      </span>
                    </td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">
                      <span :class="row.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'">
                        {{ row.avg_profit_pct >= 0 ? '+' : '' }}{{ row.avg_profit_pct.toFixed(2) }}%
                      </span>
                    </td>
                    <td class="py-2 pe-3 text-right font-mono text-xs">
                      <span v-if="row.avg_duration_hours !== null">{{ row.avg_duration_hours.toFixed(1) }}h</span>
                      <span v-else class="text-surface-500">—</span>
                    </td>
                    <td class="py-2 text-right font-mono text-xs">
                      <span :class="row.total_profit_abs >= 0 ? 'text-green-400' : 'text-red-400'">
                        {{ row.total_profit_abs >= 0 ? '+' : '' }}{{ row.total_profit_abs.toFixed(2) }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="selectedSubCategory === 'trade-duration'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Trade Duration vs Profit</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 2</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="stubFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <InputText v-model="stubFilterPair" size="small" class="w-36" placeholder="Pair" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              Scatter plot of trade duration (hours) vs profit_ratio, colored by exit reason.
              Answers: <em>do short trades outperform long ones? Are long-held trades more likely to stop-loss?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• SVG scatter: x = duration (h), y = profit_ratio, color = exit_reason</div>
                <div class="text-surface-400">• Buckets: &lt;1h | 1–4h | 4–12h | 12–24h | &gt;24h → avg profit per bucket</div>
                <div class="text-surface-400">• Filter by bot, pair, date range, exit reason</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• Backend: return (open_date, close_date, profit_ratio, exit_reason) — duration computed client-side</div>
                <div class="text-surface-400">• <code class="bg-surface-800 px-1 rounded">duration_h = (close_date - open_date).seconds / 3600</code></div>
                <div class="text-surface-400">• Frontend: SVG scatter reusing coordinate system from existing charts</div>
                <div class="text-surface-400">• Color map: trailing_stop=green, stop_loss=red, roi=blue, other=gray</div>
              </div>
            </div>
          </div>

          <div v-if="selectedSubCategory === 'slippage-quality'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Slippage & Fill Quality</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 2</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="stubFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <InputText v-model="stubFilterPair" size="small" class="w-36" placeholder="Pair" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              Compares <code class="bg-surface-700 px-1 rounded">dwh_orders.average</code> (actual fill) vs <code class="bg-surface-700 px-1 rounded">dwh_trades.open_rate</code> (signal price) per pair/bot.
              Answers: <em>are we getting filled near the signal price, or is slippage eating into profits?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• Table: pair | avg slippage% | max slippage% | trade count</div>
                <div class="text-surface-400">• slippage% = (fill_price - signal_price) / signal_price × 100</div>
                <div class="text-surface-400">• Sorted by worst avg slippage</div>
                <div class="text-surface-400">• Alert: pairs with avg slippage &gt; 0.1%</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• Join dwh_orders (ft_order_side='buy', status='closed') with dwh_trades on trade_id</div>
                <div class="text-surface-400">• <code class="bg-surface-800 px-1 rounded">slippage = (orders.average - trades.open_rate) / trades.open_rate</code></div>
                <div class="text-surface-400">• Check dwh_orders has average column populated before building</div>
                <div class="text-surface-400">• Backend aggregation; frontend table only</div>
              </div>
            </div>
          </div>

          <div v-if="selectedSubCategory === 'fee-impact'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Fee Impact</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 2</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="stubFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              Sums <code class="bg-surface-700 px-1 rounded">dwh_orders.fee_base</code> per trade and compares against gross <code class="bg-surface-700 px-1 rounded">profit_abs</code>.
              Answers: <em>what % of gross profit goes to fees? Which bots/pairs pay the most in fees?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• Summary: total fees paid, total gross profit, net efficiency %</div>
                <div class="text-surface-400">• Table: bot | total fees | gross PnL | fee % of profit</div>
                <div class="text-surface-400">• Per-pair breakdown: which pairs cost the most in fees</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• <code class="bg-surface-800 px-1 rounded">SELECT trade_id, SUM(fee_base) FROM dwh_orders GROUP BY trade_id</code></div>
                <div class="text-surface-400">• Join result with dwh_trades.profit_abs</div>
                <div class="text-surface-400">• <code class="bg-surface-800 px-1 rounded">fee_pct = total_fees / (profit_abs + total_fees) × 100</code></div>
                <div class="text-surface-400">• Check fee_base column is populated in dwh_orders before building</div>
              </div>
            </div>
          </div>

          <!-- ============================================================ -->
          <!-- Stub report pages — Tier 3                               -->
          <!-- ============================================================ -->

          <div v-if="selectedSubCategory === 'time-of-day-heatmap'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Time-of-Day Heatmap</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 3</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="stubFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <InputText v-model="stubFilterPair" size="small" class="w-36" placeholder="Pair" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              7×24 grid (weekday × hour UTC) colored by avg <code class="bg-surface-700 px-1 rounded">profit_ratio</code>.
              Answers: <em>are there consistently good or bad times to open trades?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• 7 rows (Mon–Sun) × 24 cols (hours), cell = avg profit% for that slot</div>
                <div class="text-surface-400">• Color scale: dark red (loss) → neutral → dark green (profit)</div>
                <div class="text-surface-400">• Tooltip on hover: avg profit%, trade count</div>
                <div class="text-surface-400">• Filter by bot, pair, date range</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• Backend: <code class="bg-surface-800 px-1 rounded">SELECT EXTRACT(dow FROM open_date), EXTRACT(hour FROM open_date), AVG(profit_ratio), COUNT(*) FROM dwh_trades GROUP BY 1, 2</code></div>
                <div class="text-surface-400">• Frontend: render 7×24 grid of colored divs using Tailwind bg-opacity</div>
                <div class="text-surface-400">• Color = lerp(red, green) based on profit_ratio range</div>
              </div>
            </div>
          </div>

          <div v-if="selectedSubCategory === 'entry-exit-matrix'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Entry Tag × Exit Reason Matrix</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 3</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="stubFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              Pivot table: rows = enter_tag, cols = exit_reason, cells = avg profit_ratio and trade count.
              Answers: <em>which entry tags lead to clean trailing-stop exits vs stop-loss exits?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• Pivot grid: enter_tag rows × exit_reason cols</div>
                <div class="text-surface-400">• Each cell: avg profit% (color coded) + trade count</div>
                <div class="text-surface-400">• Row totals + column totals</div>
                <div class="text-surface-400">• Empty cells = gray (no trades for that combination)</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• Backend: <code class="bg-surface-800 px-1 rounded">SELECT enter_tag, exit_reason, AVG(profit_ratio), COUNT(*) FROM dwh_trades WHERE close_date IS NOT NULL GROUP BY 1, 2</code></div>
                <div class="text-surface-400">• Frontend: pivot client-side — collect unique tags/reasons, build 2D map</div>
                <div class="text-surface-400">• Render as CSS grid or table; color each cell by avg profit</div>
              </div>
            </div>
          </div>

          <div v-if="selectedSubCategory === 'error-trade-correlation'" class="border border-surface-400 rounded-sm p-4 space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <h5 class="font-semibold">Error ↔ Trade Correlation</h5>
                <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded">Tier 3</span>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="stubDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="stubDateTo" type="date" size="small" class="w-36" />
                <InputNumber v-model="stubFilterBotId" :min="1" size="small" input-class="w-20" placeholder="Bot ID" />
                <Button label="Load" size="small" severity="secondary" outlined disabled />
              </div>
            </div>
            <p class="text-sm text-surface-300">
              Correlates anomaly spikes from <code class="bg-surface-700 px-1 rounded">dwh_anomaly_hourly_rollups</code> with missed signals or bad fills in the same time window.
              Answers: <em>when bots log lots of errors, do they also miss more trades or fill worse?</em>
            </p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">What it will show</div>
                <div class="text-surface-400">• Dual-axis timeline: error count (red) + missed signal count (blue) per hour</div>
                <div class="text-surface-400">• Correlation score: Pearson correlation between error rate and missed trade rate</div>
                <div class="text-surface-400">• Highlight hours where both spike together</div>
              </div>
              <div class="rounded border border-surface-700 p-3 space-y-1">
                <div class="font-medium text-surface-200 mb-2">How to build</div>
                <div class="text-surface-400">• Join dwh_anomaly_hourly_rollups with dwh_missed_signals bucketed to the same hour</div>
                <div class="text-surface-400">• Backend: return hourly series of (hour, error_count, missed_count)</div>
                <div class="text-surface-400">• Frontend: dual SVG polyline reusing existing timeline chart pattern</div>
                <div class="text-surface-400">• This report requires both anomaly rollups AND missed_signals to be populated</div>
              </div>
            </div>
          </div>

          <div
            v-if="selectedSubCategory === 'trade-drilldown'"
            class="border border-surface-400 rounded-sm p-4 space-y-4"
          >
            <!-- Header + filters -->
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">Trade Drill-down (DWH)</h5>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="drillDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="drillDateTo" type="date" size="small" class="w-36" />
                <InputNumber
                  v-model="drillFilterBotId"
                  :min="1"
                  size="small"
                  input-class="w-20"
                  placeholder="Bot ID"
                />
                <InputText v-model="drillFilterPair" size="small" class="w-40" placeholder="Pair (e.g. BTC/USDT)" />
                <InputText v-model="drillFilterStrategy" size="small" class="w-36" placeholder="Strategy" />
                <InputText v-model="drillFilterEntryReason" size="small" class="w-36" placeholder="Entry tag" />
                <InputText v-model="drillFilterExitReason" size="small" class="w-36" placeholder="Exit reason" />
                <Select
                  v-model="drillFilterSide"
                  :options="[
                    { label: 'All sides', value: 'all' },
                    { label: 'Long', value: 'long' },
                    { label: 'Short', value: 'short' },
                  ]"
                  option-label="label"
                  option-value="value"
                  size="small"
                  class="w-28"
                />
                <Button label="Clear" size="small" severity="secondary" outlined @click="clearDrilldownFilters" />
                <Button
                  label="Refresh"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="loadingDrilldown"
                  @click="loadDrilldownReport(false)"
                />
              </div>
            </div>

            <!-- Summary tags -->
            <div v-if="drillTrades.length" class="flex flex-wrap gap-2">
              <Tag :value="`Showing: ${drillTrades.length} / ${drillTotal}`" severity="contrast" />
              <Tag
                :value="`Avg profit: ${drillTrades.filter((t) => t.profit_ratio !== null).length ? (drillTrades.reduce((s, t) => s + (t.profit_ratio ?? 0), 0) / drillTrades.filter((t) => t.profit_ratio !== null).length * 100).toFixed(2) + '%' : 'n/a'}`"
                severity="warn"
              />
              <Tag
                :value="`Profitable: ${drillTrades.filter((t) => (t.profit_ratio ?? 0) > 0).length} / ${drillTrades.filter((t) => t.profit_ratio !== null).length}`"
                severity="warn"
              />
              <Tag
                :value="`Total profit: ${drillTrades.reduce((s, t) => s + (t.profit_abs ?? 0), 0).toFixed(2)} USDT`"
                severity="warn"
              />
            </div>

            <!-- Chart -->
            <div v-if="drillTrades.length" class="space-y-1">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-3 text-xs text-surface-400">
                  <span>{{ drillChartSeriesLabel }}</span>
                  <span>{{ drillChartDateRangeLabel }}</span>
                </div>
                <Select
                  v-model="drillChartMetric"
                  :options="drillChartMetricOptions"
                  option-label="label"
                  option-value="value"
                  size="small"
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
                    x1="46" :y1="tick.y" x2="900" :y2="tick.y"
                    stroke="#334155" stroke-width="1" stroke-dasharray="4 4"
                  />
                  <text
                    v-for="(tick, idx) in drillChartYTicks"
                    :key="`dty-${idx}`"
                    :x="42" :y="tick.y + 4"
                    text-anchor="end" fill="#94a3b8" font-size="10"
                  >{{ tick.label }}</text>
                </g>
                <!-- Zero line (profit modes) -->
                <line
                  v-if="drillChartMetric !== 'duration'"
                  x1="46" :y1="drillChartZeroY" x2="900" :y2="drillChartZeroY"
                  stroke="#64748b" stroke-width="1"
                />
                <!-- Axes -->
                <line x1="46" y1="230" x2="900" y2="230" stroke="#475569" stroke-width="1" />
                <line x1="46" y1="14" x2="46" y2="230" stroke="#475569" stroke-width="1" />
                <!-- Axis labels -->
                <text x="8" y="24" fill="#94a3b8" font-size="11">{{ drillChartMetric === 'profit_pct' ? '%' : drillChartMetric === 'profit_abs' ? 'USDT' : 'min' }}</text>
                <text x="473" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">Trade close date</text>
                <!-- X ticks -->
                <text
                  v-for="(tick, idx) in drillChartXTicks"
                  :key="`dtx-${idx}`"
                  :x="tick.x" y="245"
                  text-anchor="middle" fill="#94a3b8" font-size="10"
                >{{ tick.label }}</text>
                <!-- Dots -->
                <circle
                  v-for="(point, idx) in drillChartCoordinates"
                  :key="`dc-${idx}`"
                  :cx="point.x" :cy="point.y" r="4"
                  :fill="point.value === null ? '#475569' : drillChartMetric === 'duration' ? '#60a5fa' : (point.positive ? '#34d399' : '#f87171')"
                  class="cursor-pointer"
                  @mousemove="showChartTooltip($event, [
                    `Trade #${point.tradeId} · ${point.pair}`,
                    point.at,
                    drillChartMetric === 'profit_pct'
                      ? (point.value !== null ? `Profit: ${point.value.toFixed(2)}%` : 'Profit: n/a')
                      : drillChartMetric === 'profit_abs'
                        ? (point.value !== null ? `Profit: ${point.value.toFixed(2)} USDT` : 'Profit: n/a')
                        : (point.value !== null ? `Duration: ${point.value.toFixed(1)} min` : 'Duration: n/a'),
                  ])"
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
                    <th class="py-2 text-right">Anomalies</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="trade in drillTrades"
                    :key="`${trade.bot_id}-${trade.source_trade_id}`"
                    class="border-b border-surface-700/70 align-top"
                  >
                    <td class="py-2 pe-3 whitespace-nowrap">{{ trade.source_trade_id }}</td>
                    <td class="py-2 pe-3 whitespace-nowrap">
                      <div class="font-medium">{{ trade.vps_name ?? '—' }}</div>
                      <div class="text-xs text-surface-400">{{ trade.container_name ?? '—' }} · ID {{ trade.bot_id }}</div>
                    </td>
                    <td class="py-2 pe-3 whitespace-nowrap font-medium">{{ trade.pair ?? '—' }}</td>
                    <td class="py-2 pe-3 whitespace-nowrap">
                      <span :class="trade.is_short ? 'text-red-400' : 'text-green-400'">
                        {{ trade.is_short ? 'Short' : 'Long' }}
                      </span>
                    </td>
                    <td class="py-2 pe-3 whitespace-nowrap text-surface-300">{{ trade.enter_tag ?? '—' }}</td>
                    <td class="py-2 pe-3 whitespace-nowrap text-surface-300">{{ trade.exit_reason ?? (trade.is_open ? 'Open' : '—') }}</td>
                    <td class="py-2 pe-3 whitespace-nowrap text-surface-400">{{ trade.open_date ? formatDate(trade.open_date) : '—' }}</td>
                    <td class="py-2 pe-3 whitespace-nowrap text-surface-400">{{ trade.close_date ? formatDate(trade.close_date) : (trade.is_open ? 'Open' : '—') }}</td>
                    <td class="py-2 pe-3 whitespace-nowrap text-right text-surface-400">
                      {{ tradeDurationMinutes(trade) !== null ? `${tradeDurationMinutes(trade)!.toFixed(0)} min` : '—' }}
                    </td>
                    <td class="py-2 pe-3 whitespace-nowrap text-right font-medium"
                      :class="trade.profit_ratio === null ? 'text-surface-400' : trade.profit_ratio >= 0 ? 'text-green-400' : 'text-red-400'">
                      {{ trade.profit_ratio !== null ? `${(trade.profit_ratio * 100).toFixed(2)}%` : '—' }}
                    </td>
                    <td class="py-2 pe-3 whitespace-nowrap text-right"
                      :class="trade.profit_abs === null ? 'text-surface-400' : trade.profit_abs >= 0 ? 'text-green-400' : 'text-red-400'">
                      {{ trade.profit_abs !== null ? trade.profit_abs.toFixed(3) : '—' }}
                    </td>
                    <td class="py-2 whitespace-nowrap text-right">
                      <span v-if="trade.anomaly_count > 0" class="text-yellow-400 font-medium">{{ trade.anomaly_count }}</span>
                      <span v-else class="text-surface-600">0</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Load more -->
            <div v-if="drillTrades.length && drillTrades.length < drillTotal" class="flex items-center gap-3">
              <Button
                :label="`Load more (${drillTotal - drillTrades.length} remaining)`"
                size="small"
                severity="secondary"
                outlined
                :loading="loadingDrilldown"
                @click="loadDrilldownReport(true)"
              />
            </div>
          </div>

          <div
            v-if="selectedSubCategory === 'trailing-benefit'"
            class="border border-surface-400 rounded-sm p-4 space-y-4"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">Trailing Entries Benefit (DWH)</h5>
              <div class="flex flex-wrap items-center gap-2">
                <InputText v-model="trailingDateFrom" type="date" size="small" class="w-36" />
                <InputText v-model="trailingDateTo" type="date" size="small" class="w-36" />
                <InputNumber
                  v-model="trailingFilterBotId"
                  :min="1"
                  size="small"
                  input-class="w-20"
                  placeholder="Bot ID"
                />
                <InputNumber
                  v-model="trailingFilterTradeId"
                  :min="1"
                  size="small"
                  input-class="w-20"
                  placeholder="Trade ID"
                />
                <InputText v-model="trailingFilterPair" size="small" class="w-40" placeholder="Pair (e.g. BTC/USDT)" />
                <InputText v-model="trailingFilterVps" size="small" class="w-36" placeholder="VPS" />
                <InputText v-model="trailingFilterContainer" size="small" class="w-36" placeholder="Container" />
                <Select
                  v-model="trailingFilterSide"
                  :options="[
                    { label: 'All sides', value: 'all' },
                    { label: 'Long', value: 'long' },
                    { label: 'Short', value: 'short' },
                  ]"
                  option-label="label"
                  option-value="value"
                  size="small"
                  class="w-32"
                />
                <Select
                  v-model="trailingFilterMatchSource"
                  :options="[
                    { label: 'All sources', value: 'all' },
                    { label: 'closed_trail', value: 'closed_trail' },
                    { label: 'trade_fallback', value: 'trade_fallback' },
                    { label: 'rpc_hint', value: 'rpc_hint' },
                    { label: 'trade_only', value: 'trade_only' },
                  ]"
                  option-label="label"
                  option-value="value"
                  size="small"
                  class="w-40"
                />
                <Button
                  label="Clear"
                  size="small"
                  severity="secondary"
                  outlined
                  @click="clearTrailingBenefitFilters"
                />
                <Button
                  label="Refresh"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="loadingTrailingBenefit"
                  @click="loadTrailingBenefitReport"
                />
              </div>
            </div>

            <div class="flex flex-wrap gap-2">
              <Tag :value="`Trades: ${trailingTradeCount}`" severity="contrast" />
              <Tag :value="`Log entries: ${trailingTotalLogCount}`" severity="contrast" />
              <Tag :value="`Avg snapshot profit: ${trailingAvgProfitPct}`" severity="warn" />
              <Tag :value="`Positive profit share: ${trailingPositiveShare}`" severity="warn" />
              <Tag :value="`Avg trailing duration: ${trailingAvgDurationMinutes}`" severity="warn" />
              <Tag
                :value="`Profit <0%: ${trailingProfitBuckets.lossCount} (${trailingProfitBuckets.lossShare}%)`"
                severity="secondary"
              />
              <Tag
                :value="`Profit 0-0.2%: ${trailingProfitBuckets.nearFlatCount} (${trailingProfitBuckets.nearFlatShare}%)`"
                severity="secondary"
              />
              <Tag
                :value="`Profit >0.2%: ${trailingProfitBuckets.gainCount} (${trailingProfitBuckets.gainShare}%)`"
                severity="secondary"
              />
              <Tag
                v-if="trailingMatchSourceCounts.closed_trail"
                :value="`closed_trail: ${trailingMatchSourceCounts.closed_trail}`"
                severity="secondary"
              />
              <Tag
                v-if="trailingMatchSourceCounts.trade_fallback"
                :value="`trade_fallback: ${trailingMatchSourceCounts.trade_fallback}`"
                severity="secondary"
              />
              <Tag
                v-if="trailingMatchSourceCounts.rpc_hint"
                :value="`rpc_hint: ${trailingMatchSourceCounts.rpc_hint}`"
                severity="secondary"
              />
              <Tag
                v-if="trailingMatchSourceCounts.trade_only"
                :value="`trade_only: ${trailingMatchSourceCounts.trade_only}`"
                severity="secondary"
              />
            </div>

            <!-- Trailing Benefit Chart -->
            <div v-if="filteredTrailingTradeRows.length" class="space-y-1">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-3 text-xs text-surface-400">
                  <span>{{ trailingChartSeriesLabel }}</span>
                  <span>{{ trailingChartDateRangeLabel }}</span>
                </div>
                <Select
                  v-model="trailingChartMetric"
                  :options="trailingChartMetricOptions"
                  option-label="label"
                  option-value="value"
                  size="small"
                  class="w-44"
                />
              </div>
              <svg viewBox="0 0 920 260" class="w-full h-64">
                <defs>
                  <linearGradient id="trailingAreaGradientPos" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#34d399" stop-opacity="0.30" />
                    <stop offset="100%" stop-color="#34d399" stop-opacity="0.02" />
                  </linearGradient>
                  <linearGradient id="trailingAreaGradientDur" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.30" />
                    <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.02" />
                  </linearGradient>
                </defs>
                <!-- Y-axis grid lines and labels -->
                <g>
                  <line
                    v-for="(tick, idx) in trailingChartYTicks"
                    :key="`tgy-${idx}`"
                    x1="40"
                    :y1="tick.y"
                    x2="900"
                    :y2="tick.y"
                    stroke="#334155"
                    stroke-width="1"
                    stroke-dasharray="4 4"
                  />
                  <text
                    v-for="(tick, idx) in trailingChartYTicks"
                    :key="`tty-${idx}`"
                    :x="36"
                    :y="tick.y + 4"
                    text-anchor="end"
                    fill="#94a3b8"
                    font-size="10"
                  >{{ tick.label }}</text>
                </g>
                <!-- Zero line (profit mode only) -->
                <line
                  v-if="trailingChartMetric === 'profit'"
                  x1="40"
                  :y1="trailingChartZeroY"
                  x2="900"
                  :y2="trailingChartZeroY"
                  stroke="#64748b"
                  stroke-width="1"
                />
                <!-- Axes -->
                <line x1="40" y1="230" x2="900" y2="230" stroke="#475569" stroke-width="1" />
                <line x1="40" y1="14" x2="40" y2="230" stroke="#475569" stroke-width="1" />
                <!-- Axis labels -->
                <text x="8" y="24" fill="#94a3b8" font-size="11">{{ trailingChartMetric === 'profit' ? '%' : 'min' }}</text>
                <text x="450" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">Trade open date</text>
                <!-- X-axis tick labels -->
                <text
                  v-for="(tick, idx) in trailingChartXTicks"
                  :key="`ttx-${idx}`"
                  :x="tick.x"
                  y="245"
                  text-anchor="middle"
                  fill="#94a3b8"
                  font-size="10"
                >{{ tick.label }}</text>
                <!-- Dots per trade, colored by positive/negative -->
                <circle
                  v-for="(point, idx) in trailingChartCoordinates"
                  :key="`tc-${idx}`"
                  :cx="point.x"
                  :cy="point.y"
                  r="4"
                  :fill="point.value === null ? '#475569' : trailingChartMetric === 'profit' ? (point.positive ? '#34d399' : '#f87171') : '#60a5fa'"
                  class="cursor-pointer"
                  @mousemove="showChartTooltip($event, [
                    `Trade #${point.tradeId} · ${point.pair}`,
                    point.at,
                    trailingChartMetric === 'profit'
                      ? (point.value !== null ? `Profit: ${point.value.toFixed(2)}%` : 'Profit: n/a')
                      : (point.value !== null ? `Duration: ${point.value.toFixed(1)} min` : 'Duration: n/a'),
                  ])"
                  @mouseleave="hideChartTooltip"
                >
                  <title>{{ `Trade #${point.tradeId} · ${point.pair} · ${point.at}` }}</title>
                </circle>
              </svg>
            </div>

            <div v-if="!filteredTrailingTradeRows.length" class="text-sm text-surface-400">
              {{ loadingTrailingBenefit ? 'Loading trailing benefit report...' : 'No trailing trades found for current filters.' }}
            </div>

            <div v-else class="overflow-x-auto w-full">
              <table class="w-full text-sm border-collapse">
                <thead>
                  <tr class="border-b border-surface-600 text-left">
                    <th class="py-2 pe-2">Trade ID</th>
                    <th class="py-2 pe-2">Bot</th>
                    <th class="py-2 pe-2">Pair</th>
                    <th class="py-2 pe-2">Side</th>
                    <th class="py-2 pe-2">Enter tag</th>
                    <th class="py-2 pe-2">Open date</th>
                    <th class="py-2 pe-2">Snapshot Profit %</th>
                    <th class="py-2 pe-2">Offset %</th>
                    <th class="py-2 pe-2">Duration (min)</th>
                    <th class="py-2 pe-2">Start</th>
                    <th class="py-2 pe-2">Current</th>
                    <th class="py-2 pe-2">Lowlimit</th>
                    <th class="py-2 pe-2">Uplimit</th>
                    <th class="py-2 pe-2">Match</th>
                    <th class="py-2 pe-2">Logs</th>
                    <th class="py-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  <template
                    v-for="(row, idx) in filteredTrailingTradeRows"
                    :key="`trail-trade-${row.botId}-${row.tradeId}-${idx}`"
                  >
                    <tr class="border-b border-surface-700/70 align-top">
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.tradeId }}</td>
                      <td class="py-2 pe-2 align-top whitespace-nowrap">
                        <div class="font-medium">{{ getBotVpsName(row.botId) }}</div>
                        <div class="text-xs text-surface-400">{{ getBotContainerName(row.botId) }} · ID {{ row.botId }}</div>
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.pair }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.side }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.enterTag ?? '—' }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.openDate ? formatDate(row.openDate) : '—' }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.snapshotProfitPct === null ? '—' : `${row.snapshotProfitPct.toFixed(2)}%` }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.snapshotOffsetPct === null ? '—' : `${row.snapshotOffsetPct.toFixed(2)}%` }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.snapshotDurationMinutes === null ? '—' : row.snapshotDurationMinutes.toFixed(1) }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.snapshotStartValue === null ? '—' : row.snapshotStartValue.toFixed(4) }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.snapshotCurrentValue === null ? '—' : row.snapshotCurrentValue.toFixed(4) }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.snapshotLowLimitValue === null ? '—' : row.snapshotLowLimitValue.toFixed(4) }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.snapshotUpLimitValue === null ? '—' : row.snapshotUpLimitValue.toFixed(4) }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.matchSource }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.logCount }}</td>
                      <td class="py-2 pe-2 text-center align-top">
                        <button
                          v-if="row.logCount > 0"
                          class="px-2 py-1 rounded border border-surface-600 text-xs hover:bg-surface-800"
                          @click="toggleTrailingTradeExpand(row.botId, row.tradeId)"
                        >
                          {{ isTrailingTradeExpanded(row.botId, row.tradeId) ? 'Hide' : 'Show' }}
                        </button>
                        <span v-else class="text-surface-500">—</span>
                      </td>
                    </tr>
                    <tr
                      v-if="isTrailingTradeExpanded(row.botId, row.tradeId)"
                      class="border-b border-surface-800 bg-surface-950/40"
                    >
                      <td colspan="16" class="py-3 px-2">
                        <div class="space-y-1 max-h-72 overflow-y-auto">
                          <table class="w-full text-xs border-collapse">
                            <thead>
                              <tr class="border-b border-surface-700 text-left">
                                <th class="py-1 pe-2">Time</th>
                                <th class="py-1 pe-2">Profit %</th>
                                <th class="py-1 pe-2">Offset %</th>
                                <th class="py-1 pe-2">Duration (min)</th>
                                <th class="py-1 pe-2">Start</th>
                                <th class="py-1 pe-2">Current</th>
                                <th class="py-1 pe-2">Lowlimit</th>
                                <th class="py-1 pe-2">Uplimit</th>
                                <th class="py-1 pe-2">Match</th>
                                <th class="py-1">Message</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr
                                v-for="(log, logIdx) in row.logEntries"
                                :key="`trail-log-${row.tradeId}-${logIdx}`"
                                class="border-b border-surface-800/50 align-top"
                              >
                                <td class="py-1 pe-2 whitespace-nowrap">{{ log.at }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ log.profitPct === null ? '—' : `${log.profitPct.toFixed(2)}%` }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ log.offsetPct === null ? '—' : `${log.offsetPct.toFixed(2)}%` }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ log.durationMinutes === null ? '—' : log.durationMinutes.toFixed(1) }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ log.startValue === null ? '—' : log.startValue.toFixed(4) }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ log.currentValue === null ? '—' : log.currentValue.toFixed(4) }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ log.lowLimitValue === null ? '—' : log.lowLimitValue.toFixed(4) }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ log.upLimitValue === null ? '—' : log.upLimitValue.toFixed(4) }}</td>
                                <td class="py-1 pe-2 whitespace-nowrap">{{ log.matchSource }}</td>
                                <td class="py-1 break-words">{{ log.message }}</td>
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
          </div>

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
    </Card>
  </div>
</template>