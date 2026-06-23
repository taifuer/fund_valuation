import type { Holding, MarketStateData, QuoteData } from '../types';
import {
  displayStateLabel,
  quoteDisplayState,
  quoteDisplayTime,
  quoteMarketState,
  type QuoteDisplayState,
} from '../displayStatus';
import styles from './HoldingsTable.module.css';

interface Props {
  holdings: Holding[];
  quotes: QuoteData[];
  computedChange: number;
  normalizedChange: number;
  quoteCoverage: number;
  totalConfiguredWeight: number;
  missingQuoteCount: number;
  currencyChanges: Record<string, number>;
  marketStates?: Map<string, MarketStateData>;
}

function stateClassName(state: QuoteDisplayState): string {
  if (state === 'live') return styles.stateLive;
  if (state === 'pre' || state === 'post' || state === 'futuresLive') return styles.stateExtended;
  if (state === 'stale') return styles.stateStale;
  return styles.stateClosed;
}

export default function HoldingsTable({
  holdings,
  quotes,
  computedChange,
  normalizedChange,
  quoteCoverage,
  totalConfiguredWeight,
  missingQuoteCount,
  currencyChanges,
  marketStates = new Map(),
}: Props) {
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  const coveragePct = totalConfiguredWeight > 0 ? (quoteCoverage / totalConfiguredWeight) * 100 : 0;

  return (
    <div className={styles.container} onClick={(e) => e.stopPropagation()}>
      <table className={styles.table}>
        <colgroup>
          <col className={styles.colStock} />
          <col className={styles.colWeight} />
          <col className={styles.colCurrency} />
          <col className={styles.colDate} />
          <col className={styles.colPrice} />
          <col className={styles.colChange} />
          <col className={styles.colFx} />
          <col className={styles.colContrib} />
          <col className={styles.colState} />
        </colgroup>
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
            const marketState = quoteMarketState(h.sinaSymbol, marketStates);
            const displayState = q ? quoteDisplayState({ quote: q, marketState }) : marketState;
            const displayTime = q ? quoteDisplayTime(q, displayState, { useCloseTimeWhenClosed: true }) : null;
            return (
              <tr key={h.symbol}>
                <td className={styles.stockCell}>
                  <div className={styles.stockContent}>
                    <span className={styles.symbol}>{h.symbol}</span>
                    <span className={styles.stockName}>{h.name}</span>
                  </div>
                </td>
                <td className={styles.right}>{(h.weight * 100).toFixed(1)}%</td>
                <td className={styles.right}>{h.currency}</td>
                <td className={`${styles.right} ${displayTime?.estimated ? styles.estimatedDate : ''}`}>
                  {displayTime?.label ?? '-'}
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
                    className={`${styles.stateTag} ${stateClassName(displayState)}`}
                  >
                    {displayStateLabel(displayState)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.footer}>
        估算涨跌（按覆盖权重归一化）
        <span className={`${styles.footerStrong} ${normalizedChange >= 0 ? styles.up : styles.down}`}>
          {normalizedChange >= 0 ? '+' : ''}{normalizedChange.toFixed(2)}%
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          （覆盖 {coveragePct.toFixed(0)}%；原始加权 {computedChange >= 0 ? '+' : ''}{computedChange.toFixed(2)}%；外币持仓已并入兑 CNY 汇率）
        </span>
      </div>
      {missingQuoteCount > 0 && (
        <div className={styles.note}>
          当前有 {missingQuoteCount} 项持仓未获取到行情，T日持仓估算未包含这些持仓的实时涨跌。
        </div>
      )}
    </div>
  );
}
