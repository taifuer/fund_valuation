import { useEffect, useMemo, useState } from 'react';
import { fetchMarketReturnSummaries } from '../api';
import { MARKET_ASSETS, RANKING_ETFS, RANKING_INDEX_ETFS, RANKING_INDICES, RANKING_SECTOR_ETFS } from '../constants';
import { getMarketState } from '../marketHours';
import { useFundReturnData } from '../hooks/usePageData';
import type { FundEstimate } from '../hooks/useQuotes';
import type { Fund, FundReturnRangeKey, IndexConfig, MarketReturnSummary, MarketStateData, QuoteData } from '../types';
import styles from './RankingPage.module.css';

type RankingRangeKey = 'today' | '1w' | '1m' | '3m' | '6m' | '1y' | '3y' | 'ytd';
type CategoryKey = 'all' | 'index' | 'asset' | 'etf' | 'fund';
type EtfFilterKey = 'all' | 'index' | 'sector';
type SortDirection = 'desc' | 'asc';
type SortKey = 'return' | 'value';

interface Props {
  quotes: Map<string, QuoteData>;
  funds: Fund[];
  marketStates?: Map<string, MarketStateData>;
  marketLoading: boolean;
  onStatusMessageChange?: (message: string) => void;
}

interface RankingItem {
  id: string;
  name: string;
  symbol: string;
  category: Exclude<CategoryKey, 'all'>;
  categoryLabel: string;
  returnPercent: number | null;
  currentValue: number | null;
  startDate?: string;
  endDate?: string;
  sourceLabel: string;
}

