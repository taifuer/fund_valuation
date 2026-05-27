import { useState } from 'react';
import type { Fund, FundRangeReturn, FundReturnRangeKey, FundReturnSummary, MarketStateData, QuoteData } from '../types';
import type { FundEstimate } from '../hooks/useQuotes';
import HoldingsTable from './HoldingsTable';
import FundNavTable from './FundNavTable';
import FundHistoryChart from './FundHistoryChart';
import FundBacktestPanel from './FundBacktestPanel';
import { getMarketState } from '../marketHours';
import styles from './FundCard.module.css';

interface Props {
  fund: Fund;
  estimate?: FundEstimate;
  rank: number;
  loading: boolean;
  marketStates?: Map<string, MarketStateData>;
  showDetails?: boolean;
  onRemove?: (fund: Fund) => void;
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

function formatQuoteDate(date: string): string {
  const datetimeMatch = date.match(/^\d{4}-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (datetimeMatch) return `${datetimeMatch[1]}/${datetimeMatch[2]} ${datetimeMatch[3]}:${datetimeMatch[4]}`;
  return formatDate(date);
}

function closeTime(sinaSymbol: string): string | null {
  if (sinaSymbol.startsWith('s_')) return '15:00';
  if (sinaSymbol.startsWith('gb_')) return '04:00';
  if (sinaSymbol.startsWith('hk')) return '16:10';
  if (sinaSymbol.startsWith('kr')) return '14:30';
  if (sinaSymbol.startsWith('sh') || sinaSymbol.startsWith('sz')) return '15:00';
  if (sinaSymbol === 'int_nikkei') return '14:30';
  if (sinaSymbol === 'b_KOSPI') return '14:30';
  if (sinaSymbol === 'b_TWSE') return '13:30';
  if (sinaSymbol === 'hf_HSI') return '03:00';
  if (sinaSymbol === 'hf_NK') return '04:15';
  if (sinaSymbol.startsWith('hf_')) return '05:00';
  return null;
}

function quoteTimeCandidate(
  quote: QuoteData,
  closed: boolean,
  marketStates: Map<string, MarketStateData>,
): { label: string; sort: string } | null {
  const state = marketStates.get(quote.symbol)?.state ?? getMarketState(quote.symbol);
  if (closed && state !== 'break') {
    const time = closeTime(quote.symbol);
    const dateMatch = quote.time.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (time && dateMatch) {
      return {
        label: `${dateMatch[2]}/${dateMatch[3]} ${time}`,
        sort: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${time}:00`,
      };
    }
  }

  const label = formatQuoteDate(quote.time);
  return label ? { label, sort: quote.time || String(quote.fetchedAt) } : null;
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

export default function FundCard({
  fund,
  estimate,
  rank,
  loading,
  marketStates = new Map(),
  showDetails = false,
  onRemove,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'holdings' | 'nav' | 'trend' | 'backtest'>('holdings');
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
    computedChangeLocal,
    estimatedNAVLocal,
    computedChange,
    estimatedNAV,
    quoteCoverage,
    totalConfiguredWeight,
    missingQuoteCount,
    estimateState,
    currencyChanges,
  } = estimate;
  const up = computedChange >= 0;
  const localUp = computedChangeLocal >= 0;
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
    <div className={cardClassName} onClick={() => setExpanded(!expanded)}>
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
              {estimatedNAVLocal !== null ? estimatedNAVLocal.toFixed(4) : '--'}
              {estimatedNAV !== null && (
                <span className={`${styles.fxNavValue} ${up ? styles.up : styles.down}`}>
                  （{estimatedNAV.toFixed(4)}）
                </span>
              )}
            </div>
            <div className={styles.estimateMetaRow}>
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
              {timeLabel && (
                <span className={styles.estimateTime}>{timeLabel}</span>
              )}
            </div>
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
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === 'backtest' ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveTab('backtest')}
            >
              回测
            </button>
          </div>
          {activeTab === 'holdings' && (
            <HoldingsTable
              holdings={fund.holdings}
              quotes={estimate.holdingsQuotes}
              computedChange={computedChange}
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
          {activeTab === 'backtest' && (
            <FundBacktestPanel fundCode={fund.code} />
          )}
        </div>
      )}
    </div>
  );
}
