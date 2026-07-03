<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { todayStr } from '@/utils/reportDates';
import { formatDate, extractPairFlexible } from '@/utils/reportParsers';
import { logsChartLayout, candleBucketMs } from '@/utils/reportCharts';
import { timestampShort } from '@/utils/formatters/timeformat';
import type { DwhAnomalySample } from '@/types/vps';

const {
  reportsError,
  botSelectOptions,
  isBotActive,
  getBotVpsName,
  getBotContainerName,
  showChartTooltip,
  hideChartTooltip,
  ensureBotDisplayMapLoaded,
} = useReportsContext();

// ─── Types specific to this report ─────────────────────────────────────────

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
  | 'trail_triggered'
  | 'other';

type MissedChartMode = 'cumulative' | 'hourly';

interface ParsedLogEvent {
  eventTs: string;
  at: string;
  level: string;
  logger: string;
  message: string;
  botId: number;
  pair: string;
  side: 'long' | 'short' | null;
  reasonCode: MissedTradeReasonCode;
  reason: string;
  details: string | null;
}

interface ReasonSummaryItem {
  reasonCode: MissedTradeReasonCode;
  reason: string;
  count: number;
}

interface MissedChartPoint {
  hourKey: string;
  at: string;
  count: number;
  cumulative: number;
}

