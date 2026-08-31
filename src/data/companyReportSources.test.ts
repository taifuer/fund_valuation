import { describe, expect, it } from 'vitest';
import { companyFundamentalsDataset } from './companyFundamentals';
import { resolveCompanyReportReference } from './companyReportSources';

describe('company report sources', () => {
  const company = (id: string) => companyFundamentalsDataset.companies
    .find((candidate) => candidate.id === id)!;

  it('resolves exact period reports before the company archive', () => {
    const netflix = company('netflix');
    const point = netflix.quarterly.find((candidate) => candidate.period === 'FY2026 Q2')!;

    expect(resolveCompanyReportReference(netflix, point)).toMatchObject({
      exact: true,
      period: 'FY2026 Q2',
      publishedAt: '2026-07-17',
      sourceLabel: 'Netflix FY2026 Q2 · SEC 10-Q',
    });
  });

  it('labels unresolved legacy periods as official archives', () => {
    const alibaba = company('alibaba');
    const point = alibaba.annual[0];
    const reference = resolveCompanyReportReference(alibaba, point);

    expect(reference).toMatchObject({
      exact: false,
      period: point.period,
      sourceUrl: alibaba.sourceUrl,
    });
    expect(reference.sourceLabel).toContain('历史报告归档');
  });

  it('gives every stored disclosure point an HTTPS source destination', () => {
    companyFundamentalsDataset.companies.forEach((item) => {
      [...item.annual, ...item.halfYear, ...item.quarterly].forEach((point) => {
        const reference = resolveCompanyReportReference(item, point);
        expect(reference.sourceUrl, `${item.id} ${point.period}`).toMatch(/^https:\/\//);
        expect(reference.sourceLabel?.length ?? 0, `${item.id} ${point.period}`).toBeGreaterThan(3);
      });
    });
  });
});
