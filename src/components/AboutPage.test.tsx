import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AboutPage from './AboutPage';

describe('AboutPage', () => {
  it('shows public information, feedback, and date-based updates', () => {
    render(<AboutPage />);

    expect(screen.getByRole('heading', { name: '关于本站' })).toBeInTheDocument();
    expect(screen.queryByText('全球市场、ETF 与 QDII 基金的数据观察工具')).not.toBeInTheDocument();
    expect(screen.getByText('项目源码')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'taifu@taifua.com' })).toHaveAttribute('href', 'mailto:taifu@taifua.com');
    expect(screen.getByRole('heading', { name: '更新记录' })).toBeInTheDocument();
    expect(screen.getByText('2026年8月')).toBeInTheDocument();
    expect(screen.queryByText(/v2\./)).not.toBeInTheDocument();
  });
});
