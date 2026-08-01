import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAllQuotes,
  fetchDashboardSnapshot,
  fetchOverviewSnapshot,
  fetchFundHistory,
  fetchFundNavs,
  fetchFundReturnSummaries,
  fetchFxRates,
  fetchMarketStates,
  fetchSinaFundNavs,
  fetchSystemStatus,
} from '../api';
import { ETF_ASSETS, INDICES, MARKET_ASSETS, RANKING_ETFS, RANKING_INDICES } from '../constants';
import { pickPollInterval } from '../marketHours';
import { startAdaptivePolling } from '../polling';
import type { Fund, FundNavData, FundReturnSummary, FxRateData, MarketStateData, QuoteData, SystemStatus } from '../types';
import type { FundEstimate } from './useQuotes';

const DISPLAY_FX_CURRENCIES = ['USD', 'EUR'];

export function useSystemStatus(enabled = true) {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    async function load() {
      const next = await fetchSystemStatus();
      if (!cancelled) setStatus(next);
    }
    void load();
    const stopPolling = startAdaptivePolling(load, () => 60_000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [enabled]);

  return status;
}

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
    normalizedChangeLocal: 0,
    normalizedChange: 0,
    normalizedNAVLocal: null,
    normalizedNAV: null,
    holdingsQuotes: [],
    totalConfiguredWeight: 0,
    quoteCoverage: 0,
    missingQuoteCount: 0,
    staleQuoteCount: 0,
    missingFxCount: 0,
    lastUpdated: null,
    estimateState: 'CLOSED',
    currencyChanges: {},
    projections: null,
  };
}

export function useHeaderFxRates(enabled = true) {
  const [fxRates, setFxRates] = useState<Map<string, FxRateData>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fxSymbols = DISPLAY_FX_CURRENCIES.map((c) => `fx_s${c.toLowerCase()}cny`);
    async function load() {
      const snapshot = await fetchDashboardSnapshot([], DISPLAY_FX_CURRENCIES);
      const rates = snapshot?.fxRates.size
        ? snapshot.fxRates
        : await fetchFxRates(DISPLAY_FX_CURRENCIES);
      if (!cancelled) setFxRates(rates);
    }

    void load();
    const stopPolling = startAdaptivePolling(load, () => pickPollInterval(fxSymbols, new Map()));
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [enabled]);

  return fxRates;
}

export function useOverviewData(funds: Fund[], enabled: boolean) {
  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map());
  const [fxRates, setFxRates] = useState<Map<string, FxRateData>>(new Map());
  const [marketStates, setMarketStates] = useState<Map<string, MarketStateData>>(new Map());
  const [fundSummaries, setFundSummaries] = useState<Map<string, FundNavData>>(new Map());
  const [loading, setLoading] = useState(false);
  const [fundLoading, setFundLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref mirror of marketStates for the polling timer (sees latest without restart).
  const marketStatesRef = useRef<Map<string, MarketStateData>>(new Map());

  const symbols = useMemo(() => (
    [...new Set([
      ...INDICES.map((item) => item.sinaSymbol),
      ...INDICES.flatMap((item) => item.futures?.sinaSymbol ?? []),
      ...MARKET_ASSETS.map((item) => item.sinaSymbol),
      ...ETF_ASSETS.map((item) => item.sinaSymbol),
    ])]
  ), []);
  const fundKey = useMemo(() => funds.map((fund) => fund.code).join(','), [funds]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setFundLoading(false);
      return;
    }

    let cancelled = false;
    async function loadOverview(showLoading = false) {
      if (showLoading) {
        setLoading(true);
        setFundLoading(true);
      }
      setError(null);
      try {
        const snapshot = await fetchOverviewSnapshot(
          symbols,
          DISPLAY_FX_CURRENCIES,
          funds.map((fund) => fund.code),
        );
        if (cancelled) return;
        if (!snapshot || snapshot.quotes.size === 0) {
          throw new Error('概览行情快照暂不可用');
        }
        setQuotes((prev) => new Map([...prev, ...snapshot.quotes]));
        setFxRates((prev) => new Map([...prev, ...snapshot.fxRates]));
        setMarketStates((prev) => {
          const merged = new Map([...prev, ...snapshot.marketStates]);
          marketStatesRef.current = merged;
          return merged;
        });
        const missingFundCodes = funds
          .map((fund) => fund.code)
          .filter((code) => !snapshot.fundSummaries.has(code));
        if (missingFundCodes.length === 0) {
          setFundSummaries(snapshot.fundSummaries);
        } else {
          const history = await fetchFundHistory(missingFundCodes);
          if (cancelled) return;
          const summaries = new Map(snapshot.fundSummaries);
          for (const fund of funds) {
            const hist = history.get(fund.code);
            if (!hist || summaries.has(fund.code)) continue;
            summaries.set(fund.code, {
              code: fund.code,
              name: fund.name,
              navDate: hist.navDate,
              nav: hist.nav,
              officialChange: hist.officialChange,
              estimatedNav: hist.nav,
              estimatedChange: 0,
            });
          }
          setFundSummaries(summaries);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '概览数据加载失败');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setFundLoading(false);
        }
      }
    }

    void loadOverview(true);
    const stopMarketPolling = startAdaptivePolling(
      () => loadOverview(false),
      () => pickPollInterval(symbols, marketStatesRef.current),
    );
    return () => {
      cancelled = true;
      stopMarketPolling();
    };
  }, [enabled, fundKey, funds, symbols]);

  return { quotes, fxRates, marketStates, fundSummaries, loading, fundLoading, error };
}

export function useRankingMarketData(enabled: boolean) {
  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map());
  const [marketStates, setMarketStates] = useState<Map<string, MarketStateData>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const marketStatesRef = useRef<Map<string, MarketStateData>>(new Map());

  const symbols = useMemo(() => (
    [...new Set([
      ...RANKING_INDICES.map((item) => item.sinaSymbol),
      ...INDICES.flatMap((item) => item.futures?.sinaSymbol ?? []),
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
        setMarketStates((prev) => {
          const merged = new Map([...prev, ...stateData]);
          marketStatesRef.current = merged;
          return merged;
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '收益页行情加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(true);
    const stopPolling = startAdaptivePolling(
      () => load(false),
      () => pickPollInterval(symbols, marketStatesRef.current),
    );
    return () => {
      cancelled = true;
      stopPolling();
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
    const stopPolling = startAdaptivePolling(() => load(false), () => 15 * 60 * 1000);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [enabled, fundKey, funds]);

  return { fundEstimates, loading, error };
}
