import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PageErrorBoundary from './PageErrorBoundary';
import { updatePageMetadata } from '../pageMetadata';

describe('page recovery', () => {
  it('keeps navigation usable after a rejected lazy import and resets on navigation', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never { throw new Error('Failed to fetch dynamically imported module'); }
    try {
      const { rerender } = render(<><a href="/">概览</a><PageErrorBoundary key="failed"><Broken /></PageErrorBoundary></>);
      expect(screen.getByRole('alert')).toHaveTextContent('页面暂时无法显示');
      expect(screen.getByRole('button', { name: '刷新页面' })).toBeVisible();
      expect(screen.getByRole('link', { name: '概览' })).toHaveAttribute('href', '/');
      rerender(<PageErrorBoundary key="new"><p>可用页面</p></PageErrorBoundary>);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('可用页面')).toBeVisible();
    } finally { log.mockRestore(); }
  });

  it('updates page titles and descriptions without requests', () => {
    const meta = document.createElement('meta');
    meta.name = 'description';
    document.head.append(meta);
    updatePageMetadata('companies');
    expect(document.title).toBe('公司经营趋势 · 全球资产看板');
    expect(meta.content).toContain('公司经营趋势');
    meta.remove();
  });
});
