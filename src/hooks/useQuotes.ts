import { useState, useEffect, useRef } from 'react';
import type { QuoteData, FundNavData, FxRateData, Fund, FundPurchaseData, FundReturnSummary, MarketStateData } from '../types';
import {
  fetchAllQuotes,
  fetchDashboardSnapshot,
  fetchFundNavs,
  fetchSinaFundNavs,
  fetchFundHistory,
  fetchFundHoldings,
  fetchFundProfiles,
  fetchFundPurchaseStatuses,
  fetchFundReturnSummaries,
  fetchFxRates,
  fetchMarketStates,
} from '../api';
import { INDICES, MARKET_ASSETS, ETF_ASSETS, FUNDS } from '../constants';
import { getMarketState, marketLocalDate, quoteIsAfterNavClose, pickPollInterval } from '../marketHours';
import { startAdaptivePolling } from '../polling';

const DISPLAY_FX_CURRENCIES = ['USD', 'EUR', 'JPY', 'KRW', 'HKD'];
type EstimateState = 'LIVE' | 'PRE' | 'POST' | 'PARTIAL' | 'CLOSED';
const SLOW_DATA_TTL_MS = 5 * 60 * 1000;

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
  /** Coverage-normalized change = computedChange / quoteCoverage. This is the
   *  estimate the UI displays as the headline, matching the backend backtest's
   *  `normalizedChange` (predicted / covered_weight). Without normalization a
   *  fund whose top-10 covers only ~73% would systematically understate moves
   *  by ~1/0.73. */
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
}

interface SlowFundData {
  navs: Map<string, FundNavData>;
  purchaseStatuses: Map<string, FundPurchaseData>;
  returnSummaries: Map<string, FundReturnSummary>;
}

function usMarketClock(now = new Date()): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    hour12: false,
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    weekday: value('weekday'),
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

function isWeekday(weekday: string): boolean {
  return weekday !== 'Sat' && weekday !== 'Sun';
}

function shouldUseUsExtendedForFundEstimate(quote: QuoteData, now = new Date()): boolean {
  if (!quote.symbol.startsWith('gb_')) return true;
  if (quote.session === 'pre') {
    const local = usMarketClock(now);
    return isWeekday(local.weekday) && local.minutes >= 4 * 60 && local.minutes < 9 * 60 + 30;
  }
  if (quote.session === 'post') {
    const local = usMarketClock(now);
    return isWeekday(local.weekday) && local.minutes >= 16 * 60 && local.minutes <= 20 * 60 + 15;
  }
  return true;
}

function fundQuoteChangePercent(quote: QuoteData, now = new Date()): number {
  if ((quote.session === 'pre' || quote.session === 'post') && !shouldUseUsExtendedForFundEstimate(quote, now)) {
    return quote.regularChangePercent ?? quote.changePercent;
  }
  return quote.changePercent;
}

function fundQuoteSession(quote: QuoteData, now = new Date()): QuoteData['session'] {
  if ((quote.session === 'pre' || quote.session === 'post') && !shouldUseUsExtendedForFundEstimate(quote, now)) {
    return 'regular';
  }
  return quote.session;
}

function normalizeFundQuote(quote: QuoteData, now = new Date()): QuoteData {
  if ((quote.session === 'pre' || quote.session === 'post') && !shouldUseUsExtendedForFundEstimate(quote, now)) {
    const regularPrice = quote.regularPrice ?? quote.price;
    const regularChangePercent = quote.regularChangePercent ?? quote.changePercent;
    return {
      ...quote,
      price: regularPrice,
      changePercent: regularChangePercent,
      change: Number((regularPrice - quote.previousClose).toFixed(2)),
      session: 'regular',
      time: quote.regularTime ?? quote.time,
    };
  }
  return quote;
}

function normalizeFundFxRate(rate: FxRateData): FxRateData {
  // Sina FX does not provide a separate regular/pre/post split. Keep a dedicated
  // valuation path so fund estimates can diverge from header display if the FX
  // source is later switched to official or settled valuation rates.
  return rate;
}

