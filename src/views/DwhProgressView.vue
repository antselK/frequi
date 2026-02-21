<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import { vpsApi } from '@/composables/vpsApi';
import type {
  DwhAlertConfig,
  DwhAlertStatus,
  DwhAnomaly,
  DwhAnomalySample,
  DwhAnomalyTrendPoint,
  DwhIngestionRun,
  DwhIngestionRunResult,
  DwhRunAnomaly,
  DwhTrade,
  DwhTradeTimeline,
  DwhRetentionConfig,
  DwhIngestionStatus,
  DwhRetentionRunResult,
  DwhRollupCompactionConfig,
  DwhRollupCompactionRunResult,
  DwhSummary,
} from '@/types/vps';

const summary = ref<DwhSummary | null>(null);
const loading = ref(false);
const running = ref(false);
const errorText = ref('');
const runResult = ref<DwhIngestionRunResult | null>(null);
const runAsyncMode = ref(true);
const asyncStatus = ref<DwhIngestionStatus | null>(null);
const runHistory = ref<DwhIngestionRun[]>([]);
const expandedRunId = ref<number | null>(null);
const showFailedOnly = ref(false);
const runAnomalies = ref<Record<number, DwhRunAnomaly[]>>({});
const loadingRunAnomalies = ref<Record<number, boolean>>({});
const retentionConfig = ref<DwhRetentionConfig | null>(null);
const retentionDays = ref(180);
const retentionRunning = ref(false);
const retentionResult = ref<DwhRetentionRunResult | null>(null);
const rollupCompactionConfig = ref<DwhRollupCompactionConfig | null>(null);
const rollupDays = ref(30);
const compactLogDays = ref(14);
const compactMessageMaxLen = ref(240);
const rollupCompactionRunning = ref(false);
const rollupCompactionResult = ref<DwhRollupCompactionRunResult | null>(null);
const trades = ref<DwhTrade[]>([]);
const tradesTotal = ref(0);
const tradesLoading = ref(false);
const tradeDays = ref(30);
const tradeBotId = ref<number | null>(null);
const tradePair = ref('');
const tradeStrategy = ref('');
const tradeExitReason = ref('');
const tradeLimit = ref(25);
const expandedTradeId = ref<number | null>(null);
const tradeTimelines = ref<Record<number, DwhTradeTimeline>>({});
const loadingTradeTimeline = ref<Record<number, boolean>>({});
const anomalies = ref<DwhAnomaly[]>([]);
const anomaliesLoading = ref(false);
const anomaliesDays = ref(30);
const selectedAnomalyHash = ref<string | null>(null);
const anomalyTrend = ref<DwhAnomalyTrendPoint[]>([]);
const anomalySamples = ref<DwhAnomalySample[]>([]);
const anomalyDetailLoading = ref(false);
const alertConfig = ref<DwhAlertConfig | null>(null);
const alertStatus = ref<DwhAlertStatus | null>(null);
const alertLoading = ref(false);
const showSettingsModal = ref(false);

let refreshTimer: number | null = null;
let statusPollTimer: number | null = null;

const cards = computed(() => {
  const data = summary.value;
  if (!data) {
    return [];
  }
  return [
    { label: 'Bots', value: data.bots_total },
    { label: 'Checkpoints', value: `${data.checkpoints_success}/${data.checkpoints_total}` },
    { label: 'Trades', value: data.trade_rows },
    { label: 'Orders', value: data.order_rows },
    { label: 'Log Events', value: data.log_event_rows },
    { label: 'Anomalies', value: data.anomaly_rows },
  ];
});

const runErrors = computed(() => runResult.value?.errors ?? []);

const nextAutoRetentionText = computed(() => {
  if (!retentionConfig.value?.enabled) {
    return 'off';
  }
  const next = retentionConfig.value.next_auto_run_at;
  if (!next) {
    return 'n/a';
  }

  const nextDate = new Date(next);
  if (Number.isNaN(nextDate.getTime())) {
    return 'n/a';
  }

  const diffMs = nextDate.getTime() - Date.now();
  const minutes = Math.max(0, Math.ceil(diffMs / 60000));
  return `~${minutes} min`;
});

const nextAutoRollupText = computed(() => {
  if (!rollupCompactionConfig.value?.enabled) {
    return 'off';
  }
  const next = rollupCompactionConfig.value.next_auto_run_at;
  if (!next) {
    return 'n/a';
  }

  const nextDate = new Date(next);
  if (Number.isNaN(nextDate.getTime())) {
    return 'n/a';
  }

  const diffMs = nextDate.getTime() - Date.now();
  const minutes = Math.max(0, Math.ceil(diffMs / 60000));
  return `~${minutes} min`;
});

const visibleRunHistory = computed(() => {
  if (!showFailedOnly.value) {
    return runHistory.value;
  }
  return runHistory.value.filter((run) => run.status === 'failed');
});

