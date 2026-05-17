import { useEffect, useMemo, useState } from 'react';
import type { QuoteData, IndexConfig, MarketReturnSummary } from '../types';
import { INDICES, MARKET_ASSETS, ETF_ASSETS } from '../constants';
import { fetchMarketReturnSummaries } from '../api';
import { getMarketState } from '../marketHours';
import MarketHistoryModal from './MarketHistoryModal';
import styles from './IndexCards.module.css';

interface Props {
  quotes: Map<string, QuoteData>;
  loading: boolean;
}

interface SelectedHistory {
  item: IndexConfig;
  quote: QuoteData;
}

const COLLAPSED_GROUPS_KEY = 'fund_valuation:collapsed_market_groups';

const GROUPS = [
  { title: 'A股', symbols: ['s_sh000001', 's_sz399006', 's_sh000300', 's_sh000905'], cols: 'grid4' },
  { title: '美股', symbols: ['gb_ixic', 'gb_ndx', 'gb_inx', 'gb_dji'], cols: 'grid4' },
  { title: '亚太', symbols: ['hkHSI', 'int_nikkei', 'b_KOSPI', 'b_TWSE'], cols: 'grid4' },
  { title: '资产', symbols: ['hf_GC', 'hf_SI', 'hf_CL', 'fx_sbtcusd'], cols: 'grid4' },
  { title: 'ETF', symbols: ['sz159695', 'sh512480', 'sh561380', 'sz159770', 'sz159755', 'sz159206', 'sh510170', 'sh512890'], cols: 'grid4' },
] as const;

function readCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCollapsedGroups(value: Record<string, boolean>) {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(value));
  } catch { /* skip */ }
}

