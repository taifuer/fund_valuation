import type { Holding, QuoteData } from '../types';
import { getMarketState } from '../marketHours';
import styles from './HoldingsTable.module.css';

interface Props {
  holdings: Holding[];
  quotes: QuoteData[];
  computedChange: number;
  quoteCoverage: number;
  totalConfiguredWeight: number;
  currencyChanges: Record<string, number>;
}

function formatQuoteDate(date: string): string {
  const match = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : date || '-';
}

export default function HoldingsTable({
  holdings,
  quotes,
  computedChange,
  quoteCoverage,
  totalConfiguredWeight,
  currencyChanges,
}: Props) {
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  const coveragePct = totalConfiguredWeight > 0 ? (quoteCoverage / totalConfiguredWeight) * 100 : 0;

  return (
    <div className={styles.container} onClick={(e) => e.stopPropagation()}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>股票</th>
            <th className={styles.right}>权重</th>
            <th className={styles.right}>币种</th>
            <th className={styles.right}>日期</th>
            <th className={styles.right}>现价</th>
            <th className={styles.right}>涨跌幅</th>
            <th className={styles.right}>汇率</th>
            <th className={styles.right}>贡献</th>
            <th className={styles.right}>状态</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => {
            const q = quoteMap.get(h.sinaSymbol);
            const up = (q?.changePercent ?? 0) >= 0;
            const fxChange = currencyChanges[h.currency] ?? 0;
            const rmbChange = q
              ? ((1 + q.changePercent / 100) * (1 + fxChange / 100) - 1) * 100
              : 0;
            const contrib = q ? rmbChange * h.weight : 0;
            const state = getMarketState(h.sinaSymbol);
            const fresh = q ? Date.now() - q.fetchedAt < 90_000 : false;
            const displayState = state === 'live' && fresh ? 'live' : state === 'live' ? 'stale' : 'closed';
            return (
              <tr key={h.symbol}>
                <td>
                  {h.symbol}
                  <span className={styles.stockName}>{h.name}</span>
                </td>
                <td className={styles.right}>{(h.weight * 100).toFixed(1)}%</td>
                <td className={styles.right}>{h.currency}</td>
                <td className={`${styles.right} ${q?.dateReliable === false ? styles.estimatedDate : ''}`}>
                  {q ? formatQuoteDate(q.time) : '-'}
                </td>
                <td className={styles.right}>{q ? q.price : '-'}</td>
                <td className={`${styles.right} ${up ? styles.up : styles.down}`}>
                  {q ? `${up ? '+' : ''}${q.changePercent}%` : '-'}
                </td>
                <td className={`${styles.right} ${fxChange >= 0 ? styles.up : styles.down}`}>
                  {h.currency === 'CNY' ? '-' : `${fxChange >= 0 ? '+' : ''}${fxChange.toFixed(2)}%`}
                </td>
                <td className={`${styles.right} ${contrib >= 0 ? styles.up : styles.down}`}>
                  {q ? `${contrib >= 0 ? '+' : ''}${contrib.toFixed(2)}%` : '-'}
                </td>
                <td className={styles.right}>
                  <span
                    className={`${styles.stateTag} ${
                      displayState === 'live'
                        ? styles.stateLive
                        : displayState === 'stale'
                          ? styles.stateStale
                          : styles.stateClosed
                    }`}
                  >
                    {displayState === 'live' ? 'LIVE' : displayState === 'stale' ? '延迟' : '已收盘'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.footer}>
        持仓加权涨跌
        <span className={`${styles.footerStrong} ${computedChange >= 0 ? styles.up : styles.down}`}>
          {computedChange >= 0 ? '+' : ''}{computedChange.toFixed(2)}%
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          （已配置持仓覆盖 {coveragePct.toFixed(0)}%，USD 持仓已并入 USD/CNY 涨跌）
        </span>
      </div>
    </div>
  );
}
