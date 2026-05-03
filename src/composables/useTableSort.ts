import { computed, type Ref, type ComputedRef } from 'vue';

/**
 * Generic table sorting composable. Eliminates duplicated sort logic across reports.
 *
 * Usage:
 *   const sortCol = ref<'trades' | 'win_rate'>('trades');
 *   const sortAsc = ref(false);
 *   const sorted = useTableSort(rawItems, sortCol, sortAsc);
 *
 * For date columns, pass their names in `dateCols` — they sort lexicographically with nulls last.
 */
export function useTableSort<T extends Record<string, any>>(
  items: Ref<T[]> | ComputedRef<T[]>,
  sortCol: Ref<keyof T & string>,
  sortAsc: Ref<boolean>,
  dateCols?: Set<string>,
): ComputedRef<T[]> {
  return computed(() => {
    const col = sortCol.value;
    const asc = sortAsc.value;
    return [...items.value].sort((a, b) => {
      if (dateCols?.has(col)) {
        const av = (a[col] as string | null) ?? '\uFFFF';
        const bv = (b[col] as string | null) ?? '\uFFFF';
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const av = (a[col] as number | null) ?? (asc ? Infinity : -Infinity);
      const bv = (b[col] as number | null) ?? (asc ? Infinity : -Infinity);
      return asc ? (av < bv ? -1 : av > bv ? 1 : 0) : av > bv ? -1 : av < bv ? 1 : 0;
    });
  });
}
