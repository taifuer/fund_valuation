import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFundHistorySeries, fetchMarketHistory, fetchMarketReturnSummaries } from '../api';
import type { MarketRangeReturn, MarketReturnSummary, QuoteData } from '../types';
import { useFundReturnData } from '../hooks/usePageData';
import type { FundEstimate } from '../hooks/useQuotes';
import { FUNDS } from '../constants';
import RankingPage from './RankingPage';

vi.mock('../api', () => ({ fetchMarketReturnSummaries: vi.fn(), fetchMarketHistory: vi.fn(), fetchFundHistorySeries: vi.fn() }));
vi.mock('../hooks/usePageData', () => ({ useFundReturnData: vi.fn() }));
vi.mock('../polling', () => ({ startAdaptivePolling: () => () => undefined }));

beforeEach(() => {
  window.history.replaceState({}, '', '/returns');
  vi.mocked(fetchMarketReturnSummaries).mockReset();
  vi.mocked(fetchMarketHistory).mockReset().mockResolvedValue([
    { date: '2025-12-31', close: 100 }, { date: '2026-08-15', close: 105 },
    { date: '2026-09-15', close: 112 }, { date: '2026-09-16', close: 120 },
  ]);
  vi.mocked(fetchFundHistorySeries).mockReset().mockResolvedValue([
    { date: '2025-12-31', nav: 1, changePercent: 0 },
    { date: '2026-08-15', nav: 1, changePercent: 0 },
    { date: '2026-09-15', nav: 1.1, changePercent: 10 },
  ]);
  vi.mocked(useFundReturnData).mockReturnValue({ fundEstimates: [], loading: false, error: null });
});

