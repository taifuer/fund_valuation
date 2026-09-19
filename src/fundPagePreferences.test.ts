import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFundPageFilter, storeFundPageFilter } from './fundPagePreferences';

describe('fund page filter preferences', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('defaults to active without a valid link or remembered choice', () => {
    expect(readFundPageFilter('')).toBe('active');
    expect(readFundPageFilter('?strategy=unknown')).toBe('active');
    localStorage.setItem('fund_valuation:fund_page_filter', 'unknown');
    expect(readFundPageFilter('')).toBe('active');
  });

  it.each(['active', 'index', 'all'] as const)('restores the remembered %s choice', filter => {
    storeFundPageFilter(filter);
    expect(readFundPageFilter('')).toBe(filter);
    expect(readFundPageFilter('?strategy=unknown')).toBe(filter);
  });

  it('gives explicit links priority over the remembered filter', () => {
    storeFundPageFilter('index');
    expect(readFundPageFilter('?strategy=all')).toBe('all');
    expect(readFundPageFilter('?strategy=active&tab=history')).toBe('active');
    expect(readFundPageFilter('')).toBe('index');
  });

  it('uses links and the active default when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readFundPageFilter('')).toBe('active');
    expect(readFundPageFilter('?strategy=all')).toBe('all');
    expect(() => storeFundPageFilter('index')).not.toThrow();
  });
});
