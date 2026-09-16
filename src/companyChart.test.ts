import { describe, expect, it } from 'vitest';
import { companyPlotSeries } from './companyChart';
import type { CompanyFundamentalPoint } from './types';

const point = (date: string): CompanyFundamentalPoint => ({ period: date, periodEnd: date,
  revenue: 1, operatingProfit: 1, researchAndDevelopment: null, employees: null });

describe('company disclosure chart series', () => {
  it('trims missing ends, skips missing metrics and preserves their gap', () => {
    const dates = ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31', '2025-03-31'];
    const { coordinates } = companyPlotSeries(dates.map(point), [null, 100, null, 130, null], 'quarterly', 62, 400);
    expect(coordinates.map(p => p.x)).toEqual([62, 400]);
    expect(coordinates.map(p => p.breakBefore)).toEqual([true, true]);
    expect(coordinates.map(p => p.index)).toEqual([1, 3]);
  });
  it('uses elapsed dates and breaks at missing quarterly disclosures', () => {
    const { coordinates } = companyPlotSeries(['2024-03-31', '2024-06-30', '2024-12-31'].map(point), [1, 2, 3], 'quarterly', 62, 400);
    expect(coordinates[1].x).toBeLessThan((62 + 400) / 2);
    expect(coordinates.map(p => p.breakBefore)).toEqual([true, false, true]);
  });
  it('keeps legitimate half-year and shifted fiscal-year reporting intervals connected', () => {
    expect(companyPlotSeries(['2024-06-30', '2024-12-31'].map(point), [1, 2], 'half', 62, 400).coordinates[1].breakBefore).toBe(false);
    expect(companyPlotSeries(['2023-12-31', '2025-01-04'].map(point), [1, 2], 'annual', 62, 400).coordinates[1].breakBefore).toBe(false);
    expect(companyPlotSeries(['2023-12-31', '2025-12-31'].map(point), [1, 2], 'annual', 62, 400).coordinates[1].breakBefore).toBe(true);
  });
  it('keeps zero and negative values, but excludes non-finite points', () => {
    const points = ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31'].map(point);
    expect(companyPlotSeries(points, [0, -10, Infinity, NaN], 'quarterly', 62, 400).coordinates.map(p => p.value)).toEqual([0, -10]);
    expect(companyPlotSeries(points, [null, null, null, null], 'quarterly', 62, 400).coordinates).toEqual([]);
    expect(companyPlotSeries(points, [null, 10, null, null], 'quarterly', 62, 400).coordinates[0].x).toBe(231);
  });
});