describe('recent row history dialogs', () => {
  beforeEach(() => vi.mocked(fetchMarketReturnSummaries).mockResolvedValue(new Map([
    ['sina-cn:sh000001', marketSummary('sh000001')],
  ])));

  it('restores five-year selection and opens the same range without loading every history', async () => {
    window.history.replaceState({}, '', '/returns?range=5y');
    const summary = marketSummary('sh000016');
    summary.ranges = { '5y': { key: '5y', label: '近5年', returnPercent: 80, startDate: '2021-09-15',
      endDate: '2026-09-15', startClose: 100, endClose: 180, maxDrawdownPercent: -20, winRatePercent: 55 } };
    vi.mocked(fetchMarketReturnSummaries).mockResolvedValue(new Map([['sina-cn:sh000016', summary]]));
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    await screen.findByText('+80.00%');
    expect(screen.getByRole('button', { name: '近5年' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('近期时间区间')).toHaveValue('5y');
    expect(fetchMarketHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '上证50走势' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('img');
    expect(within(dialog).getByRole('button', { name: '5年' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    fireEvent.change(screen.getByLabelText('近期时间区间'), { target: { value: '3y' } });
    expect(screen.getByRole('button', { name: '近3年' })).toHaveAttribute('aria-pressed', 'true');
    const row = screen.getByRole('button', { name: '上证50走势' }).closest('tr')!;
    expect(within(row).getAllByRole('cell')[2]).toHaveTextContent('--');
  });

  it('loads only the clicked history, defaults latest to one month, and reuses the cache', async () => {
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    const button = await screen.findByRole('button', { name: '上证指数走势' });
    expect(fetchMarketHistory).not.toHaveBeenCalled();
    expect(fetchFundHistorySeries).not.toHaveBeenCalled();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: '上证指数历史走势' });
    await within(dialog).findByRole('img');
    expect(within(dialog).getByRole('button', { name: '1月' })).toHaveAttribute('aria-pressed', 'true');
    expect(fetchMarketHistory).toHaveBeenCalledExactlyOnceWith({ source: 'sina-cn', symbol: 'sh000001' });
    expect(fetchFundHistorySeries).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(document.body.style.overflow).not.toBe('hidden');
    const row = button.closest('tr')!;
    fireEvent.click(within(row).getByText('+2.00%'));
    await within(screen.getByRole('dialog')).findByRole('img');
    expect(fetchMarketHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps filters and sort, matches the selected range and excludes observations after its cutoff', async () => {
    window.history.replaceState({}, '', '/returns?range=ytd&sort=drawdown&order=asc');
    vi.mocked(fetchMarketReturnSummaries).mockResolvedValue(new Map([
      ['sina-cn:sz399001', { ...marketSummary('sz399001'), ranges: {
        ytd: { key: 'ytd', label: '今年', returnPercent: 12, startClose: 100, endClose: 112,
          startDate: '2025-12-31', endDate: '2026-09-15', maxDrawdownPercent: 0, winRatePercent: 100 },
      } }],
    ]));
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '深证成指走势' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('img');
    expect(within(dialog).getByRole('button', { name: '今年' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText('+12.00%')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('2025-12-31 至 2026-09-15');
    expect(dialog).not.toHaveTextContent('2026-09-16');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(window.location.search).toBe('?range=ytd&sort=drawdown&order=asc');
    expect(screen.getByRole('columnheader', { name: '回撤 ↑' })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('opens fund official NAV history without holdings or estimation data', async () => {
    const fund = FUNDS.find(item => item.code === '017091')!;
    vi.mocked(useFundReturnData).mockReturnValue({ loading: false, error: null, fundEstimates: [{
      fund, officialNAV: { nav: 1.1, officialChange: 10, navDate: '2026-09-15' },
      rangeReturns: { ranges: { '1m': { endDate: '2026-09-15', returnPercent: 10 } } },
    } as FundEstimate] });
    window.history.replaceState({}, '', '/returns?category=fund&strategy=index&range=1m');
    render(<RankingPage funds={[fund]} quotes={new Map()} marketLoading={false} />);
    expect(fetchFundHistorySeries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `${fund.name}走势` }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('img');
    expect(fetchFundHistorySeries).toHaveBeenCalledExactlyOnceWith(fund.code, 3000);
    expect(within(dialog).getByRole('button', { name: '1月' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText('+10.00%')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('官方单位净值');
    expect(fetchMarketHistory).not.toHaveBeenCalled();
    expect(fetchMarketReturnSummaries).not.toHaveBeenCalled();
  });

  it('does not open a row after a cancelled gesture or horizontal scrolling', async () => {
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    const button = await screen.findByRole('button', { name: '沪深300走势' });
    const table = screen.getByRole('region', { name: '近期表现表格' });
    fireEvent.pointerDown(button);
    fireEvent.pointerCancel(button);
    fireEvent.click(button, { detail: 1 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.pointerDown(button);
    table.scrollLeft = 100;
    fireEvent.click(button, { detail: 1 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.pointerDown(button);
    fireEvent.click(button, { detail: 1 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await within(screen.getByRole('dialog')).findByRole('img');
  });

  it('shows loading and empty states and allows another attempt after reopening', async () => {
    let resolve!: (points: []) => void;
    vi.mocked(fetchMarketHistory).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    const button = await screen.findByRole('button', { name: '科创50走势' });
    fireEvent.click(button);
    await screen.findByText('历史行情加载中...');
    resolve([]);
    await screen.findByText('暂无历史行情');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(button);
    await within(screen.getByRole('dialog')).findByRole('img');
    expect(fetchMarketHistory).toHaveBeenCalledTimes(2);
  });

  it('uses Nikkei cash history rather than the futures archive', async () => {
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '日经225走势' }));
    await waitFor(() => expect(fetchMarketHistory).toHaveBeenCalledWith({ source: 'nikkei-index', symbol: 'N225' }));
    await within(screen.getByRole('dialog')).findByRole('img');
  });

  it('uses the same January 1 observation as the summary for continuously traded assets', async () => {
    window.history.replaceState({}, '', '/returns?category=asset&range=ytd');
    vi.mocked(fetchMarketHistory).mockResolvedValue([
      { date: '2025-12-31', close: 80 }, { date: '2026-01-01', close: 100 }, { date: '2026-09-15', close: 112 },
    ]);
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '比特币走势' }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('img');
    expect(within(dialog).getByText('+12.00%')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('2026-01-01 至 2026-09-15');
  });

  it('shows a failed request or insufficient history without a blank dialog', async () => {
    vi.mocked(fetchMarketHistory).mockRejectedValueOnce(new Error('offline'));
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    const button = await screen.findByRole('button', { name: '罗素2000走势' });
    fireEvent.click(button);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('历史行情加载失败');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    vi.mocked(fetchMarketHistory).mockResolvedValueOnce([{ date: '2026-09-15', close: 100 }]);
    fireEvent.click(button);
    await screen.findByText('历史行情不足，至少需要两个交易日');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
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
    expect(screen.getByRole('columnheader', { name: '涨跌幅 ↓' })).toHaveAttribute('aria-sort', 'descending');
    expect(window.location.search).toBe('');
  });

  it('does not honor a hidden risk sort from a latest-range URL', async () => {
    window.history.replaceState({}, '', '/returns?sort=winRate&order=asc');
    render(<RankingPage funds={[]} quotes={new Map()} marketLoading={false} />);
    await screen.findByText('上证指数');
    expect(screen.getByRole('columnheader', { name: '涨跌幅 ↓' })).toHaveAttribute('aria-sort', 'descending');
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

  it('filters fund strategies for both latest NAVs and historical risk metrics', async () => {
    const estimates = ['017436', '017091', '270042'].map(code => ({
      fund: FUNDS.find(fund => fund.code === code)!,
      officialNAV: { nav: 2, officialChange: 1, navDate: '2026-09-16' },
      rangeReturns: { code, asOf: '2026-09-15', ranges: {
        '1m': { returnPercent: 10, maxDrawdownPercent: -5, winRatePercent: 55, endNav: 1.1, endDate: '2026-09-15' },
      } },
    } as FundEstimate));
    vi.mocked(useFundReturnData).mockReturnValue({ fundEstimates: estimates, loading: false, error: null });
    window.history.replaceState({}, '', '/returns?category=fund&strategy=index');
    render(<RankingPage funds={FUNDS} quotes={new Map()} marketLoading={false} />);
    const filters = screen.getByRole('group', { name: '基金类型筛选' });
    expect(within(filters).getByRole('button', { name: '指数' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.queryByText('华宝纳斯达克精选A')).not.toBeInTheDocument();
    expect(screen.getAllByText('指数基金')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '近1月' }));
    expect(screen.getAllByText('-5.00%')).toHaveLength(2);
    fireEvent.click(within(filters).getByRole('button', { name: '主动' }));
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('华宝纳斯达克精选A')).toBeInTheDocument();
    expect(screen.queryByText('270042')).not.toBeInTheDocument();
    expect(window.location.search).toContain('strategy=active');
    fireEvent.click(within(filters).getByRole('button', { name: '全部' }));
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(window.location.search).not.toContain('strategy');
    expect(fetchMarketReturnSummaries).not.toHaveBeenCalled();
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
