<script setup lang="ts">
import { computed, ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { useTableSort } from '@/composables/useTableSort';
import { vpsApi } from '@/composables/vpsApi';
import { daysAgoStr, todayStr } from '@/utils/reportDates';
import type {
  DwhConfluenceAnalysis,
  DwhConfluenceIndicatorSpec,
  DwhConfluenceTradeRow,
} from '@/types/vps';

const { reportsError, botSelectOptions } = useReportsContext();

const analysis = ref<DwhConfluenceAnalysis | null>(null);
const loaded = ref(false);
const loading = ref(false);
const recalibrating = ref(false);
const dateFrom = ref(daysAgoStr(90));
const dateTo = ref(todayStr());
const filterBotId = ref<number | null>(null);

async function loadAnalysis() {
  loading.value = true;
  reportsError.value = '';
  try {
    analysis.value = await vpsApi.dwhConfluenceAnalysis(
      dateFrom.value || undefined,
      dateTo.value || undefined,
      filterBotId.value ?? undefined,
    );
    loaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    analysis.value = null;
  } finally {
    loading.value = false;
  }
}

async function recalibrate() {
  recalibrating.value = true;
  reportsError.value = '';
  try {
    // Recalibrate over ALL history for a stable model, then reload the (possibly
    // date-filtered) validation view scored by the fresh model.
    await vpsApi.dwhRecalibrateConfluence();
    await loadAnalysis();
  } catch (error) {
    reportsError.value = String(error);
  } finally {
    recalibrating.value = false;
  }
}

const model = computed(() => analysis.value?.confluence_model ?? null);
const tagEntries = computed(() =>
  model.value ? Object.entries(model.value.tags).sort((a, b) => b[1].n - a[1].n) : [],
);

function band(spec: { lo: number | null; hi: number | null }): string {
  if (spec.lo !== null && spec.hi === null) return `≥ ${spec.lo}`;
  if (spec.hi !== null && spec.lo === null) return `≤ ${spec.hi}`;
  if (spec.lo !== null && spec.hi !== null) return `${spec.lo} – ${spec.hi}`;
  return '—';
}

// Strongest-first indicators that actually carry weight, for the per-tag table.
function weightedIndicators(indicators: Record<string, DwhConfluenceIndicatorSpec>) {
  return Object.entries(indicators)
    .filter(([, s]) => s.weight > 0)
    .sort((a, b) => b[1].weight - a[1].weight);
}

const maxBucketQs = computed(() => {
  const qs = (analysis.value?.buckets ?? [])
    .map((b) => b.avg_quality_score)
    .filter((v): v is number => v !== null);
  return qs.length ? Math.max(...qs) : 0;
});

function fmt(v: number | null, digits = 2, suffix = ''): string {
  return v === null ? '—' : `${v >= 0 && suffix === '%' ? '+' : ''}${v.toFixed(digits)}${suffix}`;
}

// --- Per-trade table ---
const scoredOnly = ref(true);
const tradeSortCol = ref<keyof DwhConfluenceTradeRow & string>('confluence_score');
const tradeSortAsc = ref(false);
const tradeDateCols = new Set(['open_date', 'close_date']);

const tradeRaw = computed<DwhConfluenceTradeRow[]>(() => {
  const items = analysis.value?.items ?? [];
  return scoredOnly.value ? items.filter((r) => r.confluence_score !== null) : items;
});
const tradeRows = useTableSort(tradeRaw, tradeSortCol, tradeSortAsc, tradeDateCols);

function setTradeSort(col: keyof DwhConfluenceTradeRow & string) {
  if (tradeSortCol.value === col) tradeSortAsc.value = !tradeSortAsc.value;
  else {
    tradeSortCol.value = col;
    tradeSortAsc.value = false;
  }
}
const arrow = (col: string) => (tradeSortCol.value === col ? (tradeSortAsc.value ? '↑' : '↓') : '');

function confColor(v: number | null): string {
  if (v === null) return 'text-surface-500';
  if (v >= 60) return 'text-green-400';
  if (v >= 40) return 'text-amber-400';
  return 'text-red-400';
}
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <!-- Header + filters -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">Confluence Score</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="dateFrom" type="date" size="sm" class="w-36" />
        <span class="text-surface-400 text-xs">to</span>
        <UInput v-model="dateTo" type="date" size="sm" class="w-36" />
        <USelect
          v-model="filterBotId"
          :items="botSelectOptions"
          placeholder="All bots"
          size="sm"
          class="w-56"
        />
        <UButton
          label="Load"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loading"
          @click="loadAnalysis"
        />
        <UButton
          label="Recalibrate"
          size="sm"
          color="primary"
          variant="outline"
          :loading="recalibrating"
          title="Recompute the model from ALL historical trades and re-score the view"
          @click="recalibrate"
        />
      </div>
    </div>

    <!-- No model yet -->
    <div v-if="loaded && !analysis?.has_model" class="text-sm text-amber-400 py-2">
      No confluence model has been calibrated yet. Click <b>Recalibrate</b> to build one from
      historical trades.
    </div>

    <!-- Model meta -->
    <div v-if="loaded && analysis?.has_model" class="flex flex-wrap gap-3 text-sm">
      <div class="rounded border border-surface-600 px-3 py-2 min-w-32 text-center">
        <div class="text-lg font-bold">{{ analysis.active_trades_used }}</div>
        <div class="text-xs text-surface-400">Trades trained on</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-32 text-center">
        <div class="text-lg font-bold">{{ analysis.scored_trades }}</div>
        <div class="text-xs text-surface-400">Scored in view</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-48 text-center">
        <div class="text-sm font-mono">
          {{ analysis.active_calibrated_at?.slice(0, 16).replace('T', ' ') ?? '—' }}
        </div>
        <div class="text-xs text-surface-400">Model calibrated at (UTC)</div>
      </div>
    </div>

    <!-- Validation: does higher confluence => higher quality? -->
    <div v-if="loaded && analysis?.has_model && analysis.buckets.length" class="space-y-2">
      <h6 class="font-semibold text-sm">Validation — average outcome by confluence-score bucket</h6>
      <p class="text-xs text-surface-400">
        If the score works, avg quality &amp; profit should rise with the bucket. The bar visualizes
        avg quality score per bucket.
      </p>
      <div class="overflow-x-auto w-full">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="border-b border-surface-600 text-left text-surface-300">
              <th class="py-2 pe-3">Confluence bucket</th>
              <th class="py-2 pe-3 text-right">Trades</th>
              <th class="py-2 pe-3 text-right">Avg quality</th>
              <th class="py-2 pe-3 w-40">Quality (bar)</th>
              <th class="py-2 pe-3 text-right">Avg profit %</th>
              <th class="py-2 pe-3 text-right">Avg dur (h)</th>
              <th class="py-2 pe-3 text-right">Avg DCA</th>
              <th class="py-2 pe-3 text-right">Win %</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="b in analysis.buckets"
              :key="b.bucket"
              class="border-b border-surface-700/70 hover:bg-surface-700/30"
            >
              <td class="py-1.5 pe-3 font-mono text-xs">{{ b.bucket }}</td>
              <td class="py-1.5 pe-3 text-right font-mono text-xs">{{ b.trades }}</td>
              <td class="py-1.5 pe-3 text-right font-mono text-xs">
                {{ fmt(b.avg_quality_score, 2) }}
              </td>
              <td class="py-1.5 pe-3">
                <div class="bg-surface-700/40 rounded-sm h-3 w-full overflow-hidden">
                  <div
                    class="h-3 bg-primary-500"
                    :style="{
                      width:
                        b.avg_quality_score !== null && maxBucketQs > 0
                          ? `${Math.max(0, (b.avg_quality_score / maxBucketQs) * 100)}%`
                          : '0%',
                    }"
                  />
                </div>
              </td>
              <td
                class="py-1.5 pe-3 text-right font-mono text-xs"
                :class="
                  b.avg_profit_pct !== null && b.avg_profit_pct >= 0
                    ? 'text-green-400'
                    : 'text-red-400'
                "
              >
                {{ fmt(b.avg_profit_pct, 2, '%') }}
              </td>
              <td class="py-1.5 pe-3 text-right font-mono text-xs">
                {{ fmt(b.avg_duration_hours, 1) }}
              </td>
              <td class="py-1.5 pe-3 text-right font-mono text-xs">
                {{ fmt(b.avg_dca_orders, 2) }}
              </td>
              <td class="py-1.5 pe-3 text-right font-mono text-xs">{{ fmt(b.win_rate_pct, 1) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Per-tag learned model -->
    <div v-if="loaded && analysis?.has_model && tagEntries.length" class="space-y-3">
      <h6 class="font-semibold text-sm">Learned model — favorable indicator bands per entry tag</h6>
      <p class="text-xs text-surface-400">
        Weights are normalized per tag and proportional to how strongly each indicator separates
        high- from low-quality trades (good = quality ≥ tag median). Indicators that don't separate
        get zero weight and are omitted. A tag with no discriminating indicators can't be scored.
      </p>
      <div
        v-for="[tag, tm] in tagEntries"
        :key="tag"
        class="border border-surface-600 rounded-sm p-3 space-y-2"
      >
        <div class="flex items-center justify-between flex-wrap gap-2">
          <span class="font-mono text-sm">{{ tag }}</span>
          <span class="text-xs text-surface-400">
            n={{ tm.n }} · qs median {{ tm.qs_median.toFixed(1) }}
            <span v-if="!tm.has_signal" class="text-amber-400">· no discriminating indicators</span>
          </span>
        </div>
        <div v-if="weightedIndicators(tm.indicators).length" class="overflow-x-auto w-full">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="border-b border-surface-700 text-left text-surface-300">
                <th class="py-1 pe-3">Indicator</th>
                <th class="py-1 pe-3 text-right">Weight</th>
                <th class="py-1 pe-3 text-right">Favorable</th>
                <th class="py-1 pe-3 text-right">Sep</th>
                <th class="py-1 pe-3 text-right">Good μ</th>
                <th class="py-1 pe-3 text-right">Bad μ</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="[name, spec] in weightedIndicators(tm.indicators)"
                :key="name"
                class="border-b border-surface-800/60"
              >
                <td class="py-1 pe-3 font-mono text-xs">{{ name }}</td>
                <td class="py-1 pe-3 text-right font-mono text-xs text-primary-400">
                  {{ (spec.weight * 100).toFixed(0) }}%
                </td>
                <td class="py-1 pe-3 text-right font-mono text-xs">{{ band(spec) }}</td>
                <td class="py-1 pe-3 text-right font-mono text-xs">{{ spec.sep.toFixed(2) }}</td>
                <td class="py-1 pe-3 text-right font-mono text-xs">
                  {{ spec.mean_good.toFixed(2) }}
                </td>
                <td class="py-1 pe-3 text-right font-mono text-xs text-surface-400">
                  {{ spec.mean_bad.toFixed(2) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="tm.bb_pos" class="text-xs text-surface-400 font-mono">
          bb_pos favorable: <span class="text-green-400">{{ tm.bb_pos.favorable }}</span> (good rate
          {{ (tm.bb_pos.good_rate * 100).toFixed(0) }}%)
        </div>
      </div>
    </div>

    <!-- Per-trade table -->
    <div v-if="loaded && analysis?.has_model" class="space-y-2">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <h6 class="font-semibold text-sm">Trades — each with its confluence score</h6>
        <UCheckbox v-model="scoredOnly" label="Scored trades only" size="sm" />
      </div>
      <p class="text-xs text-surface-400">
        Confluence is computed from the trade's own [SIGNAL_FLASH] indicators against the active
        model. Unscored trades (no matching flash, open, or an unscorable tag) show “—”. Default
        sort: highest confluence first.
      </p>
      <div v-if="tradeRows.length === 0" class="text-sm text-surface-400 py-4 text-center">
        No trades for the selected filters.
      </div>
      <div v-else class="overflow-x-auto w-full">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="border-b border-surface-600 text-left text-surface-300">
              <th
                class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
                @click="setTradeSort('open_date')"
              >
                Open {{ arrow('open_date') }}
              </th>
              <th class="py-2 pe-3 whitespace-nowrap">Bot</th>
              <th class="py-2 pe-3 whitespace-nowrap">Pair</th>
              <th class="py-2 pe-3 whitespace-nowrap">Tag</th>
              <th class="py-2 pe-3 whitespace-nowrap">Side</th>
              <th
                class="py-2 pe-3 text-right cursor-pointer select-none whitespace-nowrap"
                :class="tradeSortCol === 'confluence_score' ? 'text-primary-400' : ''"
                @click="setTradeSort('confluence_score')"
              >
                Confluence {{ arrow('confluence_score') }}
              </th>
              <th
                class="py-2 pe-3 text-right cursor-pointer select-none whitespace-nowrap"
                :class="tradeSortCol === 'quality_score' ? 'text-primary-400' : ''"
                @click="setTradeSort('quality_score')"
              >
                Quality {{ arrow('quality_score') }}
              </th>
              <th
                class="py-2 pe-3 text-right cursor-pointer select-none whitespace-nowrap"
                :class="tradeSortCol === 'profit_pct' ? 'text-primary-400' : ''"
                @click="setTradeSort('profit_pct')"
              >
                Profit % {{ arrow('profit_pct') }}
              </th>
              <th
                class="py-2 pe-3 text-right cursor-pointer select-none whitespace-nowrap"
                :class="tradeSortCol === 'duration_hours' ? 'text-primary-400' : ''"
                @click="setTradeSort('duration_hours')"
              >
                Dur (h) {{ arrow('duration_hours') }}
              </th>
              <th
                class="py-2 pe-3 text-right cursor-pointer select-none whitespace-nowrap"
                :class="tradeSortCol === 'dca_order_count' ? 'text-primary-400' : ''"
                @click="setTradeSort('dca_order_count')"
              >
                DCA {{ arrow('dca_order_count') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in tradeRows"
              :key="row.trade_id"
              class="border-b border-surface-700/70 hover:bg-surface-700/30"
            >
              <td class="py-1.5 pe-3 font-mono text-xs whitespace-nowrap">
                {{ row.open_date?.slice(0, 16).replace('T', ' ') ?? '—' }}
              </td>
              <td class="py-1.5 pe-3 font-mono text-xs whitespace-nowrap">
                {{ row.container_name ?? row.bot_id }}
                <span v-if="row.vps_name" class="text-surface-500">· {{ row.vps_name }}</span>
              </td>
              <td class="py-1.5 pe-3 font-mono text-xs">{{ row.pair ?? '—' }}</td>
              <td class="py-1.5 pe-3 font-mono text-xs">{{ row.enter_tag ?? '—' }}</td>
              <td class="py-1.5 pe-3 text-xs">
                <span :class="row.is_short ? 'text-red-400' : 'text-green-400'">
                  {{ row.is_short === null ? '—' : row.is_short ? 'short' : 'long' }}
                </span>
              </td>
              <td
                class="py-1.5 pe-3 text-right font-mono text-xs font-bold"
                :class="confColor(row.confluence_score)"
              >
                {{ row.confluence_score === null ? '—' : row.confluence_score.toFixed(0) }}
              </td>
              <td class="py-1.5 pe-3 text-right font-mono text-xs">
                {{ fmt(row.quality_score, 2) }}
              </td>
              <td
                class="py-1.5 pe-3 text-right font-mono text-xs"
                :class="
                  row.profit_pct === null
                    ? 'text-surface-500'
                    : row.profit_pct >= 0
                      ? 'text-green-400'
                      : 'text-red-400'
                "
              >
                {{ row.is_open ? 'open' : fmt(row.profit_pct, 2, '%') }}
              </td>
              <td class="py-1.5 pe-3 text-right font-mono text-xs">
                {{ fmt(row.duration_hours, 1) }}
              </td>
              <td class="py-1.5 pe-3 text-right font-mono text-xs">{{ row.dca_order_count }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