const asyncStatusBadgeClass = computed(() => {
  const status = asyncStatus.value?.status;
  if (status === 'running') {
    return 'bg-yellow-900/40 text-yellow-300 border-yellow-700';
  }
  if (status === 'finished') {
    return 'bg-green-900/40 text-green-300 border-green-700';
  }
  if (status === 'failed') {
    return 'bg-red-900/40 text-red-300 border-red-700';
  }
  return 'bg-surface-700 text-surface-200 border-surface-600';
});

async function syncAsyncStatus() {
  asyncStatus.value = await vpsApi.dwhIngestionStatus();
  if (asyncStatus.value.result) {
    runResult.value = asyncStatus.value.result;
  }
  if (asyncStatus.value.status === 'failed' && asyncStatus.value.error) {
    errorText.value = asyncStatus.value.error;
  }
}

async function loadRunHistory() {
  const history = await vpsApi.dwhIngestionRuns(20);
  runHistory.value = history;

  if (!history.length) {
    expandedRunId.value = null;
    return;
  }

  if (expandedRunId.value && history.some((run) => run.id === expandedRunId.value)) {
    return;
  }

  const newestFailed = history.find((run) => run.status === 'failed');
  expandedRunId.value = newestFailed ? newestFailed.id : null;
}

async function loadRetentionConfig() {
  retentionConfig.value = await vpsApi.dwhRetentionConfig();
}

async function loadRollupCompactionConfig() {
  rollupCompactionConfig.value = await vpsApi.dwhRollupCompactionConfig();
  rollupDays.value = rollupCompactionConfig.value.rollup_days;
  compactLogDays.value = rollupCompactionConfig.value.compact_log_days;
  compactMessageMaxLen.value = rollupCompactionConfig.value.message_max_len;
}

async function loadTrades() {
  tradesLoading.value = true;
  try {
    const normalizedDays = Number.isFinite(Number(tradeDays.value)) ? Math.max(0, Math.floor(Number(tradeDays.value))) : 0;
    const normalizedLimit = Number.isFinite(Number(tradeLimit.value)) ? Math.max(0, Math.floor(Number(tradeLimit.value))) : 0;
    const normalizedBotId = Number.isFinite(Number(tradeBotId.value)) ? Math.max(0, Math.floor(Number(tradeBotId.value))) : 0;

    tradeDays.value = normalizedDays;
    tradeLimit.value = normalizedLimit;
    tradeBotId.value = normalizedBotId > 0 ? normalizedBotId : null;

    const data = await vpsApi.dwhTrades({
      days: normalizedDays,
      bot_id: normalizedBotId > 0 ? normalizedBotId : undefined,
      pair: tradePair.value.trim() || undefined,
      strategy: tradeStrategy.value.trim() || undefined,
      exit_reason: tradeExitReason.value.trim() || undefined,
      limit: normalizedLimit,
      offset: 0,
    });
    trades.value = data.items;
    tradesTotal.value = data.total;
  } catch (error) {
    errorText.value = String(error);
  } finally {
    tradesLoading.value = false;
  }
}

async function refreshAllData() {
  await loadSummary();
  await loadRunHistory();
  await loadTrades();
  await loadAnomalies();
  await loadAlerts();
  await loadRetentionConfig();
  await loadRollupCompactionConfig();
}

async function loadAlerts() {
  alertLoading.value = true;
  try {
    const [config, status] = await Promise.all([
      vpsApi.dwhAlertConfig(),
      vpsApi.dwhAlertStatus(),
    ]);
    alertConfig.value = config;
    alertStatus.value = status;
  } catch (error) {
    errorText.value = String(error);
  } finally {
    alertLoading.value = false;
  }
}

async function loadAnomalies() {
  anomaliesLoading.value = true;
  try {
    anomaliesDays.value = normalizeIntInput(anomaliesDays.value, 30, 1, 3650);
    anomalies.value = await vpsApi.dwhAnomalies(anomaliesDays.value, 30);
    if (!anomalies.value.length) {
      selectedAnomalyHash.value = null;
      anomalyTrend.value = [];
      anomalySamples.value = [];
      return;
    }

    const hasSelected = selectedAnomalyHash.value
      ? anomalies.value.some((item) => item.signature_hash === selectedAnomalyHash.value)
      : false;
    if (!hasSelected) {
      selectedAnomalyHash.value = anomalies.value[0].signature_hash;
    }
    if (selectedAnomalyHash.value) {
      await loadAnomalyDetail(selectedAnomalyHash.value);
    }
  } catch (error) {
    errorText.value = String(error);
  } finally {
    anomaliesLoading.value = false;
  }
}

