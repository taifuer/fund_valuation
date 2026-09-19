import { lazy, Suspense } from 'react';
import type { Fund, HistoryRangeKey, IndexConfig } from '../types';
import HistoryDialog from './HistoryDialog';
import styles from './MarketHistoryModal.module.css';

const MarketHistoryChart = lazy(() => import('./MarketHistoryModal').then(module => ({ default: module.MarketHistoryChart })));
const FundHistoryChart = lazy(() => import('./FundHistoryChart'));

export type RecentHistoryTarget = { kind: 'market'; item: IndexConfig } | { kind: 'fund'; item: Fund };

interface Props {
  target: RecentHistoryTarget;
  initialRange: HistoryRangeKey;
  asOf?: string;
  onClose: () => void;
}

export default function RecentHistoryModal({ target, initialRange, asOf, onClose }: Props) {
  return (
    <HistoryDialog name={target.item.name} symbol={target.kind === 'fund' ? target.item.code : target.item.symbol} onClose={onClose}>
      <Suspense fallback={<div className={styles.state} role="status">走势加载中...</div>}>
        {target.kind === 'fund'
          ? <FundHistoryChart fundCode={target.item.code} initialRange={initialRange} asOf={asOf} />
          : <MarketHistoryChart item={target.item} initialRange={initialRange} asOf={asOf} />}
      </Suspense>
    </HistoryDialog>
  );
}
