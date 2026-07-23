import { lazy, memo, Suspense, useState } from 'react';
import type {
  Fund,
  MarketStateData,
  QuoteData,
} from '../types';
import type { FundEstimate } from '../hooks/useQuotes';
import { quoteDisplayState, quoteDisplayTime, quoteMarketState } from '../displayStatus';
import styles from './FundCard.module.css';

const HoldingsTable = lazy(() => import('./HoldingsTable'));
const FundNavTable = lazy(() => import('./FundNavTable'));
const FundHistoryChart = lazy(() => import('./FundHistoryChart'));
const FundProfilePanel = lazy(() => import('./FundProfilePanel'));

// Module-level empty Map so the default prop keeps a stable reference (a fresh
// `new Map()` default would defeat React.memo).
const EMPTY_MARKET_STATES: Map<string, MarketStateData> = new Map();

interface Props {
  fund: Fund;
  estimate?: FundEstimate;
  rank: number;
  sortMode: 'estimate' | 'official';
  loading: boolean;
  marketStates?: Map<string, MarketStateData>;
  onRemove?: (fund: Fund) => void;
  /** When provided, expansion is controlled by the parent and URL state. */
  expanded?: boolean;
  onExpandedChange?: (code: string, expanded: boolean) => void;
}

const RANK_STYLE: Record<number, string> = {
  1: 'gold',
  2: 'silver',
  3: 'bronze',
};

