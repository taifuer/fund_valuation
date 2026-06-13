import { useEffect, useMemo, useState } from 'react';
import { fetchMarketReturnSummaries } from '../api';
import { MARKET_ASSETS, RANKING_ETFS, RANKING_INDEX_ETFS, RANKING_INDICES, RANKING_SECTOR_ETFS } from '../constants';
import type { FundEstimate } from '../hooks/useQuotes';
import type { FundReturnRangeKey, IndexConfig, MarketReturnSummary, MarketStateData } from '../types';
import styles from './RankingPage.module.css';

type RiskRangeKey = 'ytd' | '1w' | '1m' | '3m' | '6m' | '1y' | '3y';
type CategoryKey = 'all' | 'index' | 'asset' | 'etf' | 'fund';
type EtfFilterKey = 'all' | 'index' | 'sector';
type SortKey = 'return' | 'drawdown' | 'ratio';
type SortDirection = 'desc' | 'asc';

interface Props {
  fundEstimates: FundEstimate[];
  marketStates?: Map<string, MarketStateData>;
  marketLoading: boolean;
  fundLoading?: boolean;
}

interface RiskItem {
  id: string;
  name: string;
  symbol: string;
  category: Exclude<CategoryKey, 'all'>;
  categoryLabel: string;
  returnPercent: number | null;
  maxDrawdownPercent: number | null;
  winRatePercent: number | null;
  endDate?: string;
}

const RANGES: Array<{ key: RiskRangeKey; label: string }> = [
  { key: 'ytd', label: '今年' },
  { key: '1w', label: '近1周' },
  { key: '1m', label: '近1月' },
  { key: '3m', label: '近3月' },
  { key: '6m', label: '近半年' },
  { key: '1y', label: '近1年' },
  { key: '3y', label: '近3年' },
];

const CATEGORIES: Array<{ key: CategoryKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'index', label: '指数' },
  { key: 'asset', label: '资产' },
  { key: 'etf', label: 'ETF' },
  { key: 'fund', label: '基金' },
];

const ETF_FILTERS: Array<{ key: EtfFilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'index', label: '指数ETF' },
  { key: 'sector', label: '行业ETF' },
];

function marketConfigs() {
  return [...RANKING_INDICES, ...MARKET_ASSETS, ...RANKING_ETFS]
    .map((item) => item.history)
    .filter((history): history is NonNullable<IndexConfig['history']> => history != null);
}

function marketReturnKey(item: IndexConfig) {
  return item.history ? `${item.history.source}:${item.history.symbol}` : '';
}

function makeMarketItems(
  configs: IndexConfig[],
  category: RiskItem['category'],
  categoryLabel: string,
  range: RiskRangeKey,
  marketReturns: Map<string, MarketReturnSummary>,
): RiskItem[] {
  return configs.map((item) => {
    const summary = item.history ? marketReturns.get(marketReturnKey(item)) : undefined;
    const rangeReturn = summary?.ranges?.[range as FundReturnRangeKey];
    return {
      id: `${category}:${item.sinaSymbol}`,
      name: item.name,
      symbol: item.symbol,
      category,
      categoryLabel,
      returnPercent: rangeReturn?.returnPercent ?? null,
      maxDrawdownPercent: rangeReturn?.maxDrawdownPercent ?? null,
      winRatePercent: rangeReturn?.winRatePercent ?? null,
      endDate: rangeReturn?.endDate,
    };
  });
}

function makeFundItems(funds: FundEstimate[], range: RiskRangeKey): RiskItem[] {
  return funds.map((estimate) => {
    const rangeReturn = estimate.rangeReturns?.ranges?.[range as FundReturnRangeKey];
    return {
      id: `fund:${estimate.fund.code}`,
      name: estimate.fund.name,
      symbol: estimate.fund.code,
      category: 'fund',
      categoryLabel: '基金',
      returnPercent: rangeReturn?.returnPercent ?? null,
      maxDrawdownPercent: rangeReturn?.maxDrawdownPercent ?? null,
      winRatePercent: rangeReturn?.winRatePercent ?? null,
      endDate: rangeReturn?.endDate ?? estimate.officialNAV?.navDate,
    };
  });
}

function formatPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatMetricPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--';
  return `${value.toFixed(2)}%`;
}

function riskRatio(item: RiskItem) {
  if (item.returnPercent == null || item.maxDrawdownPercent == null || item.maxDrawdownPercent === 0) return null;
  return item.returnPercent / Math.abs(item.maxDrawdownPercent);
}

function formatRatio(item: RiskItem) {
  const ratio = riskRatio(item);
  return ratio == null || !Number.isFinite(ratio) ? '--' : ratio.toFixed(2);
}

function drawdownAbs(item: RiskItem) {
  return item.maxDrawdownPercent == null ? null : Math.abs(item.maxDrawdownPercent);
}

function sortableValue(item: RiskItem, sortKey: SortKey) {
  if (sortKey === 'ratio') return riskRatio(item);
  if (sortKey === 'drawdown') return drawdownAbs(item);
  return item.returnPercent;
}

function defaultDirection(sortKey: SortKey): SortDirection {
  return sortKey === 'drawdown' ? 'asc' : 'desc';
}

function nextDirection(currentKey: SortKey, currentDirection: SortDirection, nextKey: SortKey): SortDirection {
  if (currentKey === nextKey) return currentDirection === 'desc' ? 'asc' : 'desc';
  return defaultDirection(nextKey);
}

function rankStyle(index: number) {
  if (index === 0) return styles.gold;
  if (index === 1) return styles.silver;
  if (index === 2) return styles.bronze;
  return '';
}

