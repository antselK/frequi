<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { vpsApi } from '@/composables/vpsApi';
import type {
  DwhAnomaly,
  DwhCheckpoint,
  DwhIngestionRun,
  DwhIngestionRunResult,
  DwhLogCauseSummary,
  DwhLogCumulativePoint,
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
  trade_rejected: 'Trade rejected',
  other: 'Other',
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
  ],
};

const systemErrorTimelinePoints = ref<TimelinePoint[]>([]);
const dwhIngestTimeline = ref<IngestTimelinePoint[]>([]);
const logsCumulativeChartPoints = ref<LogsCumulativeChartPoint[]>([]);
const missedTradeEvents = ref<ParsedLogEvent[]>([]);
const botDisplayById = ref<Map<number, BotDisplayMeta>>(new Map());
const systemSpikeSummary = ref<DwhLogCauseSummary | null>(null);
const logsSpikeSummary = ref<DwhLogCauseSummary | null>(null);
const systemDays = ref(7);
const systemSpikeFromLocal = ref('');
const systemSpikeToLocal = ref('');
const systemSpikeLevels = ref('ERROR,WARNING');
const systemSpikeLimit = ref(20);
const logsDays = ref(7);
const logsSpikeFromLocal = ref('');
const logsSpikeToLocal = ref('');
const logsSpikeLevels = ref('INFO,WARNING,ERROR');
const logsSpikeLimit = ref(20);
const logsFilterBotId = ref<number | null>(null);
const logsFilterLogger = ref('');
const logsFilterLevel = ref('');
const logsChartMode = ref<LogsChartMode>('cumulative');
const missedDays = ref(7);
const missedFilterBotId = ref<number | null>(null);
const missedFilterPair = ref('');
const selectedReasonFilters = ref<MissedTradeReasonCode[]>([]);
const loadingSystemTimeline = ref(false);
const loadingSystemSpikeSummary = ref(false);
const loadingIngestTimeline = ref(false);
const loadingLogsCumulative = ref(false);
const loadingLogsSpikeSummary = ref(false);
const loadingMissedTrades = ref(false);
const reportsError = ref('');
const systemLoaded = ref(false);
const ingestLoaded = ref(false);
const logsCumulativeLoaded = ref(false);
const missedLoaded = ref(false);
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
        : date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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
        : date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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

const filteredMissedTradeEventsByBotPair = computed(() => {
  const pairNeedle = missedFilterPair.value.trim().toLowerCase();
  const botFilter = Number(missedFilterBotId.value);
  const botFilterEnabled = Number.isFinite(botFilter) && botFilter > 0;

  return missedTradeEvents.value.filter((event) => {
    const botMatches = !botFilterEnabled || event.botId === botFilter;
    const pairMatches = !pairNeedle || event.pair.toLowerCase().includes(pairNeedle);
    return botMatches && pairMatches;
  });
});

