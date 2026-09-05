import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Header from './Header';

describe('Header', () => {
  it('keeps one live region for loading updates without inserting another row', () => {
    const props = { fxRates: new Map(), activePage: 'overview' as const, onPageChange: vi.fn() };
    const { rerender } = render(<Header {...props} />);
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    rerender(<Header {...props} statusMessage="行情数据加载中..." />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('行情数据加载中...');
    expect(region).toHaveAttribute('title', '行情数据加载中...');
    rerender(<Header {...props} />);
    expect(region).toBeEmptyDOMElement();
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
    fireEvent.click(screen.getByRole('button', { name: '关于' }));
    expect(onPageChange).toHaveBeenCalledWith('about');
    fireEvent.click(screen.getByRole('button', { name: '公司' }));
    expect(onPageChange).toHaveBeenCalledWith('companies');
    fireEvent.click(screen.getByRole('button', { name: '收益' }));
    expect(onPageChange).toHaveBeenCalledWith('ranking');
  });

  it('keeps the combined performance entry active for both subpages', () => {
    const { rerender } = render(
      <Header fxRates={new Map()} activePage="ranking" onPageChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: '收益' })).toHaveAttribute('aria-current', 'page');

    rerender(<Header fxRates={new Map()} activePage="risk" onPageChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '收益' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: '风险' })).not.toBeInTheDocument();
  });

  it('shows an offline status before the first status response', () => {
    render(<Header fxRates={new Map()} activePage="overview" onPageChange={vi.fn()} />);
    expect(screen.getByLabelText('数据状态暂不可用')).toHaveClass(/liveOffline/);
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
    expect(screen.queryByLabelText('数据状态暂不可用')).not.toBeInTheDocument();
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
    expect(screen.queryByLabelText('数据状态暂不可用')).not.toBeInTheDocument();
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
