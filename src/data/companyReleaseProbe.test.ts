import { describe, expect, it } from 'vitest';
import type { CompanyFundamentals } from '../types';
import type { CompanyReportFreshness } from './companyReportMaintenance';
import {
  companyReleaseProvider,
  expectedPeriodSearchTerms,
  probeCompanyReleaseSource,
  sourceMentionsExpectedPeriod,
  extractReportCandidates,
  cninfoReportCandidates,
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
  it('extracts period-specific HTTPS report candidates without upgrading them to verified references', () => {
    const body = '<a href="/2025-q2.pdf">2025 Q2 Results</a><a href="/2026-q2.pdf"><span>2026 Q2 Results</span></a><a href="javascript:alert(1)">2026 Q2 Results</a><a href="/archive">History</a>';
    expect(extractReportCandidates(body, 'https://example.com/ir', ['FY2026 Q2'])).toEqual([
      { period: 'FY2026 Q2', title: '2026 Q2 Results', url: 'https://example.com/2026-q2.pdf' },
    ]);
  });
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
    expect(sourceMentionsExpectedPeriod('中国移动：2025年年度报告', 'FY2025')).toBe(true);
    expect(sourceMentionsExpectedPeriod('2025年年度報告', 'FY2025')).toBe(true);
    expect(sourceMentionsExpectedPeriod('2026年第二季度报告', 'FY2026 Q2')).toBe(true);
    expect(sourceMentionsExpectedPeriod('2026 2분기 실적', 'FY2026 Q2')).toBe(true);
    expect(sourceMentionsExpectedPeriod('Q1 2026 results', 'FY2026 Q2')).toBe(false);
  });

  it('marks a matching official page as a candidate for manual verification', async () => {
    const fetchImpl = async () => new Response('<a href="/2026-q2.pdf">Second Quarter 2026 Results</a>', {
      headers: { 'content-type': 'text/html' },
    });

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

  it.each([
    '<h2>Second Quarter 2026 Results</h2>',
    '<a href="/q2-2026-earnings-invitation.pdf">Q2 2026 Earnings Conference Invitation</a>',
    '<a href="/q2-2026.pdf">Announcement of Webcast Conference Call on Q2 2026 Results</a>',
    '<a href="/q2-2026.pdf">Q2 2026 Results Conference Call Access Details</a>',
    '<a href="/q2-2026-guidance">Q2 2026 Earnings Guidance</a>',
    '<a href="/q2-2026-results">Q2 2026 Preliminary Results</a>',
    '<a href="/q2-2026-results">2026年第二季度业绩预告</a>',
    '<a href="/2026-q1.pdf">2026 Q1 Results</a><h2>2026 Q2 Results</h2>',
  ])('does not infer a published report from an invitation, guidance or bare period mention', async (body) => {
    const fetchImpl = async () => new Response(body, { headers: { 'content-type': 'text/html' } });
    const result = await probeCompanyReleaseSource(sampleCompany, freshness, fetchImpl);
    expect(result.status).toBe('需要人工核查');
    expect(result.candidateLinks?.filter(link => link.period === freshness.expectedPeriod)).toEqual([]);
  });

  it('accepts a real report alongside an invitation', () => {
    expect(extractReportCandidates(
      '<a href="/2026-q2-invitation.pdf">2026 Q2 invitation</a><a href="/2026-q2.pdf">2026 Q2 Results</a>',
      sampleCompany.sourceUrl, ['FY2026 Q2'],
    )).toHaveLength(1);
  });

  it('keeps actual conference presentations', () => {
    expect(extractReportCandidates(
      '<a href="/2026_3Q_conference_eng.pdf">3Q 2026 Financial Results</a>',
      sampleCompany.sourceUrl, ['FY2026 Q3'],
    )).toHaveLength(1);
  });

  it('does not let an archive folder year override the report title year', () => {
    expect(extractReportCandidates('<a href="/2025/Q4-2024-results.pdf">Q4 2024 Results</a>',
      sampleCompany.sourceUrl, ['FY2025 Q4'])).toEqual([]);
  });

  it('validates CNINFO company, period, path and publication cutoff', () => {
    const row = { secCode: '002594', announcementTitle: '2026年三季度报告', adjunctUrl: 'finalpage/2026-10-30/1225641442.PDF' };
    expect(cninfoReportCandidates([
      row, { ...row, secCode: '600276' }, { ...row, announcementTitle: '2026年三季度报告摘要' },
      { ...row, adjunctUrl: 'https://example.com/report.pdf' },
      { ...row, adjunctUrl: 'finalpage/2026-11-06/1225641442.PDF' },
      { ...row, announcementTitle: '2025年三季度报告' },
    ], '002594', ['FY2026 Q3'], '2026-11-05')).toEqual([
      { period: 'FY2026 Q3', title: row.announcementTitle, url: `https://static.cninfo.com.cn/${row.adjunctUrl}` },
    ]);
  });

  it('finds a Q2 candidate in a Chinese half-year report', () => {
    expect(cninfoReportCandidates([
      { secCode: '002594', announcementTitle: '2026年半年度报告', adjunctUrl: 'finalpage/2026-08-29/1225531835.PDF' },
    ], '002594', ['FY2026 Q2'], '2026-11-05')).toHaveLength(1);
  });

  it('checks BYD regulatory announcements after a dynamic or inaccessible IR archive', async () => {
    for (const status of [200, 403]) {
      const requests: string[] = [];
      const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
        requests.push(String(url));
        if (requests.length === 1) return new Response('<div id="app"></div>', { status, headers: { 'content-type': 'text/html' } });
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toContain('002594%2Cgshk0001211');
        return new Response(JSON.stringify({ totalAnnouncement: 1, hasMore: false, announcements: [
          { secCode: '002594', announcementTitle: '2026年三季度报告', adjunctUrl: 'finalpage/2026-10-30/1225641442.PDF' },
        ] }));
      };
      const result = await probeCompanyReleaseSource({ ...sampleCompany, id: 'byd' },
        { ...freshness, expectedPeriod: 'FY2026 Q3' }, fetchImpl, '2026-11-05');
      expect(requests).toHaveLength(2);
      expect(result).toMatchObject({ status: '命中报告候选', provider: '巨潮资讯' });
      expect(result.candidateLinks).toHaveLength(1);
    }
  });

  it('does not report fallback errors as no new reports', async () => {
    const result = await probeCompanyReleaseSource({ ...sampleCompany, id: 'byd' }, freshness,
      async () => new Response('not JSON', { headers: { 'content-type': 'text/html' } }), '2026-11-05');
    expect(result.status).toBe('来源异常');
    expect(result.error).toContain('CNINFO');
  });

  it('checks China Mobile with its verified SSE identity and rejects other stocks and customer updates', async () => {
    let calls = 0;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      if (++calls === 1) return new Response('', { status: 403 });
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('stock')).toBe('600941,gshk0000941');
      expect(params.get('column')).toBe('sse');
      expect(params.get('seDate')).toBe('2026-01-01~2026-11-05');
      return new Response(JSON.stringify({ totalAnnouncement: 3, hasMore: false, announcements: [
        { secCode: '600941', announcementTitle: ' 中国移动：2026年第三季度报告', adjunctUrl: 'finalpage/2026-10-21/1225613028.PDF' },
        { secCode: '600941', announcementTitle: '中国移动：2026年第三季度客户数据公告', adjunctUrl: 'finalpage/2026-10-21/1225613029.PDF' },
        { secCode: '002594', announcementTitle: '2026年第三季度报告', adjunctUrl: 'finalpage/2026-10-30/1225641442.PDF' },
      ] }));
    };
    const result = await probeCompanyReleaseSource({ ...sampleCompany, id: 'chinaMobile' },
      { ...freshness, expectedPeriod: 'FY2026 Q3' }, fetchImpl, '2026-11-05');
    expect(calls).toBe(2);
    expect(result).toMatchObject({ provider: '巨潮资讯', status: '命中报告候选' });
    expect(result.candidateLinks).toEqual([
      expect.objectContaining({ period: 'FY2026 Q3', url: 'https://static.cninfo.com.cn/finalpage/2026-10-21/1225613028.PDF' }),
    ]);
  });
});
