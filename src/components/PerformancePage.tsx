import type { Fund } from '../types';
import { lazy, Suspense } from 'react';
import type { MarketStateData, QuoteData } from '../types';
import RankingPage from './RankingPage';
import PageHeading from './PageHeading';
import DataNotice from './DataNotice';
import styles from './PerformancePage.module.css';

type PerformanceMode = 'ranking' | 'history';
const LongHistoryPage = lazy(() => import('./LongHistoryPage'));

interface Props {
  mode: PerformanceMode;
  quotes: Map<string, QuoteData>;
  funds: Fund[];
  marketStates: Map<string, MarketStateData>;
  marketLoading: boolean;
  onModeChange: (mode: PerformanceMode) => void;
  error?: string | null;
}

export default function PerformancePage({
  mode,
  quotes,
  funds,
  marketStates,
  marketLoading,
  onModeChange,
  error,
}: Props) {
  return (
    <>
      <div className={styles.viewHeader}>
        <PageHeading title="资产走势" description="按各市场交易日统计，历史指标截至最近可用数据。">
          <nav className={styles.viewNav} aria-label="走势分析视图">
            <button
              type="button"
              aria-current={mode === 'ranking' ? 'page' : undefined}
              onClick={() => onModeChange('ranking')}
            >
              近期
            </button>
            <button
              type="button"
              aria-current={mode === 'history' ? 'page' : undefined}
              onClick={() => onModeChange('history')}
            >
              长期
            </button>
          </nav>
        </PageHeading>
      </div>
      {mode === 'history' ? (
        <Suspense fallback={<div className={styles.viewHeader}><DataNotice loading message="历史数据加载中..." /></div>}>
          <LongHistoryPage />
        </Suspense>
      ) : (
        <RankingPage
          quotes={quotes}
          funds={funds}
          marketStates={marketStates}
          marketLoading={marketLoading}
          error={error}
        />
      )}
    </>
  );
}
