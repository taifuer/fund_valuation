import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Header from './Header';

describe('Header', () => {
  it.each(['funds', 'ranking', 'history', 'companies', 'about', 'diagnostics'] as const)(
    'omits the clock, FX and freshness polling UI by default on %s', (activePage) => {
      render(<Header activePage={activePage} onPageChange={vi.fn()} fxRates={new Map([
        ['USD', { currency: 'USD', pair: 'USD/CNY', rate: 7, changePercent: 0, date: '2026-09-19', fetchedAt: 1 }],
      ])} />);
      expect(screen.queryByText(/北京时间/)).not.toBeInTheDocument();
      expect(screen.queryByText('USD/CNY')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    },
  );

  it('keeps overview metadata without a global loading banner', () => {
    const props = { fxRates: new Map(), activePage: 'overview' as const, onPageChange: vi.fn() };
    render(<Header {...props} />);
    expect(screen.getByText(/北京时间/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('describes the dashboard coverage in the brand subtitle', () => {
    render(<Header fxRates={new Map()} activePage="overview" onPageChange={vi.fn()} />);
    expect(screen.getByText('Markets · Companies · ETFs · QDII Funds')).toBeInTheDocument();
  });

  it('reports degraded freshness without adding a visible status banner', () => {
    render(
      <Header
        fxRates={new Map()}
        activePage="overview"
        onPageChange={vi.fn()}
        systemStatus={{ status: 'degraded', updatedAt: 1, quoteIssueCount: 2, quoteTotal: 10, workerLastSuccessAt: 1 }}
      />,
    );
    expect(screen.getByLabelText('数据刷新存在延迟（2 项）')).toBeInTheDocument();
    expect(screen.queryByText('数据刷新存在延迟（2 项）')).not.toBeInTheDocument();
  });

  it('navigates through the primary page tabs', () => {
    const onPageChange = vi.fn();
    render(<Header fxRates={new Map()} activePage="overview" onPageChange={onPageChange} />);
    const navigation = within(screen.getByRole('navigation', { name: '页面切换' }));
    expect(navigation.getAllByRole('button').map(button => button.textContent?.trim()))
      .toEqual(['概览', '走势', '基金', '公司', '关于']);
    fireEvent.click(screen.getByRole('button', { name: '关于' }));
    expect(onPageChange).toHaveBeenCalledWith('about');
    fireEvent.click(screen.getByRole('button', { name: '公司' }));
    expect(onPageChange).toHaveBeenCalledWith('companies');
    fireEvent.click(screen.getByRole('button', { name: '走势' }));
    expect(onPageChange).toHaveBeenCalledWith('ranking');
    fireEvent.click(screen.getByRole('button', { name: '基金' }));
    expect(onPageChange).toHaveBeenCalledWith('funds');
  });

  it('keeps the service dot green while reporting isolated holding failures in its tooltip', () => {
    render(<Header fxRates={new Map()} activePage="overview" onPageChange={vi.fn()}
      systemStatus={{ status: 'ok', updatedAt: 1, workerLastSuccessAt: 1, quoteTotal: 1006,
        quoteIssueCount: 2, marketQuoteIssueCount: 0, holdingQuoteIssueCount: 2, reasons: [] }} />);
    const dot = screen.getByLabelText('服务运行正常（2 项持仓行情待更新）');
    expect(dot).not.toHaveClass(/liveDegraded|liveOffline/);
    expect(dot).toHaveAttribute('title', '服务运行正常（2 项持仓行情待更新）');
  });

  it.each([
    ['worker-stale', '后台刷新延迟'],
    ['market-quotes', '市场行情待更新'],
    ['holding-quotes', '持仓行情大面积延迟'],
  ] as const)('explains %s without presenting it as zero quote failures', (reason, label) => {
    render(<Header fxRates={new Map()} activePage="overview" onPageChange={vi.fn()}
      systemStatus={{ status: 'degraded', updatedAt: 1, workerLastSuccessAt: 0,
        quoteTotal: 1006, quoteIssueCount: 0, reasons: [reason] }} />);
    expect(screen.getByLabelText(label)).toHaveClass(/liveDegraded/);
  });

  it('keeps the combined performance entry active for both subpages', () => {
    const { rerender } = render(
      <Header fxRates={new Map()} activePage="ranking" onPageChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: '走势' })).toHaveAttribute('aria-current', 'page');

    rerender(<Header fxRates={new Map()} activePage="history" onPageChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '走势' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: '风险' })).not.toBeInTheDocument();
  });

  it('shows an offline status before the first status response', () => {
    render(<Header fxRates={new Map()} activePage="overview" onPageChange={vi.fn()} />);
    expect(screen.getByLabelText('服务状态暂不可用')).toHaveClass(/liveOffline/);
  });

  it('hides market metadata on the about page', () => {
    render(
      <Header
        fxRates={new Map()}
        activePage="about"
        onPageChange={vi.fn()}
        showMarketMeta={false}
      />,
    );
    expect(screen.queryByText(/北京时间/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('服务状态暂不可用')).not.toBeInTheDocument();
  });

  it('hides live market metadata on the offline financial-report page', () => {
    render(
      <Header
        fxRates={new Map()}
        activePage="companies"
        onPageChange={vi.fn()}
        showMarketMeta={false}
      />,
    );
    expect(screen.queryByText(/北京时间/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('服务状态暂不可用')).not.toBeInTheDocument();
  });

  it('shows only USD and EUR in the global exchange-rate summary', () => {
    const rate = (currency: string) => ({
      currency,
      pair: `${currency}/CNY`,
      rate: 7,
      changePercent: 0,
      date: '2026-07-23',
      fetchedAt: 1,
    });
    render(
      <Header
        fxRates={new Map([
          ['USD', rate('USD')],
          ['EUR', rate('EUR')],
          ['JPY', rate('JPY')],
          ['KRW', rate('KRW')],
          ['HKD', rate('HKD')],
        ])}
        activePage="overview"
        onPageChange={vi.fn()}
      />,
    );
    expect(screen.getByText('USD/CNY')).toBeInTheDocument();
    expect(screen.getByText('EUR/CNY')).toBeInTheDocument();
    expect(screen.queryByText('JPY/CNY')).not.toBeInTheDocument();
    expect(screen.queryByText('KRW/CNY')).not.toBeInTheDocument();
    expect(screen.queryByText('HKD/CNY')).not.toBeInTheDocument();
  });
});
