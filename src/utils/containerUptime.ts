/**
 * Compact container uptime for table cells.
 *
 * The backend sends `container_started_at` (docker's .State.StartedAt, ISO-8601 UTC)
 * rather than a pre-rendered duration, so the value stays accurate between polls and
 * carries no server-side timezone assumption.
 *
 * `humanizeDurationFromSeconds` is deliberately not reused here - it renders
 * "1 hour, 5 minutes, 23 seconds", which is far too wide for a table column.
 */
export function containerUptime(startedAt: string | null | undefined): string {
  if (!startedAt) {
    return '—';
  }
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) {
    return '—';
  }
  const seconds = Math.floor((Date.now() - started) / 1000);
  // Negative means host/browser clock skew; showing "-3s" would just look broken.
  if (seconds < 0) {
    return '—';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * True when the container started very recently - worth highlighting, because the
 * autoheal watchdog / boot guard restart bots automatically, so a fresh uptime is
 * how you notice that happened.
 */
export function isRecentlyRestarted(
  startedAt: string | null | undefined,
  withinMinutes = 15,
): boolean {
  if (!startedAt) {
    return false;
  }
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) {
    return false;
  }
  const seconds = (Date.now() - started) / 1000;
  return seconds >= 0 && seconds < withinMinutes * 60;
}
