import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '../api';
import { ETF_ASSETS, INDICES, MARKET_ASSETS } from '../constants';
import { useOverviewData, useRankingMarketData } from './usePageData';

const apiMocks = vi.hoisted(() => ({
  fetchAllQuotes: vi.fn(),
  fetchDashboardSnapshot: vi.fn(),
  fetchFundHistory: vi.fn(),
  fetchFundNavs: vi.fn(),
  fetchFundReturnSummaries: vi.fn(),
  fetchFxRates: vi.fn(),
  fetchMarketStates: vi.fn(),
  fetchSinaFundNavs: vi.fn(),
  fetchSystemStatus: vi.fn(),
}));

vi.mock('../api', () => apiMocks);

function overviewSnapshot(price: number, generatedAt: number): DashboardSnapshot {
  return {
    generatedAt,
    quotes: new Map([[
      'sh000001',
      {
        symbol: 'sh000001',
        name: '上证指数',
        price,
        previousClose: 3190,
        change: price - 3190,
        changePercent: ((price - 3190) / 3190) * 100,
        time: '2026-08-07 15:00:00',
        fetchedAt: generatedAt,
        dateReliable: true,
      },
    ]]),
    fxRates: new Map(),
    marketStates: new Map(),
  };
}

describe('useOverviewData', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('keeps the previous snapshot visible while refreshing after page re-entry', async () => {
    const initial = overviewSnapshot(3200, 100);
    let finishRefresh: (snapshot: DashboardSnapshot) => void = () => undefined;
    const pendingRefresh = new Promise<DashboardSnapshot>((resolve) => {
      finishRefresh = resolve;
    });
    apiMocks.fetchDashboardSnapshot
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(pendingRefresh);

    const { result, rerender } = renderHook(
      ({ enabled }) => useOverviewData(enabled),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(result.current.quotes.get('sh000001')?.price).toBe(3200));
    expect(result.current.loading).toBe(false);

    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => expect(apiMocks.fetchDashboardSnapshot).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(false);
    expect(result.current.quotes.get('sh000001')?.price).toBe(3200);

    await act(async () => {
      finishRefresh(overviewSnapshot(3210, 200));
      await pendingRefresh;
    });
    await waitFor(() => expect(result.current.quotes.get('sh000001')?.price).toBe(3210));
  });

  it('loads only market symbols and display currencies, including on focus refresh', async () => {
    apiMocks.fetchDashboardSnapshot.mockResolvedValue(overviewSnapshot(3200, 100));
    const { result } = renderHook(() => useOverviewData(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const symbols = [...new Set([
      ...INDICES.map(item => item.sinaSymbol),
      ...INDICES.flatMap(item => item.futures?.sinaSymbol ?? []),
      ...MARKET_ASSETS.map(item => item.sinaSymbol),
      ...ETF_ASSETS.map(item => item.sinaSymbol),
    ])];
    expect(apiMocks.fetchDashboardSnapshot).toHaveBeenCalledWith(symbols, ['USD', 'EUR']);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(apiMocks.fetchDashboardSnapshot).toHaveBeenCalledTimes(2);
    for (const [name, mock] of Object.entries(apiMocks)) {
      if (name !== 'fetchDashboardSnapshot') expect(mock).not.toHaveBeenCalled();
    }
  });

  it('does not request data while inactive or accept an old response after leaving', async () => {
    let finish: (snapshot: DashboardSnapshot) => void = () => undefined;
    const pending = new Promise<DashboardSnapshot>(resolve => { finish = resolve; });
    apiMocks.fetchDashboardSnapshot.mockReturnValue(pending);
    const { result, rerender } = renderHook(
      ({ enabled }) => useOverviewData(enabled),
      { initialProps: { enabled: false } },
    );
    expect(apiMocks.fetchDashboardSnapshot).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(result.current.loading).toBe(true);
    rerender({ enabled: false });
    await act(async () => {
      finish(overviewSnapshot(3200, 100));
      await pending;
      window.dispatchEvent(new Event('focus'));
    });
    expect(apiMocks.fetchDashboardSnapshot).toHaveBeenCalledTimes(1);
    expect(result.current.quotes.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('retains usable market cards after a failed refresh without fund fallbacks', async () => {
    apiMocks.fetchDashboardSnapshot
      .mockResolvedValueOnce(overviewSnapshot(3200, 100))
      .mockResolvedValueOnce(null);
    const { result, rerender } = renderHook(
      ({ enabled }) => useOverviewData(enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.quotes.size).toBe(1));
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.error).toBe('概览行情快照暂不可用'));
    expect(result.current.loading).toBe(false);
    expect(result.current.quotes.get('sh000001')?.price).toBe(3200);
    expect(apiMocks.fetchFundHistory).not.toHaveBeenCalled();
    expect(apiMocks.fetchFundNavs).not.toHaveBeenCalled();
  });

  it('requests SOX spot quotes but excludes archive-only indices', async () => {
    apiMocks.fetchDashboardSnapshot.mockResolvedValue({
      quotes: overviewSnapshot(3200, 1).quotes, marketStates: new Map(),
    });
    renderHook(() => useRankingMarketData(true));
    await waitFor(() => expect(apiMocks.fetchDashboardSnapshot).toHaveBeenCalled());
    const symbols = apiMocks.fetchDashboardSnapshot.mock.calls[0][0] as string[];
    for (const symbol of ['gb_rut', 'gb_oex']) expect(symbols).not.toContain(symbol);
    expect(symbols).toContain('gb_sox');
    expect(symbols).toContain('gb_ndx');
  });
});
