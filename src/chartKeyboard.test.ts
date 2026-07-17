import { describe, expect, it } from 'vitest';
import { nextChartIndex } from './chartKeyboard';

describe('nextChartIndex', () => {
  it('supports arrows and boundary keys', () => {
    expect(nextChartIndex('ArrowLeft', null, 10)).toBe(8);
    expect(nextChartIndex('ArrowRight', 4, 10)).toBe(5);
    expect(nextChartIndex('Home', 4, 10)).toBe(0);
    expect(nextChartIndex('End', 4, 10)).toBe(9);
  });

  it('clamps boundaries and ignores unrelated keys', () => {
    expect(nextChartIndex('ArrowLeft', 0, 10)).toBe(0);
    expect(nextChartIndex('ArrowRight', 9, 10)).toBe(9);
    expect(nextChartIndex('Enter', 4, 10)).toBeNull();
    expect(nextChartIndex('ArrowLeft', null, 0)).toBeNull();
  });
});
