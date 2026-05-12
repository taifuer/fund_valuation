import type { QuoteData, IndexConfig } from '../types';
import { INDICES } from '../constants';
import { getMarketState } from '../marketHours';
import styles from './IndexCards.module.css';

interface Props {
  quotes: Map<string, QuoteData>;
  loading: boolean;
}

function formatQuoteDate(date: string): string {
  const match = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : date || '--';
}

function Card({
  idx,
  data,
  futuresData,
  loading,
}: {
  idx: IndexConfig;
  data?: QuoteData;
  futuresData?: QuoteData;
  loading: boolean;
}) {
  if (loading || !data) {
    return (
      <div className={styles.card}>
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

  return (
    <div className={styles.card}>
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
        {formatQuoteDate(displayData.time)}
      </span>
    </div>
  );
}

export default function IndexCards({ quotes, loading }: Props) {
  const groups = [
    { title: 'A股', symbols: ['s_sh000001', 's_sz399006', 's_sh000300', 's_sh000905'], cols: 'grid4' },
    { title: '美股', symbols: ['gb_ixic', 'gb_ndx', 'gb_ndxt', 'gb_inx'], cols: 'grid4' },
    { title: '亚太', symbols: ['hkHSI', 'int_nikkei', 'b_KOSPI', 'b_TWSE'], cols: 'grid4' },
  ];

  return (
    <div className={styles.container}>
      {groups.map((g) => (
        <div key={g.title}>
          <div className={styles.sectionTitle}>{g.title}</div>
          <div className={`${styles.grid} ${styles[g.cols]}`}>
            {g.symbols.map((sym) => {
              const idx = INDICES.find((i) => i.sinaSymbol === sym)!;
              return (
                <Card
                  key={sym}
                  idx={idx}
                  data={quotes.get(sym)}
                  futuresData={idx.futures ? quotes.get(idx.futures.sinaSymbol) : undefined}
                  loading={loading}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
