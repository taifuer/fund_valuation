export interface FuturesQuoteLike {
  price: number;
  fetchedAt: number;
  dateReliable?: boolean;
}

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
  freshMs = 90_000,
}: {
  spot?: FuturesQuoteLike;
  futures?: FuturesQuoteLike;
  spotState: string;
  futuresState: string;
  now?: number;
  freshMs?: number;
}): boolean {
  if (spotState === 'live') return false;
  if (!spot || !futures || futuresState !== 'live') return false;
  if (now - futures.fetchedAt >= freshMs) return false;
  return futuresPriceComparable(spot, futures) || spot.dateReliable === false;
}
