import { useState, useEffect, useRef } from 'react';
import type { QuoteData, FundNavData, FxRateData, Fund, FundPurchaseData, FundReturnSummary, MarketStateData, FundEstimateResult } from '../types';
import { fetchFundCardSnapshot, fetchFundReturnSummaries } from '../api';
import { FUNDS } from '../constants';
import { pickPollInterval } from '../marketHours';
import { startAdaptivePolling } from '../polling';

type EstimateState = 'LIVE' | 'PRE' | 'POST' | 'PARTIAL' | 'CLOSED';

export interface FundEstimate {
  fundCode: string;
  fundName: string;
  fund: Fund;
  officialNAV: FundNavData | null;
  purchaseStatus: FundPurchaseData | null;
  rangeReturns: FundReturnSummary | null;
  /** Weighted change over covered holdings, NOT normalized by coverage. */
  computedChangeLocal: number;
  estimatedNAVLocal: number | null;
  computedChange: number;
  estimatedNAV: number | null;
  /** Compatibility fields derived from the authoritative server projection. */
  normalizedChangeLocal: number;
  normalizedChange: number;
  normalizedNAVLocal: number | null;
  normalizedNAV: number | null;
  holdingsQuotes: QuoteData[];
  totalConfiguredWeight: number;
  quoteCoverage: number;
  missingQuoteCount: number;
  /** Holdings whose quote trading day is on/before navDate (already baked into
   *  the official NAV) and were therefore excluded from the T-day estimate. */
  staleQuoteCount: number;
  /** Holdings whose FX rate could not be fetched; their FX change defaulted to 0. */
  missingFxCount: number;
  lastUpdated: number | null;
  estimateState: EstimateState;
  currencyChanges: Record<string, number>;
  /** Date-aligned server estimates; no independent browser estimate. */
  projections: FundEstimateResult | null;
}


export function useQuotes(funds: Fund[] = FUNDS, loadFundReturns = false, enabled = true) {
  const [fundEstimates, setFundEstimates] = useState<FundEstimate[]>([]);
  const [fxRates, setFxRates] = useState<Map<string, FxRateData>>(new Map());
  const [marketStates, setMarketStates] = useState<Map<string, MarketStateData>>(new Map());
  const [fundLoading, setFundLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastKey = useRef('');
  const hasData = useRef(false);
  const statesRef = useRef(new Map<string, MarketStateData>());
  const quotes = useRef(new Map<string, QuoteData>()).current;

  useEffect(() => {
    if (!enabled) { setFundLoading(false); return; }
    let cancelled = false;
    const codes = funds.map(fund => fund.code);
    const key = codes.join(',');
    const symbols = funds.flatMap(fund => fund.holdings.map(holding => holding.sinaSymbol));
    async function load(initial = false) {
      if (initial) setFundLoading(!hasData.current || lastKey.current !== key);
      if (!codes.length) {
        setFundEstimates([]);
        setFundLoading(false);
        return;
      }
      try {
        const snapshot = await fetchFundCardSnapshot(codes);
        const returns = loadFundReturns ? await fetchFundReturnSummaries(codes) : new Map<string, FundReturnSummary>();
        if (cancelled) return;
        setFxRates(snapshot.fxRates);
        setMarketStates(snapshot.marketStates);
        statesRef.current = snapshot.marketStates;
        setFundEstimates(funds.map(fund => {
          const card = snapshot.cards.get(fund.code);
          const projections = card?.estimate ?? null;
          const active = projections?.preview ?? projections?.pending;
          return {
            fundCode:fund.code, fundName:fund.name, fund,
            officialNAV:card?.official ? {...card.official, name:fund.name} : null,
            purchaseStatus:null, rangeReturns:returns.get(fund.code) ?? null,
            computedChangeLocal:active?.localChangePercent ?? 0, estimatedNAVLocal:null,
            computedChange:active?.holdingContributionPercent ?? 0, estimatedNAV:null,
            normalizedChangeLocal:active?.localChangePercent ?? 0,
            normalizedChange:active?.changePercent ?? 0,
            normalizedNAVLocal:active?.estimatedNav ?? null, normalizedNAV:active?.estimatedNav ?? null,
            holdingsQuotes:[], totalConfiguredWeight:0, quoteCoverage:active?.coverage ?? 0,
            missingQuoteCount:active?.missingQuoteCount ?? 0, staleQuoteCount:0, missingFxCount:0,
            lastUpdated:active?.quoteAsOf ?? active?.asOf ?? null,
            estimateState:active?.phase ?? 'CLOSED', currencyChanges:{}, projections,
          };
        }));
        hasData.current = true;
        lastKey.current = key;
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '基金数据加载失败');
      } finally {
        if (!cancelled) setFundLoading(false);
      }
    }
    void load(true);
    const stopPolling = startAdaptivePolling(() => load(), () => pickPollInterval(symbols, statesRef.current));
    return () => { cancelled = true; stopPolling(); };
  }, [enabled, funds, loadFundReturns]);

  return {quotes, fundEstimates, fxRates, marketStates, loading:fundLoading, marketLoading:false, fundLoading, error};
}
