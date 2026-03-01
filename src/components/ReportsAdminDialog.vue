<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { vpsApi } from '@/composables/vpsApi';
import type { ReportLayoutSettings, ReportSubcategorySettings } from '@/types/vps';

export interface ReportCategoryDef {
  value: string;
  label: string;
}

export interface ReportOptionDef {
  value: string;
  label: string;
}

const props = defineProps<{
  visible: boolean;
  categoryDefs: ReportCategoryDef[];
  subcategoryDefs: Record<string, ReportOptionDef[]>;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'saved', layout: ReportLayoutSettings): void;
}>();

// Working copies for editing
const workingCategoryOrder = ref<string[]>([]);
const workingSubcategorySettings = ref<Record<string, ReportSubcategorySettings>>({});

const saving = ref(false);
const loading = ref(false);
const errorMessage = ref('');

// Build default layout from props (no customisation applied)
function buildDefaultLayout(): ReportLayoutSettings {
  const categoryOrder = props.categoryDefs.map((c) => c.value);
  const subcategories: Record<string, ReportSubcategorySettings> = {};
  for (const cat of props.categoryDefs) {
    subcategories[cat.value] = {
      order: props.subcategoryDefs[cat.value]?.map((s) => s.value) ?? [],
      hidden: [],
    };
  }
  return { categoryOrder, subcategories };
}

// Merge a saved layout with the current definitions (handles new categories/subcategories added later)
function mergeLayout(saved: ReportLayoutSettings | null): void {
  const defaults = buildDefaultLayout();

  // Category order: start from saved order, append any new ones not in saved
  const savedCatOrder = saved?.categoryOrder ?? [];
  const allCats = defaults.categoryOrder;
  const orderedCats = [
    ...savedCatOrder.filter((c) => allCats.includes(c)),
    ...allCats.filter((c) => !savedCatOrder.includes(c)),
  ];
  workingCategoryOrder.value = orderedCats;

  // Subcategory settings per category
  const merged: Record<string, ReportSubcategorySettings> = {};
  for (const cat of allCats) {
    const savedSub = saved?.subcategories?.[cat];
    const defaultOrder = defaults.subcategories[cat]!.order;
    const savedOrder = savedSub?.order ?? [];
    const orderedSubs = [
      ...savedOrder.filter((s) => defaultOrder.includes(s)),
      ...defaultOrder.filter((s) => !savedOrder.includes(s)),
    ];
    merged[cat] = {
      order: orderedSubs,
      hidden: (savedSub?.hidden ?? []).filter((s) => defaultOrder.includes(s)),
    };
  }
  workingSubcategorySettings.value = merged;
}

// Load settings when dialog opens
watch(
  () => props.visible,
  async (open) => {
    if (!open) return;
    loading.value = true;
    errorMessage.value = '';
    try {
      const saved = await vpsApi.getReportLayout();
      mergeLayout(saved);
    } catch {
      errorMessage.value = 'Failed to load settings.';
    } finally {
      loading.value = false;
    }
  },
);

// ---- Category ordering ----
const orderedCategories = computed(() =>
  workingCategoryOrder.value
    .map((val) => props.categoryDefs.find((c) => c.value === val))
    .filter(Boolean) as ReportCategoryDef[],
);

function moveCategoryUp(index: number) {
  if (index === 0) return;
  const arr = [...workingCategoryOrder.value];
  [arr[index - 1], arr[index]] = [arr[index]!, arr[index - 1]!];
  workingCategoryOrder.value = arr;
}

function moveCategoryDown(index: number) {
  const arr = workingCategoryOrder.value;
  if (index === arr.length - 1) return;
  const copy = [...arr];
  [copy[index], copy[index + 1]] = [copy[index + 1]!, copy[index]!];
  workingCategoryOrder.value = copy;
}

// ---- Subcategory ordering / visibility ----
function getSubcategoryDef(catValue: string, subValue: string): ReportOptionDef | undefined {
  return props.subcategoryDefs[catValue]?.find((s) => s.value === subValue);
}

