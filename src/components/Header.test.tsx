import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Header from './Header';

describe('Header', () => {
  it('describes the dashboard coverage in the brand subtitle', () => {
    render(<Header fxRates={new Map()} activePage="overview" onPageChange={vi.fn()} />);
    expect(screen.getByText('Markets · ETFs · QDII Funds')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: '风险' }));
    expect(onPageChange).toHaveBeenCalledWith('risk');
  });

  it('shows an offline status before the first status response', () => {
    render(<Header fxRates={new Map()} activePage="overview" onPageChange={vi.fn()} />);
    expect(screen.getByLabelText('数据状态暂不可用')).toHaveClass(/liveOffline/);
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
