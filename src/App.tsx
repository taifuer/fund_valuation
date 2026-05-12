import { useMemo, useState } from 'react';
import { useQuotes, FundEstimate } from './hooks/useQuotes';
import { FUNDS } from './constants';
import Header from './components/Header';
import IndexCards from './components/IndexCards';
import FundCard from './components/FundCard';
import styles from './App.module.css';

type SortMode = 'estimate' | 'official';

export default function App() {
  const { quotes, fundEstimates, fxRates, loading, error } = useQuotes();
  const [sortMode, setSortMode] = useState<SortMode>('estimate');

  const sortedEstimates = useMemo(() => {
    const sorted = [...fundEstimates].sort((a, b) => {
      if (sortMode === 'official') {
        return (b.officialNAV?.officialChange ?? -Infinity) - (a.officialNAV?.officialChange ?? -Infinity);
      }
      return b.computedChange - a.computedChange;
    });
    return sorted.map((e, i) => ({ ...e, rank: i + 1 }));
  }, [fundEstimates, sortMode]);

  const sortLabel = sortMode === 'official' ? '按T-1 已出净值排序' : '按实时估算涨跌排序';

  return (
    <div className={styles.app}>
      <Header fxRates={fxRates} />
      {error && <div className={styles.error}>{error}</div>}
      <IndexCards quotes={quotes} loading={loading} />
      <div className={styles.fundSection}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>
            QDII 主动基金<span className={styles.count}> · {FUNDS.length}只 · {sortLabel}</span>
          </h2>
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
        </div>
        {sortedEstimates.map((est) => {
          const fund = FUNDS.find((f) => f.code === est.fundCode)!;
          return (
            <FundCard
              key={fund.code}
              fund={fund}
              estimate={est}
              rank={est.rank}
              loading={loading}
            />
          );
        })}
      </div>
    </div>
  );
}
