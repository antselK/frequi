<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { todayStr, dateFromToDays } from '@/utils/reportDates';
import { formatDate } from '@/utils/reportParsers';
import { logsChartLayout } from '@/utils/reportCharts';
import { timestampShort } from '@/utils/formatters/timeformat';
import type { DwhLogCauseSummary, DwhLogCumulativePoint } from '@/types/vps';

const { reportsError, botSelectOptions, showChartTooltip, hideChartTooltip } = useReportsContext();

type LogsChartMode = 'cumulative' | 'hourly';

interface LogsCumulativeChartPoint {
  at: string;
  ts: string;
  generated: number;
  cumulative: number;
}

const logsCumulativeChartPoints = ref<LogsCumulativeChartPoint[]>([]);
const logsSpikeSummary = ref<DwhLogCauseSummary | null>(null);
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

const loadingLogsCumulative = ref(false);
const loadingLogsSpikeSummary = ref(false);

const logsCumulativeLoaded = ref(false);
const logsSpikeLoaded = ref(false);

const logsChartModeOptions: { label: string; value: LogsChartMode }[] = [
  { label: 'Cumulative', value: 'cumulative' },
  { label: 'Per-hour', value: 'hourly' },
];

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

    // The API returns buckets from (now − hours) up to now; honor the To-date by
    // dropping buckets after it (exclusive next-day UTC midnight). Cumulative values
    // stay correct since they accumulate from the window start.
    const logsToMs = new Date(`${logsDateTo.value}T00:00:00Z`).getTime() + 24 * 3600 * 1000;
    logsCumulativeChartPoints.value = rows
      .map((row) => ({
        at: formatDate(row.bucket_ts),
        ts: row.bucket_ts,
        generated: row.log_count,
        cumulative: row.cumulative_count,
      }))
      .filter((p) => new Date(p.ts).getTime() < logsToMs)
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

onMounted(() => {
  if (!logsCumulativeLoaded.value) {
    void loadLogsCumulativeChart();
  }
});
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-3">
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
      <USelect v-model="logsChartMode" :items="logsChartModeOptions" size="sm" class="w-40" />
    </div>

    <div v-if="!logsCumulativeChartPoints.length" class="text-sm text-surface-400">
      {{
        loadingLogsCumulative
          ? 'Loading cumulative logs...'
          : 'No log data available for selected filters.'
      }}
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
            <UInput v-model="logsSpikeFromLocal" type="datetime-local" size="sm" class="w-56" />
            <UInput v-model="logsSpikeToLocal" type="datetime-local" size="sm" class="w-56" />
            <UInput v-model="logsSpikeLevels" size="sm" class="w-44" placeholder="Levels" />
            <UInputNumber v-model="logsSpikeLimit" :min="1" :max="200" size="sm" class="w-16" />
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
          Top repeated log messages for selected logs window. Uses current Bot ID and Logger filters
          from this report.
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
                      ? ((item.occurrences / logsSpikeSummary.total_events) * 100).toFixed(1)
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
                      ? ((logsSpikeTopOccurrences / logsSpikeSummary.total_events) * 100).toFixed(1)
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
</template>
