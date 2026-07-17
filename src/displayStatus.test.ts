import { describe, expect, it } from 'vitest';
import { quoteDisplayState, quoteIsFresh } from './displayStatus';
import type { QuoteData } from './types';

const NOW = new Date('2026-07-18T00:10:00+08:00').getTime();

function quote(symbol: string, ageMinutes: number, quoteTime = '2026-07-18 00:09:00'): QuoteData {
  return {
    symbol,
    name: symbol,
    price: 100,
    previousClose: 99,
    change: 1,
    changePercent: 1.01,
    time: quoteTime,
    dateReliable: true,
    fetchedAt: NOW - ageMinutes * 60_000,
  };
}

describe('quote freshness', () => {
  it('treats one to two minute cash quote lag as normal', () => {
    expect(quoteIsFresh(quote('gb_ixic', 2), NOW)).toBe(true);
    expect(quoteIsFresh(quote('gb_ixic', 3.1), NOW)).toBe(false);
  });

  it('uses wider thresholds for futures and crypto refresh schedules', () => {
    expect(quoteIsFresh(quote('hf_NQ', 3.5), NOW)).toBe(true);
    expect(quoteIsFresh(quote('hf_NQ', 4.1), NOW)).toBe(false);
    expect(quoteIsFresh(quote('fx_sbtcusd', 6), NOW)).toBe(true);
    expect(quoteIsFresh(quote('fx_sbtcusd', 7.1), NOW)).toBe(false);
  });

  it('checks the upstream quote time and stale futures before showing LIVE', () => {
    const staleCash = quote('gb_ixic', 0, '2026-07-18 00:06:00');
    const staleFuture = quote('hf_NQ', 4.1);
    expect(quoteIsFresh(staleCash, NOW)).toBe(false);
    expect(quoteDisplayState({ quote: staleFuture, marketState: 'live', futuresLive: true })).toBe('stale');
  });
});
