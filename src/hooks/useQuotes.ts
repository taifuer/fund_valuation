import { useState, useEffect, useRef } from 'react';
import type { QuoteData, FundNavData, FxRateData } from '../types';
import { fetchAllQuotes, fetchFundNavs, fetchSinaFundNavs, fetchFundHistory, fetchFxRates } from '../api';
import { INDICES, MARKET_ASSETS, FUNDS } from '../constants';

export interface FundEstimate {
  fundCode: string;
  fundName: string;
  officialNAV: FundNavData | null;
  computedChangeLocal: number;
  estimatedNAVLocal: number | null;
  computedChange: number;
  estimatedNAV: number | null;
  holdingsQuotes: QuoteData[];
  totalConfiguredWeight: number;
  quoteCoverage: number;
  missingQuoteCount: number;
  lastUpdated: number | null;
  currencyChanges: Record<string, number>;
}

export function useQuotes() {
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
      const futuresSymbols = INDICES.flatMap((i) => i.futures?.sinaSymbol ?? []);
      const holdingSymbols = FUNDS.flatMap((f) =>
        f.holdings.map((h) => h.sinaSymbol),
      );
      const allSinaSymbols = [...new Set([...indexSymbols, ...futuresSymbols, ...assetSymbols, ...holdingSymbols])];

      try {
        const fundCodes = FUNDS.map((f) => f.code);
        const currencies = [...new Set(FUNDS.flatMap((f) => f.holdings.map((h) => h.currency)))];
        const [quotesData, navsData, historyData, fxRates] = await Promise.all([
          fetchAllQuotes(allSinaSymbols),
          fetchFundNavs(fundCodes),
          fetchFundHistory(fundCodes),
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

        // Merge history data (officialChange) into NAVs from East Money
        for (const [code, hist] of historyData) {
          const existing = navsData.get(code);
          if (existing) {
            navsData.set(code, { ...existing, officialChange: hist.officialChange });
          }
        }

        if (!mountedRef.current) return;
        setQuotes(quotesData);
        setFxRates(fxRates);

        const estimates: FundEstimate[] = FUNDS.map((fund) => {
          const officialNAV = navsData.get(fund.code) ?? null;
          const holdingsQuotes = fund.holdings
            .map((h) => quotesData.get(h.sinaSymbol))
            .filter((q): q is QuoteData => q != null);
          const totalConfiguredWeight = fund.holdings.reduce((sum, h) => sum + h.weight, 0);
          const quoteCoverage = fund.holdings.reduce((sum, h) => {
            return quotesData.has(h.sinaSymbol) ? sum + h.weight : sum;
          }, 0);
          const missingQuoteCount = fund.holdings.length - holdingsQuotes.length;
          const lastUpdated = holdingsQuotes.length > 0
            ? Math.max(...holdingsQuotes.map((q) => q.fetchedAt))
            : null;

          const computedChangeLocal =
            holdingsQuotes.length > 0
              ? fund.holdings.reduce((sum, h) => {
                  const q = quotesData.get(h.sinaSymbol);
                  return q ? sum + q.changePercent * h.weight : sum;
                }, 0)
              : 0;

          const computedChange =
            holdingsQuotes.length > 0
              ? fund.holdings.reduce((sum, h) => {
                  const q = quotesData.get(h.sinaSymbol);
                  if (!q) return sum;
                  const fxChange = fxRates.get(h.currency)?.changePercent ?? 0;
                  const rmbChange = ((1 + q.changePercent / 100) * (1 + fxChange / 100) - 1) * 100;
                  return sum + rmbChange * h.weight;
                }, 0)
              : 0;

          const estimatedNAVLocal =
            officialNAV && officialNAV.nav > 0
              ? officialNAV.nav * (1 + computedChangeLocal / 100)
              : null;

          const estimatedNAV =
            officialNAV && officialNAV.nav > 0
              ? officialNAV.nav * (1 + computedChange / 100)
              : null;

          return {
            fundCode: fund.code,
            fundName: fund.name,
            officialNAV,
            computedChangeLocal,
            estimatedNAVLocal,
            computedChange,
            estimatedNAV,
            holdingsQuotes,
            totalConfiguredWeight,
            quoteCoverage,
            missingQuoteCount,
            lastUpdated,
            currencyChanges: Object.fromEntries(
              [...fxRates].map(([currency, rate]) => [currency, rate.changePercent]),
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
  }, []);

  return { quotes, fundEstimates, fxRates, loading, error };
}
