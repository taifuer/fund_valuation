import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DataNotice from './DataNotice';

describe('DataNotice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('only announces slow loading and disappears when data arrives', () => {
    const { rerender } = render(<DataNotice loading message="加载中" />);
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status')).toHaveTextContent('加载中');
    rerender(<DataNotice loading={false} message="加载中" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<DataNotice loading message="加载中" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('does not flash for fast requests or leave a timer after unmounting', () => {
    const { rerender, unmount } = render(<DataNotice loading message="加载中" />);
    act(() => vi.advanceTimersByTime(100));
    rerender(<DataNotice loading={false} message="加载中" />);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<DataNotice loading message="加载中" />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows errors immediately, including failures while cached data is displayed', () => {
    const { rerender } = render(<DataNotice loading message="加载中" error="请求失败" />);
    expect(screen.getByRole('alert')).toHaveTextContent('请求失败');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    rerender(<DataNotice loading={false} message="加载中" error="刷新失败" />);
    expect(screen.getByRole('alert')).toHaveTextContent('刷新失败');
    rerender(<DataNotice loading message="加载中" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
