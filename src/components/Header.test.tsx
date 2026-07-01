import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Header from './Header';

describe('Header', () => {
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
});
