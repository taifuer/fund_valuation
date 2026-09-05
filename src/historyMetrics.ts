interface PerformancePoint {
  returnSegment?: number;
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
