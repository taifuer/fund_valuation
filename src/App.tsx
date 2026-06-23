import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuotes, type FundEstimate } from './hooks/useQuotes';
import { useHeaderFxRates, useOverviewData, useRankingMarketData } from './hooks/usePageData';
import { fetchFundNavs, fetchSinaFundNavs } from './api';
import { FUNDS } from './constants';
import type { Fund, FundNavData, MarketStateData } from './types';
import Header from './components/Header';
import IndexCards from './components/IndexCards';
import FundCard from './components/FundCard';
import styles from './App.module.css';

const RankingPage = lazy(() => import('./components/RankingPage'));
const RiskPage = lazy(() => import('./components/RiskPage'));

type SortMode = 'estimate' | 'official';
type SortDirection = 'desc' | 'asc';
type FundDisplayMode = 'compact' | 'detail';
type PageKey = 'overview' | 'funds' | 'ranking' | 'risk';

const FUND_SECTION_COLLAPSED_KEY = 'fund_valuation:collapsed_fund_section';
const FUND_SUMMARY_COLLAPSED_KEY = 'fund_valuation:collapsed_fund_summary';
const FUND_MANAGER_KEY = 'fund_valuation:managed_funds';
const FUND_DISPLAY_MODE_KEY = 'fund_valuation:fund_display_mode';

const PAGE_PATHS: Record<PageKey, string> = {
  overview: '/',
  funds: '/funds',
  ranking: '/returns',
  risk: '/risk',
};

interface FundSummary {
  fund: Fund;
  nav: FundNavData | null;
}

interface ManagedFundSettings {
  hiddenDefaultCodes: string[];
  customFunds: Array<{ code: string; name: string }>;
}

// Stable empty Map for components that don't need market-state data, so we don't
// create a fresh reference on every render (which would defeat React.memo).
const EMPTY_MARKET_STATES: Map<string, MarketStateData> = new Map();

const EMPTY_MANAGED_SETTINGS: ManagedFundSettings = {
  hiddenDefaultCodes: [],
  customFunds: [],
};

function readCollapsedFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeCollapsedFlag(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch { /* skip */ }
}

function readFundDisplayMode(): FundDisplayMode {
  try {
    return window.localStorage.getItem(FUND_DISPLAY_MODE_KEY) === 'detail' ? 'detail' : 'compact';
  } catch {
    return 'compact';
  }
}

function writeFundDisplayMode(value: FundDisplayMode) {
  try {
    window.localStorage.setItem(FUND_DISPLAY_MODE_KEY, value);
  } catch { /* skip */ }
}

function pageFromPathname(pathname: string): PageKey {
  if (pathname === '/funds' || pathname === '/fund') return 'funds';
  if (pathname === '/returns' || pathname === '/ranking') return 'ranking';
  if (pathname === '/risk') return 'risk';
  return 'overview';
}

// Canonical path for a page; used to normalize alias URLs (/fund, /ranking).
function canonicalPathForPage(page: PageKey): string {
  return PAGE_PATHS[page];
}

function readManagedFundSettings(): ManagedFundSettings {
  try {
    const raw = window.localStorage.getItem(FUND_MANAGER_KEY);
    if (!raw) return EMPTY_MANAGED_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ManagedFundSettings>;
    return {
      hiddenDefaultCodes: Array.isArray(parsed.hiddenDefaultCodes)
        ? parsed.hiddenDefaultCodes.filter((code) => /^\d{6}$/.test(code))
        : [],
      customFunds: Array.isArray(parsed.customFunds)
        ? parsed.customFunds
            .map((fund) => ({
              code: String(fund.code ?? '').trim(),
              name: String(fund.name ?? '').trim(),
            }))
            .filter((fund) => /^\d{6}$/.test(fund.code) && fund.name)
        : [],
    };
  } catch {
    return EMPTY_MANAGED_SETTINGS;
  }
}

function writeManagedFundSettings(settings: ManagedFundSettings) {
  try {
    window.localStorage.setItem(FUND_MANAGER_KEY, JSON.stringify(settings));
  } catch { /* skip */ }
}

function toCustomFund(fund: { code: string; name: string }): Fund {
  return {
    symbol: fund.code,
    code: fund.code,
    name: fund.name,
    holdings: [],
  };
}

