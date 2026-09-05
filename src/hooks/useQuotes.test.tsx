import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuotes } from './useQuotes';
import { fetchFundCardSnapshot, fetchFundReturnSummaries } from '../api';
import type { Fund } from '../types';

vi.mock('../api', () => ({ fetchFundCardSnapshot: vi.fn(), fetchFundReturnSummaries: vi.fn() }));
const funds: Fund[] = [{code:'017436',symbol:'017436',name:'Test',holdings:[]}];
const snapshot = {
  generatedAt: 1, fetchedAt: 1, quotes: new Map(), fxRates: new Map(), marketStates: new Map(),
  cards: new Map([['017436', {official: {code:'017436',name:'Test',nav:1.2,navDate:'2026-09-03',officialChange:null,estimatedNav:1.2,estimatedChange:0}, estimate:null}]]),
};

beforeEach(() => { vi.clearAllMocks(); vi.mocked(fetchFundCardSnapshot).mockResolvedValue(snapshot); });

describe('fund cards use one worker snapshot', () => {
  it('loads NAV without requesting holdings, returns, or a browser estimate', async () => {
    const { result } = renderHook(() => useQuotes(funds));
    await waitFor(() => expect(result.current.fundEstimates).toHaveLength(1));
    expect(fetchFundCardSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchFundReturnSummaries).not.toHaveBeenCalled();
    expect(result.current.fundEstimates[0].officialNAV?.officialChange).toBeNull();
    expect(result.current.fundEstimates[0].normalizedNAV).toBeNull();
  });
  it('keeps loaded cards when leaving and returning while the next request waits', async () => {
    const { result, rerender } = renderHook(({enabled}) => useQuotes(funds, false, enabled), {initialProps:{enabled:true}});
    await waitFor(() => expect(result.current.fundEstimates).toHaveLength(1));
    rerender({enabled:false});
    let finish!: (value: typeof snapshot) => void;
    vi.mocked(fetchFundCardSnapshot).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    rerender({enabled:true});
    expect(result.current.fundLoading).toBe(false);
    expect(result.current.fundEstimates[0].officialNAV?.nav).toBe(1.2);
    await act(async () => { finish(snapshot); });
  });
  it('does not fetch on non-fund pages', () => {
    renderHook(() => useQuotes(funds, false, false));
    expect(fetchFundCardSnapshot).not.toHaveBeenCalled();
  });
});
