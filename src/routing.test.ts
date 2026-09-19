import { describe, expect, it } from 'vitest';
import { canonicalizePageLocation, choiceFromSearch, expandedFundCodeFromPathname, pageFromPathname, rememberPageSearch, restoredPagePath } from './routing';

describe('routing', () => {
  it('keeps independent filters when navigating between pages', () => {
    window.history.replaceState({}, '', '/returns?category=etf&range=1m');
    rememberPageSearch();
    window.history.replaceState({}, '', '/history?range=5');
    rememberPageSearch();
    expect(restoredPagePath('ranking')).toBe('/returns?category=etf&range=1m');
    expect(restoredPagePath('history')).toBe('/history?range=5');
  });
  it('keeps canonical page routes on refresh', () => {
    expect(pageFromPathname('/')).toBe('overview');
    expect(pageFromPathname('/funds')).toBe('funds');
    expect(pageFromPathname('/companies')).toBe('companies');
    expect(pageFromPathname('/returns')).toBe('ranking');
    expect(pageFromPathname('/risk')).toBe('ranking');
    expect(pageFromPathname('/history')).toBe('history');
    expect(pageFromPathname('/about')).toBe('about');
    expect(pageFromPathname('/diagnostics')).toBe('diagnostics');
  });

  it('redirects old risk links with their original defaults and filters', () => {
    window.history.replaceState({}, '', '/risk?category=etf&etf=sector#table');
    expect(canonicalizePageLocation()).toBe('ranking');
    expect(window.location.pathname).toBe('/returns');
    expect(window.location.search).toBe('?category=etf&etf=sector&range=ytd&sort=drawdown');
    expect(window.location.hash).toBe('#table');
    canonicalizePageLocation();
    expect(window.location.search).toContain('range=ytd&sort=drawdown');

    window.history.replaceState({}, '', '/risk?range=1m&sort=winRate&order=asc');
    canonicalizePageLocation();
    expect(window.location.search).toBe('?range=1m&sort=winRate&order=asc');
  });

  it('preserves alias query strings and fund deep links', () => {
    window.history.replaceState({}, '', '/ranking?category=asset&range=1y');
    canonicalizePageLocation();
    expect(window.location.pathname + window.location.search).toBe('/returns?category=asset&range=1y');
    window.history.replaceState({}, '', '/funds/016664?tab=history');
    expect(canonicalizePageLocation()).toBe('funds');
    expect(window.location.pathname + window.location.search).toBe('/funds/016664?tab=history');
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
