import { describe, expect, it } from 'vitest';
import { shouldUseFuturesQuote } from './IndexCards.logic';

describe('futures quote selection', () => {
  const now = Date.parse('2026-06-29T19:00:00+08:00');

  it('uses a fresh future when spot is unavailable', () => {
    expect(shouldUseFuturesQuote({
      futures: { price: 70020, fetchedAt: now },
      spotState: 'live',
      futuresState: 'live',
      now,
    })).toBe(true);
  });

  it('does not replace a live current-day spot quote', () => {
    expect(shouldUseFuturesQuote({
      spot: { price: 70000, fetchedAt: now, time: '2026-06-29 14:00:00', dateReliable: true },
      futures: { price: 70020, fetchedAt: now },
      spotState: 'live',
      futuresState: 'live',
      now,
    })).toBe(false);
  });
});
