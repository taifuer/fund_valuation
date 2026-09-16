import { describe, expect, it } from 'vitest';
import { axisLabelWidth, chartPointerX, fitAxisTicks, nearestChartPoint, valueAxis } from './chartLayout';

describe('responsive chart ticks', () => {
  it('keeps all years when there is room', () => {
    const ticks = Array.from({ length: 6 }, (_, i) => ({ x: i * 70, label: String(2021 + i), anchor: 'middle' as const }));
    expect(fitAxisTicks(ticks)).toEqual(ticks);
  });
  it('keeps the first and last label without collisions on narrow charts', () => {
    const ticks = Array.from({ length: 7 }, (_, i) => ({
      x: i * 30, label: `2026/0${i + 1}`,
      anchor: i === 0 ? 'start' as const : i === 6 ? 'end' as const : 'middle' as const,
    }));
    const result = fitAxisTicks(ticks);
    expect(result[0]).toBe(ticks[0]);
    expect(result[result.length - 1]).toBe(ticks[6]);
    expect(result.length).toBeLessThan(ticks.length);
  });
});

describe('shared chart geometry', () => {
  it('pads the observed range and uses evenly spaced readable linear ticks', () => {
    const axis = valueAxis([3586, 7686]);
    expect(axis.ratio(3586)).toBeLessThan(1);
    expect(axis.ratio(7686)).toBeGreaterThan(0);
    expect(axis.ratio(3586) - axis.ratio(7686)).toBeGreaterThan(0.8);
    const differences = axis.ticks.slice(1).map((tick, i) => axis.ticks[i] - tick);
    expect(new Set(differences).size).toBe(1);
    expect(axis.ticks.every(tick => tick % 1000 === 0)).toBe(true);
    expect(axis.ticks.length).toBeLessThanOrEqual(7);
  });
  it('handles missing, constant, negative and small values without invalid ticks', () => {
    for (const values of [[], [NaN, Infinity], [0], [123], [-37, -2], [0.00001, 0.00003]]) {
      const axis = valueAxis(values);
      expect(axis.ticks.length).toBeGreaterThan(1);
      expect(axis.ticks.every(value => Number.isFinite(value) && Number.isFinite(axis.ratio(value)))).toBe(true);
      expect(new Set(axis.ticks).size).toBe(axis.ticks.length);
    }
  });
  it('keeps zero visible for year-over-year charts without requiring zero for all charts', () => {
    const axis = valueAxis([30, 40], false, true);
    expect(axis.ticks).toContain(0);
    expect(axis.ratio(0)).toBeGreaterThanOrEqual(0);
    expect(axis.ratio(0)).toBeLessThanOrEqual(1);
  });
  it('preserves equal proportional distances in logarithmic charts', () => {
    const axis = valueAxis([1, 10, 100], true);
    expect(axis.ratio(1) - axis.ratio(10)).toBeCloseTo(axis.ratio(10) - axis.ratio(100));
    expect(axis.ticks.every(value => value > 0)).toBe(true);
    expect(axis.ratio(1)).toBeLessThan(1);
    expect(axis.ratio(100)).toBeGreaterThan(0);
  });
  it('reserves space for complete labels and finds points across irregular gaps', () => {
    expect(axisLabelWidth(['1,234,567,890'])).toBeGreaterThan(90);
    expect(nearestChartPoint(80, [{ x: 62 }, { x: 85 }, { x: 350 }])).toBe(1);
    expect(nearestChartPoint(80, [])).toBeNull();
  });
  it('accounts for the rendered chart scale in the fallback pointer mapping', () => {
    const svg = { getBoundingClientRect: () => ({ left: 10, width: 200 }) } as SVGSVGElement;
    expect(chartPointerX(svg, 110, 20, 400)).toBe(200);
  });
});
