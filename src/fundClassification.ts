import type { Fund, FundStrategy } from './types';

export type FundFilter = 'all' | FundStrategy;

export const FUND_FILTERS: Array<{ key: FundFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '主动' },
  { key: 'index', label: '指数' },
];
export const FUND_FILTER_KEYS = FUND_FILTERS.map(item => item.key);

export function matchesFundFilter(fund: Pick<Fund, 'strategy'>, filter: FundFilter): boolean {
  return filter === 'all' || fund.strategy === filter;
}

export function fundStrategyLabel(fund: Pick<Fund, 'strategy'>): string {
  return fund.strategy === 'index' ? '指数基金' : fund.strategy === 'active' ? '主动基金' : '未分类基金';
}
