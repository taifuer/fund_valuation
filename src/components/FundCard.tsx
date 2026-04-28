import { useState } from 'react';
import type { Fund } from '../types';
import type { FundEstimate } from '../hooks/useQuotes';
import HoldingsTable from './HoldingsTable';
import styles from './FundCard.module.css';

interface Props {
  fund: Fund;
  estimate?: FundEstimate;
  rank: number;
  loading: boolean;
}

const RANK_BADGE: Record<number, { label: string; cls: string }> = {
  1: { label: 'TOP 1', cls: 'gold' },
  2: { label: 'TOP 2', cls: 'silver' },
  3: { label: 'TOP 3', cls: 'bronze' },
};

export default function FundCard({ fund, estimate, rank, loading }: Props) {
  const [expanded, setExpanded] = useState(false);
  const badge = RANK_BADGE[rank];

  if (loading) {
    return <div className={styles.skeleton} style={{ height: 96, width: '100%' }} />;
  }

  if (!estimate || !estimate.officialNAV) {
    return (
      <div className={styles.card}>
        {badge && <div className={`${styles.badge} ${styles[badge.cls]}`}>{badge.label}</div>}
        <div className={styles.main}>
          <div className={styles.topRow}>
            <span className={styles.name}>{fund.name}<span className={styles.code}>{fund.code}</span></span>
          </div>
        </div>
      </div>
    );
  }

  const { officialNAV, computedChange, estimatedNAV } = estimate;
  const up = computedChange >= 0;
  const estBoxCls = up ? styles.estimateBox : styles.estimateBoxDown;
  const tagCls = up ? styles.estLiveTagUp : styles.estLiveTagDown;

  return (
    <div className={styles.card} onClick={() => setExpanded(!expanded)}>
      {badge && <div className={`${styles.badge} ${styles[badge.cls]}`}>{badge.label}</div>}
      <div className={styles.main}>
        <div className={styles.topRow}>
          <span className={styles.name}>{fund.name}<span className={styles.code}>{fund.code}</span></span>
        </div>

        <div className={styles.dualNav}>
          {/* T-1: Official NAV */}
          <div className={styles.navBox}>
            <div className={styles.navBoxLabel}>T-1 已出净值</div>
            <div className={styles.navBoxValue}>{officialNAV.nav.toFixed(4)}</div>
            <div className={styles.navBoxDate}>
              {officialNAV.navDate}
              {officialNAV.officialChange !== 0 && (
                <span className={`${styles.navBoxChange} ${officialNAV.officialChange >= 0 ? styles.up : styles.down}`}>
                  {' '}{officialNAV.officialChange >= 0 ? '+' : ''}{officialNAV.officialChange.toFixed(2)}%
                </span>
              )}
            </div>
          </div>

          {/* T-day: Live estimate */}
          <div className={`${styles.navBox} ${estBoxCls}`}>
            <div className={styles.navBoxLabel}>
              T日 实时估算
              <span className={`${styles.estLiveTag} ${tagCls}`}>LIVE</span>
            </div>
            <div className={`${styles.navBoxValue} ${up ? styles.up : styles.down}`}>
              {estimatedNAV !== null ? estimatedNAV.toFixed(4) : '--'}
            </div>
            <div className={`${styles.navBoxChange} ${up ? styles.up : styles.down}`}>
              {estimatedNAV !== null
                ? `${up ? '+' : ''}${computedChange.toFixed(2)}%`
                : '数据不足'}
            </div>
          </div>
        </div>
      </div>

      {expanded && (
        <HoldingsTable
          holdings={fund.holdings}
          quotes={estimate.holdingsQuotes}
          computedChange={computedChange}
        />
      )}
    </div>
  );
}
