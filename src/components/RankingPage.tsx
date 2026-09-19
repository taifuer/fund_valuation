import { useEffect, useMemo, useState } from 'react';
import { fetchMarketReturnSummaries } from '../api';
import { MARKET_ASSETS, RANKING_ETFS, RANKING_INDEX_ETFS, RANKING_INDICES, RANKING_SECTOR_ETFS } from '../constants';
import { getMarketState, marketLocalDate } from '../marketHours';
import { startAdaptivePolling } from '../polling';
import { rankingStateLabel } from '../displayStatus';
import TableSkeleton from './TableSkeleton';
import { useFundReturnData } from '../hooks/usePageData';
import { choiceFromSearch, replaceSearchParams } from '../routing';
import type { FundEstimate } from '../hooks/useQuotes';
import type { Fund, FundReturnRangeKey, IndexConfig, MarketReturnSummary, MarketStateData, QuoteData } from '../types';
import styles from './RankingPage.module.css';

type RankingRangeKey = 'today' | '1w' | '1m' | '3m' | '6m' | '1y' | '3y' | 'ytd';
type CategoryKey = 'all' | 'index' | 'asset' | 'etf' | 'fund';
type EtfFilterKey = 'all' | 'index' | 'sector';
type SortDirection = 'desc' | 'asc';
type SortKey = 'return' | 'value' | 'drawdown' | 'ratio' | 'winRate';

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
  maxDrawdownPercent: number | null;
  winRatePercent: number | null;
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

const CATEGORY_KEYS = CATEGORIES.map((item) => item.key);
const RANGE_KEYS = RANGES.map((item) => item.key);
const ETF_FILTER_KEYS = ETF_FILTERS.map((item) => item.key);
const RISK_SORT_KEYS: SortKey[] = ['drawdown', 'ratio', 'winRate'];
const SORT_KEYS: SortKey[] = ['return', 'value', ...RISK_SORT_KEYS];
const SORT_DIRECTIONS: SortDirection[] = ['desc', 'asc'];
const VALUE_COLUMNS: Array<{ key: SortKey; label: string; title?: string }> = [
  { key: 'return', label: '收益' },
  { key: 'value', label: '现值' },
  { key: 'drawdown', label: '回撤', title: '区间最大回撤，按幅度大小排序' },
  { key: 'ratio', label: '收益回撤比', title: '区间收益 / 最大回撤绝对值；回撤为零时不计算' },
  { key: 'winRate', label: '胜率', title: '区间内上涨交易日占比，平盘日计入分母' },
];

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

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

function shouldUseLatestCloseReturn(item: IndexConfig, quote: QuoteData | undefined, state: MarketStateData['state']) {
  if (!quote) return true;
  if (!item.sinaSymbol.startsWith('gb_')) return false;
  if (state === 'live') return false;
  return Math.abs(quote.changePercent) < 0.005;
}

