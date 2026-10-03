import { describe, expect, it } from 'vitest';
import { companyReviewMarkdown, summarizeCompanyReview, type CompanyReviewRun } from '../../scripts/lib/company-review-summary';

const base: CompanyReviewRun = { asOf: '2026-10-03', datasetUpdatedAt: '2026-10-03', offline: false, reviewOnly: true,
  sec: { completed: [{ status: '未发现更新披露' }], candidates: [], failures: [] } };

describe('company maintenance coverage', () => {
  it('reports inaccessible official sources as incomplete, even when SEC succeeds', () => {
    const report: CompanyReviewRun = { ...base, nonUs: [{ company: '华为', ticker: '-', provider: '官方投资者关系',
      source: 'https://example.com', latest: 'FY2026 H1', expected: 'FY2026', status: '访问受限', error: 'HTTP 403' }] };
    expect(summarizeCompanyReview(report)).toMatchObject({ coverage: 'partial', secChecked: 1,
      secWithoutNewDisclosure: 1, unverifiedSources: ['华为: HTTP 403'] });
    expect(companyReviewMarkdown(report)).toContain('Not verified: 华为: HTTP 403');
  });

  it('does not treat offline checks or reachable archives as verified financial figures', () => {
    expect(summarizeCompanyReview({ ...base, offline: true }).coverage).toBe('offline');
    expect(companyReviewMarkdown(base)).toContain('reachability is not verification');
  });

  it('deduplicates pending disclosures while keeping distinct amendments', () => {
    const item = { company: 'Micron', source: 'https://www.sec.gov/a', kind: '新报告期' };
    const report = { ...base, sec: { ...base.sec!, candidates: [item, item, { ...item, source: 'https://www.sec.gov/b' }] } };
    expect(summarizeCompanyReview(report).candidates).toHaveLength(2);
    expect(summarizeCompanyReview(report).pendingCompanies).toEqual(['Micron']);
  });
});
