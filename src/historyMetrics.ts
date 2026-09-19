interface PerformancePoint {
  returnSegment?: number;
}

export function historyCutoff(latestDate: string, days: number): string {
  const value = new Date(`${latestDate}T12:00:00Z`);
  if (days === 365 * 5) {
    const year = value.getUTCFullYear() - 5;
    const month = value.getUTCMonth();
    const day = Math.min(value.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
    value.setUTCFullYear(year, month, day);
  } else value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export function dailyHistoryCovered(points: Array<{ date: string }>, target: string): boolean {
  if (points.length < 2) return false;
  const days = points.map(point => Date.parse(`${point.date}T00:00:00Z`) / 86400000);
  const lead = Date.parse(`${target}T00:00:00Z`) / 86400000 - days[0];
  return lead >= 0 && lead <= 20 && days.every((day, i) => Number.isFinite(day)
    && (i === 0 || (day > days[i - 1] && day - days[i - 1] <= 20)));
}

export function intervalMetrics<T extends PerformancePoint>(points: T[], value: (point: T) => number) {
  if (points.length < 2 || points.some(point => (point.returnSegment ?? 0) !== (points[0].returnSegment ?? 0))) {
    return { returnPct: null, drawdown: null };
  }
  let peak = value(points[0]);
  let drawdown = 0;
  if (!(peak > 0)) return { returnPct: null, drawdown: null };
  for (const point of points) {
    const current = value(point);
    if (!Number.isFinite(current) || current <= 0) return { returnPct: null, drawdown: null };
    peak = Math.max(peak, current);
    drawdown = Math.min(drawdown, (current / peak - 1) * 100);
  }
  return { returnPct: (value(points[points.length - 1]) / value(points[0]) - 1) * 100, drawdown };
}

export function formatReturn(value: number | null): string {
  return value === null ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}
