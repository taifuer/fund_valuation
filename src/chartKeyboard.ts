export function nextChartIndex(
  key: string,
  selectedIndex: number | null,
  pointCount: number,
): number | null {
  if (pointCount <= 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return null;
  const current = selectedIndex ?? pointCount - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return pointCount - 1;
  if (key === 'ArrowLeft') return Math.max(0, current - 1);
  return Math.min(pointCount - 1, current + 1);
}