function latestSourceLabel(state: MarketStateData['state']) {
  if (state === 'live' || state === 'break') return rankingStateLabel(state);
  return '收盘价';
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
    const quote = item.quoteMode === 'close' ? undefined : quotes.get(item.sinaSymbol);
    const state = marketStates.get(item.sinaSymbol)?.state ?? getMarketState(item.sinaSymbol);
    const summary = item.history ? marketReturns.get(marketReturnKey(item)) : undefined;
    const latestReturn = summary?.latest;
    const rangeReturn = range === 'today' ? null : summary?.ranges?.[range as FundReturnRangeKey];
    const useLatestCloseReturn = range === 'today'
      && latestReturn != null
      && shouldUseLatestCloseReturn(item, quote, state);
    const quoteDate = quote ? marketLocalDate(item.sinaSymbol, quote.regularTime ?? quote.time) ?? quote.time?.slice(0, 10) : undefined;
    return {
      id: `${category}:${item.sinaSymbol}`,
      name: item.name,
      symbol: item.symbol,
      category,
      categoryLabel,
      returnPercent: range === 'today'
        ? (useLatestCloseReturn ? latestReturn.returnPercent : quote?.changePercent ?? latestReturn?.returnPercent ?? null)
        : rangeReturn?.returnPercent ?? null,
      currentValue: range === 'today'
        ? (useLatestCloseReturn ? latestReturn.endClose : quote?.price ?? latestReturn?.endClose ?? null)
        : rangeReturn?.endClose ?? summary?.endClose ?? null,
      maxDrawdownPercent: finiteOrNull(rangeReturn?.maxDrawdownPercent),
      winRatePercent: finiteOrNull(rangeReturn?.winRatePercent),
      startDate: range === 'today'
        ? (useLatestCloseReturn ? latestReturn.startDate : quoteDate ?? latestReturn?.startDate)
        : rangeReturn?.startDate,
      endDate: range === 'today'
        ? (useLatestCloseReturn ? latestReturn.endDate : quoteDate ?? latestReturn?.endDate)
        : rangeReturn?.endDate,
      sourceLabel: range === 'today' && (useLatestCloseReturn || item.quoteMode === 'close')
        ? '最新收盘'
        : range === 'today'
          ? latestSourceLabel(state)
          : '收盘价',
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
      maxDrawdownPercent: finiteOrNull(rangeReturn?.maxDrawdownPercent),
      winRatePercent: finiteOrNull(rangeReturn?.winRatePercent),
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

function sortableValue(item: RankingItem, sortKey: SortKey) {
  if (sortKey === 'winRate') return item.winRatePercent;
  if (sortKey === 'drawdown') return item.maxDrawdownPercent == null ? null : Math.abs(item.maxDrawdownPercent);
  if (sortKey === 'ratio') {
    if (item.returnPercent == null || !item.maxDrawdownPercent) return null;
    return finiteOrNull(item.returnPercent / Math.abs(item.maxDrawdownPercent));
  }
  return finiteOrNull(sortKey === 'value' ? item.currentValue : item.returnPercent);
}

function formatRiskMetric(value: number | null, suffix = '%') {
  if (value == null || !Number.isFinite(value)) return '--';
  return `${value.toFixed(2)}${suffix}`;
}

function nextDirection(currentKey: SortKey, currentDirection: SortDirection, nextKey: SortKey): SortDirection {
  if (currentKey === nextKey) return currentDirection === 'desc' ? 'asc' : 'desc';
  return 'desc';
}

function useMarketReturnRefreshTick() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => setTick(Date.now());
    return startAdaptivePolling(refresh, () => 15 * 60 * 1000);
  }, []);

  return tick;
}

