import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuotes, type FundEstimate } from './hooks/useQuotes';
import { useHeaderFxRates, useOverviewData, useRankingMarketData, useSystemStatus } from './hooks/usePageData';
import { fetchApiMeta, fetchFundNavs, fetchSinaFundNavs, verifyFundManagementToken } from './api';
import {
  clearFundManagementToken,
  readFundManagementToken,
  storeFundManagementToken,
  type FundManagementMode,
} from './fundManagementAuth';
import { FUNDS } from './constants';
import {
  PAGE_PATHS,
  canonicalPathForPage,
  expandedFundCodeFromPathname,
  fundExpansionPath,
  pageFromPathname,
  type PageKey,
} from './routing';
import type { Fund, FundNavData, MarketStateData } from './types';
import Header from './components/Header';
import IndexCards from './components/IndexCards';
import FundCard from './components/FundCard';
import styles from './App.module.css';

const RankingPage = lazy(() => import('./components/RankingPage'));
const RiskPage = lazy(() => import('./components/RiskPage'));
const DiagnosticsPage = lazy(() => import('./components/DiagnosticsPage'));

type SortMode = 'estimate' | 'official';
type SortDirection = 'desc' | 'asc';

const FUND_SECTION_COLLAPSED_KEY = 'fund_valuation:collapsed_fund_section';
const FUND_SUMMARY_COLLAPSED_KEY = 'fund_valuation:collapsed_fund_summary';
const FUND_MANAGER_KEY = 'fund_valuation:managed_funds';
const MAX_CUSTOM_FUNDS = 50;
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

function readManagedFundSettings(): ManagedFundSettings {
  try {
    const raw = window.localStorage.getItem(FUND_MANAGER_KEY);
    if (!raw) return EMPTY_MANAGED_SETTINGS;
    return normalizeManagedFundSettings(JSON.parse(raw));
  } catch {
    return EMPTY_MANAGED_SETTINGS;
  }
}

