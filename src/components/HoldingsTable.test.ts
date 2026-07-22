import { describe, expect, it } from 'vitest';
import type { Holding } from '../types';
import { formatHoldingPeriod } from './HoldingsTable';

function holding(reportDate?: string): Holding {
  return {
    symbol: 'NVDA',
    name: 'NVIDIA',
    sinaSymbol: 'gb_nvda',
    weight: 0.1,
    currency: 'USD',
    reportDate,
  };
}

describe('formatHoldingPeriod', () => {
  it('formats the latest disclosed year, quarter, and date', () => {
    expect(formatHoldingPeriod([
      holding('2026-03-31'),
      holding('2026-06-30'),
    ])).toBe('持仓数据：2026年第二季度（截至2026年6月30日）');
  });

  it('identifies built-in fallback holdings without a report date', () => {
    expect(formatHoldingPeriod([holding()])).toBe('持仓数据：参考配置（暂无有效季度披露日期）');
  });
});
