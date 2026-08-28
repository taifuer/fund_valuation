import type { CompanyReportEvent } from '../types';
import { companies } from './companies';
import { secCompanyReportEvents } from './companyReportCalendar.sec';

const confirmedScheduledReports: CompanyReportEvent[] = [];

function reportKey(event: CompanyReportEvent): string {
  return `${event.companyId}:${event.period}`;
}

const reportsByKey = new Map<string, CompanyReportEvent>();

secCompanyReportEvents.forEach((event) => reportsByKey.set(reportKey(event), event));
companies.forEach((company) => {
  if (!company.latestReport) return;
  const event: CompanyReportEvent = {
    companyId: company.id,
    ...company.latestReport,
    status: 'reported',
  };
  reportsByKey.set(reportKey(event), event);
});
confirmedScheduledReports.forEach((event) => {
  if (!reportsByKey.has(reportKey(event))) reportsByKey.set(reportKey(event), event);
});

export const companyReportEvents: CompanyReportEvent[] = [...reportsByKey.values()].sort((left, right) => (
  left.publishedAt.localeCompare(right.publishedAt)
    || left.companyId.localeCompare(right.companyId)
));