async function loadAnomalyDetail(signatureHash: string) {
  selectedAnomalyHash.value = signatureHash;
  anomalyDetailLoading.value = true;
  try {
    const [trend, samples] = await Promise.all([
      vpsApi.dwhAnomalyTrend(signatureHash, 7),
      vpsApi.dwhAnomalySamples(signatureHash, 15),
    ]);
    anomalyTrend.value = trend;
    anomalySamples.value = samples;
  } catch (error) {
    errorText.value = String(error);
    anomalyTrend.value = [];
    anomalySamples.value = [];
  } finally {
    anomalyDetailLoading.value = false;
  }
}

async function toggleTradeTimeline(tradeId: number) {
  expandedTradeId.value = expandedTradeId.value === tradeId ? null : tradeId;
  if (expandedTradeId.value === tradeId && tradeTimelines.value[tradeId] === undefined) {
    loadingTradeTimeline.value[tradeId] = true;
    try {
      tradeTimelines.value[tradeId] = await vpsApi.dwhTradeTimeline(tradeId, 120);
    } catch {
      tradeTimelines.value[tradeId] = {
        trade_id: tradeId,
        bot_id: 0,
        source_trade_id: 0,
        pair: null,
        open_date: null,
        close_date: null,
        items: [],
      };
    } finally {
      loadingTradeTimeline.value[tradeId] = false;
    }
  }
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = window.setInterval(async () => {
    try {
      await syncAsyncStatus();
      if (!asyncStatus.value || asyncStatus.value.status !== 'running') {
        stopStatusPolling();
        running.value = false;
        await refreshAllData();
      }
    } catch (pollError) {
      errorText.value = String(pollError);
      stopStatusPolling();
      running.value = false;
    }
  }, 3000);
}

