import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLongHistory } from '../api';
import LongHistoryPage from './LongHistoryPage';
import HistoryComparisonTable from './HistoryComparisonTable';
import type { HistoryComparison, LongHistoryAsset, LongHistoryCatalog, LongHistorySeries } from '../longHistory';

vi.mock('../api', () => ({ fetchLongHistory: vi.fn() }));
const performance = { startPeriod: '2024-12', endPeriod: '2025-12', months: 12, change: 20, cagr: 20, reason: '', cagrReason: '' };
const asset = (id: string, name: string): LongHistoryAsset => ({
  id, name, group: 'usa', basis: 'price', unit: '点', firstDate: '2024-12-31', lastDate: '2025-12-31',
  count: 2, note: '价格涨跌，不含股息再投资。', refreshFailed: false, sources: ['腾讯财经'],
  performance: { '5': performance, '10': performance, '20': performance, all: performance },
  annual: [{ year: 2025, return: 20, startDate: '2024-12-31', startClose: 100, endDate: '2025-12-31', endClose: 120,
    reason: '', yearToDate: false, sourceUrl: 'https://example.com/' }],
});
const sp = asset('INX', '标普500');
const ndx = asset('NDX', '纳指100');
const comparison: HistoryComparison = { startPeriod: '2021-01', endPeriod: '2025-12',
  rows: [{ id: 'INX', ...performance, startPeriod: '2020-12', months: 60, change: 60, cagr: 9.86 },
    { id: 'NDX', ...performance, change: null, cagr: null, reason: '缺少区间起止月数据' }] };
const tenYear: HistoryComparison = { ...comparison, startPeriod: '2016-01',
  rows: [{ ...comparison.rows[0], startPeriod: '2015-12', months: 120, change: 300 }, comparison.rows[1]] };
const ranges = { '5': comparison, '10': tenYear, '20': { ...tenYear, startPeriod: '2006-01' }, all: comparison };
const catalog: LongHistoryCatalog = { schemaVersion: 1, generatedAt: 1, year: 2026, assets: [sp, ndx],
  comparisons: { all: ranges, china: ranges, usa: ranges, asia: ranges, assets: ranges } };
const series = (item: LongHistoryAsset): LongHistorySeries => ({ schemaVersion: 1, generatedAt: 1, asset: item,
  points: [100, 120].map((close, i) => ({ date: `${2024 + i}-12-31`, period: `${2024 + i}-12`, close, source: 'tencent', sourceUrl: 'https://example.com/' })) });

beforeEach(() => {
  window.history.replaceState({}, '', '/history');
  vi.mocked(fetchLongHistory).mockReset().mockImplementation(async id => id ? series(id === 'INX' ? sp : ndx) : catalog);
});
afterEach(cleanup);

