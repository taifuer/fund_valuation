import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchQuoteDiagnostics } from '../api';
import DiagnosticsPage from './DiagnosticsPage';

vi.mock('../api', () => ({ fetchQuoteDiagnostics: vi.fn() }));

describe('DiagnosticsPage history freshness', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('requires authentication and distinguishes stored coverage from update success', async () => {
    vi.mocked(fetchQuoteDiagnostics).mockResolvedValue({ historyCoverage: {
      summary: { marketsStale: 1, marketRefreshErrors: 1 },
      markets: [
        { item: 'yahoo-index:RUT', name: '罗素2000', count: 100, endDate: '2026-09-15', expectedDate: '2026-09-18', stale: true,
          refresh: { error: 'History HTTP 429', lastSuccessAt: 0 } },
        { item: 'yahoo-index:SOX', name: '费城半导体', count: 100, endDate: '2026-09-18', expectedDate: '2026-09-18', stale: false,
          refresh: { error: '', lastSuccessAt: 1789707600000 } },
        { item: 'yahoo-index:OEX', name: '标普100', count: 0, stale: false },
      ],
    } });
    render(<DiagnosticsPage />);
    expect(fetchQuoteDiagnostics).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('诊断令牌'), { target: { value: 'test-token' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await screen.findByRole('heading', { name: '行情历史更新' });
    const stale = screen.getByText('罗素2000').closest('tr')!;
    expect(within(stale).getByText('未追平')).toBeInTheDocument();
    expect(within(stale).getByText('History HTTP 429')).toBeInTheDocument();
    expect(within(stale).getByText('2026-09-15')).toBeInTheDocument();
    expect(within(stale).getByText('2026-09-18')).toBeInTheDocument();
    expect(within(screen.getByText('费城半导体').closest('tr')!).getByText('已追平')).toBeInTheDocument();
    expect(within(screen.getByText('标普100').closest('tr')!).getByText('缺数据')).toBeInTheDocument();
    expect(fetchQuoteDiagnostics).toHaveBeenCalledWith('test-token');
  });

  it('keeps holding failures visible even when public service health is normal', async () => {
    vi.mocked(fetchQuoteDiagnostics).mockResolvedValue({
      status: 'degraded', publicStatus: { status: 'ok' }, total: 1006, healthy: 1004,
      issueCount: 2, holdingQuoteIssueCount: 2, marketQuoteIssueCount: 0,
      issues: [{ symbol: 'gb_atai', scope: 'holding', state: 'live', quoteTime: '2026-09-19 09:30:10',
        source: 'upstream', reason: 'quote date 2026-09-19 before 2026-09-21' }],
    });
    render(<DiagnosticsPage />);
    fireEvent.change(screen.getByLabelText('诊断令牌'), { target: { value: 'test-token' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    const summary = await screen.findByRole('region', { name: '诊断摘要' });
    expect(within(summary).getByText('服务状态').parentElement).toHaveTextContent('正常');
    expect(within(summary).getByText('行情状态').parentElement).toHaveTextContent('部分异常');
    expect(screen.getByText('gb_atai').closest('tr')).toHaveTextContent('持仓/估值');
    expect(screen.getByText('gb_atai').closest('tr')).toHaveTextContent('quote date 2026-09-19 before 2026-09-21');
  });
});