function normalizeManagedFundSettings(value: unknown): ManagedFundSettings {
  const parsed = value && typeof value === 'object' ? value as Partial<ManagedFundSettings> : {};
  const defaultCodes = new Set(FUNDS.map((fund) => fund.code));
  const hiddenDefaultCodes = Array.isArray(parsed.hiddenDefaultCodes)
    ? [...new Set(parsed.hiddenDefaultCodes.map(String))]
        .filter((code) => defaultCodes.has(code))
    : [];
  const seenCustomCodes = new Set<string>();
  const customFunds = Array.isArray(parsed.customFunds)
    ? parsed.customFunds
        .map((fund) => ({ code: String(fund?.code ?? '').trim(), name: String(fund?.name ?? '').trim().slice(0, 80) }))
        .filter((fund) => {
          if (!/^\d{6}$/.test(fund.code) || !fund.name || defaultCodes.has(fund.code) || seenCustomCodes.has(fund.code)) return false;
          seenCustomCodes.add(fund.code);
          return true;
        })
        .slice(0, MAX_CUSTOM_FUNDS)
    : [];
  return {
    hiddenDefaultCodes,
    customFunds,
  };
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
            <span className={styles.count}>· {funds.length} · 最新净值 ·</span>
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
  const [fundManagementMode, setFundManagementMode] = useState<FundManagementMode>('disabled');
  const [fundManagementUnlocked, setFundManagementUnlocked] = useState(false);
  const [fundManagementToken, setFundManagementToken] = useState(readFundManagementToken);
  const [fundManagementAuthLoading, setFundManagementAuthLoading] = useState(false);
  const [fundManagementAuthError, setFundManagementAuthError] = useState('');
  const [activePage, setActivePage] = useState<PageKey>(() => pageFromPathname(window.location.pathname));
  // The URL is the single source of truth for the expanded fund card.
  const [expandedCode, setExpandedCode] = useState<string | null>(() => {
    if (pageFromPathname(window.location.pathname) !== 'funds') return null;
    return expandedFundCodeFromPathname(window.location.pathname);
  });

  const handleFundExpandedChange = useCallback((code: string, expanded: boolean) => {
    const targetPath = fundExpansionPath(code, expanded);
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
    setExpandedCode(expanded ? code : null);
  }, []);
  const fundManagementAvailable = fundManagementMode !== 'disabled';
  const fundManagementGranted = fundManagementMode === 'open' || fundManagementUnlocked;
  const funds = useMemo(() => {
    if (!fundManagementGranted) return FUNDS;
    const hidden = new Set(managedFunds.hiddenDefaultCodes);
    const defaultFunds = FUNDS.filter((fund) => !hidden.has(fund.code));
    const defaultCodes = new Set(FUNDS.map((fund) => fund.code));
    const customFunds = managedFunds.customFunds
      .filter((fund) => !defaultCodes.has(fund.code))
      .map(toCustomFund);
    return [...defaultFunds, ...customFunds];
  }, [fundManagementGranted, managedFunds]);
  const { quotes, fundEstimates, fxRates, marketStates, fundLoading, error } = useQuotes(
    funds,
    false,
    activePage === 'funds',
  );
  const overviewData = useOverviewData(funds, activePage === 'overview');
  const headerFxRates = useHeaderFxRates(activePage !== 'overview' && activePage !== 'funds');
  const marketPageData = useRankingMarketData(activePage === 'ranking');
  const systemStatus = useSystemStatus();
  const activeFxRates = activePage === 'overview'
    ? overviewData.fxRates
    : activePage === 'funds'
      ? fxRates
      : headerFxRates;
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
  const [fundManagerOpen, setFundManagerOpen] = useState(false);
  const managerTriggerRef = useRef<HTMLButtonElement>(null);
  const managerDialogRef = useRef<HTMLElement>(null);
  const [pageStatusMessage, setPageStatusMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadFundManagementMode() {
      try {
        const meta = await fetchApiMeta();
        if (cancelled) return;
        setFundManagementMode(meta.fundManagementMode);
        if (meta.fundManagementMode === 'open') {
          setFundManagementUnlocked(true);
          return;
        }
        setFundManagementUnlocked(false);
        if (meta.fundManagementMode !== 'token') return;
        const storedToken = readFundManagementToken();
        if (!storedToken) return;
        const valid = await verifyFundManagementToken(storedToken);
        if (cancelled) return;
        if (valid) {
          setFundManagementUnlocked(true);
        } else {
          clearFundManagementToken();
          setFundManagementToken('');
        }
      } catch {
        if (!cancelled) {
          setFundManagementMode('disabled');
          setFundManagementUnlocked(false);
        }
      }
    }
    void loadFundManagementMode();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!fundManagerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    managerDialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFundManagerOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !managerDialogRef.current) return;
      const focusable = [...managerDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      managerTriggerRef.current?.focus();
    };
  }, [fundManagerOpen]);

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

  const sortLabel = sortMode === 'official' ? '按最新净值涨跌排序' : '按实时估算（含汇率）涨跌排序';
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
      // Canonicalize alias URLs (/fund, /ranking) but preserve deep links
      // (/funds/:code) so browser back/forward keeps the expanded card.
      const canonical = page === 'funds' && expandedFundCodeFromPathname(window.location.pathname)
        ? window.location.pathname
        : canonicalPathForPage(page);
      if (window.location.pathname !== canonical) {
        window.history.replaceState({}, '', canonical);
      }
      setActivePage(page);
      setExpandedCode(page === 'funds' ? expandedFundCodeFromPathname(window.location.pathname) : null);
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
    setExpandedCode(null);
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

  async function unlockFundManagement() {
    const token = fundManagementToken.trim();
    if (!token) {
      setFundManagementAuthError('请输入管理令牌');
      return;
    }
    setFundManagementAuthLoading(true);
    setFundManagementAuthError('');
    try {
      const valid = await verifyFundManagementToken(token);
      if (!valid) {
        setFundManagementAuthError('管理令牌无效');
        return;
      }
      storeFundManagementToken(token);
      setFundManagementUnlocked(true);
    } catch {
      setFundManagementAuthError('管理服务暂不可用');
    } finally {
      setFundManagementAuthLoading(false);
    }
  }

  function lockFundManagement() {
    clearFundManagementToken();
    setFundManagementToken('');
    setFundManagementUnlocked(false);
    setFundManagementAuthError('');
    setFundManagerOpen(false);
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
    const navs = await fetchFundNavs([code], true);
    const navName = navs.get(code)?.name?.trim();
    if (navName) return navName;

    const sinaNavs = await fetchSinaFundNavs([code], true);
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

  return (
    <div className={styles.app}>
      <Header
        fxRates={activeFxRates}
        activePage={activePage}
        onPageChange={navigatePage}
        statusMessage={pageStatusMessage}
        systemStatus={systemStatus}
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
            <div className={`${styles.sectionHeader} ${styles.fundToolbar}`}>
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
                      aria-pressed={sortMode === 'estimate'}
                      className={`${styles.sortButton} ${sortMode === 'estimate' ? styles.sortButtonActive : ''}`}
                      onClick={() => setSortMode('estimate')}
                    >
                      实时估算
                    </button>
                    <button
                      type="button"
                      aria-pressed={sortMode === 'official'}
                      className={`${styles.sortButton} ${sortMode === 'official' ? styles.sortButtonActive : ''}`}
                      onClick={() => setSortMode('official')}
                    >
                      最新净值
                    </button>
                  </div>
                  <button
                    type="button"
                    className={styles.sortDirectionButton}
                    aria-label={sortDirection === 'desc' ? '当前高到低，点击改为低到高' : '当前低到高，点击改为高到低'}
                    title={sortDirection === 'desc' ? '高到低' : '低到高'}
                    onClick={() => setSortDirection((direction) => direction === 'desc' ? 'asc' : 'desc')}
                  >
                    {sortDirection === 'desc' ? '↓' : '↑'}
                  </button>
                  {fundManagementAvailable && (
                    <button ref={managerTriggerRef} type="button" className={styles.managerTrigger} onClick={() => setFundManagerOpen(true)}>
                      管理基金
                    </button>
                  )}
                </div>
              )}
            </div>
            {fundManagementAvailable && !fundCollapsed && fundManagerOpen && (
              <div className={styles.managerOverlay} role="presentation" onClick={() => setFundManagerOpen(false)}>
                <section ref={managerDialogRef} className={styles.fundManager} role="dialog" aria-modal="true" aria-label="管理基金" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
                  <div className={styles.managerHeader}>
                    <div>
                      <strong>管理基金</strong>
                      <span>{fundManagementGranted ? '配置仅保存在当前浏览器' : '需要管理令牌'}</span>
                    </div>
                    <div className={styles.managerHeaderActions}>
                      {fundManagementMode === 'token' && fundManagementGranted && (
                        <button type="button" className={styles.managerLock} onClick={lockFundManagement}>退出管理</button>
                      )}
                      <button type="button" className={styles.managerClose} aria-label="关闭基金管理" onClick={() => setFundManagerOpen(false)}>×</button>
                    </div>
                  </div>
                  {fundManagementGranted ? (
                    <>
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
                    </>
                  ) : (
                    <div className={styles.managerAuthForm}>
                      <input
                        className={styles.fundSearchInput}
                        type="password"
                        autoComplete="off"
                        placeholder="管理令牌"
                        aria-label="管理令牌"
                        value={fundManagementToken}
                        onChange={(event) => {
                          setFundManagementToken(event.target.value);
                          if (fundManagementAuthError) setFundManagementAuthError('');
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !fundManagementAuthLoading) {
                            void unlockFundManagement();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className={styles.managerButtonPrimary}
                        onClick={() => void unlockFundManagement()}
                        disabled={fundManagementAuthLoading}
                      >
                        {fundManagementAuthLoading ? '验证中' : '解锁'}
                      </button>
                    </div>
                  )}
                  {fundManagementAuthError && <div className={styles.managerAuthError} role="alert">{fundManagementAuthError}</div>}
                </section>
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
                  sortMode={sortMode}
                  loading={false}
                  marketStates={marketStates}
                  onRemove={fundManagementGranted ? removeFund : undefined}
                  expanded={expandedCode === fund.code}
                  onExpandedChange={handleFundExpandedChange}
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
      ) : activePage === 'risk' ? (
        <Suspense fallback={<div className={styles.pageFallback}>风险页面加载中...</div>}>
          <RiskPage
            funds={funds}
            marketStates={EMPTY_MARKET_STATES}
            marketLoading={false}
            onStatusMessageChange={setPageStatusMessage}
          />
        </Suspense>
      ) : (
        <Suspense fallback={<div className={styles.pageFallback}>诊断页面加载中...</div>}>
          <DiagnosticsPage />
        </Suspense>
      )}
      <footer className={styles.footer}>
        © <a href="https://github.com/taifuer/fund_valuation" target="_blank" rel="noreferrer">Fund Valuation</a> · 数据来源：新浪财经、天天基金、东方财富等公开接口；估算结果仅供参考，不构成投资建议，实际净值以基金公司披露为准。
      </footer>
    </div>
  );
}