export default function RankingPage({
  quotes,
  funds,
  marketStates = new Map(),
  marketLoading,
  onStatusMessageChange,
}: Props) {
  const [range, setRange] = useState<RankingRangeKey>(() => choiceFromSearch(window.location.search, 'range', RANGE_KEYS, 'today'));
  const showRisk = range !== 'today';
  const [category, setCategory] = useState<CategoryKey>(() => choiceFromSearch(window.location.search, 'category', CATEGORY_KEYS, 'index'));
  const [etfFilter, setEtfFilter] = useState<EtfFilterKey>(() => choiceFromSearch(window.location.search, 'etf', ETF_FILTER_KEYS, 'all'));
  const [sortKey, setSortKey] = useState<SortKey>(() => choiceFromSearch(window.location.search, 'sort', showRisk ? SORT_KEYS : ['return', 'value'], 'return'));
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    const requestedSort = choiceFromSearch(window.location.search, 'sort', SORT_KEYS, 'return');
    if (!showRisk && RISK_SORT_KEYS.includes(requestedSort)) return 'desc';
    return choiceFromSearch(window.location.search, 'order', SORT_DIRECTIONS, 'desc');
  });
  const [marketReturns, setMarketReturns] = useState<Map<string, MarketReturnSummary>>(new Map());
  const [returnsLoading, setReturnsLoading] = useState(true);
  const refreshTick = useMarketReturnRefreshTick();
  const shouldLoadFunds = category === 'fund';
  const fundData = useFundReturnData(funds, shouldLoadFunds);

  useEffect(() => {
    replaceSearchParams({
      category: category === 'index' ? null : category,
      range: range === 'today' ? null : range,
      etf: category === 'etf' && etfFilter !== 'all' ? etfFilter : null,
      sort: sortKey === 'return' ? null : sortKey,
      order: sortDirection === 'desc' ? null : sortDirection,
    });
  }, [category, etfFilter, range, sortDirection, sortKey]);
  const selectedMarketConfigs = useMemo(
    () => marketConfigs(category, etfFilter),
    [category, etfFilter],
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
      const summaries = await fetchMarketReturnSummaries(selectedMarketConfigs, { force: refreshTick > 0 });
      if (!cancelled) {
        setMarketReturns((prev) => new Map([...prev, ...summaries]));
        setReturnsLoading(false);
      }
    }
    void loadReturns();
    return () => {
      cancelled = true;
    };
  }, [refreshTick, selectedMarketConfigKey, selectedMarketConfigs]);

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
    : marketLoading || (returnsLoading && marketReturns.size === 0);
  const showSkeleton = (loading || returnsLoading) && !items.some(item => item.returnPercent !== null);

  useEffect(() => {
    onStatusMessageChange?.(loading ? '收益数据加载中...' : '');
    return () => onStatusMessageChange?.('');
  }, [loading, onStatusMessageChange]);

  function updateSort(nextKey: SortKey) {
    setSortDirection((currentDirection) => nextDirection(sortKey, currentDirection, nextKey));
    setSortKey(nextKey);
  }

  function updateRange(nextRange: RankingRangeKey) {
    if (nextRange === 'today' && RISK_SORT_KEYS.includes(sortKey)) {
      setSortKey('return');
      setSortDirection('desc');
    }
    setRange(nextRange);
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
                aria-pressed={category === item.key}
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
                  aria-pressed={etfFilter === item.key}
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
                aria-pressed={range === item.key}
                className={`${styles.segmentButton} ${range === item.key ? styles.segmentButtonActive : ''}`}
                onClick={() => updateRange(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.tableWrap} aria-label="近期表现表格" tabIndex={0}>
        <table className={`${styles.table} ${showRisk ? styles.withRisk : ''}`} aria-label="近期表现">
          <colgroup>
            <col className={styles.rankCol} />
            <col className={styles.nameCol} />
            <col className={styles.returnCol} />
            <col className={styles.valueCol} />
            {showRisk && <>
              <col className={styles.riskCol} />
              <col className={styles.ratioCol} />
              <col className={styles.winRateCol} />
            </>}
            <col className={styles.statusCol} />
            <col className={styles.categoryCol} />
            <col className={styles.dateCol} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">排名</th>
              <th scope="col">名称</th>
              {VALUE_COLUMNS.filter(column => showRisk || !RISK_SORT_KEYS.includes(column.key)).map(column => (
                <th key={column.key} scope="col" className={styles.numericCell} aria-sort={sortKey === column.key ? (sortDirection === 'desc' ? 'descending' : 'ascending') : 'none'}>
                  <button
                    type="button"
                    title={column.title}
                    className={`${styles.sortHeaderButton} ${sortKey === column.key ? styles.sortHeaderButtonActive : ''}`}
                    onClick={() => updateSort(column.key)}
                  >
                    {sortLabel(column.label, column.key)}
                  </button>
                </th>
              ))}
              <th scope="col" className={styles.numericCell}>状态</th>
              <th scope="col" className={styles.categoryCell}>分类</th>
              <th scope="col" className={styles.numericCell}>截至</th>
            </tr>
          </thead>
          <tbody aria-busy={showSkeleton}>
            {showSkeleton && <TableSkeleton rows={items.length || 10} columns={showRisk ? 10 : 7} />}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={showRisk ? 10 : 7} className={styles.empty}>暂无收益数据</td>
              </tr>
            )}
            {!showSkeleton && items.map((item, index) => {
              const up = (item.returnPercent ?? 0) >= 0;
              return (
                <tr key={item.id}>
                  <td><span className={`${styles.rank} ${rankStyle(index)}`}>#{index + 1}</span></td>
                  <td className={styles.nameCell}>
                    <strong title={item.name}>{item.name}</strong>
                    <span>{item.symbol}</span>
                  </td>
                  <td className={`${styles.numericCell} ${styles.percent} ${up ? styles.up : styles.down}`}>{formatPercent(item.returnPercent)}</td>
                  <td className={`${styles.numericCell} ${styles.value}`}>{formatValue(item.currentValue)}</td>
                  {showRisk && <>
                    <td className={`${styles.numericCell} ${styles.risk}`}>{formatRiskMetric(item.maxDrawdownPercent)}</td>
                    <td className={`${styles.numericCell} ${styles.ratio}`}>{formatRiskMetric(sortableValue(item, 'ratio'), '')}</td>
                    <td className={`${styles.numericCell} ${styles.winRate}`}>{formatRiskMetric(item.winRatePercent)}</td>
                  </>}
                  <td className={`${styles.numericCell} ${styles.source}`}>{item.sourceLabel}</td>
                  <td className={styles.categoryCell}><span className={styles.category}>{item.categoryLabel}</span></td>
                  <td className={`${styles.numericCell} ${styles.dateRange}`}>{formatAsOf(item)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p className={styles.note}>
        {showRisk
          ? '* 收益与风险指标使用同区间历史收盘价或官方净值；缺失数据以 -- 显示，数据以官方披露为准。'
          : '* 最新收益可能包含盘中行情；基金收益使用已披露官方净值。数据可能存在延迟或误差，以官方披露为准。'}
      </p>
    </main>
  );
}
