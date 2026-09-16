import { describe, expect, it } from 'vitest';
import { formatHistoryNumber, longHistoryChart, nearestHistoryPoint, type LongHistoryPoint } from './longHistory';

const point = (period: string, close: number): LongHistoryPoint => ({ period, date: period, close, source: 'test', sourceUrl: '' });

describe('long-term history chart', () => {
  it('prints full axis numbers and reserves space for wide positive and negative labels', () => {
    expect(formatHistoryNumber(123456.7, true)).toBe('123,457');
    expect(formatHistoryNumber(0.0523, true)).toBe('0.0523');
    for (const values of [[10, 1234567], [-1234567, 100]]) {
      const chart = longHistoryChart(values.map((value, i) => point(`2025-0${i + 1}`, value)), 288, false);
      expect(chart.left).toBeGreaterThan(62);
      expect(chart.right - chart.left).toBeGreaterThan(150);
      expect(chart.ticks.every(tick => !/[kmb]/i.test(formatHistoryNumber(tick.value, true)))).toBe(true);
    }
  });
  it('uses elapsed months rather than evenly spacing missing observations', () => {
    const chart = longHistoryChart([point('2024-01', 100), point('2024-02', 110), point('2024-12', 120)], 640, false);
    expect(chart.positions[1].x - chart.positions[0].x).toBeCloseTo((chart.right - chart.left) / 11);
    expect(chart.path.match(/M/g)).toHaveLength(2);
  });
  it('shows equal proportional moves at equal log distances', () => {
    const chart = longHistoryChart([point('2024-01', 1), point('2024-02', 10), point('2024-03', 100)], 320, true);
    expect(chart.positions[0].y - chart.positions[1].y).toBeCloseTo(chart.positions[1].y - chart.positions[2].y);
  });
  it('handles empty and constant series without invalid geometry', () => {
    expect(longHistoryChart([], 320, false).path).toBe('');
    expect(longHistoryChart([point('2024-01', 100)], 320, true).path).not.toMatch(/NaN|Infinity/);
    expect(nearestHistoryPoint(100, [])).toBeNull();
  });
  it('selects the nearest displayed point at both edges and across gaps', () => {
    const positions = [{ x: 62 }, { x: 82 }, { x: 302 }];
    expect(nearestHistoryPoint(-10, positions)).toBe(0);
    expect(nearestHistoryPoint(90, positions)).toBe(1);
    expect(nearestHistoryPoint(400, positions)).toBe(2);
  });
});
