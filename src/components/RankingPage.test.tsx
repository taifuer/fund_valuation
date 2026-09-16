import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMarketReturnSummaries } from '../api';
import type { MarketReturnSummary, QuoteData } from '../types';
import RankingPage from './RankingPage';

vi.mock('../api', () => ({ fetchMarketReturnSummaries: vi.fn() }));
vi.mock('../hooks/usePageData', () => ({ useFundReturnData: () => ({ fundEstimates: [], loading: false }) }));
vi.mock('../polling', () => ({ startAdaptivePolling: () => () => undefined }));

beforeEach(() => {
  window.history.replaceState({}, '', '/returns');
  vi.mocked(fetchMarketReturnSummaries).mockReset();
});
afterEach(cleanup);

describe('cash-index ranking rows', () => {
  it('shows all three cash-index closes and ignores live quotes even during a live session', async () => {
    const summaries = new Map<string, MarketReturnSummary>();
    for (const symbol of ['RUT', 'SOX', 'OEX']) {
      const base = { label: '今年', returnPercent: 5, startDate: '2025-12-31', endDate: '2026-09-15', startClose: 100, endClose: 105 };
      summaries.set(`yahoo-index:${symbol}`, { ...base, source: 'yahoo-index', symbol,
        latest: { ...base, key: 'latest', label: '最新', returnPercent: 2, startDate: '2026-09-14', startClose: 100, endClose: 102 } });
    }
    vi.mocked(fetchMarketReturnSummaries).mockResolvedValue(summaries);
    const badQuote: QuoteData = { symbol: 'gb_rut', name: '罗素2000', price: 9999, previousClose: 100,
      change: 9899, changePercent: 9899, time: '2026-09-16 22:00:00', fetchedAt: 1, dateReliable: true };
    render(<RankingPage funds={[]} marketLoading={false} quotes={new Map([['gb_rut', badQuote]])}
      marketStates={new Map([['gb_rut', { symbol: 'gb_rut', market: 'us', state: 'live', source: 'calendar' }]])} />);
    for (const name of ['罗素2000', '费城半导体', '标普100']) {
      const row = (await screen.findByText(name)).closest('tr')!;
      expect(within(row).getByText('+2.00%')).toBeInTheDocument();
      expect(within(row).getByText('102.00')).toBeInTheDocument();
      expect(within(row).getByText('最新收盘')).toBeInTheDocument();
      expect(within(row).getByText('2026-09-15')).toBeInTheDocument();
    }
    expect(screen.queryByText('9,999')).not.toBeInTheDocument();
  });

  it('keeps unavailable histories blank instead of using a stale quote or zero', async () => {
    vi.mocked(fetchMarketReturnSummaries).mockResolvedValue(new Map());
    render(<RankingPage funds={[]} marketLoading={false} quotes={new Map()} />);
    const row = (await screen.findByText('标普100')).closest('tr')!;
    expect(row).not.toHaveTextContent('0.00%');
    expect(within(row).getAllByText('--')).toHaveLength(3);
  });
});
