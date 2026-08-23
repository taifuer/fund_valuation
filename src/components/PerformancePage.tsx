import type { Fund } from '../types';
import type { MarketStateData, QuoteData } from '../types';
import RankingPage from './RankingPage';
import RiskPage from './RiskPage';
import styles from './PerformancePage.module.css';

type PerformanceMode = 'ranking' | 'risk';

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
        </nav>
      </div>
      {mode === 'ranking' ? (
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
