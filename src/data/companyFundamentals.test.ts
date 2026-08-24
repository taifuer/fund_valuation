import { describe, expect, it } from 'vitest';
import { companyFundamentalsDataset, companySeries, deriveHalfYear } from './companyFundamentals';

const EXPECTED_IDS = [
  'alibaba',
  'tencent',
  'baidu',
  'xiaomi',
  'byd',
  'catl',
  'smic',
  'hengrui',
  'beone',
  'tsmc',
  'mediatek',
  'huawei',
  'foxconn',
  'microsoft',
  'alphabet',
  'nvidia',
  'amd',
  'intel',
  'qualcomm',
  'apple',
  'tesla',
  'lilly',
  'merck',
  'pfizer',
  'amazon',
  'meta',
  'micron',
  'broadcom',
  'appliedMaterials',
  'oracle',
  'palantir',
  'novoNordisk',
  'asml',
  'arm',
  'samsung',
  'sk-hynix',
].sort();

function priorPeriod(period: string) {
  const match = /^FY(\d{4})(.*)$/.exec(period);
  return match ? `FY${Number(match[1]) - 1}${match[2]}` : '';
}

describe('company fundamentals offline dataset', () => {
  it('keeps the intentionally restrained roster complete', () => {
    const ids = companyFundamentalsDataset.companies.map((company) => company.id).sort();
    expect(ids).toEqual(EXPECTED_IDS);
    expect(ids).toContain('apple');
    expect(ids).toContain('arm');
    expect(ids).toContain('micron');
    expect(ids).toContain('smic');
    expect(ids).toContain('qualcomm');
    expect(ids).toContain('byd');
    expect(ids).toContain('catl');
    expect(ids).toContain('tesla');
    expect(ids).toContain('huawei');
    expect(ids).toContain('foxconn');
    expect(ids).toContain('broadcom');
    expect(ids).toContain('mediatek');
    expect(ids).not.toContain('sap');
  });

  it('provides sufficient annual and quarterly coverage for every company', () => {
    companyFundamentalsDataset.companies.forEach((company) => {
      const expectedAnnualCoverage = company.id === 'arm' ? 5 : 8;
      expect(company.annual.length, `${company.id} annual coverage`).toBeGreaterThanOrEqual(expectedAnnualCoverage);
      if (company.id === 'huawei') {
        expect(company.quarterly, `${company.id} does not infer quarterly coverage`).toEqual([]);
      } else {
        expect(company.quarterly.length, `${company.id} quarterly coverage`).toBeGreaterThanOrEqual(10);
      }
      const annualEmployeePoints = company.annual.filter((point) => point.employees != null);
      expect(annualEmployeePoints.length, `${company.id} employee coverage`).toBeGreaterThanOrEqual(2);
      expect(
        annualEmployeePoints.every((point) => point.employees! > 0),
        `${company.id} valid employee values`,
      ).toBe(true);
      expect(company.employeeScope.length, `${company.id} employee scope`).toBeGreaterThan(3);
      expect(company.sourceName.length, `${company.id} source name`).toBeGreaterThan(3);
      expect(company.sourceUrl, `${company.id} source url`).toMatch(/^https:\/\//);

      for (const series of [company.annual, company.quarterly]) {
        expect(new Set(series.map((point) => point.period)).size, `${company.id} unique periods`).toBe(series.length);
        series.forEach((point) => {
          expect(Number.isFinite(point.revenue), `${company.id} ${point.period} revenue`).toBe(true);
          expect(Number.isFinite(point.operatingProfit), `${company.id} ${point.period} operating profit`).toBe(true);
          if (point.researchAndDevelopment != null) {
            expect(
              Number.isFinite(point.researchAndDevelopment),
              `${company.id} ${point.period} research and development`,
            ).toBe(true);
            expect(point.researchAndDevelopment).toBeGreaterThanOrEqual(0);
          }
          expect(point.periodEnd, `${company.id} ${point.period} end date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });
      }
      (company.employeeMarkers ?? []).forEach((marker) => {
        expect(
          company.annual.some((point) => point.period === marker.period),
          `${company.id} ${marker.period} methodology marker`,
        ).toBe(true);
        expect(marker.label.length).toBeGreaterThan(1);
        expect(marker.note).toContain(marker.period);
      });
      (company.metricMarkers ?? []).forEach((marker) => {
        expect(
          [...company.annual, ...company.quarterly].some((point) => point.period === marker.period),
          `${company.id} ${marker.period} metric methodology marker`,
        ).toBe(true);
        expect(marker.label.length).toBeGreaterThan(1);
        expect(marker.note).toContain(marker.period);
      });
    });
  });

  it('reconciles complete quarterly years to the matching annual disclosure', () => {
    companyFundamentalsDataset.companies.forEach((company) => {
      const quartersByYear = new Map<string, typeof company.quarterly>();
      company.quarterly.forEach((point) => {
        const year = point.period.match(/^(FY\d{4}) Q[1-4]$/)?.[1];
        if (!year) return;
        quartersByYear.set(year, [...(quartersByYear.get(year) ?? []), point]);
      });

      quartersByYear.forEach((quarters, year) => {
        if (quarters.length !== 4) return;
        const annual = company.annual.find((point) => point.period === year);
        if (!annual) return;
        const revenue = quarters.reduce((total, point) => total + point.revenue, 0);
        const operatingProfit = quarters.reduce((total, point) => total + point.operatingProfit, 0);
        const revenueError = Math.abs(revenue - annual.revenue) / Math.max(Math.abs(annual.revenue), 1);
        const profitError = Math.abs(operatingProfit - annual.operatingProfit) / Math.max(Math.abs(annual.operatingProfit), 1);
        expect(revenueError, `${company.id} ${year} revenue reconciliation`).toBeLessThan(5e-4);
        expect(profitError, `${company.id} ${year} operating profit reconciliation`).toBeLessThan(5e-4);
        if (
          annual.researchAndDevelopment != null
          && quarters.every((point) => point.researchAndDevelopment != null)
        ) {
          const researchAndDevelopment = quarters.reduce(
            (total, point) => total + point.researchAndDevelopment!,
            0,
          );
          const researchError = Math.abs(researchAndDevelopment - annual.researchAndDevelopment)
            / Math.max(Math.abs(annual.researchAndDevelopment), 1);
          expect(researchError, `${company.id} ${year} research reconciliation`).toBeLessThan(5e-4);
        }
      });
    });
  });

  it('keeps extended quarterly employee histories only for sustained official reporters', () => {
    const expectedCoverage: Record<string, { firstPeriod: string; minimumPoints: number }> = {
      alibaba: { firstPeriod: 'FY2021 Q1', minimumPoints: 25 },
      tencent: { firstPeriod: 'FY2021 Q1', minimumPoints: 22 },
      alphabet: { firstPeriod: 'FY2020 Q1', minimumPoints: 26 },
      amazon: { firstPeriod: 'FY2020 Q1', minimumPoints: 26 },
      meta: { firstPeriod: 'FY2020 Q1', minimumPoints: 26 },
      novoNordisk: { firstPeriod: 'FY2023 Q1', minimumPoints: 12 },
    };

    Object.entries(expectedCoverage).forEach(([id, expectation]) => {
      const company = companyFundamentalsDataset.companies.find((candidate) => candidate.id === id)!;
      const employeePoints = company.quarterly.filter((point) => point.employees != null);
      expect(employeePoints[0]?.period, `${id} first quarterly employee disclosure`).toBe(expectation.firstPeriod);
      expect(employeePoints.length, `${id} quarterly employee coverage`).toBeGreaterThanOrEqual(expectation.minimumPoints);
      expect(employeePoints.every((point) => point.employees! > 0), `${id} valid employee values`).toBe(true);
    });
  });

  it('has a prior-year comparison for every latest published period', () => {
    companyFundamentalsDataset.companies.forEach((company) => {
      (['annual', 'half', 'quarterly'] as const).forEach((frequency) => {
        const series = companySeries(company, frequency);
        const latest = series[series.length - 1];
        if (!latest) return;
        expect(
          series.some((point) => point.period === priorPeriod(latest!.period)),
          `${company.id} ${frequency} prior comparable period`,
        ).toBe(true);
      });
    });
  });

  it('derives half-year values only from complete quarter pairs', () => {
    const microsoft = companyFundamentalsDataset.companies.find((company) => company.id === 'microsoft')!;
    const halves = deriveHalfYear(microsoft.quarterly);
    const firstHalf = halves.find((point) => point.period === 'FY2026 H1')!;
    const q1 = microsoft.quarterly.find((point) => point.period === 'FY2026 Q1')!;
    const q2 = microsoft.quarterly.find((point) => point.period === 'FY2026 Q2')!;

    expect(firstHalf.revenue).toBe(q1.revenue + q2.revenue);
    expect(firstHalf.operatingProfit).toBe(q1.operatingProfit + q2.operatingProfit);
    expect(firstHalf.periodEnd).toBe(q2.periodEnd);
    expect(firstHalf.researchAndDevelopment).toBeNull();
    expect(firstHalf.derived).toBe(true);
  });

  it('derives research spending only when both source quarters disclose it', () => {
    const broadcom = companyFundamentalsDataset.companies.find((company) => company.id === 'broadcom')!;
    const firstHalf = deriveHalfYear(broadcom.quarterly).find((point) => point.period === 'FY2025 H1')!;
    const q1 = broadcom.quarterly.find((point) => point.period === 'FY2025 Q1')!;
    const q2 = broadcom.quarterly.find((point) => point.period === 'FY2025 Q2')!;

    expect(firstHalf.researchAndDevelopment).toBe(
      q1.researchAndDevelopment! + q2.researchAndDevelopment!,
    );
  });

  it('keeps Huawei annual-only instead of manufacturing interim periods', () => {
    const huawei = companyFundamentalsDataset.companies.find((company) => company.id === 'huawei')!;

    expect(huawei.annual).toHaveLength(8);
    expect(huawei.quarterly).toEqual([]);
    expect(companySeries(huawei, 'half')).toEqual([]);
    expect(huawei.annual.every((point) => point.researchAndDevelopment != null)).toBe(true);
  });

  it('keeps period-end employee disclosures when deriving half years', () => {
    const tencent = companyFundamentalsDataset.companies.find((company) => company.id === 'tencent')!;
    const firstHalf = deriveHalfYear(tencent.quarterly).find((point) => point.period === 'FY2026 H1')!;
    const secondQuarter = tencent.quarterly.find((point) => point.period === 'FY2026 Q2')!;

    expect(firstHalf.employees).toBe(secondQuarter.employees);
    expect(firstHalf.employees).toBe(115927);
  });
});