function formatQuoteDate(date: string): string {
  const datetimeMatch = date.match(/^\d{4}-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (datetimeMatch) return `${datetimeMatch[1]}/${datetimeMatch[2]} ${datetimeMatch[3]}:${datetimeMatch[4]}`;
  const match = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : date || '--';
}

function beijingTimestamp(date: string): number | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const timestamp = new Date(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}+08:00`,
  ).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function quoteTimeFresh(data: QuoteData): boolean {
  if (data.symbol !== 'fx_sbtcusd') return true;
  const timestamp = beijingTimestamp(data.time);
  if (timestamp == null) return false;
  return Math.abs(Date.now() - timestamp) <= 10 * 60 * 1000;
}

function closeTime(sinaSymbol: string): string | null {
  if (sinaSymbol.startsWith('s_')) return '15:00';
  if (sinaSymbol.startsWith('gb_')) return '04:00';
  if (sinaSymbol.startsWith('hk')) return '16:10';
  if (sinaSymbol === 'int_nikkei') return '14:30';
  if (sinaSymbol === 'b_KOSPI') return '14:30';
  if (sinaSymbol === 'b_TWSE') return '13:30';
  if (sinaSymbol === 'hf_HSI') return '03:00';
  if (sinaSymbol === 'hf_NK') return '04:15';
  if (sinaSymbol.startsWith('hf_')) return '05:00';
  return null;
}

function closeTimeLabel(sinaSymbol: string, quoteTime: string): string | null {
  const time = closeTime(sinaSymbol);
  if (!time) return null;
  const dateMatch = quoteTime.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) return time;
  return `${dateMatch[2]}/${dateMatch[3]} ${time}`;
}

function Card({
  idx,
  data,
  futuresData,
  ytdReturn,
  loading,
  onOpenHistory,
}: {
  idx: IndexConfig;
  data?: QuoteData;
  futuresData?: QuoteData;
  ytdReturn?: MarketReturnSummary;
  loading: boolean;
  onOpenHistory?: (quote: QuoteData) => void;
}) {
  if (loading || !data) {
    return (
      <div className={`${styles.card} ${idx.history ? styles.cardClickable : ''}`}>
        <div className={styles.label}>{idx.name}</div>
        <div className={styles.skeleton} style={{ height: 24, width: 90, margin: '4px auto' }} />
        <div className={styles.skeleton} style={{ height: 14, width: 60, margin: '3px auto 0' }} />
      </div>
    );
  }
  const state = getMarketState(idx.sinaSymbol);
  const futuresState = idx.futures ? getMarketState(idx.futures.sinaSymbol) : 'closed';
  const futuresFresh = futuresData ? Date.now() - futuresData.fetchedAt < 90_000 : false;
  const useFutures = state !== 'live' && futuresData && futuresState === 'live' && futuresFresh;
  const displayData = useFutures ? futuresData : data;
  const up = displayData.change >= 0;
  const fresh = Date.now() - displayData.fetchedAt < 90_000 && quoteTimeFresh(displayData);
  const displayState = useFutures
    ? 'futuresLive'
    : state === 'live' && fresh
      ? 'live'
      : state === 'live'
        ? 'stale'
        : 'closed';
  const quoteTimeLabel = displayState === 'closed'
    ? closeTimeLabel(displayData.symbol, displayData.time) ?? formatQuoteDate(displayData.time)
    : formatQuoteDate(displayData.time);

  return (
    <button
      type="button"
      className={`${styles.card} ${idx.history ? styles.cardClickable : ''}`}
      onClick={() => onOpenHistory?.(displayData)}
      disabled={!idx.history}
    >
      <span
        className={`${styles.state} ${
          displayState === 'futuresLive'
            ? styles.stateFutures
            : displayState === 'live'
            ? styles.stateLive
            : displayState === 'stale'
              ? styles.stateStale
              : styles.stateClosed
        }`}
      >
        {displayState === 'futuresLive'
          ? '期货 LIVE'
          : displayState === 'live'
            ? 'LIVE'
            : displayState === 'stale'
              ? '延迟'
              : '已收盘'}
      </span>
      <div className={styles.label}>{useFutures ? idx.futures?.label : idx.name}</div>
      <div className={styles.price}>{displayData.price.toLocaleString()}</div>
      <div className={`${styles.change} ${up ? styles.up : styles.down}`}>
        {up ? '+' : ''}{displayData.changePercent.toFixed(2)}%
      </div>
      {ytdReturn && (
        <span className={styles.ytdReturn}>
          今年 {ytdReturn.returnPercent >= 0 ? '+' : ''}{ytdReturn.returnPercent.toFixed(1)}%
        </span>
      )}
      <span className={`${styles.quoteDate} ${displayData.dateReliable ? '' : styles.quoteDateEstimated}`}>
        {quoteTimeLabel}
      </span>
    </button>
  );
}

export default function IndexCards({ quotes, loading }: Props) {
  const [selectedHistory, setSelectedHistory] = useState<SelectedHistory | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(readCollapsedGroups);
  const [marketReturns, setMarketReturns] = useState<Map<string, MarketReturnSummary>>(new Map());
  const cards = useMemo(() => [...INDICES, ...MARKET_ASSETS, ...ETF_ASSETS], []);

  useEffect(() => {
    const configs = cards.map((item) => item.history).filter((item): item is NonNullable<IndexConfig['history']> => item != null);
    let cancelled = false;
    fetchMarketReturnSummaries(configs).then((data) => {
      if (!cancelled) setMarketReturns(data);
    });
    return () => {
      cancelled = true;
    };
  }, [cards]);

  function toggleGroup(title: string) {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [title]: !prev[title] };
      writeCollapsedGroups(next);
      return next;
    });
  }

  return (
    <div className={styles.container}>
      {GROUPS.map((g) => (
        <div key={g.title}>
          <button
            type="button"
            className={styles.sectionToggle}
            aria-expanded={!collapsedGroups[g.title]}
            onClick={() => toggleGroup(g.title)}
          >
            <span className={styles.toggleIcon}>{collapsedGroups[g.title] ? '+' : '-'}</span>
            <span>{g.title}</span>
            <span className={styles.groupCount}>· {g.symbols.length}</span>
          </button>
          {!collapsedGroups[g.title] && (
            <div className={`${styles.grid} ${styles[g.cols]}`}>
              {g.symbols.map((sym) => {
                const idx = cards.find((i) => i.sinaSymbol === sym)!;
                return (
                  <Card
                    key={sym}
                    idx={idx}
                    data={quotes.get(sym)}
                    futuresData={idx.futures ? quotes.get(idx.futures.sinaSymbol) : undefined}
                    ytdReturn={idx.history ? marketReturns.get(`${idx.history.source}:${idx.history.symbol}`) : undefined}
                    loading={loading}
                    onOpenHistory={idx.history ? (quote) => setSelectedHistory({ item: idx, quote }) : undefined}
                  />
                );
              })}
            </div>
          )}
        </div>
      ))}
      {selectedHistory && (
        <MarketHistoryModal
          item={selectedHistory.item}
          currentQuote={selectedHistory.quote}
          onClose={() => setSelectedHistory(null)}
        />
      )}
    </div>
  );
}
