interface AxisTick {
  x: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
}

export function fitAxisTicks<T extends AxisTick>(ticks: T[]): T[] {
  const bounds = (tick: T) => {
    const width = tick.label.length * 6.6;
    const left = tick.x - (tick.anchor === 'end' ? width : tick.anchor === 'middle' ? width / 2 : 0);
    return { left, right: left + width };
  };
  const result: T[] = [];
  for (const tick of ticks) {
    const previous = result[result.length - 1];
    if (!previous || bounds(tick).left >= bounds(previous).right + 8) result.push(tick);
  }
  const last = ticks[ticks.length - 1];
  if (last && result[result.length - 1] !== last) {
    while (result.length > 1 && bounds(last).left < bounds(result[result.length - 1]).right + 8) result.pop();
    if (!result.length || bounds(last).left >= bounds(result[result.length - 1]).right + 8) result.push(last);
  }
  return result;
}
