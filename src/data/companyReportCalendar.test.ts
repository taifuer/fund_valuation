import { describe, expect, it } from 'vitest';
import { companyFundamentalsDataset } from './companyFundamentals';
import { companyReportEvents } from './companyReportCalendar';

describe('company report calendar', () => {
  it('references known companies and official HTTPS sources', () => {
    const companies = new Map(companyFundamentalsDataset.companies.map((company) => [company.id, company]));

    companyReportEvents.forEach((event) => {
      expect(companies.has(event.companyId), event.companyId).toBe(true);
      expect(event.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(event.sourceUrl).toMatch(/^https:\/\//);
      expect(event.sourceLabel?.length ?? 0).toBeGreaterThan(3);
      if (event.status === 'reported') {
        const company = companies.get(event.companyId)!;
        expect(
          [...company.annual, ...company.quarterly].some((point) => point.period === event.period),
          `${event.companyId} ${event.period}`,
        ).toBe(true);
      }
    });
  });

  it('keeps future events limited to explicitly confirmed announcements', () => {
    const scheduled = companyReportEvents.filter((event) => event.status === 'scheduled');
    expect(scheduled.map((event) => event.companyId).sort()).toEqual(['byd', 'meituan']);
    expect(scheduled.every((event) => event.sourceUrl.includes('hkexnews.hk'))).toBe(true);
  });
});
