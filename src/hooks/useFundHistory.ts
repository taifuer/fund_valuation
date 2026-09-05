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
  loadedAt: number;
}

const historyCache = new Map<string, CacheEntry>();
const pendingHistory = new Map<string, Promise<FundHistoryPoint[]>>();
const CACHE_TTL_MS = 5 * 60 * 1000;

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
      if (Date.now() - current.loadedAt < CACHE_TTL_MS) return;
    } else {
      setHistory([]);
      setLoading(true);
    }

    setError(null);
    const key = `${fundCode}:${targetSize}`;
    let pending = pendingHistory.get(key);
    if (!pending) {
      pending = fetchFundHistorySeries(fundCode, targetSize).then(data => {
        if (data.length > 0) historyCache.set(fundCode, { data, targetSize, loadedAt: Date.now() });
        return data;
      }).finally(() => pendingHistory.delete(key));
      pendingHistory.set(key, pending);
    }
    pending
      .then((data) => {
        if (cancelled) return;
        if (data.length > 0 || !current?.data.length) setHistory(data);
        setError(data.length > 0 ? null : current?.data.length
          ? '历史净值刷新失败，当前显示已缓存数据' : '暂无历史净值');
      })
      .catch(() => {
        if (!cancelled) setError(current?.data.length
          ? '历史净值刷新失败，当前显示已缓存数据' : '历史净值加载失败');
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