function moveSubUp(catValue: string, index: number) {
  if (index === 0) return;
  const entry = workingSubcategorySettings.value[catValue]!;
  const order = [...entry.order];
  [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
  entry.order = order;
}

function moveSubDown(catValue: string, index: number) {
  const entry = workingSubcategorySettings.value[catValue]!;
  const order = entry.order;
  if (index === order.length - 1) return;
  const copy = [...order];
  [copy[index], copy[index + 1]] = [copy[index + 1]!, copy[index]!];
  entry.order = copy;
}

function isHidden(catValue: string, subValue: string): boolean {
  return workingSubcategorySettings.value[catValue]?.hidden.includes(subValue) ?? false;
}

function toggleHidden(catValue: string, subValue: string) {
  const entry = workingSubcategorySettings.value[catValue]!;
  const hidden = entry.hidden;
  const idx = hidden.indexOf(subValue);
  if (idx === -1) {
    entry.hidden = [...hidden, subValue];
  } else {
    entry.hidden = hidden.filter((v) => v !== subValue);
  }
}

// ---- Save / Cancel ----
async function save() {
  saving.value = true;
  errorMessage.value = '';
  try {
    const layout: ReportLayoutSettings = {
      categoryOrder: workingCategoryOrder.value,
      subcategories: workingSubcategorySettings.value,
    };
    await vpsApi.saveReportLayout(layout);
    emit('saved', layout);
    emit('update:visible', false);
  } catch {
    errorMessage.value = 'Failed to save settings.';
  } finally {
    saving.value = false;
  }
}

function cancel() {
  emit('update:visible', false);
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Reports Admin"
    class="w-full max-w-2xl"
    @update:visible="emit('update:visible', $event)"
  >
    <div v-if="loading" class="flex justify-center py-8">
      <ProgressSpinner style="width: 36px; height: 36px" />
    </div>

    <div v-else class="flex flex-col gap-6">
      <Message v-if="errorMessage" severity="error" :closable="false">{{ errorMessage }}</Message>

      <p class="text-sm text-surface-500">
        Drag the <strong>↑ ↓</strong> buttons to reorder categories and reports. Use the eye button
        to hide reports from the navigation (hidden reports can be restored here at any time).
      </p>

      <div
        v-for="(cat, catIndex) in orderedCategories"
        :key="cat.value"
        class="border border-surface-200 dark:border-surface-700 rounded-lg"
      >
        <!-- Category header row -->
        <div
          class="flex items-center justify-between gap-2 px-4 py-2 bg-surface-100 dark:bg-surface-800 rounded-t-lg"
        >
          <span class="font-semibold text-sm">{{ cat.label }}</span>
          <div class="flex gap-1">
            <Button
              size="small"
              severity="secondary"
              text
              title="Move category up"
              :disabled="catIndex === 0"
              @click="moveCategoryUp(catIndex)"
            >
              <template #icon><i-mdi-arrow-up /></template>
            </Button>
            <Button
              size="small"
              severity="secondary"
              text
              title="Move category down"
              :disabled="catIndex === orderedCategories.length - 1"
              @click="moveCategoryDown(catIndex)"
            >
              <template #icon><i-mdi-arrow-down /></template>
            </Button>
          </div>
        </div>

        <!-- Subcategory rows -->
        <div class="divide-y divide-surface-100 dark:divide-surface-700">
          <div
            v-for="(subValue, subIndex) in workingSubcategorySettings[cat.value]?.order ?? []"
            :key="subValue"
            class="flex items-center justify-between gap-2 px-4 py-2"
            :class="isHidden(cat.value, subValue) ? 'opacity-40' : ''"
          >
            <span class="text-sm truncate flex-1">
              {{ getSubcategoryDef(cat.value, subValue)?.label ?? subValue }}
            </span>
            <div class="flex items-center gap-1 shrink-0">
              <Button
                size="small"
                severity="secondary"
                text
                title="Move up"
                :disabled="subIndex === 0"
                @click="moveSubUp(cat.value, subIndex)"
              >
                <template #icon><i-mdi-arrow-up /></template>
              </Button>
              <Button
                size="small"
                severity="secondary"
                text
                title="Move down"
                :disabled="
                  subIndex === (workingSubcategorySettings[cat.value]?.order.length ?? 0) - 1
                "
                @click="moveSubDown(cat.value, subIndex)"
              >
                <template #icon><i-mdi-arrow-down /></template>
              </Button>
              <Button
                size="small"
                severity="secondary"
                text
                :title="isHidden(cat.value, subValue) ? 'Show in nav' : 'Hide from nav'"
                @click="toggleHidden(cat.value, subValue)"
              >
                <template #icon>
                  <i-mdi-eye-off v-if="isHidden(cat.value, subValue)" />
                  <i-mdi-eye v-else />
                </template>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" @click="cancel" />
      <Button label="Save" :loading="saving" :disabled="loading" @click="save" />
    </template>
  </Dialog>
</template>
