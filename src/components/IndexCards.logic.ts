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

/**
 * Indices whose Sina spot source is known to return wrong values (e.g.
 * int_nikkei returns ~44946 while the real Nikkei 225 is ~69000). For these we
 * always prefer the futures quote regardless of session/price-comparability.
 */
export const UNRELIABLE_SPOT_SYMBOLS = new Set(['int_nikkei']);

export function shouldUseFuturesQuote({
  spot,
  futures,
  spotState,
  futuresState,
  now = Date.now(),
  freshMs = 90_000,
  spotSymbol,
}: {
  spot?: FuturesQuoteLike;
  futures?: FuturesQuoteLike;
  spotState: string;
  futuresState: string;
  now?: number;
  freshMs?: number;
  spotSymbol?: string;
}): boolean {
  if (!spot || !futures) return false;
  // Known-bad spot source: always prefer futures when available, regardless of
  // session or freshness — the spot value is wrong, so even a stale futures
  // quote is more accurate.
  if (spotSymbol && UNRELIABLE_SPOT_SYMBOLS.has(spotSymbol)) {
    return true;
  }
  if (spotState === 'live') return false;
  if (futuresState !== 'live') return false;
  if (now - futures.fetchedAt >= freshMs) return false;
  return futuresPriceComparable(spot, futures) || spot.dateReliable === false;
}
