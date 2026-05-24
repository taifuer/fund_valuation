import { useState, useEffect, useRef } from 'react';
import type { QuoteData, FundNavData, FxRateData, Fund, FundPurchaseData, FundReturnSummary } from '../types';
import {
  fetchAllQuotes,
  fetchFundNavs,
  fetchSinaFundNavs,
  fetchFundHistory,
  fetchFundHoldings,
  fetchFundProfiles,
  fetchFundPurchaseStatuses,
  fetchFundReturnSummaries,
  fetchFxRates,
} from '../api';
import { INDICES, MARKET_ASSETS, ETF_ASSETS, FUNDS } from '../constants';
import { getMarketState } from '../marketHours';

const DISPLAY_FX_CURRENCIES = ['USD', 'EUR', 'JPY', 'KRW', 'HKD'];
type EstimateState = 'LIVE' | 'PRE' | 'POST' | 'PARTIAL' | 'CLOSED';

export interface FundEstimate {
  fundCode: string;
  fundName: string;
  fund: Fund;
  officialNAV: FundNavData | null;
  purchaseStatus: FundPurchaseData | null;
  rangeReturns: FundReturnSummary | null;
  computedChangeLocal: number;
  estimatedNAVLocal: number | null;
  computedChange: number;
  estimatedNAV: number | null;
  holdingsQuotes: QuoteData[];
  totalConfiguredWeight: number;
  quoteCoverage: number;
  missingQuoteCount: number;
  lastUpdated: number | null;
  estimateState: EstimateState;
  currencyChanges: Record<string, number>;
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

export function useQuotes(funds: Fund[] = FUNDS) {
  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map());
  const [fundEstimates, setFundEstimates] = useState<FundEstimate[]>([]);
  const [fxRates, setFxRates] = useState<Map<string, FxRateData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function load(showLoading = false) {
      if (showLoading) setLoading(true);
      setError(null);

      const indexSymbols = INDICES.map((i) => i.sinaSymbol);
      const assetSymbols = MARKET_ASSETS.map((i) => i.sinaSymbol);
      const etfSymbols = ETF_ASSETS.map((i) => i.sinaSymbol);
      const futuresSymbols = INDICES.flatMap((i) => i.futures?.sinaSymbol ?? []);

      const dynamicHoldingCodes = funds
        .filter((f) => f.holdings.length === 0)
        .map((f) => f.code);
      const dynamicProfileCodes = funds
        .filter((f) => !f.profile)
        .map((f) => f.code);
      const [dynamicHoldings, dynamicProfiles] = await Promise.all([
        fetchFundHoldings(dynamicHoldingCodes),
        fetchFundProfiles(dynamicProfileCodes),
      ]);
      const effectiveFunds = funds.map((fund) => {
        const profile = fund.profile ?? dynamicProfiles.get(fund.code);
        if (fund.holdings.length > 0) return profile && !fund.profile ? { ...fund, profile } : fund;
        const holdings = dynamicHoldings.get(fund.code) ?? [];
        return holdings.length > 0 || (profile && !fund.profile)
          ? { ...fund, holdings: holdings.length > 0 ? holdings : fund.holdings, profile }
          : fund;
      });

      const holdingSymbols = effectiveFunds.flatMap((f) =>
        f.holdings.map((h) => h.sinaSymbol),
      ).filter(Boolean);
      const allSinaSymbols = [...new Set([...indexSymbols, ...futuresSymbols, ...assetSymbols, ...etfSymbols, ...holdingSymbols])];

      try {
        const fundCodes = effectiveFunds.map((f) => f.code);
        const holdingCurrencies = effectiveFunds.flatMap((f) => f.holdings.map((h) => h.currency));
        const currencies = [...new Set([...DISPLAY_FX_CURRENCIES, ...holdingCurrencies])];
        const [quotesData, navsData, historyData, purchaseStatuses, returnSummaries, fxRates] = await Promise.all([
          fetchAllQuotes(allSinaSymbols),
          fetchFundNavs(fundCodes),
          fetchFundHistory(fundCodes),
          fetchFundPurchaseStatuses(fundCodes),
          fetchFundReturnSummaries(fundCodes),
          fetchFxRates(currencies),
        ]);

        if (!mountedRef.current) return;

        // Fallback: fetch missing fund NAVs from Sina
        const missingCodes = fundCodes.filter((c) => !navsData.has(c));
        if (missingCodes.length > 0) {
          const sinaNavs = await fetchSinaFundNavs(missingCodes);
          for (const [code, nav] of sinaNavs) {
            if (!navsData.has(code)) {
              // Try to get officialChange from history
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

        if (!mountedRef.current) return;
        setQuotes(quotesData);
        setFxRates(fxRates);

        const now = new Date();
        const fundFxRates = new Map(
          [...fxRates].map(([currency, rate]) => [currency, normalizeFundFxRate(rate)]),
        );

        const estimates: FundEstimate[] = effectiveFunds.map((fund) => {
          const officialNAV = navsData.get(fund.code) ?? null;
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

          const computedChangeLocal =
            holdingsQuotes.length > 0
              ? fund.holdings.reduce((sum, h) => {
                  const q = fundQuotes.get(h.sinaSymbol);
                  return q ? sum + fundQuoteChangePercent(q, now) * h.weight : sum;
                }, 0)
              : 0;

          const computedChange =
            holdingsQuotes.length > 0
              ? fund.holdings.reduce((sum, h) => {
                  const q = fundQuotes.get(h.sinaSymbol);
                  if (!q) return sum;
                  const fxChange = fundFxRates.get(h.currency)?.changePercent ?? 0;
                  const quoteChange = fundQuoteChangePercent(q, now);
                  const rmbChange = ((1 + quoteChange / 100) * (1 + fxChange / 100) - 1) * 100;
                  return sum + rmbChange * h.weight;
                }, 0)
              : 0;
          const hasLiveHolding = fund.holdings.some((h) => getMarketState(h.sinaSymbol, now) === 'live');
          const fresh = lastUpdated != null && now.getTime() - lastUpdated < 90_000;
          const effectiveSessions = holdingsQuotes.map((q) => fundQuoteSession(q, now));
          const estimateState: EstimateState = fresh && effectiveSessions.some((session) => session === 'pre')
            ? 'PRE'
            : fresh && effectiveSessions.some((session) => session === 'post')
              ? 'POST'
              : hasLiveHolding && fresh
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

          return {
            fundCode: fund.code,
            fundName: fund.name,
            fund,
            officialNAV,
            purchaseStatus: purchaseStatuses.get(fund.code) ?? null,
            rangeReturns: returnSummaries.get(fund.code) ?? null,
            computedChangeLocal,
            estimatedNAVLocal,
            computedChange,
            estimatedNAV,
            holdingsQuotes,
            totalConfiguredWeight,
            quoteCoverage,
            missingQuoteCount,
            lastUpdated,
            estimateState,
            currencyChanges: Object.fromEntries(
              [...fundFxRates].map(([currency, rate]) => [currency, rate.changePercent]),
            ),
          };
        });

        setFundEstimates(estimates);
      } catch (e) {
        if (mountedRef.current) {
          setError(e instanceof Error ? e.message : '数据加载失败');
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    }

    load(true);
    const timer = window.setInterval(() => load(false), 30_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [funds]);

  return { quotes, fundEstimates, fxRates, loading, error };
}
