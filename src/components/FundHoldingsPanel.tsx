import { useEffect, useState } from 'react';
import { fetchFundEstimates, fetchFundHoldings } from '../api';
import type { Fund, FundEstimateProjection, FundEstimateResult, MarketStateData } from '../types';
import HoldingsTable from './HoldingsTable';
import styles from './FundCard.module.css';

interface Props {
  fund: Fund;
  projection: FundEstimateProjection | null;
  marketStates: Map<string, MarketStateData>;
}

export default function FundHoldingsPanel({ fund, projection, marketStates }: Props) {
  const [result, setResult] = useState<FundEstimateResult | null>(null);
  const [holdings, setHoldings] = useState(fund.holdings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const estimates = await fetchFundEstimates([fund.code]);
        const next = estimates.get(fund.code) ?? null;
        const rows = next?.holdings ?? (await fetchFundHoldings([fund.code])).get(fund.code) ?? fund.holdings;
        if (!cancelled) { setResult(next); setHoldings(rows); setError(''); }
      } catch {
        if (!cancelled) setError('持仓详情加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [fund.code, projection?.asOf]);
  if (loading) return <div className={styles.tabLoading} role="status">持仓数据加载中...</div>;
  if (error) return <div className={styles.tabLoading} role="alert">{error}</div>;
  const candidate = projection ? result?.[projection.kind] ?? null : result?.pending ?? result?.preview ?? null;
  const mismatch = projection && candidate && (projection.targetDate !== candidate.targetDate ||
    (projection.inputSignature && candidate.inputSignature && projection.inputSignature !== candidate.inputSignature));
  if (mismatch) return <div className={styles.tabLoading} role="status">估值快照已更新，等待卡片同步。</div>;
  const selected = candidate;
  const quotes = Object.values(result?.holdingQuotes ?? {});
  const disclosure = result?.holdingDisclosure;
  return <><HoldingsTable
    holdings={holdings} quotes={quotes} marketStates={new Map([...marketStates, ...Object.entries(result?.holdingMarketStates ?? {})])}
    computedChange={selected?.holdingContributionPercent ?? 0}
    normalizedChange={selected?.changePercent ?? 0}
    quoteCoverage={selected?.coverage ?? 0}
    totalConfiguredWeight={holdings.reduce((sum, holding) => sum + holding.weight, 0)}
    missingQuoteCount={selected?.missingQuoteCount ?? 0} staleQuoteCount={0} missingFxCount={0}
    currencyChanges={{}} projection={selected} estimateEnabled={fund.estimateMode !== 'official'} projectionRequired
  />
    {disclosure && <p className={styles.disclosureNote}>
      {disclosure.reportDate} · {disclosure.kind === 'configured' ? '配置组合' : disclosure.kind === 'proxy' ? '目标ETF披露持仓' : disclosure.kind === 'expanded' ? '扩展披露持仓' : '前十大披露持仓'} {disclosure.count} 项 · 权重 {(disclosure.weight * 100).toFixed(2)}%
      {disclosure.allocationApplied ? ` · 股票仓位 ${(disclosure.equityWeight! * 100).toFixed(2)}%` : ''}
      {disclosure.equityWeight !== null && disclosure.equityWeight < disclosure.weight ? ' · 资产配置与持仓权重口径不一致，未应用现金仓位修正' : ''}
      {disclosure.sourceUrl && <> · <a href={disclosure.sourceUrl} target="_blank" rel="noreferrer">披露来源</a></>}
    </p>}
  </>;
}
