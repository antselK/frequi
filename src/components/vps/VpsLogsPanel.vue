<script setup lang="ts">
defineProps<{
  visible: boolean;
  title: string;
  logs: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'refresh'): void;
}>();
</script>

<template>
  <UModal
    :open="visible"
    :title="title"
    :ui="{ content: 'sm:max-w-4xl' }"
    @update:open="emit('update:visible', $event)"
  >
    <template #body>
      <UTextarea
        :model-value="logs"
        :rows="20"
        class="w-full font-mono"
        readonly
        autoresize
      />
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton label="Refresh" :loading="loading" @click="emit('refresh')" />
      </div>
    </template>
  </UModal>
</template>
