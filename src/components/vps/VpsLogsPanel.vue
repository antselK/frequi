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
  <Dialog
    :visible="visible"
    modal
    :header="title"
    class="w-full max-w-4xl"
    @update:visible="emit('update:visible', $event)"
  >
    <Textarea :model-value="logs" rows="20" class="w-full font-mono" readonly auto-resize />
    <template #footer>
      <div class="flex justify-end gap-2">
        <Button label="Refresh" :loading="loading" @click="emit('refresh')" />
      </div>
    </template>
  </Dialog>
</template>
