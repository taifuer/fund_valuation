import { describe, expect, it } from 'vitest';
import { companyFundamentalsDataset, companySeries } from './companyFundamentals';
import { resolveCompanyReportReference } from './companyReportSources';
import { companyReportEvents } from './companyReportCalendar';

const company = (id: string) => companyFundamentalsDataset.companies.find(item => item.id === id)!;
const last = <T,>(points: T[]) => points[points.length - 1];

describe('November 2026 reviewed disclosures', () => {
  it.each([
    ['beone', 'FY2026 Q3', '2026-09-30', 1889.815, 418.675, 660.784],
    ['microsoft', 'FY2027 Q1', '2026-09-30', 92279, 45915, 9047],
    ['alphabet', 'FY2026 Q3', '2026-09-30', 127577, 40576, 20640],
    ['amd', 'FY2026 Q3', '2026-09-26', 13377, 2832, 2803],
    ['intel', 'FY2026 Q3', '2026-09-26', 16513, 2522, 3490],
    ['qualcomm', 'FY2026 Q4', '2026-09-27', 10322, 1356, 2684],
    ['apple', 'FY2026 Q4', '2026-09-26', 114477, 35631, 11730],
    ['lilly', 'FY2026 Q3', '2026-09-30', 24397, 8608, 4247],
    ['merck', 'FY2026 Q3', '2026-09-30', 18085, 5586, 4537],
    ['pfizer', 'FY2026 Q3', '2026-09-27', 16583, 3673, 3016],
    ['amazon', 'FY2026 Q3', '2026-09-30', 201944, 28076, null],
    ['palantir', 'FY2026 Q3', '2026-09-30', 2313.411, 1084.845, 219.72],
    ['visa', 'FY2026 Q4', '2026-09-30', 12139, 7262, null],
    ['arm', 'FY2027 Q2', '2026-09-30', 1443, 201, 857],
    ['mediatek', 'FY2026 Q3', '2026-09-30', 168058, 27102, 42237],
    ['novoNordisk', 'FY2026 Q3', '2026-09-30', 79195, 23011, 19903],
    ['byd', 'FY2026 Q3', '2026-09-30', 221488.251, 12268.165, 12969.986],
    ['hengrui', 'FY2026 Q3', '2026-09-30', 8953.179, 2906.151, 1930.058],
  ] as const)('keeps %s exact fiscal period and reported money values', (id, period, end, revenue, profit, research) => {
    const record = company(id);
    const point = record.quarterly.find(item => item.period === period)!;
    expect(point.periodEnd).toBe(end);
    expect(point.revenue).toBeCloseTo(revenue * 1e6, 0);
    expect(point.operatingProfit).toBeCloseTo(profit * 1e6, 0);
    if (research == null) expect(point.researchAndDevelopment).toBeNull();
    else expect(point.researchAndDevelopment).toBeCloseTo(research * 1e6, 0);
    const reference = resolveCompanyReportReference(record, point);
    expect(reference.exact).toBe(true);
    expect(reference.publishedAt <= '2026-11-05').toBe(true);
    expect(companyReportEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ companyId: id, period, status: 'reported', sourceUrl: reference.sourceUrl }),
    ]));
  });

  it('keeps KRW and JPY billion scales, without misusing adjusted or cumulative values', () => {
    expect(last(company('samsung').quarterly)).toMatchObject({ revenue: 195300e9, operatingProfit: 107400e9, researchAndDevelopment: 14400e9 });
    expect(last(company('sk-hynix').quarterly)).toMatchObject({ revenue: 104615.5e9, operatingProfit: 83333.8e9, researchAndDevelopment: null });
    expect(last(company('toyota').quarterly)).toMatchObject({ revenue: 13437e9, operatingProfit: 1127.6e9, researchAndDevelopment: 412.9e9, employees: 367173 });
  });

  it('reconciles derived Q3 profit and research to cumulative disclosures', () => {
    for (const [id, profit, research] of [['byd', 27011.743, 36277.138], ['hengrui', 7993.8937494, 5422.96935997]] as const) {
      const record = company(id);
      const h1 = companySeries(record, 'half').find(point => point.period === 'FY2026 H1')!;
      const q3 = record.quarterly.find(point => point.period === 'FY2026 Q3')!;
      expect(Math.abs(h1.operatingProfit + q3.operatingProfit - profit * 1e6)).toBeLessThan(1000);
      expect(Math.abs(h1.researchAndDevelopment! + q3.researchAndDevelopment! - research * 1e6)).toBeLessThan(1000);
    }
  });

  it('reconciles full fiscal years, allowing reported million-unit rounding', () => {
    for (const id of ['apple', 'qualcomm', 'visa']) {
      const record = company(id);
      const annual = record.annual.find(point => point.period === 'FY2026')!;
      const quarters = record.quarterly.filter(point => point.period.startsWith('FY2026 '));
      expect(quarters).toHaveLength(4);
      expect(Math.abs(quarters.reduce((sum, point) => sum + point.revenue, 0) - annual.revenue)).toBeLessThanOrEqual(1e6);
      expect(Math.abs(quarters.reduce((sum, point) => sum + point.operatingProfit, 0) - annual.operatingProfit)).toBeLessThanOrEqual(1e6);
    }
  });

  it('does not copy annual headcounts or promotional approximate counts into quarter-end values', () => {
    expect(last(company('apple').annual).employees).toBe(167000);
    expect(last(company('qualcomm').annual).employees).toBe(57000);
    expect(last(company('visa').annual).employees).toBeNull();
    for (const id of ['apple', 'qualcomm', 'beone', 'novoNordisk']) expect(last(company(id).quarterly).employees).toBeNull();
    expect(last(company('alphabet').quarterly).employees).toBe(204757);
    expect(last(company('amazon').quarterly).employees).toBe(1638000);
    for (const id of ['lilly', 'novoNordisk']) expect(company(id).metricMarkers).toEqual(expect.arrayContaining([
      expect.objectContaining({ period: 'FY2026 Q3', metric: 'operatingProfit' }),
    ]));
  });
});
