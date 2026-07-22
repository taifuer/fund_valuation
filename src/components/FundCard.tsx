import { lazy, memo, Suspense, useState } from 'react';
import type {
  Fund,
  FundRangeReturn,
  FundReturnRangeKey,
  FundReturnSummary,
  MarketStateData,
  QuoteData,
} from '../types';
import type { FundEstimate } from '../hooks/useQuotes';
import { quoteDisplayState, quoteDisplayTime, quoteMarketState } from '../displayStatus';
import styles from './FundCard.module.css';

const HoldingsTable = lazy(() => import('./HoldingsTable'));
const FundNavTable = lazy(() => import('./FundNavTable'));
const FundHistoryChart = lazy(() => import('./FundHistoryChart'));

// Module-level empty Map so the default prop keeps a stable reference (a fresh
// `new Map()` default would defeat React.memo).
const EMPTY_MARKET_STATES: Map<string, MarketStateData> = new Map();

interface Props {
  fund: Fund;
  estimate?: FundEstimate;
  rank: number;
  loading: boolean;
  marketStates?: Map<string, MarketStateData>;
  showDetails?: boolean;
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

const FUND_RETURN_RANGES: FundReturnRangeKey[] = ['1w', '1m', '3m', '6m', '1y', '3y', 'ytd'];

// Format YYYY-MM-DD → MM/DD
function formatDate(yyyymmdd: string): string {
  if (!yyyymmdd) return '';
  const m = yyyymmdd.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}/${m[2]}`;
  return yyyymmdd;
}

function formatChineseDate(yyyymmdd: string): string {
  if (!yyyymmdd) return '';
  const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return yyyymmdd;
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

function formatPurchaseAmount(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value >= 10_000_000_000) return '不限';
  if (value >= 10_000) return `${Number((value / 10_000).toFixed(2))}万元`;
  return `${Number(value.toFixed(2))}元`;
}

function purchaseStatusClass(status: string): string {
  if (status.includes('暂停')) return 'purchaseStopped';
  if (status.includes('限') || status.includes('封闭')) return 'purchaseLimited';
  return 'purchaseOpen';
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

function FundReturnBar({
  summary,
  ranges,
}: {
  summary: FundReturnSummary | null;
  ranges: FundReturnRangeKey[];
}) {
  const items = ranges
    .map((key) => summary?.ranges[key])
    .filter((item): item is FundRangeReturn => item != null);

  if (items.length === 0) return null;

  return (
    <div className={styles.returnBar}>
      {items.map((item) => {
        const up = item.returnPercent >= 0;
        return (
          <span key={item.key} className={styles.returnItem}>
            <em>{item.label}</em>
            <strong className={up ? styles.returnUp : styles.returnDown}>
              {up ? '+' : ''}{item.returnPercent.toFixed(2)}%
            </strong>
          </span>
        );
      })}
    </div>
  );
}

const FundCard = memo(function FundCard({
  fund,
  estimate,
  rank,
  loading,
  marketStates = EMPTY_MARKET_STATES,
  showDetails = false,
  onRemove,
  expanded: controlledExpanded,
  onExpandedChange,
}: Props) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = controlledExpanded ?? internalExpanded;
  const [activeTab, setActiveTab] = useState<'holdings' | 'nav' | 'trend'>('holdings');
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
    purchaseStatus,
    rangeReturns,
    estimatedNAVLocal,
    computedChange,
    normalizedChangeLocal,
    normalizedChange,
    normalizedNAVLocal,
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
  const localUp = normalizedChangeLocal >= 0;
  const estBoxCls = up ? styles.estimateBox : styles.estimateBoxDown;
  const tagCls = estimateState === 'LIVE'
    ? styles.estLiveTagUp
    : estimateState === 'PRE' || estimateState === 'POST'
      ? styles.estLiveTagExtended
    : estimateState === 'PARTIAL'
      ? styles.estLiveTagPartial
      : styles.estLiveTagClosed;
  const timeLabel = estimateTimeLabel(estimate.holdingsQuotes, estimateState === 'CLOSED', marketStates);
  const profile = fund.profile;

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
              {normalizedNAVLocal !== null ? normalizedNAVLocal.toFixed(4) : '--'}
              {normalizedNAV !== null && (
                <span className={`${styles.fxNavValue} ${up ? styles.up : styles.down}`}>
                  （{normalizedNAV.toFixed(4)}）
                </span>
              )}
            </div>
            <div className={styles.estimateMetaRow}>
              <div className={`${styles.navBoxChange} ${localUp ? styles.up : styles.down}`}>
                {normalizedNAVLocal !== null
                  ? `${localUp ? '+' : ''}${normalizedChangeLocal.toFixed(2)}%`
                  : '数据不足'}
                {normalizedNAV !== null && (
                  <span className={`${styles.fxChange} ${up ? styles.up : styles.down}`}>
                    （含汇率 {up ? '+' : ''}{normalizedChange.toFixed(2)}%）
                  </span>
                )}
              </div>
              {timeLabel && (
                <span className={styles.estimateTime}>{timeLabel}</span>
              )}
            </div>
            {normalizedNAVLocal !== null && staleQuoteCount > 0 && (
              <div className={styles.estimateCoverage}>
                {staleQuoteCount} 项持仓行情不晚于已出净值日，已剔除以防重复计入
              </div>
            )}
            {normalizedNAVLocal !== null && missingFxCount > 0 && (
              <div className={styles.estimateCoverage}>
                {missingFxCount} 项外币持仓汇率缺失，按 0 计入
              </div>
            )}
          </div>
        </div>
        {showDetails && (profile || purchaseStatus) && (
          <div className={styles.fundProfile}>
            {profile && (
              <>
                <span className={styles.profilePill}>
                  <em>成立</em>{formatChineseDate(profile.inceptionDate)}
                </span>
                <span className={styles.profilePill}>
                  <em>规模</em>{profile.assetScale}<small>截至 {formatChineseDate(profile.scaleDate)}</small>
                </span>
                <span className={styles.profilePill}>
                  <em>费率</em>管理 {profile.managementFee}<small>托管 {profile.custodianFee} / 销售 {profile.salesServiceFee}</small>
                </span>
              </>
            )}
            {purchaseStatus && (
              <>
                <span className={`${styles.profilePill} ${styles[purchaseStatusClass(purchaseStatus.purchaseStatus)]}`}>
                  <em>申购</em>{purchaseStatus.purchaseStatus}
                </span>
                <span className={styles.profilePill}>
                  <em>限额</em>{formatPurchaseAmount(purchaseStatus.dailyLimit)}
                  <small>起购 {formatPurchaseAmount(purchaseStatus.minPurchase)}</small>
                </span>
              </>
            )}
          </div>
        )}
        {showDetails && <FundReturnBar summary={rangeReturns} ranges={FUND_RETURN_RANGES} />}
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
          </Suspense>
        </div>
      )}
    </div>
  );
});

export default FundCard;