const parsedMissedTradeEvents = computed(() => {
  if (!selectedReasonFilters.value.length) {
    return filteredMissedTradeEventsByBotPair.value;
  }

  const selected = new Set(selectedReasonFilters.value);
  return filteredMissedTradeEventsByBotPair.value.filter((event) => selected.has(event.reasonCode));
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
  return date.toLocaleString();
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
    return 'New entries blocked because an existing trade reached deep DCA level';
  }

  if (loweredMessage.includes('can_long is disabled')) {
    return 'Long entries disabled by strategy parameter can_long';
  }

  if (loweredMessage.includes('time filter active') || loweredMessage.includes('due to unfavorable time')) {
    return 'Trade blocked by configured day/time filter window';
  }

  if (loweredMessage.includes('eth volatility too high')) {
    return 'ETH volatility exceeded configured threshold';
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

  if (
    loweredMessage.includes('start trailing long') ||
    loweredMessage.includes('start trailing short') ||
    loweredMessage.includes('stop trailing long') ||
    loweredMessage.includes('stop trailing short') ||
    loweredMessage.includes('offset returned none')
  ) {
    return 'Trailing entry flow did not reach entry trigger';
  }

  const match = message.match(/(-?\d+(?:\.\d+)?)%\s*<\s*(-?\d+(?:\.\d+)?)%/);
  if (match) {
    return `Funding rate ${match[1]}% below limit ${match[2]}%`;
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
  missedFilterBotId.value = null;
  missedFilterPair.value = '';
  selectedReasonFilters.value = [];
}

async function loadSystemErrorsTimeline() {
  loadingSystemTimeline.value = true;
  reportsError.value = '';
  try {
    systemDays.value = normalizeIntInput(systemDays.value, 7, 1, 365);
    const anomalies = await vpsApi.dwhAnomalies(systemDays.value, 30);
    const targetAnomalies = anomalies
      .filter((item) => ['error', 'warning'].includes(item.level.toLowerCase()))
      .slice(0, 8);

    if (!targetAnomalies.length) {
      systemErrorTimelinePoints.value = [];
      systemLoaded.value = true;
      return;
    }

    const trends = await Promise.all(
      targetAnomalies.map((item) => vpsApi.dwhAnomalyTrend(item.signature_hash, systemDays.value)),
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
    logsDays.value = normalizeIntInput(logsDays.value, 7, 1, 90);
    const normalizedBotId = Number.isFinite(Number(logsFilterBotId.value))
      ? Math.max(0, Math.floor(Number(logsFilterBotId.value)))
      : 0;
    logsFilterBotId.value = normalizedBotId > 0 ? normalizedBotId : null;

    const rows: DwhLogCumulativePoint[] = await vpsApi.dwhLogsCumulative({
      hours: logsDays.value * 24,
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

function isMissedTradeSignature(item: DwhAnomaly): boolean {
  const text = `${item.signature} ${item.logger}`.toLowerCase();
  if (isStrategyUserDenyMessage(text)) {
    return false;
  }
  return (
    text.includes('trade rejected') ||
    text.includes('blocking new entry') ||
    text.includes('blocking new trades:') ||
    text.includes('can_long is disabled') ||
    text.includes('time filter active') ||
    text.includes('eth volatility too high') ||
    text.includes('insufficient price momentum') ||
    text.includes('slippage too high') ||
    text.includes('bad slippage') ||
    text.includes('trailing long') ||
    text.includes('trailing short') ||
    text.includes('funding rate') ||
    text.includes('unfavorable')
  );
}

async function loadMissedTradesReport() {
  loadingMissedTrades.value = true;
  reportsError.value = '';
  try {
    await ensureBotDisplayMapLoaded();
    missedDays.value = normalizeIntInput(missedDays.value, 7, 1, 365);
    const anomalies = await vpsApi.dwhAnomalies(missedDays.value, 50);
    const targetSignatures = anomalies.filter(isMissedTradeSignature).slice(0, 10);

    if (!targetSignatures.length) {
      missedTradeEvents.value = [];
      missedLoaded.value = true;
      return;
    }

    const samplesPerSignature = await Promise.all(
      targetSignatures.map((item) => vpsApi.dwhAnomalySamples(item.signature_hash, 20)),
    );

    const dedupe = new Map<string, ParsedLogEvent>();
    for (const samples of samplesPerSignature) {
      for (const sample of samples) {
        const loweredMessage = sample.message.toLowerCase();
        if (isStrategyUserDenyMessage(loweredMessage)) {
          continue;
        }
        const isMissed =
          loweredMessage.includes('trade rejected') ||
          loweredMessage.includes('blocking new entry') ||
          loweredMessage.includes('blocking new trades:') ||
          loweredMessage.includes('can_long is disabled') ||
          loweredMessage.includes('time filter active') ||
          loweredMessage.includes('eth volatility too high') ||
          loweredMessage.includes('insufficient price momentum') ||
          loweredMessage.includes('slippage too high') ||
          loweredMessage.includes('bad slippage') ||
          loweredMessage.includes('trailing long') ||
          loweredMessage.includes('trailing short') ||
          loweredMessage.includes('funding rate');
        if (!isMissed) {
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
                <InputNumber v-model="systemDays" :min="1" :max="365" size="small" input-class="w-16" />
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
                <InputNumber v-model="logsDays" :min="1" :max="90" size="small" input-class="w-16" />
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
                <InputNumber v-model="missedDays" :min="1" :max="365" size="small" input-class="w-16" />
                <InputNumber
                  v-model="missedFilterBotId"
                  :min="1"
                  size="small"
                  input-class="w-20"
                  placeholder="Bot ID"
                />
                <InputText v-model="missedFilterPair" size="small" class="w-40" placeholder="Pair (e.g. JTO/USDT)" />
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
                v-for="item in missedTradeSummaryByReason"
                :key="item.reasonCode"
                :label="`${item.reason}: ${item.count}`"
                size="small"
                severity="warn"
                :outlined="!isReasonSelected(item.reasonCode)"
                @click="toggleReasonFilter(item.reasonCode)"
              />
              <Button
                :label="`Total events: ${parsedMissedTradeEvents.length}`"
                size="small"
                severity="contrast"
                outlined
                @click="selectedReasonFilters = []"
              />
              <Button
                :label="`Trailing-entry misses: ${trailingEntryMissCount} (${trailingEntryMissPct}%)`"
                size="small"
                severity="warn"
                :outlined="!isReasonSelected('trailing_entry')"
                @click="toggleReasonFilter('trailing_entry')"
              />
            </div>

            <div v-if="!parsedMissedTradeEvents.length" class="text-sm text-surface-400">
              {{ loadingMissedTrades ? 'Loading missed trades...' : 'No missed trade events found.' }}
            </div>

            <div v-else class="overflow-x-auto w-full">
              <table class="w-full text-sm border-collapse">
                <thead>
                  <tr class="border-b border-surface-600 text-left">
                    <th class="py-2 pe-2">Time</th>
                    <th class="py-2 pe-2">Bot</th>
                    <th class="py-2 pe-2">Pair</th>
                    <th class="py-2 pe-2">Reason code</th>
                    <th class="py-2 pe-2">Reason</th>
                    <th class="py-2 pe-2">Details</th>
                    <th class="py-2 pe-2">Logger</th>
                    <th class="py-2">Message</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(event, idx) in parsedMissedTradeEvents"
                    :key="`${event.at}-${idx}`"
                    class="border-b border-surface-700/70 align-top"
                  >
                    <td class="py-2 pe-2 whitespace-nowrap">{{ event.at }}</td>
                    <td class="py-2 pe-2 align-top whitespace-nowrap">
                      <div class="font-medium">{{ getBotVpsName(event.botId) }}</div>
                      <div class="text-xs text-surface-400">{{ getBotContainerName(event.botId) }} · ID {{ event.botId }}</div>
                    </td>
                    <td class="py-2 pe-2 whitespace-nowrap">{{ event.pair }}</td>
                    <td class="py-2 pe-2 whitespace-nowrap">{{ event.reasonCode }}</td>
                    <td class="py-2 pe-2 whitespace-nowrap">{{ event.reason }}</td>
                    <td class="py-2 pe-2 whitespace-nowrap">{{ event.details ?? '—' }}</td>
                    <td class="py-2 pe-2 whitespace-nowrap">{{ event.logger }}</td>
                    <td class="py-2 break-words">{{ event.message }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div
            v-if="selectedSubCategory === 'trade-drilldown'"
            class="border border-surface-400 rounded-sm p-4 text-sm text-surface-400"
          >
            Trade drill-down remains TODO for this page. Existing detailed trade filters/timeline are available in DWH Progress for now.
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