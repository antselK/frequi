import type { AlertType } from '@/types/alertTypes';

export const useAlertsStore = defineStore('alerts', () => {
  const activeMessages = ref<AlertType[]>([]);

  const toast = useToast();

  function addAlert(message: AlertType) {
    // TODO: is this store still necessary??
    const severityMap: Record<string, 'success' | 'info' | 'warning' | 'error' | 'neutral'> = {
      success: 'success',
      info: 'info',
      warning: 'warning',
      warn: 'warning',
      danger: 'error',
      error: 'error',
      secondary: 'neutral',
    };
    toast.add({
      title: message.title,
      description: message.message,
      color: severityMap[message.severity] ?? 'primary',
      duration: message.timeout,
    });
  }

  function removeAlert(alert: AlertType) {
    activeMessages.value = activeMessages.value.filter((v) => v !== alert);
  }

  return {
    activeMessages,
    addAlert,
    removeAlert,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAlertsStore, import.meta.hot));
}
