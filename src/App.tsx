import { useMemo } from 'react';
import { useQuotes, FundEstimate } from './hooks/useQuotes';
import { FUNDS } from './constants';
import Header from './components/Header';
import IndexCards from './components/IndexCards';
import FundCard from './components/FundCard';
import styles from './App.module.css';

export default function App() {
  const { quotes, fundEstimates, loading, error } = useQuotes();

  // Sort by computedChange descending
  const sortedEstimates = useMemo(() => {
    const sorted = [...fundEstimates].sort(
      (a, b) => b.computedChange - a.computedChange,
    );
    return sorted.map((e, i) => ({ ...e, rank: i + 1 }));
  }, [fundEstimates]);

  return (
    <div className={styles.app}>
      <Header />
      {error && <div className={styles.error}>{error}</div>}
      <IndexCards quotes={quotes} loading={loading} />
      <div className={styles.fundSection}>
        <h2 className={styles.sectionTitle}>
          QDII 主动基金<span className={styles.count}> · {FUNDS.length}只 · 按实时估算涨跌排序</span>
        </h2>
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
