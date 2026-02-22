<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { vpsApi } from '@/composables/vpsApi';
import type { DwhAnomaly, DwhIngestionRun, DwhIngestionRunResult } from '@/types/vps';

type ReportCategory = 'system' | 'trades';
type MissedTradeReasonCode =
  | 'funding_rate_unfavorable'
  | 'funding_rate_too_low'
  | 'funding_rate_guard'
  | 'strategy_user_deny'
  | 'trade_rejected'
  | 'other';

interface ReportOption {
  value: string;
  label: string;
  todo: string;
}

interface TimelinePoint {
  at: string;
  count: number;
}

interface IngestTimelinePoint {
  at: string;
  insertedLogs: number;
  updatedAnomalies: number;
  botsFailed: number;
  status: DwhIngestionRun['status'];
}

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

const MISSED_TRADE_REASON_LABELS: Record<MissedTradeReasonCode, string> = {
  funding_rate_unfavorable: 'Unfavorable funding rate',
  funding_rate_too_low: 'Funding rate too low',
  funding_rate_guard: 'Funding rate filter',
  strategy_user_deny: 'Strategy/user deny',
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
      value: 'dwh-ingest-health',
      label: 'DWH ingest timeline',
      todo: 'DWH ingestion run timeline from backend run history.',
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
const missedTradeEvents = ref<ParsedLogEvent[]>([]);
const systemDays = ref(7);
const missedDays = ref(7);
const missedFilterBotId = ref<number | null>(null);
const missedFilterPair = ref('');
const selectedReasonFilters = ref<MissedTradeReasonCode[]>([]);
const loadingSystemTimeline = ref(false);
const loadingIngestTimeline = ref(false);
const loadingMissedTrades = ref(false);
const reportsError = ref('');
const systemLoaded = ref(false);
const ingestLoaded = ref(false);
const missedLoaded = ref(false);

const selectedCategory = ref<ReportCategory>('system');
const selectedSubCategory = ref('system-errors');

const availableSubCategories = computed(() => subCategoryOptionsByCategory[selectedCategory.value]);

const selectedSubCategoryDefinition = computed(() => {
  return availableSubCategories.value.find((item) => item.value === selectedSubCategory.value);
});

const maxSystemErrorCount = computed(() => {
  return Math.max(...systemErrorTimelinePoints.value.map((point) => point.count), 1);
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

const totalSystemErrorCount = computed(() => {
  return systemErrorTimelinePoints.value.reduce((sum, point) => sum + point.count, 0);
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

function classifyMissedTradeReason(message: string): {
  reasonCode: MissedTradeReasonCode;
  reason: string;
} {
  const loweredMessage = message.toLowerCase();
  if (loweredMessage.includes('unfavorable funding rate')) {
    return {
      reasonCode: 'funding_rate_unfavorable',
      reason: MISSED_TRADE_REASON_LABELS.funding_rate_unfavorable,
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
  if (loweredMessage.includes('user denied entry')) {
    return {
      reasonCode: 'strategy_user_deny',
      reason: MISSED_TRADE_REASON_LABELS.strategy_user_deny,
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
  const match = message.match(/(-?\d+(?:\.\d+)?)%\s*<\s*(-?\d+(?:\.\d+)?)%/);
  if (match) {
    return `Funding rate ${match[1]}% below limit ${match[2]}%`;
  }

  if (loweredMessage.includes('user denied entry')) {
    return 'Entry denied by strategy/user rule';
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
      .map(([at, count]) => ({ at: formatDate(at), count }))
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
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
        updatedAnomalies: result.updated_anomalies,
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

function isMissedTradeSignature(item: DwhAnomaly): boolean {
  const text = `${item.signature} ${item.logger}`.toLowerCase();
  return (
    text.includes('trade rejected') ||
    text.includes('user denied entry') ||
    text.includes('funding rate') ||
    text.includes('unfavorable')
  );
}

async function loadMissedTradesReport() {
  loadingMissedTrades.value = true;
  reportsError.value = '';
  try {
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
        const isMissed =
          loweredMessage.includes('trade rejected') ||
          loweredMessage.includes('user denied entry') ||
          loweredMessage.includes('funding rate');
        if (!isMissed) {
          continue;
        }

        const event: ParsedLogEvent = {
          eventTs: sample.event_ts,
          at: formatDate(sample.event_ts),
          level: sample.level,
          logger: sample.logger,
          message: sample.message,
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
  if (subCategory === 'dwh-ingest-health' && !ingestLoaded.value) {
    await loadDwhIngestTimeline();
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
  <div class="mx-auto mt-3 p-4 max-w-7xl flex flex-col gap-4">
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
            <div v-else class="space-y-2">
              <div
                v-for="point in systemErrorTimelinePoints"
                :key="point.at"
                class="grid grid-cols-[10rem_1fr_3rem] items-center gap-3 text-sm"
              >
                <span class="text-surface-500">{{ point.at }}</span>
                <div class="h-3 rounded bg-surface-700 overflow-hidden">
                  <div
                    class="h-full bg-red-500"
                    :style="{ width: `${(point.count / maxSystemErrorCount) * 100}%` }"
                  />
                </div>
                <span class="text-right">{{ point.count }}</span>
              </div>
            </div>
          </div>

          <div
            v-if="selectedSubCategory === 'dwh-ingest-health'"
            class="border border-surface-400 rounded-sm p-4 space-y-3"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h5 class="font-semibold">DWH Ingest Timeline (run history)</h5>
              <Button
                label="Refresh"
                size="small"
                severity="secondary"
                outlined
                :loading="loadingIngestTimeline"
                @click="loadDwhIngestTimeline"
              />
            </div>

            <div v-if="!dwhIngestTimeline.length" class="text-sm text-surface-400">
              {{ loadingIngestTimeline ? 'Loading ingest history...' : 'No ingest runs found.' }}
            </div>

            <div v-else class="overflow-x-auto">
              <table class="w-full text-sm border-collapse">
                <thead>
                  <tr class="border-b border-surface-600 text-left">
                    <th class="py-2 pe-2">Started</th>
                    <th class="py-2 pe-2">Status</th>
                    <th class="py-2 pe-2">Inserted logs</th>
                    <th class="py-2 pe-2">Updated anomalies</th>
                    <th class="py-2">Bots failed</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(run, idx) in dwhIngestTimeline"
                    :key="`${run.at}-${idx}`"
                    class="border-b border-surface-700/70 align-top"
                  >
                    <td class="py-2 pe-2 whitespace-nowrap">{{ run.at }}</td>
                    <td class="py-2 pe-2 whitespace-nowrap">{{ run.status }}</td>
                    <td class="py-2 pe-2 whitespace-nowrap">{{ run.insertedLogs }}</td>
                    <td class="py-2 pe-2 whitespace-nowrap">{{ run.updatedAnomalies }}</td>
                    <td class="py-2 whitespace-nowrap">{{ run.botsFailed }}</td>
                  </tr>
                </tbody>
              </table>
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
              <Tag :value="`Total events: ${parsedMissedTradeEvents.length}`" severity="contrast" />
            </div>

            <div v-if="!parsedMissedTradeEvents.length" class="text-sm text-surface-400">
              {{ loadingMissedTrades ? 'Loading missed trades...' : 'No missed trade events found.' }}
            </div>

            <div v-else class="overflow-x-auto">
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
                    <td class="py-2 pe-2 whitespace-nowrap">{{ event.botId }}</td>
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
        </div>
      </template>
    </Card>
  </div>
</template>