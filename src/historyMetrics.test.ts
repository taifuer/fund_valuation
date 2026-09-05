import { describe, expect, it } from 'vitest';
import { intervalMetrics } from './historyMetrics';

describe('history performance metrics', () => {
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
