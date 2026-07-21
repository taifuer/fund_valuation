export interface FuturesQuoteLike {
  price: number;
  fetchedAt: number;
  dateReliable?: boolean;
  time?: string;
}

export const FUTURES_QUOTE_FRESH_MS = 3 * 60_000;

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
  now = Date.now(),
  freshMs = FUTURES_QUOTE_FRESH_MS,
}: {
  spot?: FuturesQuoteLike;
  futures?: FuturesQuoteLike;
  spotState: string;
  futuresState: string;
  now?: number;
  freshMs?: number;
}): boolean {
  if (!futures) return false;
  if (futuresState !== 'live') return false;
  if (now - futures.fetchedAt >= freshMs) return false;
  if (!spot) return true;
  const beijingToday = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const spotDate = spot.time?.slice(0, 10) ?? '';
  const spotIsCurrentDay = spotDate === beijingToday;
  if (spotState === 'live' && spot.dateReliable !== false && (!spotDate || spotIsCurrentDay)) return false;
  return futuresPriceComparable(spot, futures);
}
