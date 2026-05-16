<script setup lang="ts">
import { ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { todayStr } from '@/utils/reportDates';

interface Props {
  title: string;
  tier?: '1' | '2' | '3';
  showBotFilter?: boolean;
  showPairFilter?: boolean;
}

withDefaults(defineProps<Props>(), {
  tier: '1',
  showBotFilter: true,
  showPairFilter: false,
});

const { botSelectOptions } = useReportsContext();

const dateFrom = ref(todayStr());
const dateTo = ref(todayStr());
const filterBotId = ref<number | null>(null);
const filterPair = ref('');
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <h5 class="font-semibold">{{ title }}</h5>
        <span class="text-xs bg-surface-700 text-surface-300 px-2 py-1 rounded"
          >Tier {{ tier }}</span
        >
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="dateFrom" type="date" size="sm" class="w-36" />
        <UInput v-model="dateTo" type="date" size="sm" class="w-36" />
        <USelect
          v-if="showBotFilter"
          v-model="filterBotId"
          :items="botSelectOptions"
          placeholder="All bots"
          size="sm"
          class="w-56"
        />
        <UInput
          v-if="showPairFilter"
          v-model="filterPair"
          size="sm"
          class="w-36"
          placeholder="Pair"
        />
        <UButton label="Load" size="sm" color="neutral" variant="outline" disabled />
      </div>
    </div>
    <p class="text-sm text-surface-300"><slot name="description" /></p>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
      <div class="rounded border border-surface-700 p-3 space-y-1">
        <div class="font-medium text-surface-200 mb-2">What it will show</div>
        <slot name="what" />
      </div>
      <div class="rounded border border-surface-700 p-3 space-y-1">
        <div class="font-medium text-surface-200 mb-2">How to build</div>
        <slot name="how" />
      </div>
    </div>
  </div>
</template>
