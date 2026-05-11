import { useState } from 'react';
import type { Fund } from '../types';
import type { FundEstimate } from '../hooks/useQuotes';
import HoldingsTable from './HoldingsTable';
import { getMarketState } from '../marketHours';
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

// Format YYYY-MM-DD → MM/DD
function formatDate(yyyymmdd: string): string {
  if (!yyyymmdd) return '';
  const m = yyyymmdd.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}/${m[2]}`;
  return yyyymmdd;
}

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

  const {
    officialNAV,
    computedChangeLocal,
    estimatedNAVLocal,
    computedChange,
    estimatedNAV,
    quoteCoverage,
    totalConfiguredWeight,
    missingQuoteCount,
    lastUpdated,
    currencyChanges,
  } = estimate;
  const up = computedChange >= 0;
  const localUp = computedChangeLocal >= 0;
  const estBoxCls = up ? styles.estimateBox : styles.estimateBoxDown;
  const hasLiveHolding = fund.holdings.some((h) => getMarketState(h.sinaSymbol) === 'live');
  const fresh = lastUpdated != null && Date.now() - lastUpdated < 90_000;
  const estimateState = hasLiveHolding && fresh
    ? (missingQuoteCount > 0 ? 'PARTIAL' : 'LIVE')
    : 'CLOSED';
  const tagCls = estimateState === 'LIVE'
    ? styles.estLiveTagUp
    : estimateState === 'PARTIAL'
      ? styles.estLiveTagPartial
      : styles.estLiveTagClosed;
  const coveragePct = totalConfiguredWeight > 0 ? (quoteCoverage / totalConfiguredWeight) * 100 : 0;

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
              {formatDate(officialNAV.navDate)}
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
              T日 持仓估算
              <span className={`${styles.estLiveTag} ${tagCls}`}>{estimateState}</span>
            </div>
            <div className={`${styles.navBoxValue} ${up ? styles.up : styles.down}`}>
              {estimatedNAVLocal !== null ? estimatedNAVLocal.toFixed(4) : '--'}
              {estimatedNAV !== null && (
                <span className={`${styles.fxNavValue} ${up ? styles.up : styles.down}`}>
                  （{estimatedNAV.toFixed(4)}）
                </span>
              )}
            </div>
            <div className={`${styles.navBoxChange} ${localUp ? styles.up : styles.down}`}>
              {estimatedNAVLocal !== null
                ? `${localUp ? '+' : ''}${computedChangeLocal.toFixed(2)}%`
                : '数据不足'}
              {estimatedNAV !== null && (
                <span className={`${styles.fxChange} ${up ? styles.up : styles.down}`}>
                  （含汇率 {up ? '+' : ''}{computedChange.toFixed(2)}%）
                </span>
              )}
            </div>
            {missingQuoteCount > 0 && (
              <div className={styles.coverage}>
                覆盖 {coveragePct.toFixed(0)}% · 缺 {missingQuoteCount}
              </div>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <HoldingsTable
          holdings={fund.holdings}
          quotes={estimate.holdingsQuotes}
          computedChange={computedChange}
          quoteCoverage={quoteCoverage}
          totalConfiguredWeight={totalConfiguredWeight}
          currencyChanges={currencyChanges}
        />
      )}
    </div>
  );
}
