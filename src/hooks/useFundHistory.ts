import { useEffect, useState } from 'react';
import { fetchFundHistorySeries } from '../api';
import type { FundHistoryPoint } from '../types';

interface FundHistoryState {
  history: FundHistoryPoint[];
  loading: boolean;
  error: string | null;
}

interface CacheEntry {
  data: FundHistoryPoint[];
  targetSize: number;
}

const historyCache = new Map<string, CacheEntry>();

export function useFundHistory(fundCode: string, targetSize = 3000): FundHistoryState {
  const cached = historyCache.get(fundCode);
  const hasUsableCache = cached != null && cached.targetSize >= targetSize && cached.data.length > 0;
  const [history, setHistory] = useState<FundHistoryPoint[]>(() => (
    hasUsableCache ? cached.data : []
  ));
  const [loading, setLoading] = useState(!hasUsableCache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const current = historyCache.get(fundCode);
    if (current && current.targetSize >= targetSize && current.data.length > 0) {
      setHistory(current.data);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    fetchFundHistorySeries(fundCode, targetSize)
      .then((data) => {
        if (cancelled) return;
        if (data.length > 0) {
          historyCache.set(fundCode, { data, targetSize });
        }
        setHistory(data);
        setError(data.length > 0 ? null : '暂无历史净值');
      })
      .catch(() => {
        if (!cancelled) setError('历史净值加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fundCode, targetSize]);

  return { history, loading, error };
}
