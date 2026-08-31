import type { CompanyReportEvent } from '../types';
import { companies } from './companies';
import { secCompanyReportEvents } from './companyReportCalendar.sec';

const confirmedScheduledReports: CompanyReportEvent[] = [];

function reportKey(event: CompanyReportEvent): string {
  return `${event.companyId}:${event.period}`;
}

const reportsByKey = new Map<string, CompanyReportEvent>();
const calendarYears = new Set(
  secCompanyReportEvents.map((event) => event.publishedAt.slice(0, 4)),
);

secCompanyReportEvents.forEach((event) => reportsByKey.set(reportKey(event), event));
companies.forEach((company) => {
  company.reportReferences
    ?.filter((reference) => calendarYears.has(reference.publishedAt.slice(0, 4)))
    .forEach((reference) => {
      const event: CompanyReportEvent = {
        companyId: company.id,
        ...reference,
        status: 'reported',
      };
      reportsByKey.set(reportKey(event), event);
    });
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
