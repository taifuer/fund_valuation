import { describe, expect, it } from 'vitest';
import type { CompanyFundamentals } from '../types';
import type { CompanyReportFreshness } from './companyReportMaintenance';
import {
  companyReleaseProvider,
  expectedPeriodSearchTerms,
  probeCompanyReleaseSource,
  sourceMentionsExpectedPeriod,
} from '../../scripts/lib/company-releases';

const sampleCompany: CompanyFundamentals = {
  id: 'sample',
  name: '示例公司',
  nameEn: 'Sample',
  ticker: 'SAMPLE',
  region: 'europe',
  regionLabel: '欧洲',
  currency: 'EUR',
  sourceName: 'Official Results',
  sourceUrl: 'https://example.com/results',
  employeeScope: '期末员工',
  annual: [],
  halfYear: [],
  quarterly: [],
};

const freshness: CompanyReportFreshness = {
  status: 'review',
  latestPeriod: 'FY2026 Q1',
  latestPeriodEnd: '2026-03-31',
  expectedPeriod: 'FY2026 Q2',
  expectedPeriodEnd: '2026-06-30',
  reviewAfter: '2026-08-24',
};

describe('non-US company release checks', () => {
  it('classifies common official disclosure hosts', () => {
    expect(companyReleaseProvider('https://www1.hkexnews.hk/listedco/listconews/')).toBe('港交所');
    expect(companyReleaseProvider('https://www.cninfo.com.cn/new/index')).toBe('巨潮资讯');
    expect(companyReleaseProvider('https://dart.fss.or.kr/')).toBe('韩国 DART');
    expect(companyReleaseProvider('https://example.com/results')).toBe('官方投资者关系');
  });

  it('recognizes restrained quarterly, half-year and annual period phrases', () => {
    expect(expectedPeriodSearchTerms('FY2026 Q2')).toContain('second quarter 2026');
    expect(sourceMentionsExpectedPeriod('2026 Half-Year Results', 'FY2026 H1')).toBe(true);
    expect(sourceMentionsExpectedPeriod('Full Year 2026 Results', 'FY2026')).toBe(true);
    expect(sourceMentionsExpectedPeriod('2026年第二季度报告', 'FY2026 Q2')).toBe(true);
    expect(sourceMentionsExpectedPeriod('2026 2분기 실적', 'FY2026 Q2')).toBe(true);
    expect(sourceMentionsExpectedPeriod('Q1 2026 results', 'FY2026 Q2')).toBe(false);
  });

  it('marks a matching official page as a candidate for manual verification', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<h2>Second Quarter 2026 Results</h2>',
    } as unknown as Response);

    await expect(probeCompanyReleaseSource(sampleCompany, freshness, fetchImpl))
      .resolves.toMatchObject({
        status: '命中报告候选',
        provider: '官方投资者关系',
      });
  });

  it('distinguishes WAF restrictions from a broken source', async () => {
    const response = (status: number) => async () => ({
      ok: false,
      status,
      headers: { get: () => 'text/html' },
    } as unknown as Response);

    await expect(probeCompanyReleaseSource(sampleCompany, freshness, response(403)))
      .resolves.toMatchObject({ status: '访问受限', error: 'HTTP 403' });
    await expect(probeCompanyReleaseSource(sampleCompany, freshness, response(404)))
      .resolves.toMatchObject({ status: '来源异常', error: 'HTTP 404' });
  });
});