// Format YYYY-MM-DD → MM/DD
function formatDate(yyyymmdd: string): string {
  if (!yyyymmdd) return '';
  const m = yyyymmdd.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}/${m[2]}`;
  return yyyymmdd;
}

function quoteTimeCandidate(
  quote: QuoteData,
  closed: boolean,
  marketStates: Map<string, MarketStateData>,
): { label: string; sort: string } | null {
  const marketState = quoteMarketState(quote.symbol, marketStates);
  const state = quoteDisplayState({ quote, marketState });
  const displayTime = quoteDisplayTime(quote, state, { useCloseTimeWhenClosed: closed && state !== 'break' });
  return displayTime.label ? { label: displayTime.label, sort: displayTime.sort } : null;
}

function estimateTimeLabel(
  quotes: QuoteData[],
  closed: boolean,
  marketStates: Map<string, MarketStateData>,
): string | null {
  const candidates = quotes
    .map((quote) => quoteTimeCandidate(quote, closed, marketStates))
    .filter((item): item is { label: string; sort: string } => item != null)
    .sort((a, b) => b.sort.localeCompare(a.sort));
  return candidates[0]?.label ?? null;
}

const FundCard = memo(function FundCard({
  fund,
  estimate,
  rank,
  sortMode,
  loading,
  marketStates = EMPTY_MARKET_STATES,
  onRemove,
  expanded: controlledExpanded,
  onExpandedChange,
}: Props) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = controlledExpanded ?? internalExpanded;
  const [activeTab, setActiveTab] = useState<'holdings' | 'nav' | 'trend' | 'profile'>('holdings');
  function toggleExpanded() {
    const next = !expanded;
    if (controlledExpanded == null) setInternalExpanded(next);
    onExpandedChange?.(fund.code, next);
  }
  const rankStyle = RANK_STYLE[rank];
  const cardClassName = [
    styles.card,
    onRemove ? styles.cardRemovable : '',
  ].filter(Boolean).join(' ');
  const rankNode = (
    <div className={styles.rankGroup}>
      <div className={`${styles.rankNumber} ${rankStyle ? styles[rankStyle] : ''}`}>#{rank}</div>
    </div>
  );

  if (loading) {
    return <div className={styles.skeleton} style={{ height: 96, width: '100%' }} />;
  }

  if (!estimate || !estimate.officialNAV) {
    return (
      <div className={cardClassName}>
        {rankNode}
        <div className={styles.main}>
          <div className={styles.topRow}>
            <span className={styles.name}>{fund.name}<span className={styles.code}>{fund.code}</span></span>
          </div>
        </div>
        {onRemove && (
          <button
            type="button"
            className={styles.removeButton}
            aria-label={`删除 ${fund.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(fund);
            }}
          >
            ×
          </button>
        )}
      </div>
    );
  }

  const {
    officialNAV,
    computedChange,
    normalizedChange,
    normalizedNAV,
    quoteCoverage,
    totalConfiguredWeight,
    missingQuoteCount,
    staleQuoteCount,
    missingFxCount,
    estimateState,
    currencyChanges,
  } = estimate;
  // Headline direction uses the coverage-normalized change (the displayed
  // estimate), so up/down tinting matches the number the user reads.
  const up = normalizedChange >= 0;
  const estBoxCls = up ? styles.estimateBox : styles.estimateBoxDown;
  const officialUp = officialNAV.officialChange >= 0;
  const officialBoxCls = officialUp ? styles.estimateBox : styles.estimateBoxDown;
  const estimateIsPrimary = sortMode === 'estimate';
  const tagCls = estimateState === 'LIVE'
    ? styles.estLiveTagUp
    : estimateState === 'PRE' || estimateState === 'POST'
      ? styles.estLiveTagExtended
    : estimateState === 'PARTIAL'
      ? styles.estLiveTagPartial
      : styles.estLiveTagClosed;
  const estimateStateLabel = {
    LIVE: '实时',
    PRE: '盘前',
    POST: '盘后',
    PARTIAL: '部分',
    CLOSED: '收盘',
  }[estimateState];
  const timeLabel = estimateTimeLabel(estimate.holdingsQuotes, estimateState === 'CLOSED', marketStates);
  return (
    <div
      className={cardClassName}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`${fund.name} ${fund.code}，${expanded ? '收起详情' : '展开详情'}`}
      onClick={toggleExpanded}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          toggleExpanded();
        }
      }}
    >
      {rankNode}
      <div className={styles.main}>
        <div className={styles.topRow}>
          <span className={styles.name}>{fund.name}<span className={styles.code}>{fund.code}</span></span>
        </div>

        <div className={styles.dualNav}>
          {/* T-day: Live estimate */}
          <div
            className={`${styles.navBox} ${styles.estimateNavBox} ${estimateIsPrimary ? `${styles.primaryNavBox} ${estBoxCls}` : styles.secondaryNavBox}`}
            role="group"
            aria-label={`T日估算（含汇率），状态${estimateStateLabel}`}
          >
            <span className={`${styles.navKindLabel} ${styles.estimateKindLabel}`}>T日估算</span>
            <span className={`${styles.navBoxValue} ${up ? styles.up : styles.down}`}>
              {normalizedNAV !== null ? normalizedNAV.toFixed(4) : '--'}
            </span>
            <span className={`${styles.navBoxChange} ${up ? styles.up : styles.down}`}>
              {normalizedNAV !== null
                ? `${up ? '+' : ''}${normalizedChange.toFixed(2)}%`
                : '数据不足'}
            </span>
            <span className={`${styles.estLiveTag} ${tagCls}`}>{estimateStateLabel}</span>
            <span className={styles.navDataTime}>{timeLabel ?? ''}</span>
          </div>

          {/* Latest disclosed official NAV. QDII publication may lag by more than one day. */}
          <div
            className={`${styles.navBox} ${styles.officialNavBox} ${estimateIsPrimary ? styles.secondaryNavBox : `${styles.primaryNavBox} ${officialBoxCls}`}`}
            role="group"
            aria-label="最新已出净值"
          >
            <span className={styles.navKindLabel}>已出净值</span>
            <span className={`${styles.navBoxValue} ${!estimateIsPrimary ? (officialUp ? styles.up : styles.down) : ''}`}>
              {officialNAV.nav.toFixed(4)}
            </span>
            <span className={`${styles.navBoxChange} ${officialUp ? styles.up : styles.down}`}>
              {officialUp ? '+' : ''}{officialNAV.officialChange.toFixed(2)}%
            </span>
            <span className={styles.navDataTime}>{formatDate(officialNAV.navDate)}</span>
          </div>
        </div>
      </div>

      {onRemove && (
        <button
          type="button"
          className={styles.removeButton}
          aria-label={`删除 ${fund.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(fund);
          }}
        >
          ×
        </button>
      )}

      {expanded && (
        <div className={styles.expanded} onClick={(event) => event.stopPropagation()}>
          <div className={styles.tabs}>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === 'holdings' ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveTab('holdings')}
            >
              持仓
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === 'nav' ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveTab('nav')}
            >
              净值
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === 'trend' ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveTab('trend')}
            >
              走势
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === 'profile' ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveTab('profile')}
            >
              资料
            </button>
          </div>
          <Suspense fallback={<div className={styles.tabLoading}>详情加载中...</div>}>
            {activeTab === 'holdings' && (
              <HoldingsTable
                holdings={fund.holdings}
                quotes={estimate.holdingsQuotes}
                computedChange={computedChange}
                normalizedChange={normalizedChange}
                quoteCoverage={quoteCoverage}
                totalConfiguredWeight={totalConfiguredWeight}
                missingQuoteCount={missingQuoteCount}
                staleQuoteCount={staleQuoteCount}
                missingFxCount={missingFxCount}
                currencyChanges={currencyChanges}
                marketStates={marketStates}
              />
            )}
            {activeTab === 'nav' && (
              <FundNavTable fundCode={fund.code} />
            )}
            {activeTab === 'trend' && (
              <FundHistoryChart fundCode={fund.code} />
            )}
            {activeTab === 'profile' && (
              <FundProfilePanel fundCode={fund.code} fallbackProfile={fund.profile} />
            )}
          </Suspense>
        </div>
      )}
    </div>
  );
});

export default FundCard;
