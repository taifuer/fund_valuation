import { describe, expect, it } from 'vitest';
import { changeSinceBasis, combineHoldingAndFxChange } from './fundEstimate';

describe('fund estimate returns', () => {
  it('uses cumulative return from the official NAV-date basis', () => {
    expect(changeSinceBasis(110, 2, 100)).toBeCloseTo(10);
  });

  it('falls back to the current daily return when no basis is stored', () => {
    expect(changeSinceBasis(110, 2.5)).toBe(2.5);
    expect(changeSinceBasis(110, 2.5, 0)).toBe(2.5);
  });

  it('compounds holding and currency returns', () => {
    expect(combineHoldingAndFxChange(10, 2)).toBeCloseTo(12.2);
  });
});
