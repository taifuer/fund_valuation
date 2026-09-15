import { describe, expect, it } from 'vitest';
import type { CompanyFundamentals } from '../types';
import {
  assessCompanyReportFreshness,
  latestCompanyPeriodEnd,
  latestSecPeriodicFiling,
  listSecPeriodicFilings,
  listSecReviewFilings,
  secPeriodicReviewReason,
  secAnnouncementCandidates,
  type SecReviewFiling,
} from './companyReportMaintenance';

function company(overrides: Partial<CompanyFundamentals> = {}): CompanyFundamentals {
  return {
    id: 'sample',
    name: '示例公司',
    nameEn: 'Sample',
    ticker: 'SAMPLE',
    region: 'china',
    regionLabel: '中国',
    currency: 'CNY',
    sourceName: '官方披露',
    sourceUrl: 'https://example.com',
    employeeScope: '期末员工',
    annual: [],
    halfYear: [],
    quarterly: [{
      period: 'FY2026 Q1',
      periodEnd: '2026-03-31',
      revenue: 1,
      operatingProfit: 1,
      researchAndDevelopment: null,
      employees: null,
    }],
    ...overrides,
  };
}

describe('company report maintenance', () => {
  it('flags companies approaching their conservative review window', () => {
    expect(assessCompanyReportFreshness(company(), '2026-08-27')).toMatchObject({
      status: 'upcoming',
      latestPeriod: 'FY2026 Q1',
      expectedPeriod: 'FY2026 Q2',
      expectedPeriodEnd: '2026-06-30',
      reviewAfter: '2026-09-03',
    });
  });

  it('keeps recent quarterly disclosures current', () => {
    expect(assessCompanyReportFreshness(company({
      region: 'usa',
      quarterly: [{
        period: 'FY2027 Q2',
        periodEnd: '2026-07-26',
        revenue: 1,
        operatingProfit: 1,
        researchAndDevelopment: null,
        employees: null,
      }],
    }), '2026-08-27').status).toBe('current');
  });

  it('checks directly disclosed half years on a six-month cadence', () => {
    expect(assessCompanyReportFreshness(company({
      region: 'europe',
      annual: [{
        period: 'FY2025',
        periodEnd: '2025-12-31',
        revenue: 1,
        operatingProfit: 1,
        researchAndDevelopment: null,
        employees: null,
      }],
      halfYear: [{
        period: 'FY2026 H1',
        periodEnd: '2026-06-30',
        revenue: 1,
        operatingProfit: 1,
        researchAndDevelopment: null,
        employees: null,
      }],
      quarterly: [],
    }), '2026-08-31')).toMatchObject({
      status: 'current',
      latestPeriod: 'FY2026 H1',
      expectedPeriod: 'FY2026',
      expectedPeriodEnd: '2026-12-31',
    });
  });

  it('selects the latest SEC 10-Q or 10-K filing', () => {
    expect(latestSecPeriodicFiling({
      accessionNumber: ['other', 'quarterly', 'annual'],
      filingDate: ['2026-08-27', '2026-08-26', '2026-02-25'],
      reportDate: ['', '2026-07-26', '2026-01-25'],
      form: ['8-K', '10-Q', '10-K'],
      primaryDocument: ['other.htm', 'quarterly.htm', 'annual.htm'],
    })).toEqual({
      accessionNumber: 'quarterly',
      filingDate: '2026-08-26',
      reportDate: '2026-07-26',
      form: '10-Q',
      primaryDocument: 'quarterly.htm',
    });
  });

  it('lists SEC periodic filings for a calendar year in newest-first order', () => {
    expect(listSecPeriodicFilings({
      accessionNumber: ['other', 'quarterly', 'annual', 'older'],
      filingDate: ['2026-08-27', '2026-08-26', '2026-02-25', '2025-11-01'],
      reportDate: ['', '2026-07-26', '2025-12-31', '2025-09-30'],
      form: ['8-K', '10-Q', '10-K', '10-Q'],
      primaryDocument: ['other.htm', 'quarterly.htm', 'annual.htm', 'older.htm'],
    }, 2026)).toEqual([
      {
        accessionNumber: 'quarterly',
        filingDate: '2026-08-26',
        reportDate: '2026-07-26',
        form: '10-Q',
        primaryDocument: 'quarterly.htm',
      },
      {
        accessionNumber: 'annual',
        filingDate: '2026-02-25',
        reportDate: '2025-12-31',
        form: '10-K',
        primaryDocument: 'annual.htm',
      },
    ]);
  });

  it('uses the newest period end across annual, half-year and quarterly data', () => {
    expect(latestCompanyPeriodEnd(company({
      annual: [{
        period: 'FY2026',
        periodEnd: '2026-03-31',
        revenue: 1,
        operatingProfit: 1,
        researchAndDevelopment: null,
        employees: null,
      }],
      halfYear: [{
        period: 'FY2027 H1',
        periodEnd: '2026-09-30',
        revenue: 1,
        operatingProfit: 1,
        researchAndDevelopment: null,
        employees: null,
      }],
      quarterly: [{
        period: 'FY2027 Q1',
        periodEnd: '2026-06-30',
        revenue: 1,
        operatingProfit: 1,
        researchAndDevelopment: null,
        employees: null,
      }],
    }))).toBe('2026-09-30');
  });
});