export default function RiskPage({
  fundEstimates,
  marketLoading,
  fundLoading = false,
}: Props) {
  const [range, setRange] = useState<RiskRangeKey>('ytd');
  const [category, setCategory] = useState<CategoryKey>('index');
  const [etfFilter, setEtfFilter] = useState<EtfFilterKey>('all');
  const [sortKey, setSortKey] = useState<SortKey>('drawdown');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [marketReturns, setMarketReturns] = useState<Map<string, MarketReturnSummary>>(new Map());
  const [returnsLoading, setReturnsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadReturns() {
      setReturnsLoading(true);
      const summaries = await fetchMarketReturnSummaries(marketConfigs());
      if (!cancelled) {
        setMarketReturns(summaries);
        setReturnsLoading(false);
      }
    }
    void loadReturns();
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo(() => {
    const allItems = [
      ...makeMarketItems(RANKING_INDICES, 'index', '指数', range, marketReturns),
      ...makeMarketItems(MARKET_ASSETS, 'asset', '资产', range, marketReturns),
      ...makeMarketItems(RANKING_INDEX_ETFS, 'etf', '指数ETF', range, marketReturns),
      ...makeMarketItems(RANKING_SECTOR_ETFS, 'etf', '行业ETF', range, marketReturns),
      ...makeFundItems(fundEstimates, range),
    ];

    return allItems
      .filter((item) => category === 'all' || item.category === category)
      .filter((item) => (
        category !== 'etf' ||
        etfFilter === 'all' ||
        (etfFilter === 'index' ? item.categoryLabel === '指数ETF' : item.categoryLabel === '行业ETF')
      ))
      .sort((a, b) => {
        const aValue = sortableValue(a, sortKey);
        const bValue = sortableValue(b, sortKey);
        if (aValue == null && bValue == null) return a.name.localeCompare(b.name);
        if (aValue == null) return 1;
        if (bValue == null) return -1;
        return sortDirection === 'desc' ? bValue - aValue : aValue - bValue;
      });
  }, [category, etfFilter, fundEstimates, marketReturns, range, sortDirection, sortKey]);

  const loading = returnsLoading || marketLoading || fundLoading;

  function updateSort(nextKey: SortKey) {
    setSortDirection((currentDirection) => nextDirection(sortKey, currentDirection, nextKey));
    setSortKey(nextKey);
  }

  function sortLabel(label: string, key: SortKey) {
    if (sortKey !== key) return label;
    const arrow = key === 'drawdown'
      ? (sortDirection === 'asc' ? '↓' : '↑')
      : (sortDirection === 'desc' ? '↓' : '↑');
    return `${label} ${arrow}`;
  }

  return (
    <main className={styles.page}>
      <section className={styles.toolbar}>
        <div className={`${styles.controlBlock} ${styles.categoryControl}`} aria-label="分类筛选">
          <div className={styles.segmented}>
            {CATEGORIES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`${styles.segmentButton} ${category === item.key ? styles.segmentButtonActive : ''}`}
                onClick={() => setCategory(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {category === 'etf' && (
          <div className={`${styles.controlBlock} ${styles.subControl}`} aria-label="ETF类型筛选">
            <div className={styles.segmented}>
              {ETF_FILTERS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`${styles.segmentButton} ${etfFilter === item.key ? styles.segmentButtonActive : ''}`}
                  onClick={() => setEtfFilter(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className={`${styles.controlBlock} ${styles.rangeControl}`} aria-label="风险区间">
          <div className={styles.segmented}>
            {RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`${styles.segmentButton} ${range === item.key ? styles.segmentButtonActive : ''}`}
                onClick={() => setRange(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.tableWrap}>
        <table className={`${styles.table} ${styles.riskTable}`}>
          <colgroup>
            <col className={styles.rankCol} />
            <col className={styles.nameCol} />
            <col className={styles.returnCol} />
            <col className={styles.riskCol} />
            <col className={styles.ratioCol} />
            <col className={styles.winRateCol} />
            <col className={styles.categoryCol} />
            <col className={styles.dateCol} />
          </colgroup>
          <thead>
            <tr>
              <th>排名</th>
              <th>名称</th>
              <th aria-sort={sortKey === 'return' ? (sortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}>
                <button
                  type="button"
                  className={`${styles.sortHeaderButton} ${sortKey === 'return' ? styles.sortHeaderButtonActive : ''}`}
                  onClick={() => updateSort('return')}
                >
                  {sortLabel('收益', 'return')}
                </button>
              </th>
              <th aria-sort={sortKey === 'drawdown' ? (sortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}>
                <button
                  type="button"
                  className={`${styles.sortHeaderButton} ${sortKey === 'drawdown' ? styles.sortHeaderButtonActive : ''}`}
                  onClick={() => updateSort('drawdown')}
                >
                  {sortLabel('回撤', 'drawdown')}
                </button>
              </th>
              <th aria-sort={sortKey === 'ratio' ? (sortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}>
                <button
                  type="button"
                  className={`${styles.sortHeaderButton} ${sortKey === 'ratio' ? styles.sortHeaderButtonActive : ''}`}
                  onClick={() => updateSort('ratio')}
                >
                  {sortLabel('收益回撤比', 'ratio')}
                </button>
              </th>
              <th>胜率</th>
              <th>分类</th>
              <th>截至</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 && (
              <tr>
                <td colSpan={8} className={styles.empty}>风险数据加载中...</td>
              </tr>
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={8} className={styles.empty}>暂无风险数据</td>
              </tr>
            )}
            {items.map((item, index) => {
              const up = (item.returnPercent ?? 0) >= 0;
              return (
                <tr key={item.id}>
                  <td><span className={`${styles.rank} ${rankStyle(index)}`}>#{index + 1}</span></td>
                  <td className={styles.nameCell}>
                    <strong>{item.name}</strong>
                    <span>{item.symbol}</span>
                  </td>
                  <td className={`${styles.riskReturn} ${up ? styles.up : styles.down}`}>{formatPercent(item.returnPercent)}</td>
                  <td className={styles.drawdown}>{formatMetricPercent(item.maxDrawdownPercent)}</td>
                  <td className={styles.ratio}>{formatRatio(item)}</td>
                  <td className={styles.winRate}>{formatMetricPercent(item.winRatePercent)}</td>
                  <td><span className={styles.category}>{item.categoryLabel}</span></td>
                  <td className={styles.dateRange}>{item.endDate ?? '--'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {loading && items.length > 0 && (
        <p className={styles.refreshing}>风险数据更新中...</p>
      )}

      <p className={styles.note}>
        * 风险页基于历史收盘价和官方净值计算最大回撤；收益回撤比为区间收益除以最大回撤绝对值，胜率为区间内上涨天数占比，仅供参考。
      </p>
    </main>
  );
}
