<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { todayStr, dateFromToDays } from '@/utils/reportDates';
import { formatDate, extractPairFlexible } from '@/utils/reportParsers';
import { logsChartLayout } from '@/utils/reportCharts';
import { timestampShort } from '@/utils/formatters/timeformat';
import type { DwhTrade } from '@/types/vps';

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

type TrailingChartMetric = 'profit' | 'duration';

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

interface TrailingChartPoint {
  at: string;
  tradeId: number;
  pair: string;
  profit: number | null;
  duration: number | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const trailingChartMetricOptions: { label: string; value: TrailingChartMetric }[] = [
  { label: 'Trailing profit %', value: 'profit' },
  { label: 'Duration (min)', value: 'duration' },
];

const trailingAnalysisQuery = `# Run this in a terminal to get full trailing entry analysis for Printer.py tuning:

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
# Params in Printer.py lines ~347-366. After changes bump _VERSION to DD.MM.YYYY - Printer, commit+push in /home/ubuntu/ft_userdata.`;

// ─── State ─────────────────────────────────────────────────────────────────

const trailingChartMetric = ref<TrailingChartMetric>('profit');
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
const loadingTrailingBenefit = ref(false);
const showTrailingAnalysisQuery = ref(false);
const trailingLoaded = ref(false);

// ─── Helpers ───────────────────────────────────────────────────────────────

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

async function loadTrailingTrades(dateFrom: string, dateTo: string): Promise<DwhTrade[]> {
  const pageSize = 500;
  const collected: DwhTrade[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  // Fetch by explicit date window (server-side filtered), NOT a newest-first
  // `days` window capped at 2000 rows — that cap silently dropped the oldest
  // trades in wide/historical ranges (showing partial or empty results). The
  // loop is bounded by the server's `total`, so it terminates.
  while (offset < total) {
    const page = await vpsApi.dwhTrades({
      date_from: dateFrom,
      date_to: dateTo,
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

// ─── Computeds ─────────────────────────────────────────────────────────────

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

// ─── Functions ─────────────────────────────────────────────────────────────

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

    // Date window (UTC, [from, to] inclusive of the whole to-day) — mirrors the backend
    // report convention so the To picker actually narrows the result set.
    const windowFromMs = new Date(trailingDateFrom.value).getTime();
    const windowToMs = new Date(trailingDateTo.value).getTime() + 86_400_000;
    const closeDateInWindow = (closeDate: string | null): boolean => {
      if (!closeDate) return false;
      const t = new Date(closeDate).getTime();
      return t >= windowFromMs && t < windowToMs;
    };

    // Step 1: Fetch trades FIRST (reversed data flow)
    const allTrades = await loadTrailingTrades(trailingDateFrom.value, trailingDateTo.value);
    const closedTrailTrades = allTrades.filter(
      (trade) =>
        !trade.is_open && isTrailEnterTag(trade.enter_tag) && closeDateInWindow(trade.close_date),
    );

    // Step 2: Fetch trailing logs per bot via direct audit message queries
    // (replaces anomaly signature → samples approach for full coverage)
    const uniqueBotIds = [...new Set(closedTrailTrades.map((t) => t.bot_id))];
    // Cover the full selected window — trades are fetched uncapped over the same span, so a
    // fixed 720h (30d) cap here left trades older than 30d with blank trailing snapshots
    // (they read as "no trailing data"). Audit fetch paginates, so wider ranges just page more.
    const hours = trailingDaysComputed * 24;
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
      dedupe.set(`${msg.bot_id}|${msg.event_ts}|${msg.logger}|${msg.message}`, event);
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

onMounted(() => {
  if (!trailingLoaded.value) {
    void loadTrailingBenefitReport();
  }
});
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <!-- Analysis query (collapsible) -->
    <div>
      <button
        class="text-xs text-surface-400 hover:text-surface-200 underline"
        @click="showTrailingAnalysisQuery = !showTrailingAnalysisQuery"
      >
        {{ showTrailingAnalysisQuery ? '▲ Hide analysis query' : '▼ Show analysis query' }}
      </button>
      <pre
        v-if="showTrailingAnalysisQuery"
        class="mt-2 text-xs bg-surface-900 border border-surface-700 rounded p-3 overflow-x-auto whitespace-pre-wrap select-all"
        >{{ trailingAnalysisQuery }}</pre
      >
    </div>

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
        <UInput v-model="trailingFilterContainer" size="sm" class="w-36" placeholder="Container" />
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
      <UBadge :label="`Avg trailing duration: ${trailingAvgDurationMinutes}`" color="warning" />
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
                {{ row.snapshotProfitPct === null ? '—' : `${row.snapshotProfitPct.toFixed(2)}%` }}
              </td>
              <td class="py-2 pe-2 whitespace-nowrap">
                {{ row.snapshotOffsetPct === null ? '—' : `${row.snapshotOffsetPct.toFixed(2)}%` }}
              </td>
              <td class="py-2 pe-2 whitespace-nowrap">
                {{
                  row.snapshotDurationMinutes === null
                    ? '—'
                    : row.snapshotDurationMinutes.toFixed(1)
                }}
              </td>
              <td class="py-2 pe-2 whitespace-nowrap">
                {{ row.snapshotStartValue === null ? '—' : row.snapshotStartValue.toFixed(4) }}
              </td>
              <td class="py-2 pe-2 whitespace-nowrap">
                {{ row.snapshotCurrentValue === null ? '—' : row.snapshotCurrentValue.toFixed(4) }}
              </td>
              <td class="py-2 pe-2 whitespace-nowrap">
                {{
                  row.snapshotLowLimitValue === null ? '—' : row.snapshotLowLimitValue.toFixed(4)
                }}
              </td>
              <td class="py-2 pe-2 whitespace-nowrap">
                {{ row.snapshotUpLimitValue === null ? '—' : row.snapshotUpLimitValue.toFixed(4) }}
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
                          {{ log.profitPct === null ? '—' : `${log.profitPct.toFixed(2)}%` }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap">
                          {{ log.offsetPct === null ? '—' : `${log.offsetPct.toFixed(2)}%` }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap">
                          {{ log.durationMinutes === null ? '—' : log.durationMinutes.toFixed(1) }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap">
                          {{ log.startValue === null ? '—' : log.startValue.toFixed(4) }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap">
                          {{ log.currentValue === null ? '—' : log.currentValue.toFixed(4) }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap">
                          {{ log.lowLimitValue === null ? '—' : log.lowLimitValue.toFixed(4) }}
                        </td>
                        <td class="py-1 pe-2 whitespace-nowrap">
                          {{ log.upLimitValue === null ? '—' : log.upLimitValue.toFixed(4) }}
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
</template>