function formatDate(value: string | null): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatRatio(value: number | null): string {
  if (value == null) {
    return '—';
  }
  return `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value: number | null): string {
  if (value == null) {
    return '—';
  }
  return value.toFixed(4);
}

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

function timelineConfidenceClass(value: string): string {
  if (value === 'high') {
    return 'bg-green-900/40 text-green-300 border-green-700';
  }
  if (value === 'medium') {
    return 'bg-yellow-900/40 text-yellow-300 border-yellow-700';
  }
  return 'bg-surface-700 text-surface-200 border-surface-600';
}

function checkpointStatusClass(status: string): string {
  if (status === 'ok') {
    return 'bg-green-900/40 text-green-300';
  }
  if (status === 'error') {
    return 'bg-red-900/40 text-red-300';
  }
  return 'bg-surface-700 text-surface-200';
}

async function toggleRunDetails(runId: number) {
  expandedRunId.value = expandedRunId.value === runId ? null : runId;
  if (expandedRunId.value === runId && runAnomalies.value[runId] === undefined) {
    loadingRunAnomalies.value[runId] = true;
    try {
      runAnomalies.value[runId] = await vpsApi.dwhRunAnomalies(runId, 20);
    } catch {
      runAnomalies.value[runId] = [];
    } finally {
      loadingRunAnomalies.value[runId] = false;
    }
  }
}

function runStatusClass(status: string): string {
  if (status === 'running') {
    return 'bg-yellow-900/40 text-yellow-300 border-yellow-700';
  }
  if (status === 'finished') {
    return 'bg-green-900/40 text-green-300 border-green-700';
  }
  if (status === 'failed') {
    return 'bg-red-900/40 text-red-300 border-red-700';
  }
  return 'bg-surface-700 text-surface-200 border-surface-600';
}

async function loadSummary() {
  loading.value = true;
  errorText.value = '';
  try {
    summary.value = await vpsApi.dwhSummary();
  } catch (error) {
    errorText.value = String(error);
  } finally {
    loading.value = false;
  }
}

async function runIngestion() {
  running.value = true;
  errorText.value = '';
  try {
    if (runAsyncMode.value) {
      const started = await vpsApi.runDwhIngestionAsync();
      if (!started.accepted) {
        errorText.value = 'Ingestion is already running.';
        running.value = false;
        await syncAsyncStatus();
        return;
      }
      await syncAsyncStatus();
      startStatusPolling();
      return;
    }

    runResult.value = await vpsApi.runDwhIngestion();
    await loadSummary();
    await loadRunHistory();
    await loadTrades();
    await loadAnomalies();
  } catch (error) {
    errorText.value = String(error);
    running.value = false;
  } finally {
    if (!runAsyncMode.value) {
      running.value = false;
    }
  }
}

async function runRetention() {
  retentionRunning.value = true;
  errorText.value = '';
  try {
    const fallbackDays = retentionConfig.value?.days ?? 180;
    retentionDays.value = normalizeIntInput(retentionDays.value, fallbackDays, 1, 3650);
    retentionResult.value = await vpsApi.runDwhRetention(retentionDays.value);
    await loadSummary();
    await loadRunHistory();
    await loadTrades();
    await loadAnomalies();
  } catch (error) {
    errorText.value = String(error);
  } finally {
    retentionRunning.value = false;
  }
}

async function runRollupCompaction() {
  rollupCompactionRunning.value = true;
  errorText.value = '';
  try {
    const fallbackRollupDays = rollupCompactionConfig.value?.rollup_days ?? 30;
    const fallbackCompactDays = rollupCompactionConfig.value?.compact_log_days ?? 14;
    const fallbackMessageLen = rollupCompactionConfig.value?.message_max_len ?? 240;

    rollupDays.value = normalizeIntInput(rollupDays.value, fallbackRollupDays, 1, 3650);
    compactLogDays.value = normalizeIntInput(compactLogDays.value, fallbackCompactDays, 1, 3650);
    compactMessageMaxLen.value = normalizeIntInput(compactMessageMaxLen.value, fallbackMessageLen, 50, 2000);

    rollupCompactionResult.value = await vpsApi.runDwhRollupCompaction(
      rollupDays.value,
      compactLogDays.value,
      compactMessageMaxLen.value,
    );
    await loadSummary();
    await loadAnomalies();
    await loadRollupCompactionConfig();
  } catch (error) {
    errorText.value = String(error);
  } finally {
    rollupCompactionRunning.value = false;
  }
}

onMounted(async () => {
  await loadSummary();
  await loadRunHistory();
  await loadTrades();
  await loadAnomalies();
  await loadAlerts();
  await loadRetentionConfig();
  await loadRollupCompactionConfig();
  try {
    await syncAsyncStatus();
    if (asyncStatus.value?.status === 'running') {
      running.value = true;
      startStatusPolling();
    }
  } catch {
    // Ignore status bootstrap errors and keep summary visible.
  }
  refreshTimer = window.setInterval(() => {
    loadSummary();
  }, 20000);
});

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  stopStatusPolling();
});
</script>

<template>
  <main class="p-4 md:p-6 space-y-4 min-h-screen bg-black text-surface-100">
    <section class="flex justify-end">
      <button
        class="px-3 py-2 rounded border border-surface-600 text-sm hover:bg-surface-800"
        @click="showSettingsModal = true"
      >
        Settings
      </button>
    </section>

    <section v-if="errorText" class="rounded border border-red-700 bg-red-950/40 text-red-300 p-3 text-sm">
      {{ errorText }}
    </section>

    <section class="grid grid-cols-2 lg:grid-cols-6 gap-3">
      <article v-for="card in cards" :key="card.label" class="rounded border border-surface-700 p-3 bg-surface-900">
        <p class="text-xs text-surface-400">{{ card.label }}</p>
        <p class="text-xl font-semibold">{{ card.value }}</p>
      </article>
    </section>

    <section v-if="retentionResult" class="rounded border border-surface-700 bg-surface-900 p-4">
      <h2 class="font-semibold mb-2">Retention Result</h2>
      <p class="text-sm text-surface-300">
        Deleted trades {{ retentionResult.deleted_trades }}, orders {{ retentionResult.deleted_orders }}, logs {{ retentionResult.deleted_log_events }}, anomalies {{ retentionResult.deleted_anomalies }}, runs {{ retentionResult.deleted_runs }}.
      </p>
    </section>

    <section v-if="rollupCompactionResult" class="rounded border border-surface-700 bg-surface-900 p-4">
      <h2 class="font-semibold mb-2">Rollup + Compaction Result</h2>
      <p class="text-sm text-surface-300">
        Upserted rollup rows {{ rollupCompactionResult.upserted_rollup_rows }}, deleted old rollup rows {{ rollupCompactionResult.deleted_rollup_rows }}, compacted log events {{ rollupCompactionResult.compacted_log_events }}.
      </p>
    </section>

    <section class="rounded border border-surface-700 bg-surface-900 p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="font-semibold">Trade Explorer</h2>
        <p class="text-xs text-surface-400">Showing {{ trades.length }} of {{ tradesTotal }} trades</p>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-6 gap-2">
        <input
          v-model.number="tradeDays"
          type="number"
          min="0"
          max="3650"
          class="px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
          placeholder="Days (0=all)"
        />
        <input
          v-model.number="tradeBotId"
          type="number"
          min="1"
          class="px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
          placeholder="Bot ID"
        />
        <input
          v-model="tradePair"
          type="text"
          class="px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
          placeholder="Pair"
        />
        <input
          v-model="tradeStrategy"
          type="text"
          class="px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
          placeholder="Strategy"
        />
        <input
          v-model="tradeExitReason"
          type="text"
          class="px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
          placeholder="Exit Reason"
        />
        <div class="flex gap-2">
          <input
            v-model.number="tradeLimit"
            type="number"
            min="0"
            max="500"
            class="w-20 px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
            placeholder="Limit (0=all)"
          />
          <button
            class="px-3 py-1 rounded border border-surface-600 text-sm hover:bg-surface-800 disabled:opacity-50"
            :disabled="tradesLoading"
            @click="loadTrades"
          >
            {{ tradesLoading ? 'Loading...' : 'Apply' }}
          </button>
        </div>
      </div>

      <div v-if="tradesLoading" class="text-sm text-surface-400">Loading trades...</div>
      <div v-else-if="!trades.length" class="text-sm text-surface-400">No trades matched current filters.</div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-surface-400 border-b border-surface-700">
              <th class="py-2 pe-2">Bot</th>
              <th class="py-2 pe-2">Trade</th>
              <th class="py-2 pe-2">Pair</th>
              <th class="py-2 pe-2">Strategy</th>
              <th class="py-2 pe-2">Exit</th>
              <th class="py-2 pe-2">Opened</th>
              <th class="py-2 pe-2">Closed</th>
              <th class="py-2 pe-2">Profit %</th>
              <th class="py-2 pe-2">Profit Abs</th>
              <th class="py-2">Anomalies</th>
              <th class="py-2">Timeline</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="trade in trades" :key="trade.id">
              <tr class="border-b border-surface-800">
                <td class="py-2 pe-2">
                  <div class="font-medium">{{ trade.vps_name || '—' }}</div>
                  <div class="text-xs text-surface-400">{{ trade.container_name || '—' }} · ID {{ trade.bot_id }}</div>
                </td>
                <td class="py-2 pe-2">#{{ trade.source_trade_id }}</td>
                <td class="py-2 pe-2">{{ trade.pair || '—' }}</td>
                <td class="py-2 pe-2">{{ trade.strategy || '—' }}</td>
                <td class="py-2 pe-2">{{ trade.exit_reason || (trade.is_open ? 'OPEN' : '—') }}</td>
                <td class="py-2 pe-2">{{ formatDate(trade.open_date) }}</td>
                <td class="py-2 pe-2">{{ formatDate(trade.close_date) }}</td>
                <td class="py-2 pe-2">{{ formatRatio(trade.profit_ratio) }}</td>
                <td class="py-2 pe-2">{{ formatNumber(trade.profit_abs) }}</td>
                <td class="py-2">{{ trade.anomaly_count }}</td>
                <td class="py-2">
                  <button
                    class="px-2 py-1 rounded border border-surface-600 text-xs hover:bg-surface-800"
                    @click="toggleTradeTimeline(trade.id)"
                  >
                    {{ expandedTradeId === trade.id ? 'Hide' : 'Show' }}
                  </button>
                </td>
              </tr>
              <tr v-if="expandedTradeId === trade.id" class="border-b border-surface-800 bg-surface-950/40">
                <td colspan="11" class="py-3 px-2">
                  <p v-if="loadingTradeTimeline[trade.id]" class="text-sm text-surface-400">Loading timeline...</p>
                  <div v-else-if="!(tradeTimelines[trade.id]?.items?.length)" class="text-sm text-surface-400">No timeline events found.</div>
                  <div v-else class="space-y-2 max-h-72 overflow-y-auto">
                    <div
                      v-for="(item, idx) in tradeTimelines[trade.id].items"
                      :key="`${trade.id}-tl-${idx}`"
                      class="rounded border border-surface-700 p-2 text-xs"
                    >
                      <div class="flex flex-wrap items-center gap-2 mb-1">
                        <span class="text-surface-300">{{ formatDate(item.ts) }}</span>
                        <span class="px-2 py-0.5 rounded border" :class="timelineConfidenceClass(item.confidence)">{{ item.confidence }}</span>
                        <span class="text-surface-200 font-semibold">{{ item.kind }}</span>
                        <span class="text-surface-100">{{ item.title }}</span>
                      </div>
                      <p v-if="item.details" class="text-surface-300 whitespace-pre-wrap break-words">{{ item.details }}</p>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <section class="rounded border border-surface-700 bg-surface-900 p-4">
      <div class="flex items-center justify-between gap-3 mb-2">
        <h2 class="font-semibold">Recent Ingestion Runs</h2>
        <label class="flex items-center gap-2 text-sm text-surface-300 whitespace-nowrap">
          <input v-model="showFailedOnly" type="checkbox" class="accent-primary" />
          Show failed only
        </label>
      </div>
      <div v-if="!visibleRunHistory.length" class="text-sm text-surface-400">No runs to display.</div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-surface-400 border-b border-surface-700">
              <th class="py-2 pe-2">ID</th>
              <th class="py-2 pe-2">Mode</th>
              <th class="py-2 pe-2">Status</th>
              <th class="py-2 pe-2">Started</th>
              <th class="py-2 pe-2">Finished</th>
              <th class="py-2 pe-2">Synced/Failed</th>
              <th class="py-2 pe-2">Actor</th>
              <th class="py-2">Details</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="run in visibleRunHistory" :key="run.id">
              <tr class="border-b border-surface-800">
                <td class="py-2 pe-2">#{{ run.id }}</td>
                <td class="py-2 pe-2">{{ run.mode }}</td>
                <td class="py-2 pe-2">
                  <span class="inline-flex items-center px-2 py-0.5 rounded border text-xs font-semibold" :class="runStatusClass(run.status)">
                    {{ run.status }}
                  </span>
                </td>
                <td class="py-2 pe-2">{{ formatDate(run.started_at) }}</td>
                <td class="py-2 pe-2">{{ formatDate(run.finished_at) }}</td>
                <td class="py-2 pe-2">{{ run.result ? `${run.result.bots_synced}/${run.result.bots_failed}` : '—' }}</td>
                <td class="py-2 pe-2">{{ run.actor || '—' }}</td>
                <td class="py-2">
                  <button
                    class="px-2 py-1 rounded border border-surface-600 text-xs hover:bg-surface-800"
                    @click="toggleRunDetails(run.id)"
                  >
                    {{ expandedRunId === run.id ? 'Hide' : 'Show' }}
                  </button>
                </td>
              </tr>
              <tr v-if="expandedRunId === run.id" class="border-b border-surface-800 bg-surface-950/40">
                <td colspan="8" class="py-3 px-2">
                  <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div class="rounded border border-surface-700 p-3">
                      <h3 class="font-semibold mb-1">Run Metrics</h3>
                      <p>Scanned: {{ run.result?.bots_scanned ?? 0 }}</p>
                      <p>Synced: {{ run.result?.bots_synced ?? 0 }}</p>
                      <p>Failed: {{ run.result?.bots_failed ?? 0 }}</p>
                      <p>Trades +{{ run.result?.inserted_trades ?? 0 }} / ~{{ run.result?.updated_trades ?? 0 }}</p>
                      <p>Orders +{{ run.result?.inserted_orders ?? 0 }} / ~{{ run.result?.updated_orders ?? 0 }}</p>
                      <p>Logs +{{ run.result?.inserted_log_events ?? 0 }}, anomalies ~{{ run.result?.updated_anomalies ?? 0 }}</p>
                    </div>
                    <div class="rounded border border-surface-700 p-3">
                      <h3 class="font-semibold mb-1">Errors</h3>
                      <p v-if="run.error" class="text-red-300 mb-1">{{ run.error }}</p>
                      <p v-if="!run.result?.errors?.length && !run.error" class="text-surface-400">No errors recorded.</p>
                      <ul v-else class="list-disc ms-5 space-y-1 text-red-300">
                        <li v-for="(entry, index) in run.result?.errors ?? []" :key="`${run.id}-${index}`">{{ entry }}</li>
                      </ul>
                    </div>
                    <div class="rounded border border-surface-700 p-3">
                      <h3 class="font-semibold mb-1">Top Anomalies In Run</h3>
                      <p v-if="loadingRunAnomalies[run.id]" class="text-surface-400">Loading...</p>
                      <p v-else-if="!(runAnomalies[run.id]?.length)" class="text-surface-400">No anomaly spikes found.</p>
                      <ul v-else class="space-y-1 text-surface-200">
                        <li v-for="(row, index) in runAnomalies[run.id]" :key="`${run.id}-a-${index}`" class="text-xs">
                          <span class="font-semibold">{{ row.occurrences }}x</span>
                          <span class="text-surface-400"> {{ row.level }} / {{ row.logger }} </span>
                          <span> {{ row.signature }} </span>
                        </li>
                      </ul>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="runResult" class="rounded border border-surface-700 bg-surface-900 p-4">
      <h2 class="font-semibold mb-2">Last Run Errors</h2>
      <p v-if="!runErrors.length" class="text-sm text-surface-400">No errors reported in the last run.</p>
      <ul v-else class="list-disc ms-5 space-y-1 text-sm text-red-300">
        <li v-for="(entry, index) in runErrors" :key="`${index}-${entry}`">{{ entry }}</li>
      </ul>
    </section>

    <section class="rounded border border-surface-700 bg-surface-900 p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold">Anomaly Trends + Samples</h2>
        <div class="flex items-center gap-2">
          <input
            v-model.number="anomaliesDays"
            type="number"
            min="1"
            max="3650"
            class="w-20 px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
          />
          <button
            class="px-3 py-1 rounded border border-surface-600 text-sm hover:bg-surface-800 disabled:opacity-50"
            :disabled="anomaliesLoading"
            @click="loadAnomalies"
          >
            {{ anomaliesLoading ? 'Loading...' : 'Refresh' }}
          </button>
        </div>
      </div>

      <div v-if="anomaliesLoading" class="text-sm text-surface-400">Loading anomalies...</div>
      <div v-else-if="!anomalies.length" class="text-sm text-surface-400">No anomaly data yet.</div>
      <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div class="rounded border border-surface-700 p-3 overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-surface-400 border-b border-surface-700">
                <th class="py-2 pe-2">Level</th>
                <th class="py-2 pe-2">Logger</th>
                <th class="py-2 pe-2">Count</th>
                <th class="py-2 pe-2">Signature</th>
                <th class="py-2">View</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in anomalies" :key="item.signature_hash" class="border-b border-surface-800">
                <td class="py-2 pe-2">{{ item.level }}</td>
                <td class="py-2 pe-2">{{ item.logger }}</td>
                <td class="py-2 pe-2">{{ item.occurrences }}</td>
                <td class="py-2 pe-2">{{ item.signature }}</td>
                <td class="py-2">
                  <button
                    class="px-2 py-1 rounded border border-surface-600 text-xs hover:bg-surface-800"
                    @click="loadAnomalyDetail(item.signature_hash)"
                  >
                    {{ selectedAnomalyHash === item.signature_hash ? 'Selected' : 'Show' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="rounded border border-surface-700 p-3 space-y-3">
          <h3 class="font-semibold">Selected Anomaly Detail</h3>
          <p v-if="anomalyDetailLoading" class="text-sm text-surface-400">Loading detail...</p>
          <template v-else>
            <div>
              <p class="text-xs text-surface-400 mb-1">Hourly trend (last 7d)</p>
              <div v-if="!anomalyTrend.length" class="text-sm text-surface-400">No trend points.</div>
              <div v-else class="max-h-40 overflow-y-auto space-y-1">
                <div v-for="(point, index) in anomalyTrend" :key="`trend-${index}`" class="text-xs text-surface-200">
                  {{ formatDate(point.bucket_ts) }} — {{ point.occurrences }}
                </div>
              </div>
            </div>
            <div>
              <p class="text-xs text-surface-400 mb-1">Recent samples</p>
              <div v-if="!anomalySamples.length" class="text-sm text-surface-400">No samples.</div>
              <div v-else class="max-h-56 overflow-y-auto space-y-2">
                <div v-for="(sample, index) in anomalySamples" :key="`sample-${index}`" class="rounded border border-surface-700 p-2 text-xs">
                  <p class="text-surface-300">{{ formatDate(sample.event_ts) }} · #{{ sample.bot_id }} · {{ sample.level }} · {{ sample.logger }}</p>
                  <p class="text-surface-100 whitespace-pre-wrap break-words">{{ sample.message }}</p>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </section>

    <section class="rounded border border-surface-700 bg-surface-900 p-4">
      <h2 class="font-semibold mb-2">Bot Checkpoints</h2>
      <div v-if="!summary?.checkpoints?.length" class="text-sm text-surface-400">No checkpoints yet.</div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-surface-400 border-b border-surface-700">
              <th class="py-2 pe-2">VPS</th>
              <th class="py-2 pe-2">Container</th>
              <th class="py-2 pe-2">Strategy</th>
              <th class="py-2 pe-2">Status</th>
              <th class="py-2 pe-2">Last Trade</th>
              <th class="py-2 pe-2">Last Order</th>
              <th class="py-2">Last Synced</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="checkpoint in summary.checkpoints" :key="`${checkpoint.bot_id}-${checkpoint.container_name}`" class="border-b border-surface-800">
              <td class="py-2 pe-2">{{ checkpoint.vps_name }}</td>
              <td class="py-2 pe-2">{{ checkpoint.container_name }}</td>
              <td class="py-2 pe-2">{{ checkpoint.strategy || '—' }}</td>
              <td class="py-2 pe-2">
                <span class="px-2 py-1 rounded text-xs font-medium" :class="checkpointStatusClass(checkpoint.last_status)">
                  {{ checkpoint.last_status }}
                </span>
              </td>
              <td class="py-2 pe-2">{{ checkpoint.last_trade_id }}</td>
              <td class="py-2 pe-2">{{ checkpoint.last_order_id }}</td>
              <td class="py-2">{{ formatDate(checkpoint.last_synced_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div
      v-if="showSettingsModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      @click.self="showSettingsModal = false"
    >
      <section class="w-full max-w-4xl rounded border border-surface-700 bg-surface-900 p-4 space-y-4 max-h-[90vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">DWH Settings</h2>
          <button class="px-3 py-1 rounded border border-surface-600 text-sm hover:bg-surface-800" @click="showSettingsModal = false">
            Close
          </button>
        </div>

        <section class="rounded border border-surface-700 p-3 space-y-2">
          <h3 class="font-semibold">Alerting</h3>
          <p v-if="alertLoading" class="text-sm text-surface-400">Loading alerting status...</p>
          <template v-else>
            <p class="text-sm text-surface-300">
              Enabled:
              <span class="font-semibold" :class="alertConfig?.enabled ? 'text-green-300' : 'text-yellow-300'">
                {{ alertConfig?.enabled ? 'on' : 'off' }}
              </span>
            </p>
            <p v-if="!alertConfig?.enabled" class="text-xs text-yellow-300">
              Alerting is disabled in this dev stage (no alerts are sent/logged automatically).
            </p>
            <p v-if="alertConfig" class="text-xs text-surface-400">
              Rules: bots_failed ≥ {{ alertConfig.bots_failed_threshold }}, anomaly spike ≥ {{ alertConfig.anomaly_occurrences_threshold }} in {{ alertConfig.anomaly_window_minutes }}m.
            </p>
            <p v-if="alertStatus" class="text-xs text-surface-400">
              Last evaluation: {{ formatDate(alertStatus.evaluated_at) }} · currently triggered: {{ alertStatus.triggered_count }}
            </p>
            <ul v-if="alertStatus?.enabled && alertStatus.alerts.length" class="list-disc ms-5 text-xs text-red-300 space-y-1">
              <li v-for="item in alertStatus.alerts" :key="item.key">{{ item.message }}</li>
            </ul>
          </template>
        </section>

        <section class="rounded border border-surface-700 p-3 space-y-2">
          <h3 class="font-semibold">Ingestion Controls</h3>
          <p class="text-sm text-surface-300">
            State:
            <span class="inline-flex items-center px-2 py-0.5 rounded border text-xs font-semibold ms-1" :class="asyncStatusBadgeClass">
              {{ asyncStatus?.status ?? 'idle' }}
            </span>
          </p>
          <p class="text-sm text-surface-300">Started: {{ formatDate(asyncStatus?.started_at ?? null) }}</p>
          <p class="text-sm text-surface-300">Finished: {{ formatDate(asyncStatus?.finished_at ?? null) }}</p>
          <div class="flex flex-wrap items-center gap-3 pt-1">
            <label class="flex items-center gap-2 text-sm text-surface-300 whitespace-nowrap">
              <input v-model="runAsyncMode" type="checkbox" class="accent-primary" :disabled="running" />
              Run async before start
            </label>
            <button
              class="px-3 py-2 rounded border border-surface-600 text-sm hover:bg-surface-800 disabled:opacity-50"
              :disabled="loading || running"
              @click="refreshAllData"
            >
              Refresh
            </button>
            <button
              class="px-3 py-2 rounded bg-primary text-primary-contrast text-sm disabled:opacity-50"
              :disabled="running"
              @click="runIngestion"
            >
              {{ running ? 'Running...' : 'Run Ingestion Now' }}
            </button>
          </div>
        </section>

        <section class="rounded border border-surface-700 p-3 space-y-2">
          <h3 class="font-semibold">Retention</h3>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model.number="retentionDays"
              type="number"
              min="1"
              max="3650"
              class="w-24 px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
            />
            <button
              class="px-3 py-2 rounded border border-surface-600 text-sm hover:bg-surface-800 disabled:opacity-50"
              :disabled="retentionRunning"
              @click="runRetention"
            >
              {{ retentionRunning ? 'Cleaning...' : 'Run Cleanup' }}
            </button>
          </div>
          <p class="text-xs text-surface-400">Delete DWH rows older than selected days.</p>
          <p v-if="retentionConfig" class="text-xs text-surface-400">
            Auto: {{ retentionConfig.enabled ? 'on' : 'off' }} · {{ retentionConfig.days }}d · every {{ retentionConfig.interval_minutes }}m · next {{ nextAutoRetentionText }}
          </p>
        </section>

        <section class="rounded border border-surface-700 p-3 space-y-2">
          <h3 class="font-semibold">Rollups + Compaction</h3>
          <div class="grid grid-cols-1 md:grid-cols-4 gap-2">
            <input
              v-model.number="rollupDays"
              type="number"
              min="1"
              max="3650"
              class="px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
              placeholder="Rollup days"
            />
            <input
              v-model.number="compactLogDays"
              type="number"
              min="1"
              max="3650"
              class="px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
              placeholder="Compact log days"
            />
            <input
              v-model.number="compactMessageMaxLen"
              type="number"
              min="50"
              max="2000"
              class="px-2 py-1 rounded bg-surface-800 border border-surface-600 text-sm"
              placeholder="Max message len"
            />
            <button
              class="px-3 py-2 rounded border border-surface-600 text-sm hover:bg-surface-800 disabled:opacity-50"
              :disabled="rollupCompactionRunning"
              @click="runRollupCompaction"
            >
              {{ rollupCompactionRunning ? 'Running...' : 'Run Rollup + Compaction' }}
            </button>
          </div>
          <p v-if="rollupCompactionConfig" class="text-xs text-surface-400">
            Auto: {{ rollupCompactionConfig.enabled ? 'on' : 'off' }} · rollup {{ rollupCompactionConfig.rollup_days }}d · compact {{ rollupCompactionConfig.compact_log_days }}d · every {{ rollupCompactionConfig.interval_minutes }}m · next {{ nextAutoRollupText }}
          </p>
          <p class="text-xs text-surface-400">
            Rollups store hourly anomaly counts; compaction truncates older long log messages.
          </p>
        </section>
      </section>
    </div>
  </main>
</template>
