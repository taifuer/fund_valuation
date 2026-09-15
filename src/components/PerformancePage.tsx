import type { Fund } from '../types';
import { lazy, Suspense } from 'react';
import type { MarketStateData, QuoteData } from '../types';
import RankingPage from './RankingPage';
import RiskPage from './RiskPage';
import styles from './PerformancePage.module.css';

type PerformanceMode = 'ranking' | 'risk' | 'history';
const LongHistoryPage = lazy(() => import('./LongHistoryPage'));

interface Props {
  mode: PerformanceMode;
  quotes: Map<string, QuoteData>;
  funds: Fund[];
  marketStates: Map<string, MarketStateData>;
  marketLoading: boolean;
  onModeChange: (mode: PerformanceMode) => void;
  onStatusMessageChange?: (message: string) => void;
}

export default function PerformancePage({
  mode,
  quotes,
  funds,
  marketStates,
  marketLoading,
  onModeChange,
  onStatusMessageChange,
}: Props) {
  return (
    <>
      <div className={styles.viewHeader}>
        <nav className={styles.viewNav} aria-label="收益分析视图">
          <button
            type="button"
            aria-current={mode === 'ranking' ? 'page' : undefined}
            className={mode === 'ranking' ? styles.viewButtonActive : ''}
            onClick={() => onModeChange('ranking')}
          >
            收益
          </button>
          <button
            type="button"
            aria-current={mode === 'risk' ? 'page' : undefined}
            className={mode === 'risk' ? styles.viewButtonActive : ''}
            onClick={() => onModeChange('risk')}
          >
            风险
          </button>
          <button
            type="button"
            aria-current={mode === 'history' ? 'page' : undefined}
            className={mode === 'history' ? styles.viewButtonActive : ''}
            onClick={() => onModeChange('history')}
          >
            历史
          </button>
        </nav>
      </div>
      {mode === 'history' ? (
        <Suspense fallback={null}>
          <LongHistoryPage />
        </Suspense>
      ) : mode === 'ranking' ? (
        <RankingPage
          quotes={quotes}
          funds={funds}
          marketStates={marketStates}
          marketLoading={marketLoading}
          onStatusMessageChange={onStatusMessageChange}
        />
      ) : (
        <RiskPage
          funds={funds}
          marketStates={new Map()}
          marketLoading={false}
          onStatusMessageChange={onStatusMessageChange}
        />
      )}
    </>
  );
}
