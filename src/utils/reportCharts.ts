export interface ChartTooltipState {
  visible: boolean;
  x: number;
  y: number;
  lines: string[];
}

export const logsChartLayout = {
  width: 920,
  height: 260,
  leftPad: 40,
  rightPad: 20,
  topPad: 14,
  bottomPad: 30,
};

export function niceTickInterval(min: number, max: number, targetCount: number): number {
  const range = max - min;
  if (range === 0) return 1;
  const raw = range / targetCount;
  const exp = Math.floor(Math.log10(raw));
  const mag = Math.pow(10, exp);
  const frac = raw / mag;
  const step = frac <= 1 ? mag : frac <= 2 ? 2 * mag : frac <= 5 ? 5 * mag : 10 * mag;
  return step;
}

export function candleBucketMs(eventTs: string): number {
  return Math.floor(new Date(eventTs).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
}
