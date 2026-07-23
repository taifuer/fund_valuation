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

  it('keeps a live future between two-minute worker refreshes', () => {
    expect(shouldUseFuturesQuote({
      spot: { price: 70000, fetchedAt: now, time: '2026-06-27 04:00:00', dateReliable: true },
      futures: { price: 70020, fetchedAt: now - 2 * 60_000 },
      spotState: 'closed',
      futuresState: 'live',
      now,
    })).toBe(true);
  });

  it('keeps a future within the five-minute entry window', () => {
    expect(shouldUseFuturesQuote({
      spot: { price: 70000, fetchedAt: now, time: '2026-06-27 04:00:00', dateReliable: true },
      futures: { price: 70020, fetchedAt: now - 4 * 60_000 },
      spotState: 'closed',
      futuresState: 'live',
      now,
    })).toBe(true);
  });

  it('does not enter futures mode with a quote beyond the fresh window', () => {
    expect(shouldUseFuturesQuote({
      spot: { price: 70000, fetchedAt: now, time: '2026-06-27 04:00:00', dateReliable: true },
      futures: { price: 70020, fetchedAt: now - 6 * 60_000 },
      spotState: 'closed',
      futuresState: 'live',
      now,
    })).toBe(false);
  });

  it('keeps the selected future through a short refresh delay', () => {
    expect(shouldUseFuturesQuote({
      spot: { price: 70000, fetchedAt: now, time: '2026-06-27 04:00:00', dateReliable: true },
      futures: { price: 70020, fetchedAt: now - 6 * 60_000 },
      spotState: 'closed',
      futuresState: 'live',
      wasUsingFutures: true,
      now,
    })).toBe(true);
  });

  it('drops the selected future after the grace window', () => {
    expect(shouldUseFuturesQuote({
      spot: { price: 70000, fetchedAt: now, time: '2026-06-27 04:00:00', dateReliable: true },
      futures: { price: 70020, fetchedAt: now - 8 * 60_000 },
      spotState: 'closed',
      futuresState: 'live',
      wasUsingFutures: true,
      now,
    })).toBe(false);
  });

  it('rejects an unavailable-spot future after the grace window', () => {
    expect(shouldUseFuturesQuote({
      futures: { price: 70020, fetchedAt: now - 8 * 60_000 },
      spotState: 'closed',
      futuresState: 'live',
      wasUsingFutures: true,
      now,
    })).toBe(false);
  });

  it('switches immediately when the futures session closes', () => {
    expect(shouldUseFuturesQuote({
      spot: { price: 70000, fetchedAt: now, time: '2026-06-27 04:00:00', dateReliable: true },
      futures: { price: 70020, fetchedAt: now - 6 * 60_000 },
      spotState: 'closed',
      futuresState: 'closed',
      wasUsingFutures: true,
      now,
    })).toBe(false);
  });

  it('rejects an incomparable future even during the grace window', () => {
    expect(shouldUseFuturesQuote({
      spot: { price: 70000, fetchedAt: now, time: '2026-06-27 04:00:00', dateReliable: true },
      futures: { price: 40000, fetchedAt: now - 6 * 60_000 },
      spotState: 'closed',
      futuresState: 'live',
      wasUsingFutures: true,
      now,
    })).toBe(false);
  });
});
