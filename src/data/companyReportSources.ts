import type {
  CompanyFundamentalPoint,
  CompanyFundamentals,
  CompanyReportReference,
} from '../types';
import { companyReportEvents } from './companyReportCalendar';
import { secCompanyReportSources } from './companyReportSources.sec';

export interface ResolvedCompanyReportReference extends CompanyReportReference {
  exact: boolean;
}

const referenceCache = new WeakMap<CompanyFundamentals, Map<string, CompanyReportReference>>();

function referencesByPeriod(company: CompanyFundamentals): Map<string, CompanyReportReference> {
  const cached = referenceCache.get(company);
  if (cached) return cached;
  const references = new Map<string, CompanyReportReference>();
  (secCompanyReportSources[company.id] ?? []).forEach(reference => references.set(reference.period, reference));
  companyReportEvents
    .filter((event) => event.companyId === company.id && event.status === 'reported')
    .forEach((event) => references.set(event.period, event));
  company.reportReferences?.forEach((reference) => references.set(reference.period, reference));
  if (company.latestReport) references.set(company.latestReport.period, company.latestReport);
  referenceCache.set(company, references);
  return references;
}

export function resolveCompanyReportReference(
  company: CompanyFundamentals,
  point: CompanyFundamentalPoint,
): ResolvedCompanyReportReference {
  const exact = referencesByPeriod(company).get(point.period);
  if (exact) return { ...exact, exact: true };

  return {
    period: point.period,
    publishedAt: '',
    sourceUrl: company.sourceUrl,
    sourceLabel: `${company.sourceName} · 历史报告归档`,
    exact: false,
  };
}
