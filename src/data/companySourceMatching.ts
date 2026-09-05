import type { CompanyFundamentals, CompanyReportReference } from '../types';
import type { SecPeriodicFiling } from './companyReportMaintenance';

export function matchCompanyReportSources(company: CompanyFundamentals, filings: SecPeriodicFiling[], cik: number): CompanyReportReference[] {
  return [...company.annual, ...company.quarterly].flatMap(point => {
    // Derived Q4/half-year values need several reports, not a guessed single filing.
    if (point.derived) return [];
    const form = /^FY\d{4}$/.test(point.period) ? '10-K' : '10-Q';
    const candidates = filings.filter(filing => filing.form === form && filing.reportDate === point.periodEnd)
      .sort((a, b) => a.filingDate.localeCompare(b.filingDate));
    const filing = candidates[0];
    if (!filing || !/^\d{10}-\d{2}-\d{6}$/.test(filing.accessionNumber) || !/^[\w.-]+\.(htm|html)$/i.test(filing.primaryDocument)) return [];
    return [{
      period: point.period,
      publishedAt: filing.filingDate,
      sourceUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${filing.accessionNumber.replace(/-/g, '')}/${filing.primaryDocument}`,
      sourceLabel: `${company.name} ${point.period} · SEC ${filing.form}`,
    }];
  });
}
