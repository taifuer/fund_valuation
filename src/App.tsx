import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuotes } from './hooks/useQuotes';
import { useHeaderFxRates, useOverviewData, useRankingMarketData, useSystemStatus } from './hooks/usePageData';
import { fetchApiMeta, fetchFundNavs, fetchSinaFundNavs, verifyFundManagementToken } from './api';
import {
  clearFundManagementToken,
  readFundManagementToken,
  storeFundManagementToken,
  type FundManagementMode,
} from './fundManagementAuth';
import { FUNDS } from './constants';
import { FUND_FILTERS, matchesFundFilter, type FundFilter } from './fundClassification';
import { readFundPageFilter, storeFundPageFilter } from './fundPagePreferences';
import {
  rankFundEstimates,
  type FundSortDirection,
  type FundSortMode,
} from './fundSorting';
import {
  rememberPageSearch,
  restoredPagePath,
  canonicalizePageLocation,
  expandedFundCodeFromPathname,
  fundExpansionPath,
  replaceSearchParams,
  pageFromPathname,
  type PageKey,
} from './routing';
import type { Fund } from './types';
import Header from './components/Header';
import IndexCards from './components/IndexCards';
import FundCard from './components/FundCard';
import styles from './App.module.css';

const PerformancePage = lazy(() => import('./components/PerformancePage'));
const CompaniesPage = lazy(() => import('./components/CompaniesPage'));
const AboutPage = lazy(() => import('./components/AboutPage'));
const DiagnosticsPage = lazy(() => import('./components/DiagnosticsPage'));

const FUND_MANAGER_KEY = 'fund_valuation:managed_funds';
const MAX_CUSTOM_FUNDS = 50;

interface ManagedFundSettings {
  hiddenDefaultCodes: string[];
  customFunds: Array<{ code: string; name: string }>;
}

const EMPTY_MANAGED_SETTINGS: ManagedFundSettings = {
  hiddenDefaultCodes: [],
  customFunds: [],
};

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