function fundCacheKey(funds: Fund[]): string {
  return funds
    .map((fund) => `${fund.code}:${fund.name}:${fund.holdings.length}:${fund.profile ? '1' : '0'}`)
    .join('|');
}

export function useQuotes(
  funds: Fund[] = FUNDS,
  loadFundDetails = false,
  loadFundReturns = false,
  enabled = true,
) {
  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map());
  const [fundEstimates, setFundEstimates] = useState<FundEstimate[]>([]);
  const [fxRates, setFxRates] = useState<Map<string, FxRateData>>(new Map());
  const [marketStates, setMarketStates] = useState<Map<string, MarketStateData>>(new Map());
  const [marketLoading, setMarketLoading] = useState(true);
  const [fundLoading, setFundLoading] = useState(true);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [fundError, setFundError] = useState<string | null>(null);
  const slowFundDataRef = useRef<SlowFundData>({
    navs: new Map(),
    purchaseStatuses: new Map(),
    returnSummaries: new Map(),
  });
  const fundNavFetchedAtRef = useRef(0);
  const fundPurchaseFetchedAtRef = useRef(0);
  const fundReturnFetchedAtRef = useRef(0);
  const effectiveFundsRef = useRef<Fund[] | null>(null);
  const dynamicHoldingsFetchedAtRef = useRef<Map<string, number>>(new Map());
  const dynamicProfilesFetchedAtRef = useRef<Map<string, number>>(new Map());
  const fundCacheKeyRef = useRef('');
  // Mirror of marketStates state for use inside polling timers (which close
  // over the ref, not the state, so they see the latest value without restart).
  const marketStatesRef = useRef<Map<string, MarketStateData>>(new Map());

  useEffect(() => {
    // Per-invocation cancellation flag. Unlike a shared mountedRef, this is
    // flipped by cleanup on every dep change, so an in-flight fetch from the
    // previous invocation cannot overwrite fresh state after the new one starts.
    let cancelled = false;
    if (!enabled) {
      setMarketLoading(false);
      setFundLoading(false);
      return () => {
        cancelled = true;
      };
    }
    const currentFundKey = fundCacheKey(funds);
    const fundsChanged = fundCacheKeyRef.current !== currentFundKey;
    const hasMarketSnapshot = quotes.size > 0;
    const hasFundSnapshot = fundEstimates.length > 0;
    if (fundsChanged) {
      slowFundDataRef.current = {
        navs: new Map(),
        purchaseStatuses: new Map(),
        returnSummaries: new Map(),
      };
      fundNavFetchedAtRef.current = 0;
      fundPurchaseFetchedAtRef.current = 0;
      fundReturnFetchedAtRef.current = 0;
      effectiveFundsRef.current = null;
      dynamicHoldingsFetchedAtRef.current = new Map();
      dynamicProfilesFetchedAtRef.current = new Map();
      fundCacheKeyRef.current = currentFundKey;
    }
    const indexSymbols = INDICES.map((i) => i.sinaSymbol);
    const assetSymbols = MARKET_ASSETS.map((i) => i.sinaSymbol);
    const etfSymbols = ETF_ASSETS.map((i) => i.sinaSymbol);
    const futuresSymbols = INDICES.flatMap((i) => i.futures?.sinaSymbol ?? []);
    const marketSymbols = [...new Set([
      ...indexSymbols,
      ...futuresSymbols,
      ...assetSymbols,
      ...etfSymbols,
    ])];

    async function resolveEffectiveFunds(): Promise<Fund[]> {
      const now = Date.now();
      const cachedFunds = effectiveFundsRef.current ?? funds;
      const dynamicHoldingCodes = cachedFunds
        .filter((f) => f.holdings.length === 0)
        .filter((f) => now - (dynamicHoldingsFetchedAtRef.current.get(f.code) ?? 0) > SLOW_DATA_TTL_MS)
        .map((f) => f.code);
      const dynamicProfileCodes = loadFundDetails
        ? cachedFunds
            .filter((f) => !f.profile)
            .filter((f) => now - (dynamicProfilesFetchedAtRef.current.get(f.code) ?? 0) > SLOW_DATA_TTL_MS)
            .map((f) => f.code)
        : [];
      const [dynamicHoldings, dynamicProfiles] = await Promise.all([
        fetchFundHoldings(dynamicHoldingCodes, true),
        fetchFundProfiles(dynamicProfileCodes, true),
      ]);
      dynamicHoldingCodes.forEach((code) => dynamicHoldingsFetchedAtRef.current.set(code, now));
      dynamicProfileCodes.forEach((code) => dynamicProfilesFetchedAtRef.current.set(code, now));
      const effectiveFunds = cachedFunds.map((fund) => {
        const profile = fund.profile ?? dynamicProfiles.get(fund.code);
        if (fund.holdings.length > 0) return profile && !fund.profile ? { ...fund, profile } : fund;
        const holdings = dynamicHoldings.get(fund.code) ?? [];
        return holdings.length > 0 || (profile && !fund.profile)
          ? { ...fund, holdings: holdings.length > 0 ? holdings : fund.holdings, profile }
          : fund;
      });
      effectiveFundsRef.current = effectiveFunds;
      return effectiveFunds;
    }

    async function loadSlowFundData(effectiveFunds: Fund[], force = false): Promise<SlowFundData> {
      const now = Date.now();
      const fundCodes = effectiveFunds.map((f) => f.code);
      const current = slowFundDataRef.current;
      const missingNavCodes = fundCodes.filter((code) => !current.navs.has(code));
      const shouldFetchNavs = (
        force ||
        fundNavFetchedAtRef.current === 0 ||
        now - fundNavFetchedAtRef.current > SLOW_DATA_TTL_MS ||
        missingNavCodes.length > 0
      );
      const shouldFetchPurchase = (
        loadFundDetails &&
        (
          force ||
          fundPurchaseFetchedAtRef.current === 0 ||
          now - fundPurchaseFetchedAtRef.current > SLOW_DATA_TTL_MS
        )
      );
      const shouldLoadReturns = loadFundDetails || loadFundReturns;
      const shouldFetchReturns = (
        shouldLoadReturns &&
        (
          force ||
          fundReturnFetchedAtRef.current === 0 ||
          now - fundReturnFetchedAtRef.current > SLOW_DATA_TTL_MS
        )
      );
      if (!shouldFetchNavs && !shouldFetchPurchase && !shouldFetchReturns) return current;

      const [navsData, historyData, purchaseStatuses, returnSummaries] = await Promise.all([
        shouldFetchNavs ? fetchFundNavs(fundCodes) : Promise.resolve(new Map(current.navs)),
        shouldFetchNavs ? fetchFundHistory(fundCodes) : Promise.resolve(new Map<string, { navDate: string; nav: number; officialChange: number }>()),
        shouldFetchPurchase ? fetchFundPurchaseStatuses(fundCodes) : Promise.resolve(new Map(current.purchaseStatuses)),
        shouldFetchReturns ? fetchFundReturnSummaries(fundCodes) : Promise.resolve(new Map(current.returnSummaries)),
      ]);

      if (cancelled) return slowFundDataRef.current;

      // Fallback: fetch missing fund NAVs from Sina.
      const missingCodes = shouldFetchNavs ? fundCodes.filter((c) => !navsData.has(c)) : [];
      if (missingCodes.length > 0) {
        const sinaNavs = await fetchSinaFundNavs(missingCodes);
        for (const [code, nav] of sinaNavs) {
          if (!navsData.has(code)) {
            const hist = historyData.get(code);
            navsData.set(code, { ...nav, officialChange: hist?.officialChange ?? 0 });
          }
        }
      }

      // Merge official NAV history. The fundnav endpoint may lag behind
      // East Money history, so prefer history when it has a newer NAV date.
      // If fundnav is newer than the local history cache, calculate the
      // official daily change against the latest cached history point.
      for (const [code, hist] of historyData) {
        const existing = navsData.get(code);
        if (existing) {
          const historyIsNewer = hist.navDate && (!existing.navDate || hist.navDate > existing.navDate);
          const fundNavIsNewer = existing.navDate && hist.navDate && existing.navDate > hist.navDate;
          const officialChange = fundNavIsNewer && existing.nav > 0 && hist.nav > 0
            ? Number((((existing.nav - hist.nav) / hist.nav) * 100).toFixed(2))
            : hist.officialChange;
          navsData.set(code, {
            ...existing,
            navDate: historyIsNewer ? hist.navDate : existing.navDate,
            nav: historyIsNewer ? hist.nav : existing.nav,
            officialChange,
          });
        }
      }

      slowFundDataRef.current = {
        navs: new Map([...current.navs, ...navsData]),
        purchaseStatuses: new Map([...current.purchaseStatuses, ...purchaseStatuses]),
        returnSummaries: new Map([...current.returnSummaries, ...returnSummaries]),
      };
      if (shouldFetchNavs) fundNavFetchedAtRef.current = Date.now();
      if (shouldFetchPurchase) fundPurchaseFetchedAtRef.current = Date.now();
      if (shouldFetchReturns) fundReturnFetchedAtRef.current = Date.now();
      return slowFundDataRef.current;
    }

    async function loadMarket(showLoading = false) {
      if (showLoading) setMarketLoading(true);
      setMarketError(null);

      try {
        const snapshot = await fetchDashboardSnapshot(marketSymbols, DISPLAY_FX_CURRENCIES);
        const [marketQuotes, displayFxRates, marketStatesData] = snapshot && snapshot.quotes.size > 0
          ? [snapshot.quotes, snapshot.fxRates, snapshot.marketStates]
          : await Promise.all([
              fetchAllQuotes(marketSymbols),
              fetchFxRates(DISPLAY_FX_CURRENCIES),
              fetchMarketStates(marketSymbols),
            ]);

        if (cancelled) return;
        setQuotes((prev) => {
          const next = new Map(prev);
          for (const symbol of marketSymbols) {
            if (!marketQuotes.has(symbol)) next.delete(symbol);
          }
          for (const [symbol, quote] of marketQuotes) {
            next.set(symbol, quote);
          }
          return next;
        });
        setFxRates((prev) => new Map([...prev, ...displayFxRates]));
        const mergedStates = new Map([...marketStatesRef.current, ...marketStatesData]);
        marketStatesRef.current = mergedStates;
        setMarketStates(mergedStates);
      } catch (e) {
        if (!cancelled) {
          setMarketError(e instanceof Error ? e.message : '市场数据加载失败');
        }
      } finally {
        if (!cancelled) {
          setMarketLoading(false);
        }
      }
    }

    async function loadFunds(showLoading = false) {
      if (showLoading) setFundLoading(true);
      setFundError(null);

      try {
        const effectiveFunds = await resolveEffectiveFunds();
        const holdingSymbols = effectiveFunds.flatMap((f) =>
          f.holdings.map((h) => h.sinaSymbol),
        ).filter(Boolean);
        const allSinaSymbols = [...new Set(holdingSymbols)];
        const holdingCurrencies = effectiveFunds.flatMap((f) => f.holdings.map((h) => h.currency));
        const currencies = [...new Set([...DISPLAY_FX_CURRENCIES, ...holdingCurrencies])];
        const [quotesData, fxRates, marketStatesData, slowFundData] = await Promise.all([
          fetchAllQuotes(allSinaSymbols),
          fetchFxRates(currencies),
          fetchMarketStates(allSinaSymbols),
          loadSlowFundData(effectiveFunds, showLoading),
        ]);

        if (cancelled) return;
        setQuotes((prev) => new Map([...prev, ...quotesData]));
        setFxRates((prev) => new Map([...prev, ...fxRates]));
        const mergedStates = new Map([...marketStatesRef.current, ...marketStatesData]);
        marketStatesRef.current = mergedStates;
        setMarketStates(mergedStates);

        const now = new Date();
        const fundFxRates = new Map(
          [...fxRates].map(([currency, rate]) => [currency, normalizeFundFxRate(rate)]),
        );

        const estimates: FundEstimate[] = effectiveFunds.map((fund) => {
          const officialNAV = slowFundData.navs.get(fund.code) ?? null;
          const hasConfiguredHoldings = fund.holdings.length > 0;
          const rawHoldingsQuotes = fund.holdings
            .map((h) => quotesData.get(h.sinaSymbol))
            .filter((q): q is QuoteData => q != null);
          const holdingsQuotes = rawHoldingsQuotes.map((q) => normalizeFundQuote(q, now));
          const totalConfiguredWeight = fund.holdings.reduce((sum, h) => sum + h.weight, 0);
          const quoteCoverage = fund.holdings.reduce((sum, h) => {
            return quotesData.has(h.sinaSymbol) ? sum + h.weight : sum;
          }, 0);
          const missingQuoteCount = fund.holdings.length - holdingsQuotes.length;
          const lastUpdated = holdingsQuotes.length > 0
            ? Math.max(...holdingsQuotes.map((q) => q.fetchedAt))
            : null;
          const fundQuotes = new Map(holdingsQuotes.map((q) => [q.symbol, q]));

          // Problem 2 — QDII timing alignment. A holding's quote whose market-
          // local information is at or before the official NAV date's regular
          // close has already been baked into that NAV; re-adding its change%
          // would double-count the prior session's move. We count a quote only
          // if it reflects information strictly AFTER navDate's regular close:
          //   - trading day strictly after navDate, OR
          //   - trading day == navDate but the quote time is after the regular
          //     close (after-hours session) — this is a leading signal for the
          //     next NAV and must not be dropped.
          // When the decision can't be made reliably (unknown market, no time,
          // unreliable date) we conservatively keep the quote.
          const navDate = officialNAV?.navDate ?? '';
          const quoteIsAfterNav = (h: { sinaSymbol: string }) => {
            const q = fundQuotes.get(h.sinaSymbol);
            if (!q || !navDate) return true;
            if (!q.time || q.dateReliable === false) return true;
            const decision = quoteIsAfterNavClose(h.sinaSymbol, q.time, navDate);
            return decision == null ? true : decision;
          };
          let staleQuoteCount = 0;
          let missingFxCount = 0;

          const computedChangeLocal =
            holdingsQuotes.length > 0
              ? fund.holdings.reduce((sum, h) => {
                  const q = fundQuotes.get(h.sinaSymbol);
                  if (!q) return sum;
                  if (!quoteIsAfterNav(h)) { staleQuoteCount += 1; return sum; }
                  return sum + fundQuoteChangePercent(q, now) * h.weight;
                }, 0)
              : 0;

          const computedChange =
            holdingsQuotes.length > 0
              ? fund.holdings.reduce((sum, h) => {
                  const q = fundQuotes.get(h.sinaSymbol);
                  if (!q) return sum;
                  if (!quoteIsAfterNav(h)) return sum; // counted in staleQuoteCount above
                  const fxRate = fundFxRates.get(h.currency);
                  if (!fxRate && h.currency !== 'CNY') missingFxCount += 1;
                  const fxChange = fxRate?.changePercent ?? 0;
                  const quoteChange = fundQuoteChangePercent(q, now);
                  const rmbChange = ((1 + quoteChange / 100) * (1 + fxChange / 100) - 1) * 100;
                  return sum + rmbChange * h.weight;
                }, 0)
              : 0;

          // Normalize by covered weight so a partial-holdings estimate scales
          // to the full fund. coveredWeight here counts only holdings that
          // contributed a fresh (after-navDate) quote, so the projection is
          // over the genuinely-informative portion. Mirrors the backend
          // backtest's normalizedChange = predicted / covered_weight.
          const coveredWeightLocal = fund.holdings.reduce((sum, h) => {
            return fundQuotes.has(h.sinaSymbol) && quoteIsAfterNav(h) ? sum + h.weight : sum;
          }, 0);
          const normalizedChangeLocal = coveredWeightLocal > 0
            ? computedChangeLocal / coveredWeightLocal
            : computedChangeLocal;
          const normalizedChange = coveredWeightLocal > 0
            ? computedChange / coveredWeightLocal
            : computedChange;
          const hasLiveHolding = fund.holdings.some((h) => (
            marketStatesData.get(h.sinaSymbol)?.state ?? getMarketState(h.sinaSymbol, now)
          ) === 'live');
          const fresh = lastUpdated != null && now.getTime() - lastUpdated < 90_000;
          const effectiveSessions = holdingsQuotes.map((q) => fundQuoteSession(q, now));
          const hasFreshQuoteAfterNav = fund.holdings.some((h) => quoteIsAfterNav(h));
          const estimateState: EstimateState = fresh && effectiveSessions.some((session) => session === 'pre')
            ? 'PRE'
            : fresh && effectiveSessions.some((session) => session === 'post')
              ? 'POST'
              : hasLiveHolding && fresh && hasFreshQuoteAfterNav
                ? (missingQuoteCount > 0 ? 'PARTIAL' : 'LIVE')
                : 'CLOSED';

          const estimatedNAVLocal =
            hasConfiguredHoldings && officialNAV && officialNAV.nav > 0
              ? officialNAV.nav * (1 + computedChangeLocal / 100)
              : null;

          const estimatedNAV =
            hasConfiguredHoldings && officialNAV && officialNAV.nav > 0
              ? officialNAV.nav * (1 + computedChange / 100)
              : null;

          // Headline (coverage-normalized) estimates — what the UI displays.
          const normalizedNAVLocal =
            hasConfiguredHoldings && officialNAV && officialNAV.nav > 0
              ? officialNAV.nav * (1 + normalizedChangeLocal / 100)
              : null;

          const normalizedNAV =
            hasConfiguredHoldings && officialNAV && officialNAV.nav > 0
              ? officialNAV.nav * (1 + normalizedChange / 100)
              : null;

          return {
            fundCode: fund.code,
            fundName: fund.name,
            fund,
            officialNAV,
            purchaseStatus: slowFundData.purchaseStatuses.get(fund.code) ?? null,
            rangeReturns: slowFundData.returnSummaries.get(fund.code) ?? null,
            computedChangeLocal,
            estimatedNAVLocal,
            computedChange,
            estimatedNAV,
            normalizedChangeLocal,
            normalizedChange,
            normalizedNAVLocal,
            normalizedNAV,
            holdingsQuotes,
            totalConfiguredWeight,
            quoteCoverage,
            missingQuoteCount,
            staleQuoteCount,
            missingFxCount,
            lastUpdated,
            estimateState,
            currencyChanges: Object.fromEntries(
              [...fundFxRates].map(([currency, rate]) => [currency, rate.changePercent]),
            ),
          };
        });

        setFundEstimates(estimates);
      } catch (e) {
        if (!cancelled) {
          setFundError(e instanceof Error ? e.message : '数据加载失败');
        }
      } finally {
        if (!cancelled) {
          setFundLoading(false);
        }
      }
    }

    loadMarket(fundsChanged || !hasMarketSnapshot);
    const fundTimer0 = window.setTimeout(() => {
      if (!cancelled) void loadFunds(fundsChanged || !hasFundSnapshot);
    }, 0);
    const fundSymbols = effectiveFundsRef.current?.flatMap((f) => f.holdings.map((h) => h.sinaSymbol)).filter(Boolean) ?? [];
    const allPollSymbols = [...marketSymbols, ...fundSymbols];
    const stopPolling = startAdaptivePolling(
      () => Promise.all([loadMarket(false), loadFunds(false)]),
      () => pickPollInterval(allPollSymbols, marketStatesRef.current),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(fundTimer0);
      stopPolling();
    };
  }, [enabled, funds, loadFundDetails, loadFundReturns]);

  return {
    quotes,
    fundEstimates,
    fxRates,
    marketStates,
    loading: marketLoading && fundLoading,
    marketLoading,
    fundLoading,
    error: marketError ?? fundError,
  };
}
