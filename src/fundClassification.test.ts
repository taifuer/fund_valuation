import { describe, expect, it } from 'vitest';
import { FUNDS } from './constants';
import { fundStrategyLabel, matchesFundFilter } from './fundClassification';

describe('fund strategy classification', () => {
  it('classifies every default fund without using its name or estimate mode', () => {
    expect(FUNDS.filter(fund => matchesFundFilter(fund, 'active'))).toHaveLength(16);
    expect(FUNDS.filter(fund => matchesFundFilter(fund, 'index'))).toHaveLength(10);
    expect(FUNDS.find(fund => fund.code === '017436')?.strategy).toBe('active');
    for (const code of ['017091', '161128']) {
      const fund = FUNDS.find(item => item.code === code)!;
      expect(fund.strategy).toBe('index');
      expect(fund.estimateMode).toBe('official');
      expect(fund.trackingIndex).toBeTruthy();
    }
  });

  it('adds distinct official-only RMB index funds without duplicate share classes', () => {
    const codes = ['270042', '160213', '050025', '161125', '040046', '000834', '016532', '007721'];
    expect(new Set(FUNDS.map(fund => fund.code)).size).toBe(FUNDS.length);
    for (const code of codes) {
      expect(FUNDS.find(fund => fund.code === code)).toMatchObject({ strategy: 'index', estimateMode: 'official', holdings: [] });
    }
    expect(FUNDS.filter(fund => fund.estimateMode === 'official')).toHaveLength(10);
    expect(FUNDS.filter(fund => fund.strategy === 'index').every(fund => fund.estimateMode === 'official')).toBe(true);
    expect(FUNDS.filter(fund => fund.strategy === 'active').every(fund => fund.estimateMode !== 'official')).toBe(true);
    expect(FUNDS.find(fund => fund.code === '007721')?.trackingIndex).toBe('标普500指数');
  });

  it('keeps unverified custom funds in all without guessing a strategy', () => {
    expect(matchesFundFilter({}, 'all')).toBe(true);
    expect(matchesFundFilter({}, 'active')).toBe(false);
    expect(matchesFundFilter({}, 'index')).toBe(false);
    expect(fundStrategyLabel({})).toBe('未分类基金');
  });
});
