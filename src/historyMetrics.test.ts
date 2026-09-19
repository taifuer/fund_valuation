import { describe, expect, it } from 'vitest';
import { intervalMetrics, historyCutoff, dailyHistoryCovered } from './historyMetrics';

describe('history performance metrics', () => {
  it('uses five calendar years, including leap days, consistently with the summaries', () => {
    expect(historyCutoff('2026-09-18', 365 * 5)).toBe('2021-09-18');
    expect(historyCutoff('2024-02-29', 365 * 5)).toBe('2019-02-28');
    expect(historyCutoff('2026-09-18', 30)).toBe('2026-08-19');
  });
  it('rejects missing baselines and long daily gaps without rejecting weekends', () => {
    const points = [{ date: '2021-09-17' }, { date: '2021-09-20' }];
    expect(dailyHistoryCovered(points, '2021-09-18')).toBe(true);
    expect(dailyHistoryCovered(points, '2021-09-16')).toBe(false);
    expect(dailyHistoryCovered([...points, { date: '2021-10-29' }], '2021-09-18')).toBe(false);
  });
  it('uses the supplied total-return value rather than unit NAV', () => {
    const points = [{ nav: 2, returnValue: 1, returnSegment: 0 }, { nav: 1, returnValue: 1.01, returnSegment: 0 }];
    expect(intervalMetrics(points, point => point.returnValue).returnPct).toBeCloseTo(1);
  });
  it('does not calculate across unverified corporate actions', () => {
    expect(intervalMetrics([{ close: 3, returnSegment: 0 }, { close: 1, returnSegment: 1 }], p => p.close))
      .toEqual({ returnPct: null, drawdown: null });
  });
  it('can calculate a verified segment after an older discontinuity', () => {
    expect(intervalMetrics([{ close: 1, returnSegment: 1 }, { close: 0.9, returnSegment: 1 }], p => p.close).drawdown)
      .toBeCloseTo(-10);
  });
});
