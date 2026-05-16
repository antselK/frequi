<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { timestampShort } from '@/utils/formatters/timeformat';
import { formatDate, extractPairFlexible } from '@/utils/reportParsers';
import { logsChartLayout, niceTickInterval } from '@/utils/reportCharts';
import { vpsApi } from '@/composables/vpsApi';
import { useTableSort } from '@/composables/useTableSort';
import { provideReportsContext } from '@/composables/useReportsContext';
import ReportsAdminDialog from '@/components/ReportsAdminDialog.vue';
import EntryTagPerformanceReport from '@/views/reports/EntryTagPerformanceReport.vue';
import DcaAnalysisReport from '@/views/reports/DcaAnalysisReport.vue';
import TodDurationReport from '@/views/reports/TodDurationReport.vue';
import ReportStub from '@/views/reports/ReportStub.vue';
import MissedTradesReport from '@/views/reports/MissedTradesReport.vue';
import SignalOutcomesReport from '@/views/reports/SignalOutcomesReport.vue';
import TradeDrilldownReport from '@/views/reports/TradeDrilldownReport.vue';
import type { BotSummary, ReportLayoutSettings } from '@/types/vps';
import type {
  DwhCheckpoint,
  DwhLogCauseSummary,
  DwhLogCumulativePoint,
  DwhTrade,
  DwhSignalIndicatorTradeRow,
  DwhSignalIndicatorAnalysis,
  DwhBotPerfRead,
  DwhBotPerfHistoryRead,
  DwhBotPerfRollingScoreRead,
} from '@/types/vps';

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
type TrailingChartMetric = 'profit' | 'duration';

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
      analysisQuery: `# Run this in a terminal to get full trailing entry analysis for Printer.py tuning:

docker exec -w /app control-plane-api-1 python3 << 'PYEOF'
import re
from collections import defaultdict, Counter
from sqlalchemy import text
from app.db.session import SessionLocal
db = SessionLocal()
trades = db.execute(text("SELECT t.source_trade_id, t.bot_id, t.pair, t.is_short, t.enter_tag, t.exit_reason, (t.profit_ratio*100)::float, t.profit_abs::float, (EXTRACT(EPOCH FROM (t.close_date-t.open_date))/60)::float, t.open_date FROM dwh_trades t WHERE t.enter_tag ILIKE :tag AND t.is_open=false AND t.close_date IS NOT NULL AND t.profit_ratio IS NOT NULL ORDER BY t.open_date DESC"), {'tag': '%_trail%'}).fetchall()
po_msgs = db.execute(text("SELECT bot_id, event_ts, message FROM dwh_log_events WHERE message ILIKE '%Price OK for %' ORDER BY event_ts")).fetchall()
db.close()
pct_re = re.compile(r'\\((-?[0-9]+\\.[0-9]+)\\s*%\\)')
po_by_bot = defaultdict(list)
for row in po_msgs:
    m = pct_re.search(row[2])
    if m: po_by_bot[row[0]].append((row[1], row[2], float(m.group(1))))
def find_trail(bot_id, pair, open_date):
    best, bd = None, 999
    for ts, msg, pct in po_by_bot.get(bot_id, []):
        if pair.lower() not in msg.lower(): continue
        d = abs((ts - open_date).total_seconds())
        if d <= 35 and d < bd: bd, best = d, pct
    return best
data = [{'id':t[0],'bot':t[1],'pair':t[2],'short':t[3],'tag':t[4],'exit':t[5],'pp':t[6] or 0,'pa':t[7] or 0,'dur':t[8] or 0,'tp':find_trail(t[1],t[2],t[9])} for t in trades]
def stats(g):
    n=len(g); ap=sum(e['pp'] for e in g)/n; tu=sum(e['pa'] for e in g); w=sum(1 for e in g if e['pp']>0); ad=sum(e['dur'] for e in g)/n
    return n,ap,tu,w,n-w,w/n*100,ad
print(f"Trades: {len(data)}  Matched: {sum(1 for d in data if d['tp'] is not None)}")
print()
print('TRAIL ENTRY BUCKET               N   AvgP%   TotalUSDT    W    L    WR%  Dur')
print('-'*80)
for lbl,fn in [('<= -0.25%',lambda p:p is not None and p<=-0.25),('-0.25 to -0.15%',lambda p:p is not None and -0.25<p<=-0.15),('-0.15 to -0.05%',lambda p:p is not None and -0.15<p<=-0.05),('-0.05 to 0.00%',lambda p:p is not None and -0.05<p<=0.00),('0.00 to 0.10%',lambda p:p is not None and 0.00<p<=0.10),('>0.10% (force/exp)',lambda p:p is not None and p>0.10),('no data',lambda p:p is None)]:
    g=[e for e in data if fn(e['tp'])]
    if not g: continue
    n,ap,tu,w,l,wr,ad=stats(g)
    print(f'{lbl:<32} {n:>4} {ap:>7.3f} {tu:>11.2f} {w:>4} {l:>4} {wr:>6.1f} {ad:>5.1f}')
print()
print('SIDE       N    WR%  AvgP%  TotalUSDT  AvgTrailEntry')
for side,s in [('LONG',False),('SHORT',True)]:
    g=[e for e in data if e['short']==s]
    if not g: continue
    n,ap,tu,w,l,wr,ad=stats(g); m=[e for e in g if e['tp'] is not None]; at=sum(e['tp'] for e in m)/len(m) if m else 0
    print(f'{side:<10}{n:>4} {wr:>6.1f} {ap:>6.3f} {tu:>10.2f}  {at:>12.4f}%')
print()
print('DURATION                   N   AvgP%  TotalUSDT    WR%')
for lbl,fn in [('<1 min',lambda d:d<1),('1-5 min',lambda d:1<=d<5),('5-14 min',lambda d:5<=d<14),('>=14 min (expired)',lambda d:d>=14)]:
    g=[e for e in data if fn(e['dur'])]
    if not g: continue
    n,ap,tu,w,l,wr,ad=stats(g)
    print(f'{lbl:<26} {n:>4} {ap:>6.3f} {tu:>10.2f} {wr:>6.1f}')
print()
print('EXIT REASON                          N   AvgP%  TotalUSDT    WR%')
for ex,_ in Counter(e['exit'] for e in data).most_common():
    g=[e for e in data if e['exit']==ex]; n,ap,tu,w,l,wr,ad=stats(g)
    print(f'{str(ex):<36} {n:>4} {ap:>6.3f} {tu:>10.2f} {wr:>6.1f}')
print()
print('TRAIL ENTRY PERCENTILES:')
tv=sorted(e['tp'] for e in data if e['tp'] is not None); n=len(tv)
for p in [0,5,10,25,50,75,90,95,100]:
    print(f'  p{p:3d}: {tv[min(int(n*p/100),n-1)]:.4f}%')
PYEOF

# HOW TO INTERPRET:
# Entry bucket WR%/AvgP%: deeper (more negative) = stronger entries. Near-0% losers → increase default_offset.
# Duration: >=14 min dominating (>80%) → reduce expire_seconds. Current expire: trailing_expire_seconds / trailing_short_expire_seconds.
# Exit reasons: roi underperforming → ROI table too loose. trailing_stop_loss dominating → healthy.
# Long vs Short AvgTrailEntry: longs at higher trail% than shorts → longs need tighter offset or shorter expiry.
# Params in Printer.py lines ~347-366. After changes bump _VERSION to DD.MM.YYYY - Printer, commit+push in /home/ubuntu/ft_userdata.`,
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
const trailingChartMetric = ref<TrailingChartMetric>('profit');
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

