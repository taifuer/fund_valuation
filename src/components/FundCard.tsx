import { useState } from 'react';
import type { Fund, QuoteData } from '../types';
import type { FundEstimate } from '../hooks/useQuotes';
import HoldingsTable from './HoldingsTable';
import FundHistoryChart from './FundHistoryChart';
import { getMarketState } from '../marketHours';
import styles from './FundCard.module.css';

interface Props {
  fund: Fund;
  estimate?: FundEstimate;
  rank: number;
  rankLabel?: string;
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

function formatChineseDate(yyyymmdd: string): string {
  if (!yyyymmdd) return '';
  const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return yyyymmdd;
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
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

function quoteTimeCandidate(quote: QuoteData, closed: boolean): { label: string; sort: string } | null {
  if (closed) {
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

function estimateTimeLabel(quotes: QuoteData[], closed: boolean): string | null {
  const candidates = quotes
    .map((quote) => quoteTimeCandidate(quote, closed))
    .filter((item): item is { label: string; sort: string } => item != null)
    .sort((a, b) => b.sort.localeCompare(a.sort));
  return candidates[0]?.label ?? null;
}

export default function FundCard({ fund, estimate, rank, rankLabel, loading }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'holdings' | 'history'>('holdings');
  const badge = RANK_BADGE[rank];
  const badgeLabel = rankLabel ?? badge?.label;

  if (loading) {
    return <div className={styles.skeleton} style={{ height: 96, width: '100%' }} />;
  }

  if (!estimate || !estimate.officialNAV) {
    return (
      <div className={styles.card}>
        <div className={styles.rankNumber}>#{rank}</div>
        {badge && <div className={`${styles.badge} ${styles[badge.cls]}`}>{badgeLabel}</div>}
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
  const hasPreHolding = estimate.holdingsQuotes.some((q) => q.session === 'pre');
  const hasPostHolding = estimate.holdingsQuotes.some((q) => q.session === 'post');
  const estimateState = fresh && hasPreHolding
    ? 'PRE'
    : fresh && hasPostHolding
      ? 'POST'
      : hasLiveHolding && fresh
    ? (missingQuoteCount > 0 ? 'PARTIAL' : 'LIVE')
    : 'CLOSED';
  const tagCls = estimateState === 'LIVE'
    ? styles.estLiveTagUp
    : estimateState === 'PRE' || estimateState === 'POST'
      ? styles.estLiveTagExtended
    : estimateState === 'PARTIAL'
      ? styles.estLiveTagPartial
      : styles.estLiveTagClosed;
  const timeLabel = estimateTimeLabel(estimate.holdingsQuotes, estimateState === 'CLOSED');
  const profile = fund.profile;

  return (
    <div className={styles.card} onClick={() => setExpanded(!expanded)}>
      <div className={styles.rankNumber}>#{rank}</div>
      {badge && <div className={`${styles.badge} ${styles[badge.cls]}`}>{badgeLabel}</div>}
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
        {profile && (
          <div className={styles.fundProfile}>
            <span className={styles.profilePill}>
              <em>成立</em>{formatChineseDate(profile.inceptionDate)}
            </span>
            <span className={styles.profilePill}>
              <em>规模</em>{profile.assetScale}<small>截至 {formatChineseDate(profile.scaleDate)}</small>
            </span>
            <span className={styles.profilePill}>
              <em>费率</em>管理 {profile.managementFee}<small>托管 {profile.custodianFee} / 销售 {profile.salesServiceFee}</small>
            </span>
          </div>
        )}
      </div>

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
              className={`${styles.tabButton} ${activeTab === 'history' ? styles.tabButtonActive : ''}`}
              onClick={() => setActiveTab('history')}
            >
              历史
            </button>
          </div>
          {activeTab === 'holdings' ? (
            <HoldingsTable
              holdings={fund.holdings}
              quotes={estimate.holdingsQuotes}
              computedChange={computedChange}
              quoteCoverage={quoteCoverage}
              totalConfiguredWeight={totalConfiguredWeight}
              missingQuoteCount={missingQuoteCount}
              currencyChanges={currencyChanges}
            />
          ) : (
            <FundHistoryChart fundCode={fund.code} />
          )}
        </div>
      )}
    </div>
  );
}
