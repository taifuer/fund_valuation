import { useMemo, useState } from 'react';
import { useQuotes, FundEstimate } from './hooks/useQuotes';
import { FUNDS } from './constants';
import Header from './components/Header';
import IndexCards from './components/IndexCards';
import FundCard from './components/FundCard';
import styles from './App.module.css';

type SortMode = 'estimate' | 'official';
type SortDirection = 'desc' | 'asc';

const FUND_SECTION_COLLAPSED_KEY = 'fund_valuation:collapsed_fund_section';

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

function sortValue(estimate: FundEstimate, mode: SortMode): number | null {
  if (mode === 'official') {
    return estimate.officialNAV?.officialChange ?? null;
  }
  return estimate.computedChange;
}

export default function App() {
  const { quotes, fundEstimates, fxRates, loading, error } = useQuotes();
  const [sortMode, setSortMode] = useState<SortMode>('estimate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [fundCollapsed, setFundCollapsed] = useState(() => readCollapsedFlag(FUND_SECTION_COLLAPSED_KEY));

  const sortedEstimates = useMemo(() => {
    const sorted = [...fundEstimates].sort((a, b) => {
      const aValue = sortValue(a, sortMode);
      const bValue = sortValue(b, sortMode);
      if (aValue === null && bValue === null) return 0;
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return sortDirection === 'desc' ? bValue - aValue : aValue - bValue;
    });
    return sorted.map((e, i) => ({ ...e, rank: i + 1 }));
  }, [fundEstimates, sortMode, sortDirection]);

  const sortLabel = sortMode === 'official' ? '按 T-1 已出净值排序' : '按实时估算涨跌排序';

  function toggleFundSection() {
    setFundCollapsed((prev) => {
      const next = !prev;
      writeCollapsedFlag(FUND_SECTION_COLLAPSED_KEY, next);
      return next;
    });
  }

  return (
    <div className={styles.app}>
      <Header fxRates={fxRates} />
      {error && <div className={styles.error}>{error}</div>}
      <IndexCards quotes={quotes} loading={loading} />
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
            <span className={styles.count}> · {FUNDS.length}只{fundCollapsed ? '' : ` · ${sortLabel}`}</span>
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
            </div>
          )}
        </div>
        {!fundCollapsed && sortedEstimates.map((est) => {
          const fund = FUNDS.find((f) => f.code === est.fundCode)!;
          return (
            <FundCard
              key={fund.code}
              fund={fund}
              estimate={est}
              rank={est.rank}
              rankLabel={sortDirection === 'desc' ? `TOP ${est.rank}` : `LOW ${est.rank}`}
              loading={loading}
            />
          );
        })}
      </div>
      <footer className={styles.footer}>
        © <a href="https://github.com/taifuer/fund_valuation" target="_blank" rel="noreferrer">Fund Valuation</a> · 数据来源：新浪财经、天天基金、东方财富等公开接口；估算结果仅供参考，不构成投资建议，实际净值以基金公司披露为准。
      </footer>
    </div>
  );
}