interface MissedTradeGroup {
  key: string;
  bucketMs: number;
  representative: ParsedLogEvent;
  events: ParsedLogEvent[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

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
  trail_triggered: 'Trail triggered (entry taken)',
  other: 'Unclassified',
};

const missedChartModeOptions: { label: string; value: MissedChartMode }[] = [
  { label: 'Cumulative', value: 'cumulative' },
  { label: 'Per-hour', value: 'hourly' },
];

// ─── State ─────────────────────────────────────────────────────────────────

const missedTradeEvents = ref<ParsedLogEvent[]>([]);
const missedTotal = ref(0);
const missedLoaded = ref(false);
const loadingMissedTrades = ref(false);
const missedChartMode = ref<MissedChartMode>('cumulative');
const missedDateFrom = ref(todayStr());
const missedDateTo = ref(todayStr());
const missedFilterBotId = ref<number | null>(null);
const missedFilterPair = ref('');
const missedFilterVps = ref('');
const missedFilterSide = ref<'both' | 'long' | 'short'>('both');
const missedExpandedGroupKey = ref<string | null>(null);
const selectedReasonFilters = ref<MissedTradeReasonCode[]>([]);

// ─── Missed-trade-specific parsers (private) ───────────────────────────────

function extractMissedTradeSide(message: string): 'long' | 'short' | null {
  // Prefer the backend's anchored `dir=` token; the bare word match is a fallback and can
  // grab the wrong direction when a message mentions the opposite side first.
  const dir = message.match(/\bdir=(long|short)\b/i);
  if (dir) return dir[1].toLowerCase() as 'long' | 'short';
  const m = message.match(/\b(long|short)\b/i);
  return m ? (m[1].toLowerCase() as 'long' | 'short') : null;
}

function isStrategyUserDenyMessage(loweredMessage: string): boolean {
  return (
    loweredMessage.includes('user denied entry') ||
    loweredMessage.includes('entry denied by strategy/user rule') ||
    loweredMessage.includes('strategy/user deny') ||
    loweredMessage.includes('strategy_user_deny')
  );
}

function formatMissedTradeMessage(message: string): string {
  const loweredMessage = message.toLowerCase();
  const match = message.match(/(-?\d+(?:\.\d+)?)%\s*([<>])\s*(-?\d+(?:\.\d+)?)%/);
  if (match && loweredMessage.includes('funding rate')) {
    return `FR: ${match[1]}% , Threshold: ${match[3]}%`;
  }
  return message;
}

function extractDecisionDetails(message: string): string | null {
  const loweredMessage = message.toLowerCase();
  const percentCompareMatch = message.match(/(-?\d+(?:\.\d+)?)%\s*([<>])\s*(-?\d+(?:\.\d+)?)%/);
  if (percentCompareMatch && loweredMessage.includes('funding rate')) {
    const comparator = percentCompareMatch[2] === '<' ? 'below' : 'above';
    return `Funding rate ${percentCompareMatch[1]}% ${comparator} limit ${percentCompareMatch[3]}%`;
  }

  if (
    loweredMessage.includes('blocking new entry') ||
    loweredMessage.includes('blocking new trades:')
  ) {
    const dcaPairMatch = message.match(
      /:\s*([A-Z0-9]+\/[A-Z0-9]+(?::[A-Z0-9]+)?)\s+has\s+(\d+)\s+DCA.*?total entries:\s*(\d+)/i,
    );
    if (dcaPairMatch) {
      return `${dcaPairMatch[1]} has ${dcaPairMatch[2]} DCA (${dcaPairMatch[3]} entries)`;
    }
    return 'Existing trade reached deep DCA level';
  }

  if (loweredMessage.includes('can_long is disabled')) {
    return 'Long entries disabled (can_long=false)';
  }

  if (
    loweredMessage.includes('time filter active') ||
    loweredMessage.includes('due to unfavorable time')
  ) {
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
    const momentumMatch = message.match(
      /(\d+(?:\.\d+)?)%\s*<\s*(\d+(?:\.\d+)?)%\s*over\s*(\d+)\s*candles/i,
    );
    if (momentumMatch) {
      return `Momentum ${momentumMatch[1]}% below threshold ${momentumMatch[2]}% over ${momentumMatch[3]} candles`;
    }
    return 'Price momentum below configured threshold';
  }

  if (loweredMessage.includes('slippage too high') || loweredMessage.includes('bad slippage')) {
    const slippageMatch = message.match(
      /slippage\s+([0-9]+(?:\.[0-9]+)?)%\s*>?=\s*([0-9]+(?:\.[0-9]+)?)%/i,
    );
    if (slippageMatch) {
      return `Slippage ${slippageMatch[1]}% exceeded limit ${slippageMatch[2]}%`;
    }
    return 'Slippage exceeded configured limit';
  }

  if (
    loweredMessage.includes('start trailing long') ||
    loweredMessage.includes('start trailing short')
  ) {
    const priceMatch = message.match(/at\s+(\d+(?:\.\d+)?)/);
    const side = loweredMessage.includes('trailing long') ? 'long' : 'short';
    return priceMatch ? `Start trailing ${side} @ ${priceMatch[1]}` : `Start trailing ${side}`;
  }
  if (
    loweredMessage.includes('stop trailing long') ||
    loweredMessage.includes('stop trailing short')
  ) {
    const side = loweredMessage.includes('trailing long') ? 'long' : 'short';
    if (loweredMessage.includes('offset returned none')) {
      return `Stop trailing ${side}: offset=None`;
    }
    if (loweredMessage.includes('above max stop') || loweredMessage.includes('below max stop')) {
      return `Stop trailing ${side}: price beyond max stop`;
    }
    return `Stop trailing ${side}`;
  }
  if (
    loweredMessage.includes('update trailing long') ||
    loweredMessage.includes('update trailing short')
  ) {
    const side = loweredMessage.includes('trailing long') ? 'long' : 'short';
    return `Update trailing ${side} limit`;
  }
  if (loweredMessage.includes('triggering long') || loweredMessage.includes('triggering short')) {
    const side = loweredMessage.includes('triggering long') ? 'long' : 'short';
    const profitMatch = message.match(/\((-?\d+(?:\.\d+)?)\s*%\)/);
    return profitMatch
      ? `Trailing ${side} triggered (${profitMatch[1]}%)`
      : `Trailing ${side} triggered`;
  }
  if (
    loweredMessage.includes('trailing long for') ||
    loweredMessage.includes('trailing short for')
  ) {
    const side = loweredMessage.includes('trailing long') ? 'long' : 'short';
    const current = message.match(/Current:\s*([\d.]+)/i)?.[1];
    const lowlimit = message.match(/Lowlimit:\s*([\d.]+)/i)?.[1];
    const profit = message.match(/Profit:\s*(-?[\d.]+)%/i)?.[1];
    const bestProfit = message.match(/BestProfit:\s*(-?[\d.]+)%/i)?.[1];
    const offset = message.match(/Offset:\s*([\d.]+)%/i)?.[1];
    const parts: string[] = [];
    if (current) parts.push(`Cur: ${current}`);
    if (lowlimit) parts.push(`Lim: ${lowlimit}`);
    if (profit) parts.push(`P: ${profit}%`);
    if (bestProfit) parts.push(`Best: ${bestProfit}%`);
    if (offset) parts.push(`Off: ${offset}%`);
    return parts.length > 0 ? `Trailing ${side} | ${parts.join(' | ')}` : `Trailing ${side} status`;
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

  if (
    loweredMessage.includes('entry confirmation error') ||
    loweredMessage.includes('confirm_trade_entry error')
  ) {
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
  if (
    loweredMessage.includes('can_long is disabled') ||
    loweredMessage.includes('long trade rejected')
  ) {
    return {
      reasonCode: 'long_disabled',
      reason: MISSED_TRADE_REASON_LABELS.long_disabled,
    };
  }
  if (
    loweredMessage.includes('time filter active') ||
    loweredMessage.includes('due to unfavorable time')
  ) {
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
  if (loweredMessage.includes('[trail_result]') && loweredMessage.includes('result=triggered')) {
    return { reasonCode: 'trail_triggered', reason: MISSED_TRADE_REASON_LABELS.trail_triggered };
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
  if (
    loweredMessage.includes('entry confirmation error') ||
    loweredMessage.includes('confirm_trade_entry error')
  ) {
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

function parseMissedTradeSamples(
  samples: DwhAnomalySample[],
  existing: Map<string, ParsedLogEvent>,
): Map<string, ParsedLogEvent> {
  for (const sample of samples) {
    const loweredMessage = sample.message.toLowerCase();
    if (isStrategyUserDenyMessage(loweredMessage)) {
      continue;
    }
    // Deep-DCA blocks emit two lines. "Blocking new trades: {blocker} has N DCA
    // entries" names the pair CAUSING the block (which had no signal); only
    // "Blocking new entry for {candidate}" is a genuinely missed trade. Parsing
    // the blocker line created a spurious row + double-count (backend parser
    // dropped this pattern 2026-06-10 for the same reason).
    if (loweredMessage.includes('blocking new trades:')) {
      continue;
    }
    const event: ParsedLogEvent = {
      eventTs: sample.event_ts,
      at: formatDate(sample.event_ts),
      level: sample.level,
      logger: sample.logger,
      message: formatMissedTradeMessage(sample.message),
      botId: sample.bot_id,
      pair: extractPairFlexible(sample.message),
      side: extractMissedTradeSide(sample.message),
      ...classifyMissedTradeReason(sample.message),
      details: extractDecisionDetails(sample.message),
    };
    existing.set(`${sample.event_ts}|${sample.logger}|${sample.message}`, event);
  }
  return existing;
}

// ─── Computeds ─────────────────────────────────────────────────────────────

const filteredMissedTradeEventsByBotPair = computed(() => {
  const pairNeedle = missedFilterPair.value.trim().toLowerCase();
  const vpsNeedle = missedFilterVps.value.trim().toLowerCase();
  const botFilter = Number(missedFilterBotId.value);
  const botFilterEnabled = Number.isFinite(botFilter) && botFilter > 0;

  const sideFilter = missedFilterSide.value;
  return missedTradeEvents.value.filter((event) => {
    const botMatches = !botFilterEnabled || event.botId === botFilter;
    const pairMatches = !pairNeedle || event.pair.toLowerCase().includes(pairNeedle);
    const vpsMatches = !vpsNeedle || getBotVpsName(event.botId).toLowerCase().includes(vpsNeedle);
    const sideMatches = sideFilter === 'both' || event.side === sideFilter;
    const globalBotMatches = isBotActive(event.botId);
    return globalBotMatches && botMatches && pairMatches && vpsMatches && sideMatches;
  });
});

const parsedMissedTradeEvents = computed(() => {
  if (!selectedReasonFilters.value.length) {
    return filteredMissedTradeEventsByBotPair.value;
  }
  const selected = new Set(selectedReasonFilters.value);
  return filteredMissedTradeEventsByBotPair.value.filter(
    (event) => event.reasonCode === 'trail_triggered' || selected.has(event.reasonCode),
  );
});

const groupedMissedTradeEvents = computed<MissedTradeGroup[]>(() => {
  const groups = new Map<string, MissedTradeGroup>();
  for (const event of parsedMissedTradeEvents.value) {
    const bucket = candleBucketMs(event.eventTs);
    const key = `${event.botId}|${event.pair}|${bucket}`;
    if (!groups.has(key))
      groups.set(key, { key, bucketMs: bucket, representative: event, events: [] });
    groups.get(key)!.events.push(event);
  }
  return Array.from(groups.values())
    .filter((g) => !g.events.some((e) => e.reasonCode === 'trail_triggered'))
    .sort((a, b) => b.bucketMs - a.bucketMs)
    .map((g) => ({
      ...g,
      events: g.events
        .filter((e) => e.reasonCode !== 'trail_triggered')
        .sort((a, b) => new Date(a.eventTs).getTime() - new Date(b.eventTs).getTime()),
    }));
});

const allMissedGroupStats = computed<{
  reasonCounts: Map<MissedTradeReasonCode, number>;
  total: number;
}>(() => {
  const groupReasons = new Map<string, Set<MissedTradeReasonCode>>();
  for (const event of filteredMissedTradeEventsByBotPair.value) {
    const bucket = candleBucketMs(event.eventTs);
    const key = `${event.botId}|${event.pair}|${bucket}`;
    if (!groupReasons.has(key)) groupReasons.set(key, new Set());
    groupReasons.get(key)!.add(event.reasonCode);
  }
  const reasonCounts = new Map<MissedTradeReasonCode, number>();
  let total = 0;
  for (const reasons of groupReasons.values()) {
    if (reasons.has('trail_triggered')) continue;
    total++;
    for (const code of reasons) {
      if (code === 'trail_triggered') continue;
      reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
    }
  }
  return { reasonCounts, total };
});

const missedTradeSummaryByReason = computed<ReasonSummaryItem[]>(() => {
  return Array.from(allMissedGroupStats.value.reasonCounts.entries()).map(
    ([reasonCode, count]) => ({
      reasonCode,
      reason: MISSED_TRADE_REASON_LABELS[reasonCode],
      count,
    }),
  );
});

const missedTradeReasonButtons = computed<ReasonSummaryItem[]>(() => {
  return missedTradeSummaryByReason.value.filter((item) => item.reasonCode !== 'trailing_entry');
});

const trailingEntryMissCount = computed(
  () => allMissedGroupStats.value.reasonCounts.get('trailing_entry') ?? 0,
);

const trailingEntryMissPct = computed(() => {
  const total = allMissedGroupStats.value.total;
  if (!total) return '0.0';
  return ((trailingEntryMissCount.value / total) * 100).toFixed(1);
});

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
  if (!pts.length)
    return [] as { x: number; y: number; at: string; count: number; cumulative: number }[];
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

// ─── Functions ─────────────────────────────────────────────────────────────

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
  missedFilterSide.value = 'both';
  selectedReasonFilters.value = [];
}

function reasonSharePct(count: number): string {
  const total = allMissedGroupStats.value.total;
  if (!total) return '0.0';
  return ((count / total) * 100).toFixed(1);
}

function toggleMissedGroup(key: string) {
  missedExpandedGroupKey.value = missedExpandedGroupKey.value === key ? null : key;
}

function isMissedGroupExpanded(key: string): boolean {
  return missedExpandedGroupKey.value === key;
}

onMounted(() => {
  if (!missedLoaded.value) {
    void loadMissedTradesReport();
  }
});

async function loadMissedTradesReport() {
  loadingMissedTrades.value = true;
  missedExpandedGroupKey.value = null;
  missedTradeEvents.value = [];
  missedTotal.value = 0;
  reportsError.value = '';
  try {
    await ensureBotDisplayMapLoaded();
    if (!missedDateFrom.value) missedDateFrom.value = todayStr();
    if (!missedDateTo.value) missedDateTo.value = todayStr();

    // Fetch all pages so client-side filtering works on the complete dataset
    const pageSize = 2000;
    let offset = 0;
    let total = Infinity;
    const dedupe = new Map<string, ParsedLogEvent>();
    while (offset < total) {
      const result = await vpsApi.dwhMissedTrades(
        missedDateFrom.value,
        missedDateTo.value,
        pageSize,
        offset,
        missedFilterBotId.value ?? undefined,
      );
      total = result.total;
      parseMissedTradeSamples(result.items, dedupe);
      offset += result.items.length;
      if (result.items.length === 0) break;
    }
    missedTotal.value = total;

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
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">Missed Trades Report (DWH)</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="missedDateFrom" type="date" size="sm" class="w-36" />
        <UInput v-model="missedDateTo" type="date" size="sm" class="w-36" />
        <USelect
          v-model="missedFilterBotId"
          :items="botSelectOptions"
          placeholder="All bots"
          size="sm"
          class="w-56"
        />
        <UInput
          v-model="missedFilterPair"
          size="sm"
          class="w-40"
          placeholder="Pair (e.g. JTO/USDT)"
        />
        <UInput v-model="missedFilterVps" size="sm" class="w-32" placeholder="VPS" />
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
              missedFilterSide === sf.key
                ? 'bg-primary-600 text-white'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-700'
            "
            @click="missedFilterSide = sf.key as 'both' | 'long' | 'short'"
          >
            {{ sf.label }}
          </button>
        </div>
        <UButton
          label="Clear"
          size="sm"
          color="neutral"
          variant="outline"
          @click="clearMissedTradeFilters"
        />
        <UButton
          label="Refresh"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loadingMissedTrades"
          @click="loadMissedTradesReport"
        />
      </div>
    </div>

    <div class="flex flex-wrap gap-2">
      <UButton
        :label="`Missed trades: ${allMissedGroupStats.total}`"
        size="sm"
        color="info"
        variant="outline"
        @click="selectedReasonFilters = []"
      />
      <UButton
        v-for="item in missedTradeReasonButtons"
        :key="item.reasonCode"
        :label="`${item.reason}: ${item.count} (${reasonSharePct(item.count)}%)`"
        size="sm"
        color="warning"
        :variant="isReasonSelected(item.reasonCode) ? 'solid' : 'outline'"
        @click="toggleReasonFilter(item.reasonCode)"
      />
      <UButton
        :label="`Trailing-entry misses: ${trailingEntryMissCount} (${trailingEntryMissPct}%)`"
        size="sm"
        color="warning"
        :variant="isReasonSelected('trailing_entry') ? 'solid' : 'outline'"
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
        <USelect v-model="missedChartMode" :items="missedChartModeOptions" size="sm" class="w-36" />
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
          v-for="(tick, idx) in missedChartXTicks"
          :key="`mtx-${idx}`"
          :x="tick.x"
          y="245"
          text-anchor="middle"
          fill="#94a3b8"
          font-size="10"
        >
          {{ tick.label }}
        </text>
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
          @mousemove="
            showChartTooltip($event, [
              point.at,
              missedChartMode === 'hourly'
                ? `Missed trades: ${point.count}`
                : `Cumulative missed: ${point.cumulative}`,
            ])
          "
          @mouseleave="hideChartTooltip"
        >
          <title>
            {{
              missedChartMode === 'hourly'
                ? `Missed trades: ${point.count}`
                : `Cumulative missed: ${point.cumulative}`
            }}
          </title>
        </circle>
      </svg>
    </div>

    <div v-if="missedTradeEvents.length" class="text-xs text-surface-400">
      Showing {{ missedTradeEvents.length }} of {{ missedTotal }} events
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
            <th class="py-2 pe-2">Side</th>
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
                <div class="font-medium">
                  {{ getBotVpsName(group.representative.botId) }}
                </div>
                <div class="text-xs text-surface-400">
                  {{ getBotContainerName(group.representative.botId) }} · #{{
                    group.representative.botId
                  }}
                </div>
              </td>
              <td class="py-2 pe-2 whitespace-nowrap font-mono">
                {{ group.representative.pair }}
              </td>
              <td class="py-2 pe-2 whitespace-nowrap text-xs">
                <template
                  v-for="s in [...new Set(group.events.map((e) => e.side))].filter(Boolean)"
                  :key="s"
                >
                  <span
                    v-if="s === 'long'"
                    class="px-1.5 py-0.5 rounded text-green-400 bg-green-900/40 font-medium me-1"
                    >Long</span
                  >
                  <span
                    v-else-if="s === 'short'"
                    class="px-1.5 py-0.5 rounded text-red-400 bg-red-900/40 font-medium me-1"
                    >Short</span
                  >
                </template>
                <span v-if="!group.events.some((e) => e.side)" class="text-surface-500">—</span>
              </td>
              <td class="py-2 pe-2">
                <span
                  v-for="rc in [...new Set(group.events.map((e) => e.reasonCode))]"
                  :key="rc"
                  class="inline-block text-xs text-surface-300 bg-surface-700 rounded px-1 me-1 mb-0.5 whitespace-nowrap"
                  >{{ rc }}</span
                >
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
            <tr
              v-if="isMissedGroupExpanded(group.key)"
              class="border-b border-surface-800 bg-surface-950/40"
            >
              <td colspan="7" class="py-3 px-2">
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
                        <td class="py-1 pe-2 whitespace-nowrap">
                          {{ event.details ?? '—' }}
                        </td>
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
</template>
