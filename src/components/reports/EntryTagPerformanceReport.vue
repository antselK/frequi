<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTableSort } from '@/composables/useTableSort';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { daysAgoStr, todayStr } from '@/utils/reportDates';
import type { DwhEntryTagPerformanceList } from '@/types/vps';

const { reportsError, botSelectOptions } = useReportsContext();

const entryTagPerformance = ref<DwhEntryTagPerformanceList | null>(null);
const entryTagLoaded = ref(false);
const loadingEntryTag = ref(false);
const entryTagDateFrom = ref(daysAgoStr(30));
const entryTagDateTo = ref(todayStr());
const entryTagFilterBotId = ref<number | null>(null);
const entryTagMinTrades = ref(1);
const entryTagSortCol = ref<
  'trades' | 'wins' | 'win_rate_pct' | 'avg_profit_pct' | 'avg_duration_hours' | 'total_profit_abs'
>('trades');
const entryTagSortAsc = ref(false);

const entryTagRawItems = computed(() => entryTagPerformance.value?.items ?? []);
const entryTagItems = useTableSort(entryTagRawItems, entryTagSortCol, entryTagSortAsc);
const entryTagBestWinRate = computed(() => {
  const rows = entryTagPerformance.value?.items ?? [];
  if (!rows.length) return null;
  return rows.reduce((best, r) => (r.win_rate_pct > best.win_rate_pct ? r : best));
});
const entryTagBestAvgProfit = computed(() => {
  const rows = entryTagPerformance.value?.items ?? [];
  if (!rows.length) return null;
  return rows.reduce((best, r) => (r.avg_profit_pct > best.avg_profit_pct ? r : best));
});

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
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <!-- Header + filters -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">Entry Tag Performance</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="entryTagDateFrom" type="date" size="sm" class="w-36" />
        <UInput v-model="entryTagDateTo" type="date" size="sm" class="w-36" />
        <USelect
          v-model="entryTagFilterBotId"
          :items="botSelectOptions"
          placeholder="All bots"
          size="sm"
          class="w-56"
        />
        <UInputNumber
          v-model="entryTagMinTrades"
          :min="1"
          size="sm"
          class="w-20"
          placeholder="Min trades"
        />
        <UButton
          label="Load"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loadingEntryTag"
          @click="loadEntryTagPerformance"
        />
      </div>
    </div>

    <!-- Summary stats -->
    <div v-if="entryTagLoaded && entryTagPerformance" class="flex flex-wrap gap-3 text-sm">
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold">{{ entryTagPerformance.total_tags }}</div>
        <div class="text-xs text-surface-400">Unique tags</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold">
          {{ entryTagPerformance.items.reduce((s, r) => s + r.trades, 0) }}
        </div>
        <div class="text-xs text-surface-400">Total trades</div>
      </div>
      <div
        v-if="entryTagBestWinRate"
        class="rounded border border-green-700 px-3 py-2 min-w-36 text-center"
      >
        <div class="text-lg font-bold text-green-400">
          {{ entryTagBestWinRate.win_rate_pct.toFixed(1) }}%
        </div>
        <div class="text-xs text-surface-400">
          Best win rate ({{ entryTagBestWinRate.enter_tag ?? 'null' }})
        </div>
      </div>
      <div
        v-if="entryTagBestAvgProfit"
        class="rounded border border-green-700 px-3 py-2 min-w-36 text-center"
      >
        <div class="text-lg font-bold text-green-400">
          {{ entryTagBestAvgProfit.avg_profit_pct > 0 ? '+' : ''
          }}{{ entryTagBestAvgProfit.avg_profit_pct.toFixed(2) }}%
        </div>
        <div class="text-xs text-surface-400">
          Best avg profit ({{ entryTagBestAvgProfit.enter_tag ?? 'null' }})
        </div>
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
              @click="
                entryTagSortCol === 'trades'
                  ? (entryTagSortAsc = !entryTagSortAsc)
                  : ((entryTagSortCol = 'trades'), (entryTagSortAsc = false))
              "
            >
              Trades {{ entryTagSortCol === 'trades' ? (entryTagSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="entryTagSortCol === 'wins' ? 'text-primary-400' : ''"
              @click="
                entryTagSortCol === 'wins'
                  ? (entryTagSortAsc = !entryTagSortAsc)
                  : ((entryTagSortCol = 'wins'), (entryTagSortAsc = false))
              "
            >
              Wins {{ entryTagSortCol === 'wins' ? (entryTagSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="entryTagSortCol === 'win_rate_pct' ? 'text-primary-400' : ''"
              @click="
                entryTagSortCol === 'win_rate_pct'
                  ? (entryTagSortAsc = !entryTagSortAsc)
                  : ((entryTagSortCol = 'win_rate_pct'), (entryTagSortAsc = false))
              "
            >
              Win rate
              {{ entryTagSortCol === 'win_rate_pct' ? (entryTagSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="entryTagSortCol === 'avg_profit_pct' ? 'text-primary-400' : ''"
              @click="
                entryTagSortCol === 'avg_profit_pct'
                  ? (entryTagSortAsc = !entryTagSortAsc)
                  : ((entryTagSortCol = 'avg_profit_pct'), (entryTagSortAsc = false))
              "
            >
              Avg profit
              {{ entryTagSortCol === 'avg_profit_pct' ? (entryTagSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="entryTagSortCol === 'avg_duration_hours' ? 'text-primary-400' : ''"
              @click="
                entryTagSortCol === 'avg_duration_hours'
                  ? (entryTagSortAsc = !entryTagSortAsc)
                  : ((entryTagSortCol = 'avg_duration_hours'), (entryTagSortAsc = false))
              "
            >
              Avg duration
              {{ entryTagSortCol === 'avg_duration_hours' ? (entryTagSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 cursor-pointer select-none whitespace-nowrap"
              :class="entryTagSortCol === 'total_profit_abs' ? 'text-primary-400' : ''"
              @click="
                entryTagSortCol === 'total_profit_abs'
                  ? (entryTagSortAsc = !entryTagSortAsc)
                  : ((entryTagSortCol = 'total_profit_abs'), (entryTagSortAsc = false))
              "
            >
              Total profit
              {{ entryTagSortCol === 'total_profit_abs' ? (entryTagSortAsc ? '↑' : '↓') : '' }}
            </th>
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
