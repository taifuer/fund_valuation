export interface FuturesQuoteLike {
  price: number;
  fetchedAt: number;
  dateReliable?: boolean;
  time?: string;
}

export const FUTURES_QUOTE_FRESH_MS = 5 * 60_000;
export const FUTURES_QUOTE_GRACE_MS = 8 * 60_000;

export function futuresPriceComparable(spot?: FuturesQuoteLike, futures?: FuturesQuoteLike): boolean {
  if (!spot || !futures || spot.price <= 0 || futures.price <= 0) return false;
  const ratio = futures.price / spot.price;
  return ratio >= 0.85 && ratio <= 1.15;
}

export function shouldUseFuturesQuote({
  spot,
  futures,
  spotState,
  futuresState,
  wasUsingFutures = false,
  now = Date.now(),
  freshMs = FUTURES_QUOTE_FRESH_MS,
  graceMs = FUTURES_QUOTE_GRACE_MS,
}: {
  spot?: FuturesQuoteLike;
  futures?: FuturesQuoteLike;
  spotState: string;
  futuresState: string;
  wasUsingFutures?: boolean;
  now?: number;
  freshMs?: number;
  graceMs?: number;
}): boolean {
  if (!futures) return false;
  if (futuresState !== 'live') return false;
  const maxAge = wasUsingFutures ? Math.max(graceMs, freshMs) : freshMs;
  if (now - futures.fetchedAt >= maxAge) return false;
  if (!spot) return true;
  const beijingToday = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const spotDate = spot.time?.slice(0, 10) ?? '';
  const spotIsCurrentDay = spotDate === beijingToday;
  if (spotState === 'live' && spot.dateReliable !== false && (!spotDate || spotIsCurrentDay)) return false;
  if (!futuresPriceComparable(spot, futures)) return false;
  return true;
}
