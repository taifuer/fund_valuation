import { useState } from 'react';
import type { QuoteData, IndexConfig } from '../types';
import { INDICES, MARKET_ASSETS } from '../constants';
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

function formatQuoteDate(date: string): string {
  const datetimeMatch = date.match(/^\d{4}-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (datetimeMatch) return `${datetimeMatch[1]}/${datetimeMatch[2]} ${datetimeMatch[3]}:${datetimeMatch[4]}`;
  const match = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : date || '--';
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
  loading,
  onOpenHistory,
}: {
  idx: IndexConfig;
  data?: QuoteData;
  futuresData?: QuoteData;
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
  const fresh = Date.now() - displayData.fetchedAt < 90_000;
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
      <span className={`${styles.quoteDate} ${displayData.dateReliable ? '' : styles.quoteDateEstimated}`}>
        {quoteTimeLabel}
      </span>
    </button>
  );
}

export default function IndexCards({ quotes, loading }: Props) {
  const [selectedHistory, setSelectedHistory] = useState<SelectedHistory | null>(null);
  const groups = [
    { title: 'A股', symbols: ['s_sh000001', 's_sz399006', 's_sh000300', 's_sh000905'], cols: 'grid4' },
    { title: '美股', symbols: ['gb_ixic', 'gb_ndx', 'gb_inx', 'gb_dji'], cols: 'grid4' },
    { title: '亚太', symbols: ['hkHSI', 'int_nikkei', 'b_KOSPI', 'b_TWSE'], cols: 'grid4' },
    { title: '资产', symbols: ['hf_GC', 'hf_SI', 'hf_CL', 'fx_sbtcusd'], cols: 'grid4' },
  ];
  const cards = [...INDICES, ...MARKET_ASSETS];

  return (
    <div className={styles.container}>
      {groups.map((g) => (
        <div key={g.title}>
          <div className={styles.sectionTitle}>{g.title}</div>
          <div className={`${styles.grid} ${styles[g.cols]}`}>
            {g.symbols.map((sym) => {
              const idx = cards.find((i) => i.sinaSymbol === sym)!;
              return (
                <Card
                  key={sym}
                  idx={idx}
                  data={quotes.get(sym)}
                  futuresData={idx.futures ? quotes.get(idx.futures.sinaSymbol) : undefined}
                  loading={loading}
                  onOpenHistory={idx.history ? (quote) => setSelectedHistory({ item: idx, quote }) : undefined}
                />
              );
            })}
          </div>
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