const loadingSystemTimeline = ref(false);
const loadingSystemSpikeSummary = ref(false);
const loadingLogsCumulative = ref(false);
const loadingLogsSpikeSummary = ref(false);
const loadingTrailingBenefit = ref(false);
const showTrailingAnalysisQuery = ref(false);
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
const trailingLoaded = ref(false);
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

// Entry Tag Performance computed
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
  const yPad = yRange * 0.12;
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
    chartTooltip.value.visible = false;
    return;
  }

  botHistHoverDate.value = nearest;
  const lines: string[] = [nearest];
  for (const hp of cd.series) {
    const pt = hp.points.find((p) => p.date === nearest);
    if (pt) lines.push(`${hp.name}${hp.vpsName ? ' / ' + hp.vpsName : ''}: ${pt.extraLabel}`);
  }
  chartTooltip.value = { visible: true, x: event.clientX + 14, y: event.clientY - 10, lines };
}
function botHistOnMouseLeave() {
  botHistHoverDate.value = null;
  chartTooltip.value.visible = false;
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
      // ISO date strings sort lexicographically; nulls (open trades) sort last when asc, first when desc
      const av = (a[col] as string | null) ?? '\uFFFF';
      const bv = (b[col] as string | null) ?? '\uFFFF';
      return asc ? av.localeCompare(bv) : bv.localeCompare(av);
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
  (signalIndData.value?.items ?? []).filter((r) => r.rsi === null && !r.is_open),
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
    if (r.is_open) continue;
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
    const globalBotMatches = isBotActive(row.botId);
    return (
      globalBotMatches &&
      botMatches &&
      tradeMatches &&
      pairMatches &&
      vpsMatches &&
      containerMatches &&
      sideMatches &&
      matchSourceMatches
    );
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
  { label: 'Trailing profit %', value: 'profit' },
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
    ? 'Trailing profit % (per trade, by open date)'
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
  if (!pts.length)
    return [] as {
      x: number;
      y: number;
      at: string;
      tradeId: number;
      pair: string;
      value: number | null;
      positive: boolean;
    }[];
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
    const at = (() => {
      const d = new Date(pt.at);
      return Number.isNaN(d.getTime()) ? pt.at : timestampShort(d);
    })();
    return {
      x,
      y,
      at,
      tradeId: pt.tradeId,
      pair: pt.pair,
      value: rawVal,
      positive: (rawVal ?? 0) >= 0,
    };
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

function parseLabeledNumber(message: string, label: string): number | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = message.match(
    new RegExp(`${escapedLabel}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)\\s*%?`, 'i'),
  );
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

// Extracts the trailing profit % from "Price OK for PAIR (X.XX %), ..." messages.
function parsePriceOkProfit(message: string): number | null {
  const match = message.match(/price ok for [^(]+\(\s*(-?\d+(?:\.\d+)?)\s*%\s*\)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePeakDrawdownProfit(message: string): number | null {
  const match = message.match(/current\s+(-?\d+(?:\.\d+)?)\s*%/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDurationMinutes(message: string): number | null {
  const durationMatch = message.match(
    /duration\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?/i,
  );
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
  return (
    normalized.endsWith('_trail') || normalized.includes('_trail_') || normalized.includes('trail')
  );
}

function parseTradeIdFromMessage(message: string): number | null {
  const match = message.match(/trade_id['"]?\s*[:=]\s*(\d+)/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRpcTradeHints(
  samplesBySignature: Array<Array<{ event_ts: string; bot_id: number; message: string }>>,
): RpcTradeHint[] {
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

  const rpcSamples = await Promise.all(
    rpcSignatures.map((item) => vpsApi.dwhAnomalySamples(item.signature_hash, 80)),
  );
  const hints = buildRpcTradeHints(rpcSamples);
  const dedupe = new Map<string, RpcTradeHint>();
  for (const hint of hints) {
    dedupe.set(
      `${hint.tradeId}|${hint.botId}|${normalizePairForMatch(hint.pair)}|${hint.eventTs}`,
      hint,
    );
  }
  return Array.from(dedupe.values());
}

function matchTrailingEventRpcTradeHint(
  event: TrailingTriggerEvent,
  rpcHints: RpcTradeHint[],
): TrailingTriggerEvent {
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
    const samePair =
      hintPairNorm === normalizedPair || simplifyPairForMatch(hint.pair) === simplifiedPair;
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
      return deltaMs >= 0 && deltaMs <= 15 * 60 * 1000;
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

function matchTrailingEventTrade(
  event: TrailingTriggerEvent,
  tradeIndex: Map<string, DwhTrade[]>,
): TrailingTriggerEvent {
  const normalizedPair = normalizePairForMatch(event.pair);
  const simplifiedPair = simplifyPairForMatch(event.pair);
  const directKey = `${event.botId}|${normalizedPair}`;

  let candidateTrades = tradeIndex.get(directKey) ?? [];
  if (!candidateTrades.length && simplifiedPair) {
    candidateTrades = Array.from(tradeIndex.entries())
      .filter(
        ([key]) =>
          key.startsWith(`${event.botId}|`) &&
          simplifyPairForMatch(key.split('|')[1]) === simplifiedPair,
      )
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
    loweredMessage.includes('price ok for ') ||
    loweredMessage.includes('peak drawdown entry for ')
  );
}

function parseTrailingTriggerEvent(sample: {
  event_ts: string;
  bot_id: number;
  logger: string;
  message: string;
}): TrailingTriggerEvent {
  // "Price OK" and "Peak drawdown entry" messages embed profit inline; prefer over generic label parser.
  const isPriceOk = /price ok for /i.test(sample.message);
  const isPeakDrawdown = /peak drawdown entry for /i.test(sample.message);
  const profitPct = isPriceOk
    ? parsePriceOkProfit(sample.message)
    : isPeakDrawdown
      ? parsePeakDrawdownProfit(sample.message)
      : parseLabeledNumber(sample.message, 'Profit');
  return {
    eventTs: sample.event_ts,
    at: formatDate(sample.event_ts),
    botId: sample.bot_id,
    pair: extractPairFlexible(sample.message),
    side: extractTrailingSide(sample.message),
    profitPct,
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
  const keywords = ['trailing', 'triggering', 'Price OK', 'Peak drawdown'];
  const pageLimit = 500;

  async function fetchPages(botId: number, keyword: string) {
    const collected: Array<{ event_ts: string; bot_id: number; logger: string; message: string }> =
      [];
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

  const tasks = botIds.flatMap((botId) => keywords.map((keyword) => fetchPages(botId, keyword)));
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

  // Use the last trigger log for profit % — either "Price OK" or "Peak drawdown entry".
  // Both embed the definitive entry profit inline. Take the chronologically last one.
  const isTriggerLog = (l: TrailingTriggerEvent) =>
    /price ok for /i.test(l.message) || /peak drawdown entry for /i.test(l.message);
  const triggerLogs = logs.filter(isTriggerLog);
  const triggerProfit =
    triggerLogs.length > 0 ? (triggerLogs[triggerLogs.length - 1]?.profitPct ?? null) : null;

  // Pick the best structural log (has Start/Current/Lowlimit/Duration/Offset) using timestamp logic:
  // last "Trailing short/long for" log at or before trade open time.
  const structuralLogs = logs.filter((l) => !isTriggerLog(l));

  let structuralBest: TrailingTriggerEvent | null = null;
  if (tradeOpenDate) {
    const openTime = new Date(tradeOpenDate).getTime();
    if (Number.isFinite(openTime)) {
      // Walk the (already-sorted ascending) logs, keep the last one that is <= openTime + 2s buffer
      // (2s buffer handles the case where the log fires milliseconds after the trade opens)
      for (const log of structuralLogs) {
        const logTime = new Date(log.eventTs).getTime();
        if (Number.isFinite(logTime) && logTime <= openTime + 2000) {
          structuralBest = log;
        }
      }
    }
  }
  if (!structuralBest) {
    structuralBest = structuralLogs[structuralLogs.length - 1] ?? logs[logs.length - 1] ?? null;
  }

  if (!structuralBest) {
    return triggerLogs[triggerLogs.length - 1] ?? null;
  }

  // Merge: structural fields from best "Trailing" log, profitPct from trigger log if available.
  return triggerProfit !== null ? { ...structuralBest, profitPct: triggerProfit } : structuralBest;
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
      const msgOrder = (msg: string): number => {
        if (/^start trailing/i.test(msg)) return 0;
        if (/^price ok for /i.test(msg) || /^peak drawdown entry for /i.test(msg)) return 2;
        return 1;
      };
      bucket.sort((a, b) => {
        // Primary: sort by whole second (timestamps within the same second are treated as tied).
        const aTs = Math.floor(new Date(a.eventTs).getTime() / 1000);
        const bTs = Math.floor(new Date(b.eventTs).getTime() / 1000);
        const secDiff = aTs - bTs;
        if (secDiff !== 0) return secDiff;
        // Tie-break within same second: "Start trailing" first, "Price OK" last.
        return msgOrder(a.message) - msgOrder(b.message);
      });
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

async function ensureDataForSubcategory(subCategory: string) {
  if (subCategory === 'system-errors' && !systemLoaded.value) {
    await loadSystemErrorsTimeline();
    return;
  }
  if (subCategory === 'logs-cumulative' && !logsCumulativeLoaded.value) {
    await loadLogsCumulativeChart();
    return;
  }
  if (subCategory === 'trailing-benefit' && !trailingLoaded.value) {
    await loadTrailingBenefitReport();
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
            <div v-if="selectedSubCategoryDefinition?.analysisQuery">
              <button
                class="text-xs text-surface-400 hover:text-surface-200 underline"
                @click="showTrailingAnalysisQuery = !showTrailingAnalysisQuery"
              >
                {{ showTrailingAnalysisQuery ? '▲ Hide analysis query' : '▼ Show analysis query' }}
              </button>
              <pre
                v-if="showTrailingAnalysisQuery"
                class="mt-2 text-xs bg-surface-900 border border-surface-700 rounded p-3 overflow-x-auto whitespace-pre-wrap select-all"
                >{{ selectedSubCategoryDefinition.analysisQuery }}</pre
              >
            </div>
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

          <!-- ============================================================ -->
          <!-- Signal Indicator Analysis -->
          <!-- ============================================================ -->
          <div
            v-if="selectedSubCategory === 'signal-indicator-analysis'"
            class="border border-surface-400 rounded-sm p-4 space-y-4"
          >
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
              {{ signalIndData.matched_trades }} of {{ signalIndData.total_trades }} trades have
              indicator snapshots (closed trades only)
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
                  <div
                    class="text-lg font-bold font-mono"
                    :class="signalIndAvgProfit >= 0 ? 'text-green-400' : 'text-red-400'"
                  >
                    {{ signalIndAvgProfit >= 0 ? '+' : '' }}{{ signalIndAvgProfit.toFixed(2) }}%
                  </div>
                  <div class="text-xs text-surface-400">Avg profit</div>
                </div>
                <div
                  v-if="signalIndAvgDuration !== null"
                  class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center"
                >
                  <div class="text-lg font-bold font-mono">
                    {{ signalIndAvgDuration.toFixed(1) }}h
                  </div>
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
                    :class="signalIndUnmatchedAvgProfit >= 0 ? 'text-green-400' : 'text-red-400'"
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
                      <option
                        v-for="opt in signalIndIndicatorOptions"
                        :key="opt.value"
                        :value="opt.value"
                      >
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
                      <span class="inline-block w-2 h-2 rounded-full bg-green-400"></span> Profit
                      &gt; 0
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
                        row.rsi === null && signalIndMatchFilter !== 'unmatched'
                          ? 'opacity-40'
                          : '',
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
                            row.is_short
                              ? 'bg-red-900/50 text-red-300'
                              : 'bg-green-900/50 text-green-300'
                          "
                          >{{ row.is_short ? 'Short' : 'Long' }}</span
                        >
                      </td>
                      <td class="py-2 pe-3 font-mono text-xs whitespace-nowrap">
                        {{ row.open_date ? formatDate(row.open_date) : '-' }}
                      </td>
                      <td class="py-2 pe-3 font-mono text-xs whitespace-nowrap">
                        {{
                          row.is_open ? 'Open' : row.close_date ? formatDate(row.close_date) : '-'
                        }}
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
                            : (row.quality_score ?? -99) >= (signalIndAvgQuality ?? -99)
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
              <div
                v-if="signalIndAnalyticsData === null"
                class="text-sm text-surface-400 py-4 text-center"
              >
                Load data to see analytics. Trades must have indicator snapshots (closed trades
                matched to [SIGNAL_FLASH] logs).
              </div>

              <template v-else>
                <!-- Summary + legend row -->
                <div class="flex flex-wrap items-center gap-4 text-xs text-surface-400">
                  <span class="text-surface-200 font-medium">
                    {{ signalIndAnalyticsData.tradeCount }} trades &mdash; threshold: score &le;
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
                  <div
                    class="ml-auto flex gap-0 rounded border border-surface-600 overflow-hidden text-xs"
                  >
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

          <div
            v-if="selectedSubCategory === 'trailing-benefit'"
            class="border border-surface-400 rounded-sm p-4 space-y-4"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">Trailing Entries Benefit (DWH)</h5>
              <div class="flex flex-wrap items-center gap-2">
                <UInput v-model="trailingDateFrom" type="date" size="sm" class="w-36" />
                <UInput v-model="trailingDateTo" type="date" size="sm" class="w-36" />
                <USelect
                  v-model="trailingFilterBotId"
                  :items="botSelectOptions"
                  placeholder="All bots"
                  size="sm"
                  class="w-56"
                />
                <UInputNumber
                  v-model="trailingFilterTradeId"
                  :min="1"
                  size="sm"
                  class="w-20"
                  placeholder="Trade ID"
                />
                <UInput
                  v-model="trailingFilterPair"
                  size="sm"
                  class="w-40"
                  placeholder="Pair (e.g. BTC/USDT)"
                />
                <UInput v-model="trailingFilterVps" size="sm" class="w-36" placeholder="VPS" />
                <UInput
                  v-model="trailingFilterContainer"
                  size="sm"
                  class="w-36"
                  placeholder="Container"
                />
                <USelect
                  v-model="trailingFilterSide"
                  :items="[
                    { label: 'All sides', value: 'all' },
                    { label: 'Long', value: 'long' },
                    { label: 'Short', value: 'short' },
                  ]"
                  size="sm"
                  class="w-32"
                />
                <USelect
                  v-model="trailingFilterMatchSource"
                  :items="[
                    { label: 'All sources', value: 'all' },
                    { label: 'closed_trail', value: 'closed_trail' },
                    { label: 'trade_fallback', value: 'trade_fallback' },
                    { label: 'rpc_hint', value: 'rpc_hint' },
                    { label: 'trade_only', value: 'trade_only' },
                  ]"
                  size="sm"
                  class="w-40"
                />
                <UButton
                  label="Clear"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  @click="clearTrailingBenefitFilters"
                />
                <UButton
                  label="Refresh"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  :loading="loadingTrailingBenefit"
                  @click="loadTrailingBenefitReport"
                />
              </div>
            </div>

            <div class="flex flex-wrap gap-2">
              <UBadge :label="`Trades: ${trailingTradeCount}`" color="info" />
              <UBadge :label="`Log entries: ${trailingTotalLogCount}`" color="info" />
              <UBadge :label="`Avg trailing profit: ${trailingAvgProfitPct}`" color="warning" />
              <UBadge :label="`Positive profit share: ${trailingPositiveShare}`" color="warning" />
              <UBadge
                :label="`Avg trailing duration: ${trailingAvgDurationMinutes}`"
                color="warning"
              />
              <UBadge
                :label="`Profit <0%: ${trailingProfitBuckets.lossCount} (${trailingProfitBuckets.lossShare}%)`"
                color="neutral"
              />
              <UBadge
                :label="`Profit 0-0.2%: ${trailingProfitBuckets.nearFlatCount} (${trailingProfitBuckets.nearFlatShare}%)`"
                color="neutral"
              />
              <UBadge
                :label="`Profit >0.2%: ${trailingProfitBuckets.gainCount} (${trailingProfitBuckets.gainShare}%)`"
                color="neutral"
              />
              <UBadge
                v-if="trailingMatchSourceCounts.closed_trail"
                :label="`closed_trail: ${trailingMatchSourceCounts.closed_trail}`"
                color="neutral"
              />
              <UBadge
                v-if="trailingMatchSourceCounts.trade_fallback"
                :label="`trade_fallback: ${trailingMatchSourceCounts.trade_fallback}`"
                color="neutral"
              />
              <UBadge
                v-if="trailingMatchSourceCounts.rpc_hint"
                :label="`rpc_hint: ${trailingMatchSourceCounts.rpc_hint}`"
                color="neutral"
              />
              <UBadge
                v-if="trailingMatchSourceCounts.trade_only"
                :label="`trade_only: ${trailingMatchSourceCounts.trade_only}`"
                color="neutral"
              />
            </div>

            <!-- Trailing Benefit Chart -->
            <div v-if="filteredTrailingTradeRows.length" class="space-y-1">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-3 text-xs text-surface-400">
                  <span>{{ trailingChartSeriesLabel }}</span>
                  <span>{{ trailingChartDateRangeLabel }}</span>
                </div>
                <USelect
                  v-model="trailingChartMetric"
                  :items="trailingChartMetricOptions"
                  size="sm"
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
                  >
                    {{ tick.label }}
                  </text>
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
                <text x="8" y="24" fill="#94a3b8" font-size="11">
                  {{ trailingChartMetric === 'profit' ? '%' : 'min' }}
                </text>
                <text x="450" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">
                  Trade open date
                </text>
                <!-- X-axis tick labels -->
                <text
                  v-for="(tick, idx) in trailingChartXTicks"
                  :key="`ttx-${idx}`"
                  :x="tick.x"
                  y="245"
                  text-anchor="middle"
                  fill="#94a3b8"
                  font-size="10"
                >
                  {{ tick.label }}
                </text>
                <!-- Dots per trade, colored by positive/negative -->
                <circle
                  v-for="(point, idx) in trailingChartCoordinates"
                  :key="`tc-${idx}`"
                  :cx="point.x"
                  :cy="point.y"
                  r="4"
                  :fill="
                    point.value === null
                      ? '#475569'
                      : trailingChartMetric === 'profit'
                        ? point.positive
                          ? '#34d399'
                          : '#f87171'
                        : '#60a5fa'
                  "
                  class="cursor-pointer"
                  @mousemove="
                    showChartTooltip($event, [
                      `Trade #${point.tradeId} · ${point.pair}`,
                      point.at,
                      trailingChartMetric === 'profit'
                        ? point.value !== null
                          ? `Profit: ${point.value.toFixed(2)}%`
                          : 'Profit: n/a'
                        : point.value !== null
                          ? `Duration: ${point.value.toFixed(1)} min`
                          : 'Duration: n/a',
                    ])
                  "
                  @mouseleave="hideChartTooltip"
                >
                  <title>{{ `Trade #${point.tradeId} · ${point.pair} · ${point.at}` }}</title>
                </circle>
              </svg>
            </div>

            <div v-if="!filteredTrailingTradeRows.length" class="text-sm text-surface-400">
              {{
                loadingTrailingBenefit
                  ? 'Loading trailing benefit report...'
                  : 'No trailing trades found for current filters.'
              }}
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
                    <th class="py-2 pe-2">Trailing profit %</th>
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
                        <div class="text-xs text-surface-400">
                          {{ getBotContainerName(row.botId) }} · ID {{ row.botId }}
                        </div>
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.pair }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.side }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">{{ row.enterTag ?? '—' }}</td>
                      <td class="py-2 pe-2 whitespace-nowrap">
                        {{ row.openDate ? formatDate(row.openDate) : '—' }}
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">
                        {{
                          row.snapshotProfitPct === null
                            ? '—'
                            : `${row.snapshotProfitPct.toFixed(2)}%`
                        }}
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">
                        {{
                          row.snapshotOffsetPct === null
                            ? '—'
                            : `${row.snapshotOffsetPct.toFixed(2)}%`
                        }}
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">
                        {{
                          row.snapshotDurationMinutes === null
                            ? '—'
                            : row.snapshotDurationMinutes.toFixed(1)
                        }}
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">
                        {{
                          row.snapshotStartValue === null ? '—' : row.snapshotStartValue.toFixed(4)
                        }}
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">
                        {{
                          row.snapshotCurrentValue === null
                            ? '—'
                            : row.snapshotCurrentValue.toFixed(4)
                        }}
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">
                        {{
                          row.snapshotLowLimitValue === null
                            ? '—'
                            : row.snapshotLowLimitValue.toFixed(4)
                        }}
                      </td>
                      <td class="py-2 pe-2 whitespace-nowrap">
                        {{
                          row.snapshotUpLimitValue === null
                            ? '—'
                            : row.snapshotUpLimitValue.toFixed(4)
                        }}
                      </td>
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
                                <td class="py-1 pe-2 whitespace-nowrap">
                                  {{
                                    log.profitPct === null ? '—' : `${log.profitPct.toFixed(2)}%`
                                  }}
                                </td>
                                <td class="py-1 pe-2 whitespace-nowrap">
                                  {{
                                    log.offsetPct === null ? '—' : `${log.offsetPct.toFixed(2)}%`
                                  }}
                                </td>
                                <td class="py-1 pe-2 whitespace-nowrap">
                                  {{
                                    log.durationMinutes === null
                                      ? '—'
                                      : log.durationMinutes.toFixed(1)
                                  }}
                                </td>
                                <td class="py-1 pe-2 whitespace-nowrap">
                                  {{ log.startValue === null ? '—' : log.startValue.toFixed(4) }}
                                </td>
                                <td class="py-1 pe-2 whitespace-nowrap">
                                  {{
                                    log.currentValue === null ? '—' : log.currentValue.toFixed(4)
                                  }}
                                </td>
                                <td class="py-1 pe-2 whitespace-nowrap">
                                  {{
                                    log.lowLimitValue === null ? '—' : log.lowLimitValue.toFixed(4)
                                  }}
                                </td>
                                <td class="py-1 pe-2 whitespace-nowrap">
                                  {{
                                    log.upLimitValue === null ? '—' : log.upLimitValue.toFixed(4)
                                  }}
                                </td>
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

          <!-- ═══ BOT PERFORMANCE ANALYSIS ═══ -->
          <div
            v-if="selectedSubCategory === 'bot-performance'"
            class="border border-surface-400 rounded-sm p-4 space-y-4"
          >
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
                        {{
                          botPerfSortCol === 'total_closed_trades'
                            ? botPerfSortAsc
                              ? '↑'
                              : '↓'
                            : ''
                        }}
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
                        {{
                          botPerfSortCol === 'avg_profit_pct' ? (botPerfSortAsc ? '↑' : '↓') : ''
                        }}
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
                        {{
                          botPerfSortCol === 'total_profit_abs' ? (botPerfSortAsc ? '↑' : '↓') : ''
                        }}
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
                        {{
                          botPerfSortCol === 'avg_duration_hours'
                            ? botPerfSortAsc
                              ? '↑'
                              : '↓'
                            : ''
                        }}
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
                        {{
                          botPerfSortCol === 'avg_dca_orders' ? (botPerfSortAsc ? '↑' : '↓') : ''
                        }}
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
                        {{
                          botPerfSortCol === 'trades_per_day' ? (botPerfSortAsc ? '↑' : '↓') : ''
                        }}
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
                            :class="
                              row.best_pair_profit_abs >= 0 ? 'text-green-500' : 'text-red-400'
                            "
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
                        <div class="text-surface-500 font-normal">
                          {{ row.wins }}/{{ row.losses }}
                        </div>
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
                        {{ row.total_profit_abs >= 0 ? '+' : ''
                        }}{{ row.total_profit_abs.toFixed(2) }}
                      </td>
                      <td class="py-2 pe-3 text-right font-mono text-xs text-surface-300">
                        {{
                          row.avg_duration_hours !== null
                            ? `${Math.floor(row.avg_duration_hours)}:${String(Math.round((row.avg_duration_hours % 1) * 60)).padStart(2, '0')}h`
                            : '—'
                        }}
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
                  Score = avg profit% × 2 − avg duration × 0.1 − (avg DCA − 1) × 1. Higher is
                  better. Green ≥ 8 · Yellow ≥ 3 · Red &lt; 3.
                </p>
              </div>

              <!-- Performance tab -->
              <div v-if="botPerfActiveTab === 'performance'" class="space-y-3">
                <div class="flex items-center justify-between flex-wrap gap-2">
                  <p class="text-xs text-surface-400 italic">
                    <template v-if="botPerfProjectionMode === 'usdt'">
                      Linear extrapolation from closed trade history within the selected date range.
                      Based on total PnL ÷ days active. Past performance does not predict future
                      results.
                    </template>
                    <template v-else-if="botPerfProjectionMode === 'pct'">
                      Daily PnL as % of starting capital. Linear extrapolation. Past performance
                      does not predict future results.
                    </template>
                    <template v-else>
                      Compounded daily rate: (1 + daily%)^N − 1. Assumes profits reinvested. Past
                      performance does not predict future results.
                    </template>
                  </p>
                  <div class="flex items-center gap-2 shrink-0">
                    <div
                      class="flex gap-0 rounded border border-surface-600 overflow-hidden text-xs"
                    >
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
                    <div
                      v-if="botPerfProjectionMode !== 'usdt'"
                      class="flex items-center gap-1 text-xs"
                    >
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
                          {{
                            botPerfProjectionMode === 'usdt' ? 'Daily est. USDT' : 'Daily est. %'
                          }}
                        </th>
                        <th class="py-2 pe-3 whitespace-nowrap text-right">
                          {{
                            botPerfProjectionMode === 'usdt'
                              ? 'Monthly est. USDT'
                              : 'Monthly est. %'
                          }}
                        </th>
                        <th class="py-2 pe-3 whitespace-nowrap text-right">
                          {{
                            botPerfProjectionMode === 'usdt' ? 'Yearly est. USDT' : 'Yearly est. %'
                          }}
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
                          <div class="text-surface-500 font-normal">
                            {{ row.wins }}/{{ row.losses }}
                          </div>
                        </td>
                        <td
                          class="py-2 pe-3 text-right font-mono text-xs"
                          :class="row.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'"
                        >
                          {{ row.avg_profit_pct >= 0 ? '+' : ''
                          }}{{ row.avg_profit_pct.toFixed(2) }}%
                        </td>
                        <td
                          class="py-2 pe-3 text-right font-mono text-xs font-semibold"
                          :class="row.total_profit_abs >= 0 ? 'text-green-400' : 'text-red-400'"
                        >
                          {{ row.total_profit_abs >= 0 ? '+' : ''
                          }}{{ row.total_profit_abs.toFixed(2) }}
                        </td>
                        <td class="py-2 pe-3 text-right font-mono text-xs text-surface-300">
                          {{
                            row.avg_duration_hours !== null
                              ? `${Math.floor(row.avg_duration_hours)}:${String(Math.round((row.avg_duration_hours % 1) * 60)).padStart(2, '0')}h`
                              : '—'
                          }}
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
                            :class="
                              (row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                            "
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
                              (row.monthly_projected_usdt ?? 0) >= 0
                                ? 'text-green-400'
                                : 'text-red-400'
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
                              (row.yearly_projected_usdt ?? 0) >= 0
                                ? 'text-green-400'
                                : 'text-red-400'
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
                            :class="
                              (row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                            "
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
                              (row.monthly_projected_usdt ?? 0) >= 0
                                ? 'text-green-400'
                                : 'text-red-400'
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
                              (row.yearly_projected_usdt ?? 0) >= 0
                                ? 'text-green-400'
                                : 'text-red-400'
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
                            :class="
                              (row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                            "
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
                              (row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                            "
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
                            :class="
                              (row.daily_profit_usdt ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                            "
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
                      >Score = avg profit% × 2 − avg duration × 0.1 − (avg DCA − 1) × 1, computed
                      over the trailing 7 days of closed trades.</template
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
