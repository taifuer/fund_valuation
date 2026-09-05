import { describe, expect, it } from 'vitest';
import { fitAxisTicks } from './chartLayout';

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
