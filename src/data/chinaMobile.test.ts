import { describe, expect, it } from 'vitest';
import company from './companies/china-mobile';
import { companySeries } from './companyFundamentals';
import { companyIndustry } from './companyIndustries';
import { companyReportEvents } from './companyReportCalendar';
import { resolveCompanyReportReference } from './companyReportSources';
import { companyMarketCaps, marketCapUnavailable, marketCapQuoteBasis, marketCapNotes } from './companyMarketCaps';

describe('China Mobile reviewed consolidated disclosures', () => {
  it('uses one listed-company accounting scope and a continuous supported history', () => {
    expect(companyIndustry(company.id)).toBe('electronics');
    expect(company).toMatchObject({ region: 'china', currency: 'CNY', ticker: '600941.SH / 0941.HK' });
    expect(company.annual).toHaveLength(28);
    expect(company.annual[0]).toMatchObject({ period: 'FY1998', operatingProfit: null, researchAndDevelopment: null, employees: 12530 });
    expect(company.annual[0].revenue).toBeCloseTo(26345393000, 0);
    expect(company.annual.find(point => point.period === 'FY2018')).toMatchObject({ revenue: 736819e6, operatingProfit: 151585e6, researchAndDevelopment: 3865e6 });
    expect(company.quarterly).toHaveLength(23);
    expect(company.quarterly[0].period).toBe('FY2021 Q1');
    expect(company.halfYear.filter(point => !point.derived)).toHaveLength(29);
    expect(companySeries(company, 'half')).toHaveLength(57);
    expect(company.annual.some(point => point.period === 'FY1997')).toBe(false);
    company.quarterly.forEach((point, index) => {
      expect(point.period).toBe(`FY${2021 + Math.floor(index / 4)} Q${index % 4 + 1}`);
    });
  });

  it('preserves original consolidated revenue, null profit gaps and consistent full-year minus H1 calculations', () => {
    for (const annual of company.annual.filter(point => point.periodEnd < '2018-01-01')) {
      expect(annual.operatingProfit).toBeNull();
      expect(annual.researchAndDevelopment).toBeNull();
    }
    for (const half of company.halfYear.filter(point => point.periodEnd < '2021-01-01')) {
      expect(half.operatingProfit).toBeNull();
      expect(half.researchAndDevelopment).toBeNull();
    }
    for (const annual of company.annual) {
      const halves = company.halfYear.filter(point => point.period.startsWith(`${annual.period} `));
      expect(halves).toHaveLength(2);
      expect(halves[0].revenue + halves[1].revenue).toBeCloseTo(annual.revenue, 0);
      expect(halves[1].derived).toBe(true);
      expect(halves[1].employees).toBe(annual.employees);
    }
    expect(company.annual.find(point => point.period === 'FY1998')!.revenue).not.toBe(28527747000);
    expect(company.halfYear.find(point => point.period === 'FY1998 H1')!.revenue).toBeCloseTo(11367140000, 0);
    expect(company.halfYear.find(point => point.period === 'FY2015 H1')!.revenue).toBe(345691e6);
    expect(company.halfYear.find(point => point.period === 'FY2015 H2')!.revenue).toBe(322644e6);
    expect(resolveCompanyReportReference(company, company.halfYear.find(point => point.period === 'FY2015 H1')!).sourceUrl)
      .toBe('https://www.chinamobileltd.com/en/ir/reports/ir2016.pdf');
    expect(company.metricMarkers).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'revenue', period: 'FY2013' }),
      expect.objectContaining({ metric: 'revenue', period: 'FY2015' }),
    ]));
  });

  it('reconciles every quarter to the official cumulative statements, not IFRS operating earnings', () => {
    const cumulative = [
      [2021, 198429, 443647, 648630, 848258, 31252, 77436, 113991, 151994, 1718, 5795, 9513, 15577],
      [2022, 227320, 496934, 723487, 937259, 33477, 90910, 127052, 161306, 2339, 7002, 11715, 18091],
      [2023, 250746, 530719, 775560, 1009309, 36141, 98000, 136912, 168117, 2814, 8515, 15101, 28711],
      [2024, 263707, 546744, 791458, 1040759, 38134, 102506, 141479, 176284, 3003, 11971, 20300, 28163],
      [2025, 263760, 543769, 794666, 1050187, 39016, 106295, 145704, 178444, 3192, 10382, 20423, 29253],
    ];
    for (const [year, ...values] of cumulative) {
      const quarters = company.quarterly.filter(point => point.period.startsWith(`FY${year} `));
      for (const [metricIndex, metric] of (['revenue', 'operatingProfit', 'researchAndDevelopment'] as const).entries()) {
        quarters.forEach((_, index) => {
          const sum = quarters.slice(0, index + 1).reduce((total, point) => total + point[metric]!, 0);
          expect(sum, `${year} Q${index + 1} ${metric}`).toBe(values[metricIndex * 4 + index] * 1e6);
        });
      }
      const halves = companySeries(company, 'half').filter(point => point.period.startsWith(`FY${year} `));
      expect(halves[1].derived).toBe(true);
      for (const metric of ['revenue', 'operatingProfit', 'researchAndDevelopment'] as const) {
        expect(halves[0][metric]! + halves[1][metric]!).toBe(company.annual.find(point => point.period === `FY${year}`)![metric]);
      }
    }
    const recent = company.quarterly.filter(point => point.period.startsWith('FY2026 '));
    expect(recent[2]).toMatchObject({ period: 'FY2026 Q3', revenue: 242260e6, operatingProfit: 33826e6, researchAndDevelopment: 8539e6 });
    expect(recent.reduce((sum, point) => sum + point.revenue, 0)).toBe(780295e6);
    expect(recent.reduce((sum, point) => sum + point.operatingProfit!, 0)).toBe(131769e6);
    expect(recent.reduce((sum, point) => sum + point.researchAndDevelopment!, 0)).toBe(20548e6);
    expect(company.annual[company.annual.length - 1].operatingProfit).not.toBe(148932e6);
    expect(company.annual[company.annual.length - 1].researchAndDevelopment).toBe(29253e6);
  });

  it('retains exact annual counts and labelled official interim approximations without filling missing quarters', () => {
    expect(company.annual.slice(-8).map(point => point.employees)).toEqual([459152, 456239, 454332, 449934, 450698, 451830, 455405, 461345]);
    expect(company.annual.every(point => point.employees != null)).toBe(true);
    expect(company.annual.find(point => point.period === 'FY2015')!.employees).toBe(438645);
    expect(company.halfYear.find(point => point.period === 'FY2001 H1')!.employees).toBe(38312);
    for (const year of [1998, 1999, 2000, 2015, 2016, 2017, 2018]) {
      expect(company.halfYear.find(point => point.period === `FY${year} H1`)!.employees).toBeNull();
    }
    expect(company.halfYear.filter(point => point.period.endsWith('H1') && point.periodEnd >= '2021').map(point => point.employees))
      .toEqual([446898, 446068, 450000, 450000, 450000, 457000]);
    expect(company.employeeScope).toContain('约 45 万人');
    expect(company.employeeScope).toContain('约 45.7 万人');
    expect(company.employeeMarkers).toEqual(expect.arrayContaining([
      expect.objectContaining({ period: 'FY2023 H1', label: '披露约数' }),
    ]));
    company.quarterly.forEach(point => {
      if (/Q[13]$/.test(point.period)) expect(point.employees).toBeNull();
      else expect(point.employees).toBe(company.halfYear.find(half => half.periodEnd === point.periodEnd)!.employees);
    });
  });

  it('links all periods to verified official reports and includes the new financial calendar event', () => {
    for (const point of [...company.annual, ...company.quarterly, ...companySeries(company, 'half')]) {
      const source = resolveCompanyReportReference(company, point);
      expect(source.exact).toBe(true);
      expect(source.sourceUrl).toMatch(/^https:\/\/(?:static\.cninfo\.com\.cn\/finalpage\/\d{4}-\d{2}-\d{2}\/\d+\.PDF|www\.chinamobileltd\.com\/en\/ir\/reports\/(?:ar|ir)\d{4}\.pdf)$/);
      expect(source.publishedAt > point.periodEnd && source.publishedAt <= '2026-11-05').toBe(true);
    }
    expect(companyReportEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ companyId: company.id, period: 'FY2026 Q3', publishedAt: '2026-10-21', status: 'reported' }),
    ]));
  });

  it('keeps verified Hong Kong quote market caps distinct from A/H combined equity', () => {
    const caps = companyMarketCaps[company.id];
    expect(caps).toHaveLength(65);
    expect(marketCapUnavailable[company.id]).toBeUndefined();
    expect(marketCapQuoteBasis[company.id]).toBe('港股口径');
    expect(marketCapNotes[company.id]).toContain('不是 A/H 股分股类合计市值');
    expect(new Set(caps.map(point => point.currency))).toEqual(new Set(['HKD']));
    for (const point of caps) {
      expect(point.value).toBeGreaterThan(0);
      expect(point.sourceUrl).toMatch(/^https:\/\/(stockanalysis.com\/quote\/hkg\/0941\/|companiesmarketcap.com\/hkd\/china-mobile\/)/);
    }
    expect(caps.find(point => point.periodEnd === '2025-12-31')?.value).toBe(1796123976040);
    expect(caps.find(point => point.periodEnd === '2019-06-30')?.observationDate).toBe('2019-06-28');
    expect(caps.find(point => point.periodEnd === '2000-12-31')?.observationDate).toBe('2000-12-29');
    for (const frequency of ['annual', 'half', 'quarterly'] as const) {
      const points = companySeries(company, frequency);
      expect(points.filter(point => point.periodEnd >= '2000').every(point => point.marketCap != null), frequency).toBe(true);
      expect(points.filter(point => point.periodEnd < '2000').every(point => point.marketCap == null), frequency).toBe(true);
    }
  });
});