const RANGES: Array<{ key: RankingRangeKey; label: string }> = [
  { key: 'today', label: '最新' },
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

function historyConfigs(configs: IndexConfig[]) {
  return configs
    .map((item) => item.history)
    .filter((history): history is NonNullable<IndexConfig['history']> => history != null);
}

function marketConfigs(category: CategoryKey, etfFilter: EtfFilterKey) {
  if (category === 'fund') return [];
  if (category === 'index') return historyConfigs(RANKING_INDICES);
  if (category === 'asset') return historyConfigs(MARKET_ASSETS);
  if (category === 'etf') {
    if (etfFilter === 'index') return historyConfigs(RANKING_INDEX_ETFS);
    if (etfFilter === 'sector') return historyConfigs(RANKING_SECTOR_ETFS);
    return historyConfigs(RANKING_ETFS);
  }
  return historyConfigs([...RANKING_INDICES, ...MARKET_ASSETS, ...RANKING_ETFS]);
}

function marketReturnKey(item: IndexConfig) {
  return item.history ? `${item.history.source}:${item.history.symbol}` : '';
}

function makeMarketItems(
  configs: IndexConfig[],
  category: RankingItem['category'],
  categoryLabel: string,
  range: RankingRangeKey,
  quotes: Map<string, QuoteData>,
  marketReturns: Map<string, MarketReturnSummary>,
  marketStates: Map<string, MarketStateData>,
): RankingItem[] {
  return configs.map((item) => {
    const quote = quotes.get(item.sinaSymbol);
    const summary = item.history ? marketReturns.get(marketReturnKey(item)) : undefined;
    const rangeReturn = range === 'today' ? null : summary?.ranges?.[range as FundReturnRangeKey];
    const state = marketStates.get(item.sinaSymbol)?.state ?? getMarketState(item.sinaSymbol);
    return {
      id: `${category}:${item.sinaSymbol}`,
      name: item.name,
      symbol: item.symbol,
      category,
      categoryLabel,
      returnPercent: range === 'today' ? quote?.changePercent ?? null : rangeReturn?.returnPercent ?? null,
      currentValue: range === 'today' ? quote?.price ?? null : rangeReturn?.endClose ?? summary?.endClose ?? null,
      startDate: range === 'today' ? quote?.time?.slice(0, 10) : rangeReturn?.startDate,
      endDate: range === 'today' ? quote?.time?.slice(0, 10) : rangeReturn?.endDate,
      sourceLabel: range === 'today' ? marketStateLabel(state) : '收盘价',
    };
  });
}

function makeFundItems(
  funds: FundEstimate[],
  range: RankingRangeKey,
): RankingItem[] {
  return funds.map((estimate) => {
    const officialNAV = estimate.officialNAV;
    const rangeReturn = range === 'today' ? null : estimate.rangeReturns?.ranges?.[range as FundReturnRangeKey];
    return {
      id: `fund:${estimate.fund.code}`,
      name: estimate.fund.name,
      symbol: estimate.fund.code,
      category: 'fund',
      categoryLabel: '基金',
      returnPercent: range === 'today' ? officialNAV?.officialChange ?? null : rangeReturn?.returnPercent ?? null,
      currentValue: range === 'today' ? officialNAV?.nav ?? null : rangeReturn?.endNav ?? officialNAV?.nav ?? null,
      startDate: range === 'today' ? officialNAV?.navDate : rangeReturn?.startDate,
      endDate: range === 'today' ? officialNAV?.navDate : rangeReturn?.endDate,
      sourceLabel: '确认净值',
    };
  });
}

function formatPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatValue(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '--';
  if (Math.abs(value) >= 1000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(4);
}

function formatAsOf(item: RankingItem) {
  return item.endDate || item.startDate || '--';
}

function rankStyle(index: number) {
  if (index === 0) return styles.gold;
  if (index === 1) return styles.silver;
  if (index === 2) return styles.bronze;
  return '';
}

function marketStateLabel(state: MarketStateData['state']) {
  if (state === 'live') return '开盘中';
  if (state === 'break') return '午间休市';
  if (state === 'holiday') return '假期休市';
  if (state === 'weekend') return '周末休市';
  return '已收盘';
}

function sortableValue(item: RankingItem, sortKey: SortKey) {
  return sortKey === 'value' ? item.currentValue : item.returnPercent;
}

function nextDirection(currentKey: SortKey, currentDirection: SortDirection, nextKey: SortKey): SortDirection {
  if (currentKey === nextKey) return currentDirection === 'desc' ? 'asc' : 'desc';
  return 'desc';
}

export default function RankingPage({
  quotes,
  funds,
  marketStates = new Map(),
  marketLoading,
  onStatusMessageChange,
}: Props) {
  const [range, setRange] = useState<RankingRangeKey>('today');
  const [category, setCategory] = useState<CategoryKey>('index');
  const [etfFilter, setEtfFilter] = useState<EtfFilterKey>('all');
  const [sortKey, setSortKey] = useState<SortKey>('return');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [marketReturns, setMarketReturns] = useState<Map<string, MarketReturnSummary>>(new Map());
  const [returnsLoading, setReturnsLoading] = useState(false);
  const shouldLoadFunds = category === 'fund';
  const fundData = useFundReturnData(funds, shouldLoadFunds);
  const selectedMarketConfigs = useMemo(
    () => (range === 'today' ? [] : marketConfigs(category, etfFilter)),
    [category, etfFilter, range],
  );
  const selectedMarketConfigKey = useMemo(
    () => selectedMarketConfigs.map((config) => `${config.source}:${config.symbol}`).join('|'),
    [selectedMarketConfigs],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadReturns() {
      if (selectedMarketConfigs.length === 0) {
        setReturnsLoading(false);
        return;
      }
      setReturnsLoading(true);
      const summaries = await fetchMarketReturnSummaries(selectedMarketConfigs);
      if (!cancelled) {
        setMarketReturns((prev) => new Map([...prev, ...summaries]));
        setReturnsLoading(false);
      }
    }
    void loadReturns();
    return () => {
      cancelled = true;
    };
  }, [selectedMarketConfigKey, selectedMarketConfigs]);

  const items = useMemo(() => {
    const allItems = [
      ...makeMarketItems(RANKING_INDICES, 'index', '指数', range, quotes, marketReturns, marketStates),
      ...makeMarketItems(MARKET_ASSETS, 'asset', '资产', range, quotes, marketReturns, marketStates),
      ...makeMarketItems(RANKING_INDEX_ETFS, 'etf', '指数ETF', range, quotes, marketReturns, marketStates),
      ...makeMarketItems(RANKING_SECTOR_ETFS, 'etf', '行业ETF', range, quotes, marketReturns, marketStates),
      ...makeFundItems(fundData.fundEstimates, range),
    ];
    return allItems
      .filter((item) => (category === 'all' ? item.category !== 'fund' : item.category === category))
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
  }, [category, etfFilter, fundData.fundEstimates, marketReturns, marketStates, quotes, range, sortDirection, sortKey]);

  const loading = category === 'fund'
    ? fundData.loading
    : marketLoading || (range !== 'today' && returnsLoading);

  useEffect(() => {
    onStatusMessageChange?.(loading ? '收益数据加载中...' : '');
    return () => onStatusMessageChange?.('');
  }, [loading, onStatusMessageChange]);

  function updateSort(nextKey: SortKey) {
    setSortDirection((currentDirection) => nextDirection(sortKey, currentDirection, nextKey));
    setSortKey(nextKey);
  }

  function sortLabel(label: string, key: SortKey) {
    if (sortKey !== key) return label;
    return `${label} ${sortDirection === 'desc' ? '↓' : '↑'}`;
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
        <div className={`${styles.controlBlock} ${styles.rangeControl}`} aria-label="收益区间">
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
        <table className={`${styles.table} ${styles.rankingTable}`}>
          <colgroup>
            <col className={styles.rankCol} />
            <col className={styles.nameCol} />
            <col className={styles.returnCol} />
            <col className={styles.valueCol} />
            <col className={styles.statusCol} />
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
              <th aria-sort={sortKey === 'value' ? (sortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}>
                <button
                  type="button"
                  className={`${styles.sortHeaderButton} ${sortKey === 'value' ? styles.sortHeaderButtonActive : ''}`}
                  onClick={() => updateSort('value')}
                >
                  {sortLabel('现值', 'value')}
                </button>
              </th>
              <th>状态</th>
              <th>分类</th>
              <th>截至</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.empty}>收益数据加载中...</td>
              </tr>
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.empty}>暂无收益数据</td>
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
                  <td className={`${styles.percent} ${up ? styles.up : styles.down}`}>{formatPercent(item.returnPercent)}</td>
                  <td className={styles.value}>{formatValue(item.currentValue)}</td>
                  <td className={styles.source}>{item.sourceLabel}</td>
                  <td><span className={styles.category}>{item.categoryLabel}</span></td>
                  <td className={styles.dateRange}>{formatAsOf(item)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p className={styles.note}>
        * 最新收益可能包含盘中行情；基金收益使用已披露官方净值。数据可能存在延迟或误差，以官方披露为准。
      </p>
    </main>
  );
}
