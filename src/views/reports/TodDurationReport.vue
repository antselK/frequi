<script setup lang="ts">
import { computed, ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { daysAgoStr, todayStr } from '@/utils/reportDates';
import type { DwhTodDurationHourlyStat, DwhTodDurationRead } from '@/types/vps';

const { reportsError } = useReportsContext();

const todDuration = ref<DwhTodDurationRead | null>(null);
const todDurLoaded = ref(false);
const loadingTodDur = ref(false);
const todDurDateFrom = ref(daysAgoStr(90));
const todDurDateTo = ref(todayStr());
const todDurFilterTag = ref('');
const todDurFilterDir = ref<'all' | 'long' | 'short'>('all');
const todDurSortCol = ref<keyof DwhTodDurationHourlyStat>('hour_utc');
const todDurSortAsc = ref(true);

async function loadTodDuration() {
  try {
    loadingTodDur.value = true;
    todDuration.value = await vpsApi.dwhTodDuration(
      todDurDateFrom.value,
      todDurDateTo.value,
      todDurFilterTag.value || undefined,
      todDurFilterDir.value,
    );
    todDurLoaded.value = true;
  } catch (err) {
    reportsError.value = String(err);
  } finally {
    loadingTodDur.value = false;
  }
}

const todDurItems = computed(() => {
  if (!todDuration.value) return [];
  const items = [...todDuration.value.items];
  items.sort((a, b) => {
    const diff = (a[todDurSortCol.value] as number) - (b[todDurSortCol.value] as number);
    return todDurSortAsc.value ? diff : -diff;
  });
  return items;
});
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <!-- Header + filters -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">Time-of-Day Duration</h5>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="todDurDateFrom" type="date" size="sm" class="w-36" />
        <span class="text-surface-400 text-xs">to</span>
        <UInput v-model="todDurDateTo" type="date" size="sm" class="w-36" />
        <UInput
          v-model="todDurFilterTag"
          size="sm"
          class="w-44"
          placeholder="Enter tag (optional)"
        />
        <USelect
          v-model="todDurFilterDir"
          :items="[
            { label: 'All directions', value: 'all' },
            { label: 'Long only', value: 'long' },
            { label: 'Short only', value: 'short' },
          ]"
          size="sm"
          class="w-36"
        />
        <UButton
          label="Load"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loadingTodDur"
          @click="loadTodDuration"
        />
      </div>
    </div>

    <!-- Summary cards -->
    <div v-if="todDurLoaded && todDuration" class="flex flex-wrap gap-3 text-sm">
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold">{{ todDuration.total_trades }}</div>
        <div class="text-xs text-surface-400">Total trades</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold">
          {{
            todDurItems.length > 0
              ? String(
                  todDurItems.reduce(
                    (best, r) => (r.pct_8h_plus < best.pct_8h_plus ? r : best),
                    todDurItems[0],
                  ).hour_utc,
                ).padStart(2, '0') + ':00'
              : '—'
          }}
        </div>
        <div class="text-xs text-surface-400">Best hour (lowest 8h+%)</div>
      </div>
      <div class="rounded border border-surface-600 px-3 py-2 min-w-28 text-center">
        <div class="text-lg font-bold text-red-400">
          {{
            todDurItems.length > 0
              ? String(
                  todDurItems.reduce(
                    (worst, r) => (r.pct_8h_plus > worst.pct_8h_plus ? r : worst),
                    todDurItems[0],
                  ).hour_utc,
                ).padStart(2, '0') + ':00'
              : '—'
          }}
        </div>
        <div class="text-xs text-surface-400">Worst hour (highest 8h+%)</div>
      </div>
    </div>

    <!-- Table -->
    <div v-if="todDurItems.length > 0" class="overflow-x-auto w-full">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="border-b border-surface-600 text-left text-surface-300">
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap"
              :class="todDurSortCol === 'hour_utc' ? 'text-primary-400' : ''"
              @click="
                todDurSortCol === 'hour_utc'
                  ? (todDurSortAsc = !todDurSortAsc)
                  : ((todDurSortCol = 'hour_utc'), (todDurSortAsc = true))
              "
            >
              Hour (UTC)
              {{ todDurSortCol === 'hour_utc' ? (todDurSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="todDurSortCol === 'total_trades' ? 'text-primary-400' : ''"
              @click="
                todDurSortCol === 'total_trades'
                  ? (todDurSortAsc = !todDurSortAsc)
                  : ((todDurSortCol = 'total_trades'), (todDurSortAsc = false))
              "
            >
              Trades
              {{ todDurSortCol === 'total_trades' ? (todDurSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="todDurSortCol === 'pct_le_1h' ? 'text-primary-400' : ''"
              @click="
                todDurSortCol === 'pct_le_1h'
                  ? (todDurSortAsc = !todDurSortAsc)
                  : ((todDurSortCol = 'pct_le_1h'), (todDurSortAsc = false))
              "
            >
              ≤1h% {{ todDurSortCol === 'pct_le_1h' ? (todDurSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="todDurSortCol === 'pct_8h_plus' ? 'text-primary-400' : ''"
              @click="
                todDurSortCol === 'pct_8h_plus'
                  ? (todDurSortAsc = !todDurSortAsc)
                  : ((todDurSortCol = 'pct_8h_plus'), (todDurSortAsc = false))
              "
            >
              8h+% {{ todDurSortCol === 'pct_8h_plus' ? (todDurSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="todDurSortCol === 'avg_duration_min' ? 'text-primary-400' : ''"
              @click="
                todDurSortCol === 'avg_duration_min'
                  ? (todDurSortAsc = !todDurSortAsc)
                  : ((todDurSortCol = 'avg_duration_min'), (todDurSortAsc = false))
              "
            >
              Avg Dur (min)
              {{ todDurSortCol === 'avg_duration_min' ? (todDurSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="todDurSortCol === 'median_duration_min' ? 'text-primary-400' : ''"
              @click="
                todDurSortCol === 'median_duration_min'
                  ? (todDurSortAsc = !todDurSortAsc)
                  : ((todDurSortCol = 'median_duration_min'), (todDurSortAsc = false))
              "
            >
              Median Dur (min)
              {{ todDurSortCol === 'median_duration_min' ? (todDurSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="todDurSortCol === 'avg_profit_pct' ? 'text-primary-400' : ''"
              @click="
                todDurSortCol === 'avg_profit_pct'
                  ? (todDurSortAsc = !todDurSortAsc)
                  : ((todDurSortCol = 'avg_profit_pct'), (todDurSortAsc = false))
              "
            >
              Avg Profit%
              {{ todDurSortCol === 'avg_profit_pct' ? (todDurSortAsc ? '↑' : '↓') : '' }}
            </th>
            <th
              class="py-2 pe-3 cursor-pointer select-none whitespace-nowrap text-right"
              :class="todDurSortCol === 'win_rate_pct' ? 'text-primary-400' : ''"
              @click="
                todDurSortCol === 'win_rate_pct'
                  ? (todDurSortAsc = !todDurSortAsc)
                  : ((todDurSortCol = 'win_rate_pct'), (todDurSortAsc = false))
              "
            >
              Win Rate%
              {{ todDurSortCol === 'win_rate_pct' ? (todDurSortAsc ? '↑' : '↓') : '' }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in todDurItems"
            :key="row.hour_utc"
            class="border-b border-surface-700/70 hover:bg-surface-700/30"
          >
            <td class="py-1.5 pe-3 font-mono text-xs">
              {{ String(row.hour_utc).padStart(2, '0') }}:00
            </td>
            <td class="py-1.5 pe-3 text-right">{{ row.total_trades }}</td>
            <td
              class="py-1.5 pe-3 text-right font-mono text-xs"
              :class="
                row.pct_le_1h >= 50
                  ? 'text-green-400'
                  : row.pct_le_1h < 30
                    ? 'text-red-400'
                    : 'text-yellow-400'
              "
            >
              {{ row.pct_le_1h.toFixed(1) }}%
            </td>
            <td
              class="py-1.5 pe-3 text-right font-mono text-xs"
              :class="
                row.pct_8h_plus <= 5
                  ? 'text-green-400'
                  : row.pct_8h_plus <= 15
                    ? 'text-yellow-400'
                    : 'text-red-400'
              "
            >
              {{ row.pct_8h_plus.toFixed(1) }}%
            </td>
            <td class="py-1.5 pe-3 text-right font-mono text-xs">
              {{ row.avg_duration_min.toFixed(0) }}
            </td>
            <td class="py-1.5 pe-3 text-right font-mono text-xs">
              {{ row.median_duration_min.toFixed(0) }}
            </td>
            <td
              class="py-1.5 pe-3 text-right font-mono text-xs"
              :class="row.avg_profit_pct >= 0 ? 'text-green-400' : 'text-red-400'"
            >
              {{ row.avg_profit_pct.toFixed(2) }}%
            </td>
            <td
              class="py-1.5 pe-3 text-right font-mono text-xs"
              :class="row.win_rate_pct >= 50 ? 'text-green-400' : 'text-red-400'"
            >
              {{ row.win_rate_pct.toFixed(1) }}%
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Empty state -->
    <div v-else-if="todDurLoaded" class="text-surface-400 text-sm">
      No data found for selected filters.
    </div>
  </div>
</template>
