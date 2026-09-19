import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PageHeading from './PageHeading';

describe('PageHeading', () => {
  it('shares a compact title, optional disclosure and view navigation', () => {
    render(<PageHeading title="QDII 基金" description="估算包含汇率影响，不代表官方净值。">
      <nav aria-label="视图">近期</nav>
    </PageHeading>);
    expect(screen.getByRole('heading', { level: 2, name: 'QDII 基金' })).toBeInTheDocument();
    expect(screen.getByText('估算包含汇率影响，不代表官方净值。')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '视图' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not reserve an empty status row without a description', () => {
    const { container } = render(<PageHeading title="资产走势" />);
    expect(container.textContent).toBe('资产走势');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
