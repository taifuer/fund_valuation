import { describe, expect, it } from 'vitest';
import type { CompanyFundamentals } from '../types';
import {
  assessCompanyReportFreshness,
  latestCompanyPeriodEnd,
  latestSecPeriodicFiling,
  listSecPeriodicFilings,
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
