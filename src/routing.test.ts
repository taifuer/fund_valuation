import { describe, expect, it } from 'vitest';
import { choiceFromSearch, expandedFundCodeFromPathname, pageFromPathname } from './routing';

describe('routing', () => {
  it('keeps canonical page routes on refresh', () => {
    expect(pageFromPathname('/')).toBe('overview');
    expect(pageFromPathname('/funds')).toBe('funds');
    expect(pageFromPathname('/companies')).toBe('companies');
    expect(pageFromPathname('/returns')).toBe('ranking');
    expect(pageFromPathname('/risk')).toBe('risk');
    expect(pageFromPathname('/about')).toBe('about');
    expect(pageFromPathname('/diagnostics')).toBe('diagnostics');
  });

  it('parses fund detail deep links', () => {
    expect(expandedFundCodeFromPathname('/funds/016664')).toBe('016664');
    expect(expandedFundCodeFromPathname('/funds/not-a-code')).toBeNull();
  });

  it('validates shareable filter query parameters', () => {
    expect(choiceFromSearch('?category=etf', 'category', ['index', 'etf'] as const, 'index')).toBe('etf');
    expect(choiceFromSearch('?category=invalid', 'category', ['index', 'etf'] as const, 'index')).toBe('index');
  });
});
