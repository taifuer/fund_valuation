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

function Card({ idx, data, loading }: { idx: IndexConfig; data?: QuoteData; loading: boolean }) {
  if (loading || !data) {
    return (
      <div className={styles.card}>
        <div className={styles.label}>{idx.name}</div>
        <div className={styles.skeleton} style={{ height: 24, width: 90, margin: '4px auto' }} />
        <div className={styles.skeleton} style={{ height: 14, width: 60, margin: '3px auto 0' }} />
      </div>
    );
  }
  const up = data.change >= 0;
  const state = getMarketState(idx.sinaSymbol);
  const fresh = Date.now() - data.fetchedAt < 90_000;
  const displayState = state === 'live' && fresh ? 'live' : state === 'live' ? 'stale' : 'closed';
  return (
    <div className={styles.card}>
      <span
        className={`${styles.state} ${
          displayState === 'live'
            ? styles.stateLive
            : displayState === 'stale'
              ? styles.stateStale
              : styles.stateClosed
        }`}
      >
        {displayState === 'live' ? 'LIVE' : displayState === 'stale' ? '延迟' : '已收盘'}
      </span>
      <div className={styles.label}>{idx.name}</div>
      <div className={styles.price}>{data.price.toLocaleString()}</div>
      <div className={`${styles.change} ${up ? styles.up : styles.down}`}>
        {up ? '+' : ''}{data.changePercent.toFixed(2)}%
      </div>
      <span className={`${styles.quoteDate} ${data.dateReliable ? '' : styles.quoteDateEstimated}`}>
        {formatQuoteDate(data.time)}{data.dateReliable ? '' : ' 估'}
      </span>
    </div>
  );
}

export default function IndexCards({ quotes, loading }: Props) {
  const groups = [
    { title: 'A股', symbols: ['s_sh000001', 's_sz399006', 's_sh000300', 's_sh000905'], cols: 'grid4' },
    { title: '港股', symbols: ['hkHSI', 'hkHSTECH'], cols: 'grid2' },
    { title: '美股', symbols: ['gb_ixic', 'gb_ndx', 'gb_inx'], cols: 'grid3' },
    { title: '亚太', symbols: ['int_nikkei', 'b_KOSPI', 'b_TWSE'], cols: 'grid3' },
  ];

  return (
    <div className={styles.container}>
      {groups.map((g) => (
        <div key={g.title}>
          <div className={styles.sectionTitle}>{g.title}</div>
          <div className={`${styles.grid} ${styles[g.cols]}`}>
            {g.symbols.map((sym) => {
              const idx = INDICES.find((i) => i.sinaSymbol === sym)!;
              return <Card key={sym} idx={idx} data={quotes.get(sym)} loading={loading} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
