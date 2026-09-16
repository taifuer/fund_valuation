interface AxisTick {
  x: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
}

export function valueAxis(values: number[], logarithmic = false, includeZero = false) {
  const valid = values.filter(value => Number.isFinite(value) && (!logarithmic || value > 0));
  const transformed = valid.map(value => logarithmic ? Math.log(value) : value);
  let low = transformed.length ? Math.min(...transformed) : 0;
  let high = transformed.length ? Math.max(...transformed) : 1;
  if (includeZero && !logarithmic) { low = Math.min(low, 0); high = Math.max(high, 0); }
  const padding = (high - low || Math.abs(high) || 1) * 0.08;
  low -= padding;
  high += padding;
  let ticks: number[];
  if (logarithmic) {
    ticks = Array.from({ length: 5 }, (_, i) => Math.exp(high - (high - low) * i / 4));
  } else {
    const rough = (high - low) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const multiple = [1, 2, 2.5, 5, 10].reduce((best, value) => Math.abs(value - rough / magnitude) < Math.abs(best - rough / magnitude) ? value : best);
    const step = multiple * magnitude;
    const first = Math.ceil(low / step);
    const last = Math.floor(high / step);
    ticks = Array.from({ length: last - first + 1 }, (_, i) => Number(((last - i) * step).toPrecision(12)));
  }
  return { ticks, ratio: (value: number) => (high - (logarithmic ? Math.log(value) : value)) / (high - low) };
}

export function chartPointerX(svg: SVGSVGElement, clientX: number, clientY: number, width: number) {
  const matrix = svg.getScreenCTM?.();
  if (matrix) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(matrix.inverse()).x;
  }
  const rect = svg.getBoundingClientRect();
  return (clientX - rect.left) * width / (rect.width || width);
}

export function nearestChartPoint(x: number, positions: Array<{ x: number }>): number | null {
  if (!positions.length) return null;
  let left = 0;
  let right = positions.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (positions[mid].x < x) left = mid + 1;
    else right = mid;
  }
  return left > 0 && x - positions[left - 1].x < positions[left].x - x ? left - 1 : left;
}

export function axisLabelWidth(labels: string[]) {
  return Math.max(62, ...labels.map(label => [...label].reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 11 : 6.6), 18)));
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
