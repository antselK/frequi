export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function dateFromToDays(dateFrom: string): number {
  // Parse as UTC midnight to match todayStr()/daysAgoStr() (both UTC via toISOString)
  // and the UTC date-window filters in the reports — a local parse drifts the day count
  // by up to ±1 in non-UTC timezones, under-fetching near the from-boundary.
  const from = new Date(dateFrom + 'T00:00:00Z');
  const diffMs = Date.now() - from.getTime();
  return Math.max(1, Math.ceil(diffMs / 86400000));
}
