<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTableSort } from '@/composables/useTableSort';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { daysAgoStr, todayStr } from '@/utils/reportDates';
import type { DwhDcaAnalysisList } from '@/types/vps';

const { reportsError, botSelectOptions } = useReportsContext();

const dcaAnalysis = ref<DwhDcaAnalysisList | null>(null);
const dcaLoaded = ref(false);
const loadingDca = ref(false);
const dcaDateFrom = ref(daysAgoStr(30));
const dcaDateTo = ref(todayStr());
const dcaFilterBotId = ref<number | null>(null);
const dcaSortCol = ref<
  | 'order_count'
  | 'trades'
  | 'wins'
  | 'win_rate_pct'
  | 'avg_profit_pct'
  | 'avg_duration_hours'
  | 'total_profit_abs'
>('order_count');
const dcaSortAsc = ref(true);

const dcaRawItems = computed(() => dcaAnalysis.value?.items ?? []);
const dcaItems = useTableSort(dcaRawItems, dcaSortCol, dcaSortAsc);
const dcaSingleEntry = computed(
  () => dcaAnalysis.value?.items.find((r) => r.order_count === 1) ?? null,
);
const dcaMultiEntry = computed(() => {
  const rows = dcaAnalysis.value?.items.filter((r) => r.order_count > 1) ?? [];
  if (!rows.length) return null;
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  const totalWins = rows.reduce((s, r) => s + r.wins, 0);
  const totalProfit = rows.reduce((s, r) => s + r.total_profit_abs, 0);
  const avgProfit = rows.reduce((s, r) => s + r.avg_profit_pct * r.trades, 0) / totalTrades;
  return {
    trades: totalTrades,
    wins: totalWins,
    win_rate_pct: (totalWins / totalTrades) * 100,
    avg_profit_pct: avgProfit,
    total_profit_abs: totalProfit,
  };
});

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
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <!-- Header + filters -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">DCA / Multi-Order Analysis</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="dcaDateFrom" type="date" size="sm" class="w-36" />
        <UInput v-model="dcaDateTo" type="date" size="sm" class="w-36" />
        <USelect
          v-model="dcaFilterBotId"
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
          :loading="loadingDca"
          @click="loadDcaAnalysis"
        />
      </div>
    </div>

    <!-- Coverage note -->
    <div v-if="dcaLoaded && dcaAnalysis" class="text-xs text-surface-400">
      {{ dcaAnalysis.trades_with_orders.toLocaleString() }} of
      {{ dcaAnalysis.total_closed_trades.toLocaleString() }} closed trades have order data
      <span v-if="dcaAnalysis.total_closed_trades > 0">
        ({{ Math.round((dcaAnalysis.trades_with_orders / dcaAnalysis.total_closed_trades) * 100) }}%
        coverage)
      </span>
    </div>

    <!-- Single vs DCA summary cards -->
    <div
      v-if="dcaLoaded && dcaAnalysis && dcaAnalysis.items.length > 0"
      class="flex flex-wrap gap-3 text-sm"
    >
      <div
        v-if="dcaSingleEntry"
        class="rounded border border-surface-600 px-3 py-2 min-w-40 text-center"
      >
        <div class="text-xs text-surface-400 mb-1">Single entry (1 order)</div>
        <div class="text-lg font-bold">{{ dcaSingleEntry.trades }}</div>
        <div class="text-xs text-surface-400">trades</div>
        <div
          class="mt-1 font-mono text-sm"
          :class="dcaSingleEntry.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'"
        >
          {{ dcaSingleEntry.avg_profit_pct >= 0 ? '+' : ''
          }}{{ dcaSingleEntry.avg_profit_pct.toFixed(2) }}% avg
        </div>
        <div
          class="font-mono text-xs"
          :class="dcaSingleEntry.win_rate_pct >= 50 ? 'text-green-400' : 'text-red-400'"
        >
          {{ dcaSingleEntry.win_rate_pct.toFixed(1) }}% win rate
        </div>
      </div>
      <div
        v-if="dcaMultiEntry"
        class="rounded border border-primary-700 px-3 py-2 min-w-40 text-center"
      >
        <div class="text-xs text-surface-400 mb-1">DCA (2+ orders)</div>
        <div class="text-lg font-bold">{{ dcaMultiEntry.trades }}</div>
        <div class="text-xs text-surface-400">trades</div>
        <div
          class="mt-1 font-mono text-sm"
          :class="dcaMultiEntry.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'"
        >
          {{ dcaMultiEntry.avg_profit_pct >= 0 ? '+' : ''
          }}{{ dcaMultiEntry.avg_profit_pct.toFixed(2) }}% avg
        </div>
        <div
          class="font-mono text-xs"
          :class="dcaMultiEntry.win_rate_pct >= 50 ? 'text-green-400' : 'text-red-400'"
        >
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
          :class="
            dcaMultiEntry.avg_profit_pct - dcaSingleEntry.avg_profit_pct >= 0
              ? 'text-green-400'
              : 'text-red-400'
          "
        >
          {{ dcaMultiEntry.avg_profit_pct - dcaSingleEntry.avg_profit_pct >= 0 ? '+' : ''
          }}{{ (dcaMultiEntry.avg_profit_pct - dcaSingleEntry.avg_profit_pct).toFixed(2) }}%
        </div>
        <div class="text-xs text-surface-400">avg profit diff</div>
        <div
          class="font-mono text-xs"
          :class="
            dcaMultiEntry.win_rate_pct - dcaSingleEntry.win_rate_pct >= 0
              ? 'text-green-400'
              : 'text-red-400'
          "
        >
          {{ dcaMultiEntry.win_rate_pct - dcaSingleEntry.win_rate_pct >= 0 ? '+' : ''
          }}{{ (dcaMultiEntry.win_rate_pct - dcaSingleEntry.win_rate_pct).toFixed(1) }}% win rate
          diff
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
              @click="
                dcaSortCol === 'order_count'
                  ? (dcaSortAsc = !dcaSortAsc)
                  : ((dcaSortCol = 'order_count'), (dcaSortAsc = true))
              "
            >
              Buy orders {{ dcaSortCol === 'order_count' ? (dcaSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="dcaSortCol === 'trades' ? 'text-primary-400' : ''"
              @click="
                dcaSortCol === 'trades'
                  ? (dcaSortAsc = !dcaSortAsc)
                  : ((dcaSortCol = 'trades'), (dcaSortAsc = false))
              "
            >
              Trades {{ dcaSortCol === 'trades' ? (dcaSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="dcaSortCol === 'wins' ? 'text-primary-400' : ''"
              @click="
                dcaSortCol === 'wins'
                  ? (dcaSortAsc = !dcaSortAsc)
                  : ((dcaSortCol = 'wins'), (dcaSortAsc = false))
              "
            >
              Wins {{ dcaSortCol === 'wins' ? (dcaSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="dcaSortCol === 'win_rate_pct' ? 'text-primary-400' : ''"
              @click="
                dcaSortCol === 'win_rate_pct'
                  ? (dcaSortAsc = !dcaSortAsc)
                  : ((dcaSortCol = 'win_rate_pct'), (dcaSortAsc = false))
              "
            >
              Win rate {{ dcaSortCol === 'win_rate_pct' ? (dcaSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="dcaSortCol === 'avg_profit_pct' ? 'text-primary-400' : ''"
              @click="
                dcaSortCol === 'avg_profit_pct'
                  ? (dcaSortAsc = !dcaSortAsc)
                  : ((dcaSortCol = 'avg_profit_pct'), (dcaSortAsc = false))
              "
            >
              Avg profit {{ dcaSortCol === 'avg_profit_pct' ? (dcaSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="dcaSortCol === 'avg_duration_hours' ? 'text-primary-400' : ''"
              @click="
                dcaSortCol === 'avg_duration_hours'
                  ? (dcaSortAsc = !dcaSortAsc)
                  : ((dcaSortCol = 'avg_duration_hours'), (dcaSortAsc = false))
              "
            >
              Avg duration
              {{ dcaSortCol === 'avg_duration_hours' ? (dcaSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 cursor-pointer select-none whitespace-nowrap"
              :class="dcaSortCol === 'total_profit_abs' ? 'text-primary-400' : ''"
              @click="
                dcaSortCol === 'total_profit_abs'
                  ? (dcaSortAsc = !dcaSortAsc)
                  : ((dcaSortCol = 'total_profit_abs'), (dcaSortAsc = false))
              "
            >
              Total profit
              {{ dcaSortCol === 'total_profit_abs' ? (dcaSortAsc ? '↑' : '↓') : '' }}
            </th>
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
              <span v-if="row.avg_duration_hours !== null"
                >{{ row.avg_duration_hours.toFixed(1) }}h</span
              >
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
</template>
