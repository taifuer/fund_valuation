import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverviewSnapshot } from '../api';
import type { Fund } from '../types';
import { useOverviewData } from './usePageData';

const apiMocks = vi.hoisted(() => ({
  fetchAllQuotes: vi.fn(),
  fetchDashboardSnapshot: vi.fn(),
  fetchOverviewSnapshot: vi.fn(),
  fetchFundHistory: vi.fn(),
  fetchFundNavs: vi.fn(),
  fetchFundReturnSummaries: vi.fn(),
  fetchFxRates: vi.fn(),
  fetchMarketStates: vi.fn(),
  fetchSinaFundNavs: vi.fn(),
  fetchSystemStatus: vi.fn(),
}));

vi.mock('../api', () => apiMocks);

const fund: Fund = {
  symbol: '000001',
  code: '000001',
  name: '测试基金',
  holdings: [],
};
const funds = [fund];

function overviewSnapshot(price: number, generatedAt: number): OverviewSnapshot {
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
    fundSummaries: new Map([[
      fund.code,
      {
        code: fund.code,
        name: fund.name,
        navDate: '2026-08-06',
        nav: 1.2,
        officialChange: 0.5,
        estimatedNav: 1.2,
        estimatedChange: 0,
      },
    ]]),
  };
}

describe('useOverviewData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the previous snapshot visible while refreshing after page re-entry', async () => {
    const initial = overviewSnapshot(3200, 100);
    let finishRefresh: (snapshot: OverviewSnapshot) => void = () => undefined;
    const pendingRefresh = new Promise<OverviewSnapshot>((resolve) => {
      finishRefresh = resolve;
    });
    apiMocks.fetchOverviewSnapshot
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(pendingRefresh);

    const { result, rerender } = renderHook(
      ({ enabled }) => useOverviewData(funds, enabled),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(result.current.quotes.get('sh000001')?.price).toBe(3200));
    expect(result.current.loading).toBe(false);

    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => expect(apiMocks.fetchOverviewSnapshot).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(false);
    expect(result.current.fundLoading).toBe(false);
    expect(result.current.quotes.get('sh000001')?.price).toBe(3200);

    await act(async () => {
      finishRefresh(overviewSnapshot(3210, 200));
      await pendingRefresh;
    });
    await waitFor(() => expect(result.current.quotes.get('sh000001')?.price).toBe(3210));
  });
});
