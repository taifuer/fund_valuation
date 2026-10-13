import data from './companyMarketCaps.json';
import type { CompanyFundamentalPoint, CompanyMarketCapObservation } from '../types';

export const companyMarketCaps = data as Readonly<Record<string, readonly CompanyMarketCapObservation[]>>;

export const marketCapUnavailable: Readonly<Record<string, string>> = {
  huawei: '未上市，不展示推测估值。',
  byd: 'A/H 股合计市值口径尚未核验。',
  smic: 'A/H 股合计市值口径尚未核验。',
  beone: '多地上市股份合计市值口径尚未核验。',
};

export const marketCapNotes: Readonly<Record<string, string>> = {
  catl: '仅收录港股上市前可核验的期末市值；2025 年 5 月起 A/H 股合计口径暂缺，不沿用 A 股价格乘总股本。',
  hengrui: '仅收录港股上市前可核验的期末市值；2025 年 5 月起 A/H 股合计口径暂缺，不沿用 A 股价格乘总股本。',
  samsung: '采用包含普通股和优先股的市值口径，不重复叠加存托凭证。',
};

export function marketCapSourceName(url: string): string {
  const host = new URL(url).hostname;
  if (host === 'companiesmarketcap.com') return 'CompaniesMarketCap';
  if (host === 'datacenter-web.eastmoney.com') return '东方财富';
  if (host === 'stockanalysis.com') return 'Stock Analysis';
  if (host === 'www.sec.gov') return 'SEC 财报';
  if (host === 'www.twse.com.tw') return '台湾证券交易所';
  return host;
}

export function withCompanyMarketCaps(
  points: readonly CompanyFundamentalPoint[],
  observations: readonly CompanyMarketCapObservation[],
): CompanyFundamentalPoint[] {
  const byDate = new Map(observations.map(point => [point.periodEnd, point]));
  return points.map(point => ({ ...point, marketCap: byDate.get(point.periodEnd) }));
}

export function companyMarketCapCurrency(companyId: string): string {
  return companyMarketCaps[companyId]?.[0]?.currency ?? 'USD';
}
