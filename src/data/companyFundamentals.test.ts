import { describe, expect, it } from 'vitest';
import {
  COMPANIES_WITHOUT_COMPARABLE_RESEARCH_DISCLOSURE,
  PARTIAL_RESEARCH_DISCLOSURE_PERIODS,
  companyFundamentalsDataset,
  companySeries,
  deriveHalfYear,
} from './companyFundamentals';

const EXPECTED_IDS = [
  'alibaba',
  'jd',
  'pdd',
  'tencent',
  'meituan',
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
  'visa',
  'walmart',
  'ibm',
  'microsoft',
  'alphabet',
  'crm',
  'adbe',
  'nvidia',
  'amd',
  'intel',
  'txn',
  'cisco',
  'qualcomm',
  'apple',
  'tesla',
  'jnj',
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
  'siemens',
  'arm',
  'toyota',
  'tcs',
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
    expect(ids).toContain('meituan');
    expect(ids).toContain('jd');
    expect(ids).toContain('pdd');
    expect(ids).toContain('cisco');
    expect(ids).toContain('toyota');
    expect(ids).toContain('tcs');
    expect(ids).toContain('visa');
    expect(ids).toContain('walmart');
    expect(ids).toContain('ibm');
    expect(ids).toContain('crm');
    expect(ids).toContain('adbe');
    expect(ids).toContain('txn');
    expect(ids).toContain('jnj');
    expect(ids).toContain('siemens');
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

      for (const series of [company.annual, company.halfYear, company.quarterly]) {
        expect(new Set(series.map((point) => point.period)).size, `${company.id} unique periods`).toBe(series.length);
        expect(
          series.map((point) => point.periodEnd),
          `${company.id} chronological periods`,
        ).toEqual(series.map((point) => point.periodEnd).sort());
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
          [...company.annual, ...company.halfYear, ...company.quarterly]
            .some((point) => point.period === marker.period),
          `${company.id} ${marker.period} methodology marker`,
        ).toBe(true);
        expect(marker.label.length).toBeGreaterThan(1);
        expect(marker.note).toContain(marker.period);
      });
      (company.metricMarkers ?? []).forEach((marker) => {
        expect(
          [...company.annual, ...company.halfYear, ...company.quarterly]
            .some((point) => point.period === marker.period),
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

  it('classifies every annual research gap instead of silently leaving missing data', () => {
    const noComparableResearch = new Set(
      Object.keys(COMPANIES_WITHOUT_COMPARABLE_RESEARCH_DISCLOSURE),
    );

    companyFundamentalsDataset.companies.forEach((company) => {
      const missingPeriods = company.annual
        .filter((point) => point.researchAndDevelopment == null)
        .map((point) => point.period);

      if (noComparableResearch.has(company.id)) {
        expect(missingPeriods, `${company.id} intentionally has no standalone research series`)
          .toEqual(company.annual.map((point) => point.period));
        return;
      }

      expect(missingPeriods, `${company.id} classified partial research periods`)
        .toEqual(PARTIAL_RESEARCH_DISCLOSURE_PERIODS[company.id] ?? []);
    });
  });

  it('keeps corrected official research series and comparable historical scopes', () => {
    const annualResearch = (id: string, period: string) => companyFundamentalsDataset.companies
      .find((company) => company.id === id)!
      .annual.find((point) => point.period === period)!
      .researchAndDevelopment;

    expect(annualResearch('tencent', 'FY2025')).toBe(85_747_000_000);
    expect(annualResearch('byd', 'FY2025')).toBe(57_978_105_000);
    expect(annualResearch('catl', 'FY2025')).toBe(22_146_581_000);
    expect(annualResearch('tsmc', 'FY2025')).toBe(246_427_000_000);
    expect(annualResearch('toyota', 'FY2026')).toBe(1_522_800_000_000);
    expect(annualResearch('jd', 'FY2025')).toBe(22_229_000_000);
    expect(annualResearch('samsung', 'FY2025')).toBe(37_740_392_000_000);
    expect(annualResearch('sk-hynix', 'FY2018')).toBeNull();

    const smic = companyFundamentalsDataset.companies.find((company) => company.id === 'smic')!;
    expect(annualResearch('smic', 'FY2018')).toBe(663_368_000);
    expect(smic.quarterly.find((point) => point.period === 'FY2018 Q1')!.researchAndDevelopment)
      .toBeNull();
    expect(smic.quarterly.find((point) => point.period === 'FY2020 Q1')!.researchAndDevelopment)
      .toBe(166_486_000);
  });

  it('keeps the latest Meituan and BYD quarter reconciled to their original reports', () => {
    const meituan = companyFundamentalsDataset.companies.find(
      (company) => company.id === 'meituan',
    )!;
    const meituanQuarter = meituan.quarterly.find((point) => point.period === 'FY2026 Q2')!;
    expect(meituanQuarter).toMatchObject({
      periodEnd: '2026-06-30',
      revenue: 104_643_044_000,
      operatingProfit: 2_691_166_000,
      researchAndDevelopment: 7_670_045_000,
    });
    expect(meituan.latestReport?.publishedAt).toBe('2026-08-28');

    const byd = companyFundamentalsDataset.companies.find((company) => company.id === 'byd')!;
    const bydQuarter = byd.quarterly.find((point) => point.period === 'FY2026 Q2')!;
    expect(bydQuarter).toMatchObject({
      periodEnd: '2026-06-30',
      revenue: 194_590_107_000,
      operatingProfit: 10_047_689_000,
      researchAndDevelopment: 11_963_586_000,
    });
    expect(byd.latestReport?.sourceUrl).toContain('hkexnews.hk');
  });

  it('retains official exact and approximate employee disclosures with explicit scope', () => {
    const annualEmployees = (id: string, period: string) => companyFundamentalsDataset.companies
      .find((company) => company.id === id)!
      .annual.find((point) => point.period === period)!
      .employees;

    expect(annualEmployees('meituan', 'FY2019')).toBe(54580);
    expect(annualEmployees('mediatek', 'FY2025')).toBe(22869);
    expect(annualEmployees('foxconn', 'FY2025')).toBe(900000);
    expect(annualEmployees('broadcom', 'FY2019')).toBe(19000);
    expect(annualEmployees('oracle', 'FY2026')).toBe(141000);
    expect(annualEmployees('tcs', 'FY2026')).toBe(584519);
    expect(annualEmployees('jd', 'FY2025')).toBe(776682);

    const foxconn = companyFundamentalsDataset.companies.find((company) => company.id === 'foxconn')!;
    expect(foxconn.employeeMarkers?.find((marker) => marker.period === 'FY2025')?.label)
      .toBe('官方约数');
  });

  it('keeps extended quarterly employee histories only for sustained official reporters', () => {
    const expectedCoverage: Record<string, { firstPeriod: string; minimumPoints: number }> = {
      alibaba: { firstPeriod: 'FY2021 Q1', minimumPoints: 25 },
      tencent: { firstPeriod: 'FY2021 Q1', minimumPoints: 22 },
      toyota: { firstPeriod: 'FY2019 Q1', minimumPoints: 33 },
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

  it('keeps verified long-form quarterly histories continuous', () => {
    const expectedCoverage: Record<string, { firstPeriod: string; minimumPoints: number }> = {
      alibaba: { firstPeriod: 'FY2019 Q1', minimumPoints: 33 },
      jd: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      pdd: { firstPeriod: 'FY2022 Q1', minimumPoints: 18 },
      tencent: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      meituan: { firstPeriod: 'FY2018 Q1', minimumPoints: 33 },
      baidu: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      xiaomi: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      byd: { firstPeriod: 'FY2018 Q1', minimumPoints: 33 },
      catl: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      smic: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      hengrui: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      beone: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      tsmc: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      mediatek: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      foxconn: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      visa: { firstPeriod: 'FY2018 Q1', minimumPoints: 35 },
      walmart: { firstPeriod: 'FY2019 Q1', minimumPoints: 34 },
      ibm: { firstPeriod: 'FY2021 Q1', minimumPoints: 22 },
      microsoft: { firstPeriod: 'FY2019 Q1', minimumPoints: 32 },
      alphabet: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      crm: { firstPeriod: 'FY2018 Q1', minimumPoints: 38 },
      adbe: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      nvidia: { firstPeriod: 'FY2019 Q1', minimumPoints: 33 },
      amd: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      intel: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      txn: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      cisco: { firstPeriod: 'FY2018 Q1', minimumPoints: 36 },
      qualcomm: { firstPeriod: 'FY2018 Q1', minimumPoints: 35 },
      apple: { firstPeriod: 'FY2018 Q1', minimumPoints: 35 },
      tesla: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      jnj: { firstPeriod: 'FY2023 Q1', minimumPoints: 14 },
      lilly: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      merck: { firstPeriod: 'FY2020 Q1', minimumPoints: 26 },
      pfizer: { firstPeriod: 'FY2020 Q1', minimumPoints: 26 },
      amazon: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      meta: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      micron: { firstPeriod: 'FY2018 Q1', minimumPoints: 35 },
      broadcom: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      appliedMaterials: { firstPeriod: 'FY2018 Q1', minimumPoints: 35 },
      oracle: { firstPeriod: 'FY2018 Q1', minimumPoints: 36 },
      palantir: { firstPeriod: 'FY2020 Q1', minimumPoints: 26 },
      novoNordisk: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      asml: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      siemens: { firstPeriod: 'FY2021 Q1', minimumPoints: 23 },
      arm: { firstPeriod: 'FY2023 Q1', minimumPoints: 17 },
      toyota: { firstPeriod: 'FY2019 Q1', minimumPoints: 33 },
      tcs: { firstPeriod: 'FY2019 Q1', minimumPoints: 33 },
      samsung: { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
      'sk-hynix': { firstPeriod: 'FY2018 Q1', minimumPoints: 34 },
    };

    expect(Object.keys(expectedCoverage).sort()).toEqual(
      EXPECTED_IDS.filter((id) => id !== 'huawei'),
    );

    Object.entries(expectedCoverage).forEach(([id, expectation]) => {
      const company = companyFundamentalsDataset.companies.find((candidate) => candidate.id === id)!;
      expect(company.quarterly[0]?.period, `${id} first verified quarter`).toBe(expectation.firstPeriod);
      expect(company.quarterly.length, `${id} quarterly coverage`).toBeGreaterThanOrEqual(expectation.minimumPoints);
    });

    companyFundamentalsDataset.companies.forEach((company) => {
      const quarterCounts = new Map<string, number>();
      company.quarterly.forEach((point) => {
        const fiscalYear = point.period.match(/^(FY\d{4}) Q[1-4]$/)?.[1];
        if (fiscalYear) quarterCounts.set(fiscalYear, (quarterCounts.get(fiscalYear) ?? 0) + 1);
      });
      const completeYears = [...quarterCounts.entries()]
        .filter(([, count]) => count === 4)
        .map(([year]) => Number(year.slice(2)))
        .sort((left, right) => left - right);
      if (completeYears.length < 2) return;
      const expectedYears = Array.from(
        { length: completeYears[completeYears.length - 1] - completeYears[0] + 1 },
        (_, index) => completeYears[0] + index,
      );
      expect(completeYears, `${company.id} continuous complete fiscal years`).toEqual(expectedYears);
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

  it('keeps JD consolidated GAAP results separate from segment and ecosystem measures', () => {
    const jd = companyFundamentalsDataset.companies.find((company) => company.id === 'jd')!;

    expect(jd.annual.find((point) => point.period === 'FY2025')?.operatingProfit)
      .toBe(2_774_000_000);
    expect(jd.quarterly.find((point) => point.period === 'FY2025 Q4')?.operatingProfit)
      .toBe(-5_849_000_000);
    expect(jd.quarterly[jd.quarterly.length - 1]?.period).toBe('FY2026 Q2');
    expect(jd.methodologyNote).toContain('JD Ecosystem');
  });

  it('includes NVIDIA fiscal 2027 second-quarter GAAP results', () => {
    const nvidia = companyFundamentalsDataset.companies.find((company) => company.id === 'nvidia')!;
    const latest = nvidia.quarterly[nvidia.quarterly.length - 1]!;

    expect(latest).toMatchObject({
      period: 'FY2027 Q2',
      periodEnd: '2026-07-26',
      revenue: 96_221_000_000,
      operatingProfit: 63_734_000_000,
      researchAndDevelopment: 7_054_000_000,
    });
  });

  it('keeps PDD audited annual reconciliation and latest quarterly results explicit', () => {
    const pdd = companyFundamentalsDataset.companies.find((company) => company.id === 'pdd')!;
    const latest = pdd.quarterly[pdd.quarterly.length - 1]!;

    expect(latest).toMatchObject({
      period: 'FY2026 Q2',
      periodEnd: '2026-06-30',
      revenue: 112_358_000_000,
      operatingProfit: 27_764_000_000,
      researchAndDevelopment: 4_567_000_000,
    });
    expect(pdd.annual.find((point) => point.period === 'FY2025')?.operatingProfit)
      .toBe(93_102_131_000);
    expect(pdd.metricMarkers?.some((marker) => marker.period === 'FY2025 Q4')).toBe(true);
    expect(pdd.latestReport?.publishedAt).toBe('2026-08-24');
  });

  it('includes Cisco fiscal 2026 full-year and fourth-quarter GAAP results', () => {
    const cisco = companyFundamentalsDataset.companies.find((company) => company.id === 'cisco')!;

    expect(cisco.annual[cisco.annual.length - 1]).toMatchObject({
      period: 'FY2026',
      revenue: 63_325_000_000,
      operatingProfit: 15_368_000_000,
      researchAndDevelopment: 9_563_000_000,
    });
    expect(cisco.quarterly[cisco.quarterly.length - 1]).toMatchObject({
      period: 'FY2026 Q4',
      revenue: 17_252_000_000,
      operatingProfit: 4_264_000_000,
      researchAndDevelopment: 2_431_000_000,
    });
    expect(cisco.latestReport?.publishedAt).toBe('2026-08-12');
  });

  it('keeps the five added companies on verified report-specific profit scopes', () => {
    const company = (id: string) => companyFundamentalsDataset.companies
      .find((candidate) => candidate.id === id)!;

    const salesforce = company('crm');
    const ibm = company('ibm');

    expect(salesforce.quarterly[salesforce.quarterly.length - 1]).toMatchObject({
      period: 'FY2027 Q2',
      periodEnd: '2026-07-31',
      revenue: 11_345_000_000,
      operatingProfit: 2_331_000_000,
      researchAndDevelopment: 1_687_000_000,
    });
    expect(ibm.quarterly[ibm.quarterly.length - 1]).toMatchObject({
      period: 'FY2026 Q2',
      revenue: 17_162_000_000,
      operatingProfit: 2_479_000_000,
      researchAndDevelopment: 2_311_000_000,
    });
    expect(company('ibm').profitMetricLabel).toBe('税前利润');
    expect(company('jnj').profitMetricLabel).toBe('税前利润');
    expect(company('jnj').metricMarkers?.some((marker) => marker.period === 'FY2025 Q1')).toBe(true);
    expect(company('txn').quarterly).toHaveLength(34);
    expect(company('adbe').quarterly).toHaveLength(34);
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
    expect(firstHalf.researchAndDevelopment).toBe(
      q1.researchAndDevelopment! + q2.researchAndDevelopment!,
    );
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

  it('keeps Huawei reported half years without manufacturing quarterly periods', () => {
    const huawei = companyFundamentalsDataset.companies.find((company) => company.id === 'huawei')!;
    const halves = companySeries(huawei, 'half');

    expect(huawei.annual).toHaveLength(8);
    expect(huawei.quarterly).toEqual([]);
    expect(halves).toEqual(huawei.halfYear);
    expect(halves.map((point) => point.period)).toEqual([
      'FY2019 H1',
      'FY2020 H1',
      'FY2021 H1',
      'FY2022 H1',
      'FY2023 H1',
      'FY2024 H1',
      'FY2025 H1',
      'FY2026 H1',
    ]);
    expect(halves[0]).toMatchObject({
      period: 'FY2019 H1',
      periodEnd: '2019-06-30',
      employees: null,
    });
    expect(halves[7]).toMatchObject({
      period: 'FY2026 H1',
      periodEnd: '2026-06-30',
      employees: null,
    });
    expect(halves[0].revenue).toBeCloseTo(396_538_490_000, 0);
    expect(halves[0].operatingProfit).toBeCloseTo(43_543_180_000, 0);
    expect(halves[0].researchAndDevelopment).toBeCloseTo(56_596_722_000, 0);
    expect(halves[7].revenue).toBeCloseTo(467_819_096_000, 0);
    expect(halves[7].operatingProfit).toBeCloseTo(32_771_344_000, 0);
    expect(halves[7].researchAndDevelopment).toBeCloseTo(121_382_454_000, 0);
    expect(halves.every((point) => point.derived !== true)).toBe(true);
    expect(huawei.latestReport?.publishedAt).toBe('2026-08-31');
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