describe('long-term history page', () => {
  it('loads the catalog and only the selected series, with keyboard point selection', async () => {
    render(<LongHistoryPage />);
    const chart = await screen.findByRole('img', { name: '标普500长期走势' });
    await waitFor(() => expect(screen.getByRole('table', { name: '标普500年度收益' })).toHaveTextContent('+20.00%'));
    expect(fetchLongHistory).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('history-crosshair')).not.toBeInTheDocument();
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(chart.querySelector('circle')).toBeInTheDocument();
    expect(screen.getByTestId('history-crosshair').querySelectorAll('line')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '线性' }));
    expect(window.location.search).toContain('scale=linear');
    expect(fetchLongHistory).toHaveBeenCalledTimes(2);
  });

  it('keeps individual asset links and does not retain the old asset table after switching', async () => {
    render(<LongHistoryPage />);
    await screen.findByRole('table', { name: '标普500年度收益' });
    fireEvent.click(within(screen.getByRole('group', { name: '历史标的' })).getByRole('button', { name: '纳指100' }));
    await screen.findByRole('table', { name: '纳指100年度收益' });
    expect(window.location.search).toContain('asset=NDX');
    expect(screen.queryByRole('table', { name: '标普500年度收益' })).not.toBeInTheDocument();
  });

  it('keeps missing archives and source errors explicit rather than showing zero prices', async () => {
    vi.mocked(fetchLongHistory).mockResolvedValue(null);
    render(<LongHistoryPage />);
    await screen.findByText('暂无已归档的历史数据');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    vi.mocked(fetchLongHistory).mockRejectedValue(new Error('source failure'));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('历史数据加载失败，请重试');
  });

  it('does not display an unavailable first-year return as zero', async () => {
    const partial = { ...sp, annual: [{ ...sp.annual[0], return: null, reason: '首年非完整年度' }] };
    vi.mocked(fetchLongHistory).mockImplementation(async id => id ? series(partial) : catalog);
    render(<LongHistoryPage />);
    await screen.findByText('首年非完整年度');
    expect(screen.getByRole('table')).not.toHaveTextContent('0.00%');
  });

  it('removes redundant headings, current-year badges, raw source links and loading copy', async () => {
    const current = { ...sp, annual: [{ ...sp.annual[0], year: 2026, yearToDate: true }] };
    vi.mocked(fetchLongHistory).mockImplementation(async id => id ? series(current) : catalog);
    render(<LongHistoryPage />);
    await screen.findByRole('table');
    expect(screen.queryByText('长期走势与年度收益')).not.toBeInTheDocument();
    expect(screen.queryByText('指数与资产')).not.toBeInTheDocument();
    expect(screen.queryByText('今年')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('数据来源：腾讯财经。')).toBeInTheDocument();
    expect(screen.getByText('年化涨幅').parentElement).toHaveTextContent('+20.00%');
    expect(screen.queryByText(/加载中/)).not.toBeInTheDocument();
  });

  it('keeps a stable busy surface without loading text during a slow read', () => {
    vi.mocked(fetchLongHistory).mockImplementation(() => new Promise(() => undefined));
    render(<LongHistoryPage />);
    expect(screen.getByRole('region', { name: '长期历史' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/加载中/)).not.toBeInTheDocument();
    expect(screen.queryByText('--')).not.toBeInTheDocument();
  });

  it('keeps multi-year ranges and annualized returns without a single-year selector or series requests', async () => {
    window.history.replaceState({}, '', '/history?view=change&range=10');
    render(<LongHistoryPage />);
    const table = await screen.findByRole('table', { name: '区间涨幅' });
    expect(fetchLongHistory).toHaveBeenCalledTimes(1);
    expect(table).toHaveTextContent('+300.00%');
    expect(table).toHaveTextContent('缺少区间起止月数据');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '历史涨幅年度' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('历史时间区间')).toHaveValue('10');
    expect(screen.getByLabelText('涨幅统计区间')).toHaveTextContent('2016-01 至 2025-12');
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['排名', '名称', '涨幅↓', '年化涨幅']);
    fireEvent.click(within(table).getByRole('button', { name: '标普500' }));
    await screen.findByRole('img', { name: '标普500长期走势' });
    expect(window.location.search).toContain('view=price');
    expect(fetchLongHistory).toHaveBeenCalledTimes(2);
  });

  it('switches views with the keyboard and preserves the selected range', async () => {
    render(<LongHistoryPage />);
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: '近10年' }));
    fireEvent.keyDown(screen.getByRole('tab', { name: '走势' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '涨幅' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'history-view-change');
    expect(window.location.search).toContain('range=10');
    expect(fetchLongHistory).toHaveBeenCalledTimes(2);
  });

  it('keeps the selected range while distinguishing rolling chart months from complete calendar years', async () => {
    const five = { ...performance, startPeriod: '2021-08', endPeriod: '2026-08', months: 60, change: 100, cagr: 14.8698 };
    const longer = { ...sp, performance: { ...sp.performance!, '5': five } };
    vi.mocked(fetchLongHistory).mockImplementation(async id => id ? { ...series(longer), points: [
      { ...series(sp).points[0], period: '2015-12', date: '2015-12-31', close: 50 },
      { ...series(sp).points[0], period: '2020-12', date: '2020-12-31', close: 100 },
      { ...series(sp).points[0], period: '2021-08', date: '2021-08-31', close: 100 },
      { ...series(sp).points[1], close: 160 },
      { ...series(sp).points[1], period: '2026-08', date: '2026-08-31', close: 200 },
    ] } : catalog);
    window.history.replaceState({}, '', '/history?range=5');
    render(<LongHistoryPage />);
    const chart = await screen.findByRole('img');
    expect(screen.getByLabelText('历史时间区间')).toHaveValue('5');
    expect(screen.getByRole('button', { name: '近5年' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(screen.getByText('2021-08')).toBeInTheDocument();
    expect(screen.queryByText('2015-12')).not.toBeInTheDocument();
    expect(screen.getByText('区间涨幅').parentElement).toHaveTextContent('+100.00%');
    fireEvent.click(screen.getByRole('tab', { name: '涨幅' }));
    expect(screen.getByRole('table', { name: '区间涨幅' })).toHaveTextContent('+60.00%');
    expect(screen.getByLabelText('涨幅统计区间')).toHaveTextContent('2021-01 至 2025-12');
    fireEvent.click(screen.getByRole('tab', { name: '走势' }));
    expect(screen.getByLabelText('历史时间区间')).toHaveValue('5');
    expect(screen.getByText('区间涨幅').parentElement).toHaveTextContent('+100.00%');
    fireEvent.change(screen.getByLabelText('历史时间区间'), { target: { value: '10' } });
    expect(window.location.search).toContain('range=10');
    expect(screen.getByRole('button', { name: '近10年' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('tab', { name: '涨幅' }));
    expect(screen.getByLabelText('历史时间区间')).toHaveValue('10');
    expect(screen.getByRole('table', { name: '区间涨幅' })).toHaveTextContent('+300.00%');
    expect(screen.getByLabelText('涨幅统计区间')).toHaveTextContent('2016-01 至 2025-12');
    expect(fetchLongHistory).toHaveBeenCalledTimes(2);
  });

  it('ranks available returns in sort order with shared podium colors and leaves missing values unranked', () => {
    const rows = [
      { id: 'LOSS', ...performance, change: -20, cagr: -5 },
      { id: 'MISSING', ...performance, change: null, cagr: null, reason: '缺少区间起止月数据' },
      { id: 'GAIN', ...performance, change: 50, cagr: 10 },
      { id: 'FLAT', ...performance, change: 0, cagr: 0 },
    ];
    render(<HistoryComparisonTable comparison={{ ...comparison, rows }} assets={rows.map(row => asset(row.id, row.id))} onSelect={vi.fn()} />);
    const bodyRows = () => screen.getAllByRole('row').slice(1);
    const names = () => bodyRows().map(row => within(row).getByRole('rowheader').textContent);
    expect(names()).toEqual(['GAIN', 'FLAT', 'LOSS', 'MISSING']);
    expect(screen.getByText('#1').className).toContain('gold');
    expect(screen.getByText('#2').className).toContain('silver');
    expect(screen.getByText('#3').className).toContain('bronze');
    expect(within(bodyRows()[2]).getAllByRole('cell')[1]).toHaveTextContent('-20.00%');
    expect(within(bodyRows()[3]).getAllByRole('cell')[0]).toHaveTextContent('--');
    fireEvent.click(screen.getByRole('button', { name: '涨幅' }));
    expect(names()).toEqual(['LOSS', 'FLAT', 'GAIN', 'MISSING']);
    expect(bodyRows()[0]).toHaveTextContent('#1');
    expect(within(bodyRows()[3]).getAllByRole('cell')[0]).toHaveTextContent('--');
    fireEvent.click(screen.getByRole('button', { name: '年化涨幅' }));
    expect(names()).toEqual(['GAIN', 'FLAT', 'LOSS', 'MISSING']);
    expect(screen.getByRole('columnheader', { name: '年化涨幅' })).toHaveAttribute('aria-sort', 'descending');
  });

  it('preserves the common complete-year range and leaves missing data unranked', async () => {
    window.history.replaceState({}, '', '/history?view=change');
    render(<LongHistoryPage />);
    const table = await screen.findByRole('table', { name: '区间涨幅' });
    expect(screen.getByLabelText('历史时间区间')).toHaveValue('all');
    expect(screen.getByRole('button', { name: '共同区间' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('涨幅统计区间')).toHaveTextContent('2021-01 至 2025-12');
    expect(table).toHaveTextContent('+60.00%');
    expect(within(table).queryByText('#2')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: '历史资产类别' })).getByRole('button', { name: 'A股' }));
    expect(table.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(screen.getByLabelText('历史时间区间')).toHaveValue('all');
    expect(fetchLongHistory).toHaveBeenCalledTimes(1);
  });

  it('ignores obsolete single-year links and restores multi-year ranges on navigation', async () => {
    window.history.replaceState({}, '', '/history?view=change&range=10&year=2025');
    render(<LongHistoryPage />);
    await screen.findByRole('table', { name: '区间涨幅' });
    expect(screen.getByLabelText('历史时间区间')).toHaveValue('10');
    fireEvent.click(screen.getByRole('button', { name: '近5年' }));
    expect(window.location.search).not.toContain('year=');
    window.history.replaceState({}, '', '/history?view=change&range=20');
    fireEvent.popState(window);
    expect(screen.getByLabelText('历史时间区间')).toHaveValue('20');
    expect(screen.getByLabelText('涨幅统计区间')).toHaveTextContent('2006-01 至 2025-12');
    expect(fetchLongHistory).toHaveBeenCalledTimes(1);
  });
});
