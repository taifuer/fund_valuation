import type { CompanyFundamentals } from '../../src/types';
import type { CompanyReportFreshness } from '../../src/data/companyReportMaintenance';

export type CompanyReleaseProvider =
  | '港交所'
  | '巨潮资讯'
  | '台湾公开资讯观测站'
  | '韩国 DART'
  | '上海清算所'
  | '官方投资者关系';

export interface CompanyReleaseProbe {
  company: string;
  ticker: string;
  provider: CompanyReleaseProvider;
  latest: string;
  expected: string;
  status: '来源可用' | '需要人工核查' | '命中报告候选' | '访问受限' | '来源异常';
  source: string;
  error?: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function companyReleaseProvider(url: string): CompanyReleaseProvider {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname.endsWith('hkexnews.hk')) return '港交所';
  if (hostname.endsWith('cninfo.com.cn')) return '巨潮资讯';
  if (hostname.includes('mops.twse.com.tw') || hostname.endsWith('twse.com.tw')) {
    return '台湾公开资讯观测站';
  }
  if (hostname.endsWith('dart.fss.or.kr')) return '韩国 DART';
  if (hostname.endsWith('shclearing.com.cn')) return '上海清算所';
  return '官方投资者关系';
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function expectedPeriodSearchTerms(period: string): string[] {
  const quarter = /^FY(\d{4}) Q([1-4])$/.exec(period);
  if (quarter) {
    const [, year, number] = quarter;
    const ordinal = ['first', 'second', 'third', 'fourth'][Number(number) - 1];
    const chineseOrdinal = ['一', '二', '三', '四'][Number(number) - 1];
    return [
      `fy${year} q${number}`,
      `q${number} ${year}`,
      `${year} q${number}`,
      `${number}q ${year}`,
      `${ordinal} quarter ${year}`,
      `${year} ${ordinal} quarter`,
      `${year}年第${chineseOrdinal}季度`,
      `${year}年第${chineseOrdinal}季度报告`,
      `${year} ${number}분기`,
    ];
  }

  const half = /^FY(\d{4}) H([12])$/.exec(period);
  if (half) {
    const [, year, number] = half;
    const ordinal = number === '1' ? 'first' : 'second';
    return [
      `fy${year} h${number}`,
      `h${number} ${year}`,
      `${year} h${number}`,
      `${ordinal} half ${year}`,
      `${year} ${ordinal} half`,
      `${year} half year results`,
      `${year}年半年度报告`,
      `${year}年中期业绩`,
    ];
  }

  const annual = /^FY(\d{4})$/.exec(period);
  if (annual) {
    const year = annual[1];
    return [
      `fy${year} results`,
      `${year} full year results`,
      `full year ${year} results`,
      `${year} annual results`,
      `${year} annual report`,
      `${year}年度报告`,
      `${year}年报`,
      `${year} 사업보고서`,
    ];
  }
  return [];
}

export function sourceMentionsExpectedPeriod(source: string, period?: string): boolean {
  if (!period) return false;
  const normalized = normalizeSearchText(source);
  return expectedPeriodSearchTerms(period)
    .some((term) => normalized.includes(normalizeSearchText(term)));
}

export async function probeCompanyReleaseSource(
  company: CompanyFundamentals,
  freshness: CompanyReportFreshness,
  fetchImpl: FetchLike = fetch,
): Promise<CompanyReleaseProbe> {
  const common = {
    company: company.name,
    ticker: company.ticker,
    provider: companyReleaseProvider(company.sourceUrl),
    latest: `${freshness.latestPeriod} · ${freshness.latestPeriodEnd}`,
    expected: freshness.expectedPeriod
      ? `${freshness.expectedPeriod} · ${freshness.expectedPeriodEnd}`
      : '-',
    source: company.sourceUrl,
  };

  try {
    const response = await fetchImpl(company.sourceUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5',
        'User-Agent': 'fund-valuation company-data maintenance taifu@taifua.com',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const accessRestricted = response.status === 401
        || response.status === 403
        || response.status === 429;
      return {
        ...common,
        status: accessRestricted ? '访问受限' : '来源异常',
        error: `HTTP ${response.status}`,
      };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('html') || contentType.includes('text')
      ? await response.text()
      : '';
    if (sourceMentionsExpectedPeriod(body, freshness.expectedPeriod)) {
      return { ...common, status: '命中报告候选' };
    }
    if (freshness.status === 'review') {
      return { ...common, status: '需要人工核查' };
    }
    return { ...common, status: '来源可用' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const accessRestricted = /abort|timeout/i.test(message);
    return {
      ...common,
      status: accessRestricted ? '访问受限' : '来源异常',
      error: message,
    };
  }
}
