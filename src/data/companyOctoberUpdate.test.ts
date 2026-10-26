import { describe, expect, it } from 'vitest';
import { companyFundamentalsDataset, companySeries } from './companyFundamentals';

const company = (id: string) => companyFundamentalsDataset.companies.find(item => item.id === id)!;

describe('October 2026 reviewed company disclosures', () => {
  it.each([
    ['netflix', '2026-09-30', 12874.176, 4458.6, 1033.142],
    ['ibm', '2026-09-30', 17103, 2497, 2378],
    ['txn', '2026-09-30', 6055, 2874, 530],
    ['tesla', '2026-09-30', 28046, 718, 2761],
    ['jnj', '2026-09-27', 25399, 34, 4652],
    ['meta', '2026-09-30', 64601, 12988, 20054],
    ['asml', '2026-09-27', 11662, 5172.8, 1174.4],
    ['tsmc', '2026-09-30', 1494243, 876445, 88979],
    ['catl', '2026-09-30', 165220.844, 25268.302, 7140.441],
  ] as const)('keeps %s single-quarter values, currency scale and exact period end', (id, end, revenue, profit, research) => {
    const record = company(id);
    const point = record.quarterly.find(item => item.period === 'FY2026 Q3')!;
    expect(point.periodEnd).toBe(end);
    expect(point.revenue).toBeCloseTo(revenue * 1e6, 0);
    expect(point.operatingProfit).toBeCloseTo(profit * 1e6, 0);
    expect(point.researchAndDevelopment).toBeCloseTo(research * 1e6, 0);
    expect(record.latestReport?.period).toBe(point.period);
    expect(record.latestReport?.publishedAt).toMatch(/^2026-10-/);
  });

  it('derives CATL Q3 from nine months less H1, not net income', () => {
    const record = company('catl');
    const h1 = companySeries(record, 'half').find(point => point.period === 'FY2026 H1')!;
    const q3 = record.quarterly.find(point => point.period === 'FY2026 Q3')!;
    expect(h1.operatingProfit + q3.operatingProfit).toBeCloseTo(80933059 * 1000, 0);
    expect(h1.researchAndDevelopment! + q3.researchAndDevelopment!).toBeCloseTo(18516986 * 1000, 0);
    expect(h1.revenue + q3.revenue).toBeCloseTo(442137424 * 1000, 0);
  });

  it('keeps TCS fiscal year and INR figures rather than appending USD amounts', () => {
    const record = company('tcs');
    expect(record.currency).toBe('INR');
    expect(record.quarterly.find(point => point.period === 'FY2027 Q2')).toMatchObject({
      periodEnd: '2026-09-30', revenue: 731880e6, operatingProfit: 175530e6, employees: 598056,
    });
  });

  it('keeps annual employee disclosures annual and annotates unusual profit charges', () => {
    expect(company('micron').annual.find(point => point.period === 'FY2026')?.employees).toBe(61000);
    expect(company('micron').quarterly.find(point => point.period === 'FY2026 Q4')?.employees).toBeNull();
    expect(company('meta').quarterly.find(point => point.period === 'FY2026 Q3')?.employees).toBe(66775);
    for (const id of ['meta', 'jnj']) {
      expect(company(id).metricMarkers).toEqual(expect.arrayContaining([
        expect.objectContaining({ period: 'FY2026 Q3', metric: 'operatingProfit' }),
      ]));
    }
  });
});
