import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMarketReturnSummaries } from '../api';
import type { MarketRangeReturn, MarketReturnSummary, QuoteData } from '../types';
import { useFundReturnData } from '../hooks/usePageData';
import type { FundEstimate } from '../hooks/useQuotes';
import { FUNDS } from '../constants';
import RankingPage from './RankingPage';

vi.mock('../api', () => ({ fetchMarketReturnSummaries: vi.fn() }));
vi.mock('../hooks/usePageData', () => ({ useFundReturnData: vi.fn() }));
vi.mock('../polling', () => ({ startAdaptivePolling: () => () => undefined }));

beforeEach(() => {
  window.history.replaceState({}, '', '/returns');
  vi.mocked(fetchMarketReturnSummaries).mockReset();
  vi.mocked(useFundReturnData).mockReturnValue({ fundEstimates: [], loading: false, error: null });
});

function marketSummary(symbol: string, metrics: Partial<MarketRangeReturn> = {}): MarketReturnSummary {
  const range: MarketRangeReturn = {
    key: '1m', label: '近1月', returnPercent: 12, maxDrawdownPercent: -4, winRatePercent: 60,
    startDate: '2026-08-15', endDate: '2026-09-15', startClose: 100, endClose: 112, ...metrics,
  };
  return {
    ...range, source: 'sina-cn', symbol, ranges: { '1m': range },
    latest: { ...range, key: 'latest', returnPercent: 2, startDate: '2026-09-14' },
  };
}

describe('combined recent returns and risk', () => {
  beforeEach(() => {
    vi.mocked(fetchMarketReturnSummaries).mockResolvedValue(new Map([
      ['sina-cn:sh000001', marketSummary('sh000001')],
      ['sina-cn:sh000300', marketSummary('sh000300', { returnPercent: -6, maxDrawdownPercent: -12, winRatePercent: 40 })],
      ['sina-cn:sz399006', marketSummary('sz399006', { returnPercent: 8, maxDrawdownPercent: 0, winRatePercent: 100 })],
    ]));
  });

  it('adds historical risk metrics from the same summary without extra requests', async () => {
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    const row = (await screen.findByText('上证指数')).closest('tr')!;
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(within(row).getByText('+2.00%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '近1月' }));
    expect(screen.getAllByRole('columnheader')).toHaveLength(10);
    expect(within(row).getByText('+12.00%')).toBeInTheDocument();
    expect(within(row).getByText('-4.00%')).toBeInTheDocument();
    expect(within(row).getByText('3.00')).toBeInTheDocument();
    expect(within(row).getByText('60.00%')).toBeInTheDocument();
    expect(within(row).getByText('2026-09-15')).toBeInTheDocument();
    expect(fetchMarketReturnSummaries).toHaveBeenCalledTimes(1);
    expect(useFundReturnData).toHaveBeenLastCalledWith([], false);
  });

  it('sorts all risk metrics, keeps missing values last, and resets risk sorting for latest', async () => {
    window.history.replaceState({}, '', '/returns?range=1m');
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    await screen.findByText('上证指数');
    const rows = () => screen.getAllByRole('row').slice(1);
    expect(rows()[0]).toHaveTextContent('上证指数');
    fireEvent.click(screen.getByRole('button', { name: '回撤' }));
    expect(rows()[0]).toHaveTextContent('沪深300');
    fireEvent.click(screen.getByRole('button', { name: '回撤 ↓' }));
    expect(rows()[0]).toHaveTextContent('创业板指');
    const missingRow = screen.getByText('标普100').closest('tr')!;
    expect(within(missingRow).getAllByText('--')).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: '收益回撤比' }));
    expect(rows()[0]).toHaveTextContent('上证指数');
    expect(within(screen.getByText('创业板指').closest('tr')!).getAllByRole('cell')[5]).toHaveTextContent('--');
    fireEvent.click(screen.getByRole('button', { name: '收益回撤比 ↓' }));
    expect(rows()[0]).toHaveTextContent('沪深300');
    expect(within(rows()[0]).getByText('-0.50')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '胜率' }));
    expect(rows()[0]).toHaveTextContent('创业板指');
    fireEvent.click(screen.getByRole('button', { name: '胜率 ↓' }));
    expect(rows()[0]).toHaveTextContent('沪深300');
    fireEvent.click(screen.getByRole('button', { name: '最新' }));
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(screen.getByRole('columnheader', { name: '收益 ↓' })).toHaveAttribute('aria-sort', 'descending');
    expect(window.location.search).toBe('');
  });

  it('does not honor a hidden risk sort from a latest-range URL', async () => {
    window.history.replaceState({}, '', '/returns?sort=winRate&order=asc');
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    await screen.findByText('上证指数');
    expect(screen.getByRole('columnheader', { name: '收益 ↓' })).toHaveAttribute('aria-sort', 'descending');
    expect(window.location.search).toBe('');
  });

  it('uses confirmed fund returns, NAVs, and risk data, not estimates', async () => {
    const fund = FUNDS[0];
    const estimate = {
      fund, computedChange: 99, estimatedNAV: 99,
      officialNAV: { nav: 1.8, officialChange: -1, navDate: '2026-09-16' },
      rangeReturns: { code: fund.code, asOf: '2026-09-15', ranges: {
        '1m': { key: '1m', returnPercent: 10, maxDrawdownPercent: -5, winRatePercent: 55,
          startDate: '2026-08-15', endDate: '2026-09-15', startNav: 1, endNav: 1.1 },
      } },
    } as FundEstimate;
    vi.mocked(useFundReturnData).mockReturnValue({ fundEstimates: [estimate], loading: false, error: null });
    window.history.replaceState({}, '', '/returns?category=fund&range=1m');
    render(<RankingPage funds={[fund]} quotes={new Map()} marketLoading={false} />);
    const row = screen.getByText(fund.name).closest('tr')!;
    expect(within(row).getByText('+10.00%')).toBeInTheDocument();
    expect(within(row).getByText('1.1000')).toBeInTheDocument();
    expect(within(row).getByText('2.00')).toBeInTheDocument();
    expect(within(row).getByText('55.00%')).toBeInTheDocument();
    expect(within(row).getByText('2026-09-15')).toBeInTheDocument();
    expect(useFundReturnData).toHaveBeenLastCalledWith([fund], true);
    expect(fetchMarketReturnSummaries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '最新' }));
    expect(within(row).getByText('-1.00%')).toBeInTheDocument();
    expect(within(row).getByText('1.8000')).toBeInTheDocument();
    expect(row).not.toHaveTextContent('99.00');
  });

  it('shows no risk when the requested range is unavailable or its metrics are invalid', async () => {
    vi.mocked(fetchMarketReturnSummaries).mockResolvedValue(new Map([
      ['sina-cn:sh000001', marketSummary('sh000001', { maxDrawdownPercent: NaN, winRatePercent: Infinity })],
    ]));
    window.history.replaceState({}, '', '/returns?range=1m');
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    const row = (await screen.findByText('上证指数')).closest('tr')!;
    expect(within(row).getAllByRole('cell').slice(4, 7).map(cell => cell.textContent)).toEqual(['--', '--', '--']);
    fireEvent.click(screen.getByRole('button', { name: '近3年' }));
    expect(within(row).getAllByRole('cell')[2]).toHaveTextContent('--');
    expect(within(row).getAllByRole('cell').slice(4, 7).map(cell => cell.textContent)).toEqual(['--', '--', '--']);
  });
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