function filing(overrides: Partial<SecReviewFiling> = {}): SecReviewFiling {
  return { accessionNumber: '0000796343-26-000147', filingDate: '2026-09-10',
    reportDate: '2026-08-28', form: '10-Q', primaryDocument: 'report.htm', items: '', ...overrides };
}

describe('SEC disclosure review', () => {
  it('finds new financial periods before the conservative calendar window', () => {
    expect(secPeriodicReviewReason(company(), filing())).toBe('新报告期');
  });

  it('flags the formal filing after an earnings release for the same financial period', () => {
    const item = company({ latestReport: { period: 'FY2026 Q1', publishedAt: '2026-04-20',
      sourceUrl: 'https://example.com/q1-results', sourceLabel: 'Earnings release' } });
    expect(secPeriodicReviewReason(item, filing({ reportDate: '2026-03-31' })))
      .toBe('同期间正式报告，待复核公告数据');
  });

  it('revisits missing annual employees even when a newer quarter is already stored', () => {
    const point = company().quarterly[0];
    const item = company({ annual: [
      { ...point, period: 'FY2024', periodEnd: '2024-12-31', employees: 100 },
      { ...point, period: 'FY2025', periodEnd: '2025-12-31', employees: null },
    ] });
    expect(secPeriodicReviewReason(item, filing({ form: '10-K', reportDate: '2025-12-31' })))
      .toContain('员工人数');
  });

  it('does not flag normally undisclosed quarterly employees', () => {
    expect(secPeriodicReviewReason(company(), filing({ reportDate: '2026-03-31' }))).toBeUndefined();
  });

  it('flags amendments separately but does not requeue an explicitly reviewed accession', () => {
    const amendment = filing({ form: '10-Q/A', reportDate: '2026-03-31' });
    expect(secPeriodicReviewReason(company(), amendment)).toBe('同期间修订报告');
    const reviewed = company({ reportReferences: [{ period: 'FY2026 Q1', publishedAt: '2026-09-10',
      sourceUrl: 'https://www.sec.gov/Archives/edgar/data/796343/000079634326000147/report.htm' }] });
    expect(secPeriodicReviewReason(reviewed, amendment)).toBeUndefined();
  });

  it('ignores future filings and unsafe document paths while including foreign annual reports', () => {
    const source = {
      accessionNumber: Array(5).fill('0000796343-26-000147'),
      filingDate: ['2026-09-10', '2026-09-16', '2026-09-10', '2026-09-10', '2026-09-10'],
      reportDate: Array(5).fill('2026-03-31'),
      form: ['20-F', '10-Q', '6-K', '8-K', '4'],
      primaryDocument: ['annual.htm', 'future.htm', '../bad.htm', 'event.htm', 'director.htm'],
      items: ['', '', '', '5.02', ''],
    };
    expect(listSecReviewFilings(source, '2026-09-15').map(item => item.form)).toEqual(['20-F', '8-K']);
  });

  it('treats 8-K dates as events and bounds only earnings-related announcement candidates', () => {
    const events = [
      filing({ form: '8-K', reportDate: '2026-09-10', items: '2.02,9.01' }),
      filing({ form: '8-K', items: '5.02,9.01' }),
      filing({ form: '6-K' }),
      filing({ form: '8-K', filingDate: '2026-06-01', items: '2.02' }),
    ];
    expect(secAnnouncementCandidates(company(), events, '2026-09-15').map(item => item.form))
      .toEqual(['8-K', '6-K']);
    expect(secAnnouncementCandidates(company(), events, '2026-09-15', 1)).toHaveLength(1);
  });

  it('recognizes reviewed exhibit URLs and skips earlier already-covered announcements', () => {
    const item = company({ latestReport: { period: 'FY2026 Q3', publishedAt: '2026-09-10',
      sourceUrl: 'https://www.sec.gov/Archives/edgar/data/796343/000079634326000147/adbeex991q326.htm' } });
    expect(secAnnouncementCandidates(item, [filing({ form: '8-K' }),
      filing({ form: '8-K', filingDate: '2026-09-09' })], '2026-09-15')).toEqual([]);
  });
});
