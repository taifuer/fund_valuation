import type { FundEstimateProjection, Holding, MarketStateData, QuoteData } from '../types';
import {
  displayStateLabel,
  quoteDisplayState,
  quoteDisplayTime,
  quoteMarketState,
  type QuoteDisplayState,
} from '../displayStatus';
import { isHoldingQuoteSupported } from '../quoteCapabilities';
import styles from './HoldingsTable.module.css';

interface Props {
  holdings: Holding[];
  quotes: QuoteData[];
  computedChange: number;
  normalizedChange: number;
  quoteCoverage: number;
  totalConfiguredWeight: number;
  missingQuoteCount: number;
  staleQuoteCount: number;
  missingFxCount: number;
  currencyChanges: Record<string, number>;
  projection?: FundEstimateProjection | null;
  marketStates?: Map<string, MarketStateData>;
}

function stateClassName(state: QuoteDisplayState): string {
  if (state === 'live') return styles.stateLive;
  if (state === 'pre' || state === 'post' || state === 'futuresLive') return styles.stateExtended;
  if (state === 'stale') return styles.stateStale;
  return styles.stateClosed;
}

function shortDate(value: string): string {
  const match = value.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : value;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function formatHoldingPeriod(holdings: Holding[]): string {
  const reportDates = holdings
    .map((holding) => holding.reportDate ?? '')
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();
  const reportDate = reportDates[reportDates.length - 1];
  if (!reportDate) return '持仓数据：参考配置（暂无有效季度披露日期）';

  const [year, month, day] = reportDate.split('-').map(Number);
  const quarter = Math.ceil(month / 3);
  const quarterLabel = ['', '一', '二', '三', '四'][quarter];
  return `持仓数据：${year}年第${quarterLabel}季度（截至${year}年${month}月${day}日）`;
}

export default function HoldingsTable({
  holdings,
  quotes,
  computedChange,
  normalizedChange,
  quoteCoverage,
  totalConfiguredWeight,
  missingQuoteCount,
  staleQuoteCount,
  missingFxCount,
  currencyChanges,
  projection = null,
  marketStates = new Map(),
}: Props) {
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  const contributionMap = new Map(
    (projection?.holdingContributions ?? []).map((item) => [item.sinaSymbol, item]),
  );
  const coveragePct = projection
    ? projection.coverage * 100
    : totalConfiguredWeight > 0 ? (quoteCoverage / totalConfiguredWeight) * 100 : 0;
  const estimateChange = projection?.changePercent ?? normalizedChange;
  const holdingContribution = projection?.holdingContributionPercent ?? computedChange;
  const residualContribution = projection?.residualContributionPercent ?? 0;
  const calibrationContribution = projection?.calibrationContributionPercent ?? 0;
  const holdingPeriod = formatHoldingPeriod(holdings);
  const unsupportedQuoteCount = holdings.filter((holding) => (
    !isHoldingQuoteSupported(holding.sinaSymbol, holding.quoteSupported)
  )).length;
  const unavailableQuoteCount = Math.max(missingQuoteCount - unsupportedQuoteCount, 0);

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
            const quoteSupported = isHoldingQuoteSupported(h.sinaSymbol, h.quoteSupported);
            const q = quoteSupported ? quoteMap.get(h.sinaSymbol) : undefined;
            const contribution = contributionMap.get(h.sinaSymbol);
            const priceChange = contribution?.priceChangePercent ?? q?.changePercent ?? null;
            const up = (priceChange ?? 0) >= 0;
            const fxChange = contribution?.fxChangePercent ?? currencyChanges[h.currency] ?? 0;
            const rmbChange = priceChange == null
              ? 0
              : ((1 + priceChange / 100) * (1 + fxChange / 100) - 1) * 100;
            const contrib = contribution?.contributionPercent ?? (q ? rmbChange * h.weight : 0);
            const marketState = quoteMarketState(h.sinaSymbol, marketStates);
            const displayState = q ? quoteDisplayState({ quote: q, marketState }) : marketState;
            const contributionIsClosed = Boolean(contribution && projection?.complete);
            const effectiveState: QuoteDisplayState = contributionIsClosed ? 'closed' : displayState;
            const displayTime = contributionIsClosed
              ? { label: shortDate(projection?.targetDate ?? ''), estimated: false }
              : q && quoteSupported
              ? quoteDisplayTime(q, displayState, { useCloseTimeWhenClosed: true })
              : null;
            const displayPrice = contribution?.targetPrice ?? q?.price ?? null;
            const hasValue = contribution != null || q != null;
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
                <td className={styles.right}>{displayPrice ?? '-'}</td>
                <td className={`${styles.right} ${up ? styles.up : styles.down}`}>
                  {priceChange == null ? '-' : signedPercent(priceChange)}
                </td>
                <td className={`${styles.right} ${fxChange >= 0 ? styles.up : styles.down}`}>
                  {h.currency === 'CNY' ? '-' : signedPercent(fxChange)}
                </td>
                <td className={`${styles.right} ${contrib >= 0 ? styles.up : styles.down}`}>
                  {hasValue ? signedPercent(contrib) : '-'}
                </td>
                <td className={styles.right}>
                  <span
                    className={`${styles.stateTag} ${quoteSupported ? stateClassName(effectiveState) : styles.stateUnavailable}`}
                  >
                    {quoteSupported ? displayStateLabel(effectiveState) : '暂无行情'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.footer}>
        估算涨跌
        <span className={`${styles.footerStrong} ${estimateChange >= 0 ? styles.up : styles.down}`}>
          {signedPercent(estimateChange)}
        </span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          （覆盖 {coveragePct.toFixed(0)}%；持仓 {signedPercent(holdingContribution)}
          {projection?.model === 'holdingsBenchmark' && `；未披露仓位 ${signedPercent(residualContribution)}`}
          {Math.abs(calibrationContribution) >= 0.005 && `；校准 ${signedPercent(calibrationContribution)}`}
          ；外币已折算）
        </span>
      </div>
      <div className={styles.notes}>
        <div>{holdingPeriod}</div>
        {projection?.model === 'coverageNormalizedFallback' && (
          <div>未披露仓位暂无稳定基准，本次估算按已覆盖持仓权重归一化。</div>
        )}
        {unsupportedQuoteCount > 0 && (
          <div>
            {unsupportedQuoteCount} 项持仓的数据源暂不支持行情，已从T日持仓估算覆盖权重中排除。
          </div>
        )}
        {unavailableQuoteCount > 0 && (
          <div>
            当前有 {unavailableQuoteCount} 项持仓未获取到行情，T日持仓估算未包含这些持仓的实时涨跌。
          </div>
        )}
        {staleQuoteCount > 0 && (
          <div>{staleQuoteCount} 项行情不晚于最新已出净值日，已从本次估算中剔除。</div>
        )}
        {missingFxCount > 0 && (
          <div>{missingFxCount} 项外币持仓缺少汇率，暂按汇率变动 0 计算。</div>
        )}
      </div>
    </div>
  );
}
