import type { CompanyReportEvent } from '../types';
import { companies } from './companies';

const confirmedScheduledReports: CompanyReportEvent[] = [
  {
    companyId: 'meituan',
    period: 'FY2026 Q2',
    publishedAt: '2026-08-28',
    status: 'scheduled',
    sourceLabel: '美团董事会会议公告',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0818/2026081800498.pdf',
  },
  {
    companyId: 'byd',
    period: 'FY2026 H1',
    publishedAt: '2026-08-28',
    status: 'scheduled',
    sourceLabel: '比亚迪董事会会议公告',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0813/2026081300621.pdf',
  },
];

export const companyReportEvents: CompanyReportEvent[] = [
  ...companies.flatMap((company) => company.latestReport ? [{
    companyId: company.id,
    ...company.latestReport,
    status: 'reported' as const,
  }] : []),
  ...confirmedScheduledReports,
].sort((left, right) => (
  left.publishedAt.localeCompare(right.publishedAt)
    || left.companyId.localeCompare(right.companyId)
));