function sortValue(estimate: FundEstimate, mode: SortMode): number | null {
  if (mode === 'official') {
    return estimate.officialNAV?.officialChange ?? null;
  }
  // Sort by the coverage-normalized change so fund ordering matches the
  // headline number shown on each card (not the under-stated raw value).
  if (estimate.normalizedNAVLocal === null) return null;
  return estimate.normalizedChange;
}

function formatDate(yyyymmdd: string): string {
  if (!yyyymmdd) return '--';
  const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  return yyyymmdd;
}

function fundSummarySortValue(summary: FundSummary): number | null {
  return summary.nav?.officialChange ?? null;
}

function summaryRankClass(index: number): string {
  if (index === 0) return styles.summaryRankGold;
  if (index === 1) return styles.summaryRankSilver;
  if (index === 2) return styles.summaryRankBronze;
  return '';
}

function FundSummaryCards({
  funds,
  summaries,
  loading,
  collapsed,
  onToggle,
  onOpenFunds,
}: {
  funds: Fund[];
  summaries: FundSummary[];
  loading: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onOpenFunds: () => void;
}) {
  return (
    <section className={styles.summarySection}>
      <div className={styles.summaryHeader}>
        <div className={styles.summaryHeaderLeft}>
          <button
            type="button"
            className={styles.sectionTitleButton}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <span className={styles.toggleIcon}>{collapsed ? '+' : '-'}</span>
            <span>基金</span>
            <span className={styles.count}>· {funds.length} · T-1 净值 ·</span>
          </button>
          <div className={styles.summaryTitle}>
            <button type="button" className={styles.summaryAction} onClick={onOpenFunds}>
              查看估值
            </button>
          </div>
        </div>
      </div>
      {collapsed ? null : loading && summaries.length === 0 ? (
        <div className={styles.fundLoading}>基金净值加载中...</div>
      ) : (
        <div className={styles.summaryGrid}>
          {summaries.map((summary, index) => {
            const change = summary.nav?.officialChange ?? null;
            const up = (change ?? 0) >= 0;
            return (
              <button
                type="button"
                key={summary.fund.code}
                className={styles.summaryCard}
                onClick={onOpenFunds}
              >
                <div className={`${styles.summaryRank} ${summaryRankClass(index)}`}>#{index + 1}</div>
                <div className={styles.summaryName}>{summary.fund.name}</div>
                <div className={styles.summaryValue}>
                  {summary.nav ? summary.nav.nav.toFixed(4) : '--'}
                </div>
                <div className={up ? styles.summaryChangeUp : styles.summaryChangeDown}>
                  {change == null ? '--' : `${up ? '+' : ''}${change.toFixed(2)}%`}
                </div>
                <span className={styles.summaryCode}>{summary.fund.code}</span>
                <div className={styles.summaryMeta}>
                  <span>{formatDate(summary.nav?.navDate ?? '')}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [managedFunds, setManagedFunds] = useState<ManagedFundSettings>(() => readManagedFundSettings());
  const [fundDisplayMode, setFundDisplayMode] = useState<FundDisplayMode>(() => readFundDisplayMode());
  const [activePage, setActivePage] = useState<PageKey>(() => pageFromPathname(window.location.pathname));
  const funds = useMemo(() => {
    const hidden = new Set(managedFunds.hiddenDefaultCodes);
    const defaultFunds = FUNDS.filter((fund) => !hidden.has(fund.code));
    const defaultCodes = new Set(FUNDS.map((fund) => fund.code));
    const customFunds = managedFunds.customFunds
      .filter((fund) => !defaultCodes.has(fund.code))
      .map(toCustomFund);
    return [...defaultFunds, ...customFunds];
  }, [managedFunds]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const { quotes, fundEstimates, fxRates, marketStates, marketLoading, fundLoading, error } = useQuotes(
    funds,
    fundDisplayMode === 'detail',
    false,
    activePage === 'funds',
    refreshNonce,
  );
  const lastUpdated = useMemo(() => {
    let latest = 0;
    for (const q of quotes.values()) {
      if (q.fetchedAt > latest) latest = q.fetchedAt;
    }
    return latest || null;
  }, [quotes]);
  const triggerRefresh = useCallback(() => setRefreshNonce((n) => n + 1), []);
  const overviewData = useOverviewData(funds, activePage === 'overview');
  const headerFxRates = useHeaderFxRates(activePage !== 'overview');
  const marketPageData = useRankingMarketData(activePage === 'ranking');
  const activeFxRates = activePage === 'overview' && overviewData.fxRates.size > 0
    ? overviewData.fxRates
    : headerFxRates.size > 0 ? headerFxRates : fxRates;
  const activeError = activePage === 'overview'
    ? overviewData.error
    : activePage === 'funds'
      ? error
    : activePage === 'ranking'
      ? marketPageData.error
      : null;
  const [sortMode, setSortMode] = useState<SortMode>('estimate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [fundCollapsed, setFundCollapsed] = useState(() => readCollapsedFlag(FUND_SECTION_COLLAPSED_KEY));
  const [fundSummaryCollapsed, setFundSummaryCollapsed] = useState(() => readCollapsedFlag(FUND_SUMMARY_COLLAPSED_KEY));
  const [fundSearchQuery, setFundSearchQuery] = useState('');
  const [addingFund, setAddingFund] = useState(false);
  const [fundManageMessage, setFundManageMessage] = useState('');
  const [pageStatusMessage, setPageStatusMessage] = useState('');

  const sortedEstimates = useMemo(() => {
    const sorted = [...fundEstimates].sort((a, b) => {
      const aValue = sortValue(a, sortMode);
      const bValue = sortValue(b, sortMode);
      if (aValue === null && bValue === null) return 0;
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return sortDirection === 'desc' ? bValue - aValue : aValue - bValue;
    });
    // Keep the original estimate object reference intact (do not spread) so that
    // memoized FundCard children skip re-rendering when only sort order changed.
    return sorted.map((estimate, i) => ({ estimate, rank: i + 1 }));
  }, [fundEstimates, sortMode, sortDirection]);

  const sortLabel = sortMode === 'official' ? '按 T-1 已出净值排序' : '按实时估算涨跌排序';
  const overviewFundSummaries = useMemo(() => {
    const items = funds.map((fund) => ({ fund, nav: overviewData.fundSummaries.get(fund.code) ?? null }));
    return items.sort((a, b) => {
      const aValue = fundSummarySortValue(a);
      const bValue = fundSummarySortValue(b);
      if (aValue === null && bValue === null) return a.fund.name.localeCompare(b.fund.name);
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return bValue - aValue;
    });
  }, [overviewData.fundSummaries, funds]);

  useEffect(() => {
    function handlePopState() {
      const page = pageFromPathname(window.location.pathname);
      const canonical = canonicalPathForPage(page);
      // Replace alias URLs (/fund, /ranking) with the canonical path so the
      // address bar reflects a single canonical URL per page.
      if (window.location.pathname !== canonical) {
        window.history.replaceState({}, '', canonical);
      }
      setActivePage(page);
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    setPageStatusMessage('');
  }, [activePage]);

  useEffect(() => {
    if (activePage === 'funds' && fundCollapsed) {
      setFundCollapsed(false);
      writeCollapsedFlag(FUND_SECTION_COLLAPSED_KEY, false);
    }
  }, [activePage, fundCollapsed]);

  function navigatePage(page: PageKey) {
    const path = PAGE_PATHS[page];
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
    setActivePage(page);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function updateManagedFunds(next: ManagedFundSettings) {
    const normalized = {
      hiddenDefaultCodes: [...new Set(next.hiddenDefaultCodes)],
      customFunds: [...new Map(next.customFunds.map((fund) => [fund.code, fund])).values()],
    };
    setManagedFunds(normalized);
    writeManagedFundSettings(normalized);
  }

  function restoreDefaultFund(defaultFund: Fund) {
    if (!managedFunds.hiddenDefaultCodes.includes(defaultFund.code)) {
      setFundManageMessage(`${defaultFund.name} 已在列表中`);
      return;
    }
    updateManagedFunds({
      ...managedFunds,
      hiddenDefaultCodes: managedFunds.hiddenDefaultCodes.filter((item) => item !== defaultFund.code),
    });
    setFundSearchQuery('');
    setFundManageMessage(`已恢复 ${defaultFund.name}`);
  }

  async function lookupFundName(code: string): Promise<string | null> {
    const navs = await fetchFundNavs([code]);
    const navName = navs.get(code)?.name?.trim();
    if (navName) return navName;

    const sinaNavs = await fetchSinaFundNavs([code]);
    return sinaNavs.get(code)?.name?.trim() || null;
  }

  async function addFund() {
    const query = fundSearchQuery.trim();
    if (!query) {
      setFundManageMessage('请输入基金代码或基金名称');
      return;
    }

    const defaultMatches = FUNDS.filter((fund) => (
      fund.code === query ||
      fund.name === query ||
      fund.name.toLowerCase().includes(query.toLowerCase())
    ));
    const exactDefaultFund = defaultMatches.find((fund) => fund.code === query || fund.name === query);
    if (!/^\d{6}$/.test(query) && defaultMatches.length > 1 && !exactDefaultFund) {
      setFundManageMessage('匹配到多个默认基金，请输入更完整名称或 6 位代码');
      return;
    }

    const defaultFund = exactDefaultFund ?? defaultMatches[0];
    if (defaultFund) {
      restoreDefaultFund(defaultFund);
      return;
    }

    const existingCustomFund = managedFunds.customFunds.find((fund) => (
      fund.code === query ||
      fund.name === query ||
      fund.name.toLowerCase() === query.toLowerCase()
    ));
    if (existingCustomFund) {
      setFundManageMessage('该基金已在自定义列表中');
      return;
    }

    if (!/^\d{6}$/.test(query)) {
      setFundManageMessage('新增基金请先输入 6 位基金代码；名称仅用于匹配默认基金');
      return;
    }

    setAddingFund(true);
    setFundManageMessage('正在校验基金代码...');
    try {
      const displayName = await lookupFundName(query);
      if (!displayName) {
        setFundManageMessage('未找到该基金，请确认 6 位基金代码');
        return;
      }
      updateManagedFunds({
        ...managedFunds,
        customFunds: [...managedFunds.customFunds, { code: query, name: displayName }],
      });
      setFundSearchQuery('');
      setFundManageMessage(`已添加 ${displayName}`);
    } catch {
      setFundManageMessage('基金代码校验失败，请稍后重试');
    } finally {
      setAddingFund(false);
    }
  }

  const removeFund = useCallback((fund: Fund) => {
    const isDefaultFund = FUNDS.some((item) => item.code === fund.code);
    if (isDefaultFund) {
      updateManagedFunds({
        ...managedFunds,
        hiddenDefaultCodes: [...managedFunds.hiddenDefaultCodes, fund.code],
      });
    } else {
      updateManagedFunds({
        ...managedFunds,
        customFunds: managedFunds.customFunds.filter((item) => item.code !== fund.code),
      });
    }
    setFundManageMessage(`已删除 ${fund.name}`);
  }, [managedFunds]);

  function restoreDefaultFunds() {
    updateManagedFunds(EMPTY_MANAGED_SETTINGS);
    setFundSearchQuery('');
    setFundManageMessage(`已恢复默认 ${FUNDS.length} 只基金`);
  }

  function toggleFundSection() {
    setFundCollapsed((prev) => {
      const next = !prev;
      writeCollapsedFlag(FUND_SECTION_COLLAPSED_KEY, next);
      return next;
    });
  }

  function toggleFundSummary() {
    setFundSummaryCollapsed((prev) => {
      const next = !prev;
      writeCollapsedFlag(FUND_SUMMARY_COLLAPSED_KEY, next);
      return next;
    });
  }

  function updateFundDisplayMode(value: FundDisplayMode) {
    setFundDisplayMode(value);
    writeFundDisplayMode(value);
  }

  return (
    <div className={styles.app}>
      <Header
        fxRates={activeFxRates}
        activePage={activePage}
        onPageChange={navigatePage}
        statusMessage={pageStatusMessage}
        lastUpdated={lastUpdated}
        onRefresh={triggerRefresh}
        refreshing={marketLoading || fundLoading}
      />
      {activeError && <div className={styles.error}>{activeError}</div>}
      {activePage === 'overview' ? (
        <>
          <IndexCards quotes={overviewData.quotes} marketStates={overviewData.marketStates} loading={overviewData.loading} />
          <FundSummaryCards
            funds={funds}
            summaries={overviewFundSummaries}
            loading={overviewData.fundLoading}
            collapsed={fundSummaryCollapsed}
            onToggle={toggleFundSummary}
            onOpenFunds={() => navigatePage('funds')}
          />
        </>
      ) : activePage === 'funds' ? (
        <>
          <div className={styles.fundSection}>
            <div className={styles.sectionHeader}>
              <button
                type="button"
                className={styles.sectionTitleButton}
                aria-expanded={!fundCollapsed}
                onClick={toggleFundSection}
              >
                <span className={styles.toggleIcon}>{fundCollapsed ? '+' : '-'}</span>
                <span>QDII 主动基金</span>
                <span className={styles.count}> · {funds.length}只{fundCollapsed ? '' : ` · ${sortLabel}`}</span>
              </button>
              {!fundCollapsed && (
                <div className={styles.sortControls}>
                  <div className={styles.sortToggle} aria-label="基金排序方式">
                    <button
                      type="button"
                      className={`${styles.sortButton} ${sortMode === 'estimate' ? styles.sortButtonActive : ''}`}
                      onClick={() => setSortMode('estimate')}
                    >
                      实时估算
                    </button>
                    <button
                      type="button"
                      className={`${styles.sortButton} ${sortMode === 'official' ? styles.sortButtonActive : ''}`}
                      onClick={() => setSortMode('official')}
                    >
                      T-1 净值
                    </button>
                  </div>
                  <div className={styles.sortToggle} aria-label="基金排序方向">
                    <button
                      type="button"
                      className={`${styles.sortButton} ${sortDirection === 'desc' ? styles.sortButtonActive : ''}`}
                      onClick={() => setSortDirection('desc')}
                    >
                      高到低
                    </button>
                    <button
                      type="button"
                      className={`${styles.sortButton} ${sortDirection === 'asc' ? styles.sortButtonActive : ''}`}
                      onClick={() => setSortDirection('asc')}
                    >
                      低到高
                    </button>
                  </div>
                  <div className={styles.sortToggle} aria-label="基金显示模式">
                    <button
                      type="button"
                      className={`${styles.sortButton} ${fundDisplayMode === 'compact' ? styles.sortButtonActive : ''}`}
                      onClick={() => updateFundDisplayMode('compact')}
                    >
                      简洁
                    </button>
                    <button
                      type="button"
                      className={`${styles.sortButton} ${fundDisplayMode === 'detail' ? styles.sortButtonActive : ''}`}
                      onClick={() => updateFundDisplayMode('detail')}
                    >
                      详细
                    </button>
                  </div>
                </div>
              )}
            </div>
            {!fundCollapsed && (
              <div className={styles.fundManager}>
                <div className={styles.addFundForm}>
                  <input
                    className={styles.fundSearchInput}
                    placeholder="基金代码或基金名称"
                    value={fundSearchQuery}
                    onChange={(event) => {
                      setFundSearchQuery(event.target.value);
                      if (fundManageMessage) setFundManageMessage('');
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !addingFund) {
                        addFund();
                      }
                    }}
                  />
                  <button type="button" className={styles.managerButtonPrimary} onClick={addFund} disabled={addingFund}>
                    {addingFund ? '校验中' : '添加'}
                  </button>
                  <button type="button" className={styles.managerButton} onClick={restoreDefaultFunds} disabled={addingFund}>
                    恢复默认
                  </button>
                </div>
                {fundManageMessage && <div className={styles.managerMessage}>{fundManageMessage}</div>}
              </div>
            )}
            {!fundCollapsed && fundLoading && sortedEstimates.length === 0 && (
              <div className={styles.fundLoading}>基金数据加载中...</div>
            )}
            {!fundCollapsed && sortedEstimates.map((est) => {
              const fund = est.estimate.fund;
              return (
                <FundCard
                  key={fund.code}
                  fund={fund}
                  estimate={est.estimate}
                  rank={est.rank}
                  loading={false}
                  marketStates={marketStates}
                  showDetails={fundDisplayMode === 'detail'}
                  onRemove={removeFund}
                />
              );
            })}
          </div>
        </>
      ) : activePage === 'ranking' ? (
        <Suspense fallback={<div className={styles.pageFallback}>收益页面加载中...</div>}>
          <RankingPage
            quotes={marketPageData.quotes}
            funds={funds}
            marketStates={marketPageData.marketStates}
            marketLoading={marketPageData.loading}
            onStatusMessageChange={setPageStatusMessage}
          />
        </Suspense>
      ) : (
        <Suspense fallback={<div className={styles.pageFallback}>风险页面加载中...</div>}>
          <RiskPage
            funds={funds}
            marketStates={EMPTY_MARKET_STATES}
            marketLoading={false}
            onStatusMessageChange={setPageStatusMessage}
          />
        </Suspense>
      )}
      <footer className={styles.footer}>
        © <a href="https://github.com/taifuer/fund_valuation" target="_blank" rel="noreferrer">Fund Valuation</a> · 数据来源：新浪财经、天天基金、东方财富等公开接口；估算结果仅供参考，不构成投资建议，实际净值以基金公司披露为准。
      </footer>
    </div>
  );
}
