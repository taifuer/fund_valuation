import type { Holding, QuoteData } from '../types';
import styles from './HoldingsTable.module.css';

interface Props {
  holdings: Holding[];
  quotes: QuoteData[];
  computedChange: number;
}

export default function HoldingsTable({ holdings, quotes, computedChange }: Props) {
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  return (
    <div className={styles.container} onClick={(e) => e.stopPropagation()}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>股票</th>
            <th className={styles.right}>权重</th>
            <th className={styles.right}>现价</th>
            <th className={styles.right}>涨跌幅</th>
            <th className={styles.right}>贡献</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => {
            const q = quoteMap.get(h.sinaSymbol);
            const up = (q?.changePercent ?? 0) >= 0;
            const contrib = q ? q.changePercent * h.weight : 0;
            return (
              <tr key={h.symbol}>
                <td>
                  {h.symbol}
                  <span className={styles.stockName}>{h.name}</span>
                </td>
                <td className={styles.right}>{(h.weight * 100).toFixed(1)}%</td>
                <td className={styles.right}>{q ? q.price : '-'}</td>
                <td className={`${styles.right} ${up ? styles.up : styles.down}`}>
                  {q ? `${up ? '+' : ''}${q.changePercent}%` : '-'}
                </td>
                <td className={`${styles.right} ${contrib >= 0 ? styles.up : styles.down}`}>
                  {q ? `${contrib >= 0 ? '+' : ''}${contrib.toFixed(2)}%` : '-'}
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
        <span style={{ fontSize: 11, color: '#94a3b8' }}>（基于持仓实时行情计算）</span>
      </div>
    </div>
  );
}