export default function App() {
  const [managedFunds, setManagedFunds] = useState<ManagedFundSettings>(() => readManagedFundSettings());
  const [fundManagementMode, setFundManagementMode] = useState<FundManagementMode>('disabled');
  const [fundManagementUnlocked, setFundManagementUnlocked] = useState(false);
  const [fundManagementToken, setFundManagementToken] = useState(readFundManagementToken);
  const [fundManagementAuthLoading, setFundManagementAuthLoading] = useState(false);
  const [fundManagementAuthError, setFundManagementAuthError] = useState('');
  const [activePage, setActivePage] = useState<PageKey>(canonicalizePageLocation);
  // The URL is the single source of truth for the expanded fund card.
  const [expandedCode, setExpandedCode] = useState<string | null>(() => {
    if (pageFromPathname(window.location.pathname) !== 'funds') return null;
    return expandedFundCodeFromPathname(window.location.pathname);
  });
  const pendingFundScrollRef = useRef<string | null>(expandedFundCodeFromPathname(window.location.pathname));

  const handleFundExpandedChange = useCallback((code: string, expanded: boolean) => {
    const targetPath = `${fundExpansionPath(code, expanded)}${window.location.search}`;
    if (`${window.location.pathname}${window.location.search}` !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
    setExpandedCode(expanded ? code : null);
  }, []);
  const fundManagementAvailable = fundManagementMode !== 'disabled';
  const fundManagementGranted = fundManagementMode === 'open' || fundManagementUnlocked;
  const funds = useMemo(() => {
    if (!fundManagementGranted || (managedFunds.hiddenDefaultCodes.length === 0 && managedFunds.customFunds.length === 0)) return FUNDS;
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
  const overviewData = useOverviewData(activePage === 'overview');
  const showMarketMeta = activePage !== 'about' && activePage !== 'companies';
  const headerFxRates = useHeaderFxRates(showMarketMeta && activePage !== 'overview' && activePage !== 'funds');
  const marketPageData = useRankingMarketData(activePage === 'ranking');
  const systemStatus = useSystemStatus(showMarketMeta);
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
  const [sortMode, setSortMode] = useState<FundSortMode>('preview');
  const [sortDirection, setSortDirection] = useState<FundSortDirection>('desc');
  const [fundFilter, setFundFilter] = useState<FundFilter>(() => (
    readFundPageFilter(window.location.search)
  ));
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

  const effectiveSortMode = fundFilter === 'index' ? 'official' : sortMode;
  const filteredFunds = useMemo(() => funds.filter(fund => matchesFundFilter(fund, fundFilter)), [funds, fundFilter]);
  const sortedEstimates = useMemo(() => (
    rankFundEstimates(fundEstimates.filter(item => matchesFundFilter(item.fund, fundFilter)), effectiveSortMode, sortDirection)
  ), [fundEstimates, fundFilter, sortDirection, effectiveSortMode]);

  const sortLabel = effectiveSortMode === 'official'
    ? '按最新净值涨跌排序'
    : effectiveSortMode === 'preview'
      ? '按实时参考（含汇率）涨跌排序'
      : '待公布优先 · 各组按涨跌排序';

  useEffect(() => {
    function handlePopState() {
      const page = canonicalizePageLocation();
      setActivePage(page);
      if (page === 'funds') setFundFilter(readFundPageFilter(window.location.search));
      setExpandedCode(page === 'funds' ? expandedFundCodeFromPathname(window.location.pathname) : null);
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    setPageStatusMessage('');
  }, [activePage]);

  useEffect(() => {
    const code = pendingFundScrollRef.current;
    if (activePage !== 'funds' || !code || !fundEstimates.some((estimate) => estimate.fund.code === code)) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`fund-${code}`);
      if (!target) return;
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
      pendingFundScrollRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activePage, expandedCode, fundEstimates.length, fundFilter]);

  useEffect(() => {
    if (activePage !== 'funds') return;
    const expandedFund = funds.find(fund => fund.code === expandedCode);
    if (expandedFund && !matchesFundFilter(expandedFund, fundFilter)) {
      setFundFilter('all');
      return;
    }
    replaceSearchParams({ strategy: fundFilter });
    storeFundPageFilter(fundFilter);
  }, [activePage, expandedCode, fundFilter, funds]);

  function navigatePage(page: PageKey) {
    rememberPageSearch();
    const path = restoredPagePath(page);
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.pushState({}, '', path);
    }
    setActivePage(page);
    if (page === 'funds') setFundFilter(readFundPageFilter(window.location.search));
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
    if (!matchesFundFilter(defaultFund, fundFilter)) changeFundFilter('all');
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
      changeFundFilter('all');
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

  function changeFundFilter(filter: FundFilter) {
    if (filter === fundFilter) return;
    setFundFilter(filter);
    if (expandedCode) handleFundExpandedChange(expandedCode, false);
  }

  return (
    <div className={styles.app}>
      <Header
        fxRates={activeFxRates}
        activePage={activePage}
        onPageChange={navigatePage}
        statusMessage={pageStatusMessage}
        systemStatus={systemStatus}
        showMarketMeta={showMarketMeta}
      />
      {activeError && <div className={styles.error}>{activeError}</div>}
      {activePage === 'overview' ? (
        <IndexCards quotes={overviewData.quotes} marketStates={overviewData.marketStates} loading={overviewData.loading} />
      ) : activePage === 'funds' ? (
        <>
          <div className={styles.fundSection}>
            <div className={`${styles.sectionHeader} ${styles.fundToolbar}`}>
              <h2 className={styles.sectionTitle}>
                QDII 基金
                <span className={styles.count}>
                  {' · '}{filteredFunds.length} · {sortLabel}
                </span>
              </h2>
              <div className={`${styles.fundControls} ${fundFilter === 'index' ? styles.fundControlsOfficial : ''}`}>
                <div className={styles.sortToggle} role="group" aria-label="基金类型筛选">
                  {FUND_FILTERS.map(item => (
                    <button key={item.key} type="button"
                      className={`${styles.sortButton} ${fundFilter === item.key ? styles.sortButtonActive : ''}`}
                      aria-pressed={fundFilter === item.key}
                      onClick={() => changeFundFilter(item.key)}>{item.label}</button>
                  ))}
                </div>
                <div className={styles.sortControls}>
                  {fundFilter !== 'index' && <div className={styles.sortToggle} aria-label="基金排序方式">
                    <button
                      type="button"
                      aria-pressed={sortMode === 'pending'}
                      className={`${styles.sortButton} ${sortMode === 'pending' ? styles.sortButtonActive : ''}`}
                      onClick={() => setSortMode('pending')}
                    >
                      待公布估值
                    </button>
                    <button
                      type="button"
                      aria-pressed={sortMode === 'preview'}
                      className={`${styles.sortButton} ${sortMode === 'preview' ? styles.sortButtonActive : ''}`}
                      onClick={() => setSortMode('preview')}
                    >
                      实时参考
                    </button>
                    <button
                      type="button"
                      aria-pressed={sortMode === 'official'}
                      className={`${styles.sortButton} ${sortMode === 'official' ? styles.sortButtonActive : ''}`}
                      onClick={() => setSortMode('official')}
                    >
                      最新净值
                    </button>
                  </div>}
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
              </div>
            </div>
            {fundManagementAvailable && fundManagerOpen && (
              <div className={styles.managerOverlay} role="presentation" onClick={() => setFundManagerOpen(false)}>
                <section
                  ref={managerDialogRef}
                  className={`${styles.fundManager} ${fundManagementGranted ? '' : styles.fundManagerLocked}`}
                  role="dialog"
                  aria-modal="true"
                  aria-label="管理基金"
                  tabIndex={-1}
                  onClick={(event) => event.stopPropagation()}
                >
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
                        className={`${styles.fundSearchInput} ${styles.managerTokenInput}`}
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
            {fundLoading && sortedEstimates.length === 0 && (
              <div className={styles.fundLoading}>基金数据加载中...</div>
            )}
            {!fundLoading && filteredFunds.length === 0 && <div className={styles.fundLoading}>暂无此类基金</div>}
            {sortedEstimates.map((est) => {
              const fund = est.estimate.fund;
              return (
                <Fragment key={fund.code}>
                  {effectiveSortMode === 'pending' && est.groupStart && (
                    <div className={styles.fundSortGroup}>
                      <span>{est.group === 'pending' ? '待公布' : est.group === 'officialOnly' ? '仅官方净值' : '已公布'}</span>
                      <span>· {est.groupCount}</span>
                      {est.group === 'published' && <span>· 按实时参考排序</span>}
                    </div>
                  )}
                  <FundCard
                    fund={fund}
                    estimate={est.estimate}
                    rank={est.rank}
                    sortMode={effectiveSortMode}
                    loading={false}
                    marketStates={marketStates}
                    onRemove={fundManagementGranted ? removeFund : undefined}
                    expanded={expandedCode === fund.code}
                    onExpandedChange={handleFundExpandedChange}
                  />
                </Fragment>
              );
            })}
          </div>
        </>
      ) : activePage === 'companies' ? (
        <Suspense fallback={<div className={styles.pageFallback}>公司页面加载中...</div>}>
          <CompaniesPage onStatusMessageChange={setPageStatusMessage} />
        </Suspense>
      ) : activePage === 'ranking' || activePage === 'history' ? (
        <Suspense fallback={activePage === 'history' ? null : <div className={styles.pageFallback}>走势页面加载中...</div>}>
          <PerformancePage
            mode={activePage}
            quotes={marketPageData.quotes}
            funds={funds}
            marketStates={marketPageData.marketStates}
            marketLoading={marketPageData.loading}
            onModeChange={navigatePage}
            onStatusMessageChange={setPageStatusMessage}
          />
        </Suspense>
      ) : activePage === 'about' ? (
        <Suspense fallback={<div className={styles.pageFallback}>关于页面加载中...</div>}>
          <AboutPage />
        </Suspense>
      ) : (
        <Suspense fallback={<div className={styles.pageFallback}>诊断页面加载中...</div>}>
          <DiagnosticsPage />
        </Suspense>
      )}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          © {new Date().getFullYear()} <a href="https://github.com/taifuer/fund_valuation" target="_blank" rel="noreferrer">Fund Valuation</a> · 数据仅供参考，不构成投资建议
        </div>
      </footer>
    </div>
  );
}
