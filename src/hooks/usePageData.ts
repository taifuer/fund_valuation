import { useEffect, useMemo, useState } from 'react';
import {
  fetchAllQuotes,
  fetchDashboardSnapshot,
  fetchFundHistory,
  fetchFundNavs,
  fetchFundReturnSummaries,
  fetchFxRates,
  fetchMarketStates,
  fetchSinaFundNavs,
} from '../api';
import { MARKET_ASSETS, RANKING_ETFS, RANKING_INDICES } from '../constants';
import type { Fund, FundNavData, FundReturnSummary, FxRateData, MarketStateData, QuoteData } from '../types';
import type { FundEstimate } from './useQuotes';

const DISPLAY_FX_CURRENCIES = ['USD', 'EUR', 'JPY', 'KRW', 'HKD'];

interface FundHistoryNav {
  navDate: string;
  nav: number;
  officialChange: number;
}

function mergeOfficialNavs(
  navsData: Map<string, FundNavData>,
  historyData: Map<string, FundHistoryNav>,
): Map<string, FundNavData> {
  const merged = new Map(navsData);
  for (const [code, hist] of historyData) {
    const existing = merged.get(code);
    if (!existing) {
      continue;
    }

    const historyIsNewer = hist.navDate && (!existing.navDate || hist.navDate > existing.navDate);
    const fundNavIsNewer = existing.navDate && hist.navDate && existing.navDate > hist.navDate;
    const officialChange = fundNavIsNewer && existing.nav > 0 && hist.nav > 0
      ? Number((((existing.nav - hist.nav) / hist.nav) * 100).toFixed(2))
      : hist.officialChange;
    merged.set(code, {
      ...existing,
      navDate: historyIsNewer ? hist.navDate : existing.navDate,
      nav: historyIsNewer ? hist.nav : existing.nav,
      officialChange,
    });
  }
  return merged;
}

function officialNavForFund(
  fund: Fund,
  officialNavs: Map<string, FundNavData>,
  historyData: Map<string, FundHistoryNav>,
): FundNavData | null {
  const nav = officialNavs.get(fund.code);
  if (nav) return nav;
  const hist = historyData.get(fund.code);
  if (!hist) return null;
  return {
    code: fund.code,
    name: fund.name,
    navDate: hist.navDate,
    nav: hist.nav,
    officialChange: hist.officialChange,
    estimatedNav: hist.nav,
    estimatedChange: 0,
  };
}

function emptyFundEstimate(
  fund: Fund,
  officialNAV: FundNavData | null,
  rangeReturns: FundReturnSummary | null,
): FundEstimate {
  return {
    fundCode: fund.code,
    fundName: fund.name,
    fund,
    officialNAV,
    purchaseStatus: null,
    rangeReturns,
    computedChangeLocal: 0,
    estimatedNAVLocal: null,
    computedChange: 0,
    estimatedNAV: null,
    holdingsQuotes: [],
    totalConfiguredWeight: 0,
    quoteCoverage: 0,
    missingQuoteCount: 0,
    lastUpdated: null,
    estimateState: 'CLOSED',
    currencyChanges: {},
  };
}

export function useHeaderFxRates() {
  const [fxRates, setFxRates] = useState<Map<string, FxRateData>>(new Map());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const rates = await fetchFxRates(DISPLAY_FX_CURRENCIES);
      if (!cancelled) setFxRates(rates);
    }

    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return fxRates;
}

export function useRankingMarketData(enabled: boolean) {
  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map());
  const [marketStates, setMarketStates] = useState<Map<string, MarketStateData>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const symbols = useMemo(() => (
    [...new Set([
      ...RANKING_INDICES.map((item) => item.sinaSymbol),
      ...MARKET_ASSETS.map((item) => item.sinaSymbol),
      ...RANKING_ETFS.map((item) => item.sinaSymbol),
    ])]
  ), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    async function load(showLoading = false) {
      if (showLoading) setLoading(true);
      setError(null);
      try {
        const snapshot = await fetchDashboardSnapshot(symbols, []);
        const [quoteData, stateData] = snapshot && snapshot.quotes.size > 0
          ? [snapshot.quotes, snapshot.marketStates]
          : await Promise.all([
              fetchAllQuotes(symbols),
              fetchMarketStates(symbols),
            ]);
        if (cancelled) return;
        setQuotes((prev) => new Map([...prev, ...quoteData]));
        setMarketStates((prev) => new Map([...prev, ...stateData]));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '收益页行情加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(true);
    const timer = window.setInterval(() => load(false), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, symbols]);

  return { quotes, marketStates, loading, error };
}

export function useFundReturnData(funds: Fund[], enabled: boolean) {
  const [fundEstimates, setFundEstimates] = useState<FundEstimate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fundKey = useMemo(() => (
    funds.map((fund) => `${fund.code}:${fund.name}`).join('|')
  ), [funds]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    async function load(showLoading = false) {
      if (showLoading) setLoading(true);
      setError(null);
      const fundCodes = funds.map((fund) => fund.code);
      if (fundCodes.length === 0) {
        setFundEstimates([]);
        setLoading(false);
        return;
      }
      try {
        const [navsData, historyData, returnSummaries] = await Promise.all([
          fetchFundNavs(fundCodes),
          fetchFundHistory(fundCodes),
          fetchFundReturnSummaries(fundCodes),
        ]);

        const missingCodes = fundCodes.filter((code) => !navsData.has(code));
        if (missingCodes.length > 0) {
          const sinaNavs = await fetchSinaFundNavs(missingCodes);
          for (const [code, nav] of sinaNavs) {
            if (!navsData.has(code)) {
              const hist = historyData.get(code);
              navsData.set(code, { ...nav, officialChange: hist?.officialChange ?? 0 });
            }
          }
        }

        if (cancelled) return;
        const officialNavs = mergeOfficialNavs(navsData, historyData);
        setFundEstimates(funds.map((fund) => (
          emptyFundEstimate(
            fund,
            officialNavForFund(fund, officialNavs, historyData),
            returnSummaries.get(fund.code) ?? null,
          )
        )));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '基金收益数据加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(true);
    const timer = window.setInterval(() => load(false), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, fundKey, funds]);

  return { fundEstimates, loading, error };
}
