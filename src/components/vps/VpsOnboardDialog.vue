<script setup lang="ts">
import type { VpsCreatePayload, VpsUpdatePayload } from '@/types/vps';

const props = defineProps<{
  visible: boolean;
  loading?: boolean;
  mode?: 'create' | 'edit';
  initialValues?: Partial<VpsCreatePayload>;
}>();

const emit = defineEmits<{
  (event: 'update:visible', value: boolean): void;
  (event: 'submit', payload: VpsCreatePayload | VpsUpdatePayload): void;
}>();

const form = reactive<VpsCreatePayload>({
  name: '',
  ip: '',
  ssh_user: 'printer',
  ssh_port: 22,
  private_key: '',
});

function closeDialog() {
  emit('update:visible', false);
}

function resetForm() {
  form.name = props.initialValues?.name || '';
  form.ip = props.initialValues?.ip || '';
  form.ssh_user = props.initialValues?.ssh_user || 'printer';
  form.ssh_port = props.initialValues?.ssh_port || 22;
  form.private_key = '';
}

function submit() {
  if (props.mode === 'edit') {
    const payload: VpsUpdatePayload = {
      name: form.name.trim(),
      ip: form.ip.trim(),
      ssh_user: form.ssh_user.trim(),
      ssh_port: Number(form.ssh_port),
    };
    if (form.private_key.trim()) {
      payload.private_key = form.private_key;
    }
    emit('submit', payload);
    return;
  }

  emit('submit', {
    name: form.name.trim(),
    ip: form.ip.trim(),
    ssh_user: form.ssh_user.trim(),
    ssh_port: Number(form.ssh_port),
    private_key: form.private_key,
  });
}

watch(
  () => props.visible,
  (newVisible) => {
    if (newVisible) {
      resetForm();
    }
  },
);
</script>

<template>
  <UModal
    :open="visible"
    :title="mode === 'edit' ? 'Edit VPS' : 'Add VPS'"
    :ui="{ content: 'sm:max-w-2xl' }"
    @update:open="emit('update:visible', $event)"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <label for="vps-name">Name</label>
          <UInput id="vps-name" v-model="form.name" placeholder="vps-main" />
        </div>
        <div class="flex flex-col gap-2">
          <label for="vps-ip">IP</label>
          <UInput id="vps-ip" v-model="form.ip" placeholder="100.x.y.z" />
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="flex flex-col gap-2">
            <label for="vps-user">SSH User</label>
            <UInput id="vps-user" v-model="form.ssh_user" />
          </div>
          <div class="flex flex-col gap-2">
            <label for="vps-port">SSH Port</label>
            <UInputNumber id="vps-port" v-model="form.ssh_port" :min="1" :max="65535" />
          </div>
        </div>
        <div class="flex flex-col gap-2">
          <label for="vps-private-key">{{
            mode === 'edit' ? 'Private Key (optional)' : 'Private Key'
          }}</label>
          <UTextarea id="vps-private-key" v-model="form.private_key" :rows="8" autoresize />
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton label="Cancel" color="neutral" variant="outline" @click="closeDialog" />
        <UButton
          label="Save"
          :loading="loading"
          :disabled="
            !form.name.trim() ||
            !form.ip.trim() ||
            !form.ssh_user.trim() ||
            !(Number(form.ssh_port) >= 1) ||
            (mode !== 'edit' && !form.private_key.trim())
          "
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
