import { describe, expect, it } from 'vitest';
import { matchCompanyReportSources } from './companySourceMatching';
import { companyFundamentalsDataset } from './companyFundamentals';
import type { SecPeriodicFiling } from './companyReportMaintenance';

describe('exact company report matching', () => {
  const company = companyFundamentalsDataset.companies.find(item => item.id === 'apple')!;
  const annual = company.annual[0];
  const filing: SecPeriodicFiling = { form: '10-K', reportDate: annual.periodEnd, filingDate: '2020-11-01', accessionNumber: '0000320193-20-000001', primaryDocument: 'report.htm' };
  it('matches the actual fiscal period end, not the calendar year', () => {
    expect(matchCompanyReportSources(company, [filing], 320193)[0]?.period).toBe(annual.period);
  });
  it('does not guess an adjacent date or wrong report type', () => {
    expect(matchCompanyReportSources(company, [{ ...filing, reportDate: '1900-01-01' }], 320193)).toEqual([]);
  });
  it('rejects unsafe document paths', () => {
    expect(matchCompanyReportSources(company, [{ ...filing, primaryDocument: '../../bad.htm' }], 320193)).toEqual([]);
  });
});
