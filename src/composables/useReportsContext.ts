import { inject, provide, type ComputedRef, type InjectionKey, type Ref } from 'vue';

export interface BotSelectOption {
  label: string;
  value: number | null;
}

export interface ReportsContext {
  reportsError: Ref<string>;
  botSelectOptions: ComputedRef<BotSelectOption[]>;
  activeBotIds: Ref<Set<number>>;
  isBotActive: (botId: number) => boolean;
}

const reportsContextKey: InjectionKey<ReportsContext> = Symbol('reports-context');

export function provideReportsContext(ctx: ReportsContext): void {
  provide(reportsContextKey, ctx);
}

export function useReportsContext(): ReportsContext {
  const ctx = inject(reportsContextKey);
  if (!ctx) {
    throw new Error(
      'useReportsContext must be used inside a component that calls provideReportsContext',
    );
  }
  return ctx;
}
