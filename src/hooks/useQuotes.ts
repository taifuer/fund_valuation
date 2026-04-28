import { useState, useEffect, useRef } from 'react';
import type { QuoteData, FundNavData } from '../types';
import { fetchAllQuotes, fetchFundNavs, fetchSinaFundNavs, fetchFundHistory } from '../api';
import { INDICES, FUNDS } from '../constants';

export interface FundEstimate {
  fundCode: string;
  fundName: string;
  officialNAV: FundNavData | null;
  computedChange: number;
  estimatedNAV: number | null;
  holdingsQuotes: QuoteData[];
}

export function useQuotes() {
  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map());
  const [fundEstimates, setFundEstimates] = useState<FundEstimate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function load() {
      setLoading(true);
      setError(null);

      const indexSymbols = INDICES.map((i) => i.sinaSymbol);
      const holdingSymbols = FUNDS.flatMap((f) =>
        f.holdings.map((h) => h.sinaSymbol),
      );
      const allSinaSymbols = [...new Set([...indexSymbols, ...holdingSymbols])];

      try {
        const fundCodes = FUNDS.map((f) => f.code);
        const [quotesData, navsData, historyData] = await Promise.all([
          fetchAllQuotes(allSinaSymbols),
          fetchFundNavs(fundCodes),
          fetchFundHistory(fundCodes),
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

        const estimates: FundEstimate[] = FUNDS.map((fund) => {
          const officialNAV = navsData.get(fund.code) ?? null;
          const holdingsQuotes = fund.holdings
            .map((h) => quotesData.get(h.sinaSymbol))
            .filter((q): q is QuoteData => q != null);

          const computedChange =
            holdingsQuotes.length > 0
              ? fund.holdings.reduce((sum, h) => {
                  const q = quotesData.get(h.sinaSymbol);
                  return sum + (q?.changePercent ?? 0) * h.weight;
                }, 0)
              : 0;

          const estimatedNAV =
            officialNAV && officialNAV.nav > 0
              ? officialNAV.nav * (1 + computedChange / 100)
              : null;

          return {
            fundCode: fund.code,
            fundName: fund.name,
            officialNAV,
            computedChange,
            estimatedNAV,
            holdingsQuotes,
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

    load();
    return () => { mountedRef.current = false; };
  }, []);

  return { quotes, fundEstimates, loading, error };
}
