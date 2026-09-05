import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFundHistorySeries } from '../api';
import { useFundHistory } from './useFundHistory';

vi.mock('../api', () => ({ fetchFundHistorySeries: vi.fn() }));
const series = [
  { date: '2026-09-01', nav: 1, changePercent: null },
  { date: '2026-09-02', nav: 1.01, changePercent: 1 },
];

afterEach(() => vi.restoreAllMocks());

describe('fund history cache', () => {
  it('shares an in-flight request between charts and NAV tables', async () => {
    vi.mocked(fetchFundHistorySeries).mockClear().mockResolvedValue(series);
    const first = renderHook(() => useFundHistory('100001'));
    const second = renderHook(() => useFundHistory('100001'));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(second.result.current.history).toEqual(series);
    expect(fetchFundHistorySeries).toHaveBeenCalledTimes(1);
  });

  it.each(['empty', 'error'])('preserves expired data when refresh returns %s', async (outcome) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const code = outcome === 'empty' ? '100002' : '100003';
    vi.mocked(fetchFundHistorySeries).mockResolvedValueOnce(series);
    const first = renderHook(() => useFundHistory(code));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();
    clock.mockReturnValue(1000 + 6 * 60 * 1000);
    if (outcome === 'empty') vi.mocked(fetchFundHistorySeries).mockResolvedValueOnce([]);
    else vi.mocked(fetchFundHistorySeries).mockRejectedValueOnce(new Error('unavailable'));
    const next = renderHook(() => useFundHistory(code));
    await act(async () => {});
    expect(next.result.current.history).toEqual(series);
    expect(next.result.current.loading).toBe(false);
    expect(next.result.current.error).toContain('当前显示已缓存数据');
  });
});
