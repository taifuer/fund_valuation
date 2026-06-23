import { getMarketState, type MarketState } from './marketHours';
import type { MarketStateData, QuoteData } from './types';

export type QuoteDisplayState = MarketState | 'futuresLive' | 'pre' | 'post' | 'stale';

export function formatQuoteTime(value: string): string {
  const datetimeMatch = value.match(/^\d{4}-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (datetimeMatch) return `${datetimeMatch[1]}/${datetimeMatch[2]} ${datetimeMatch[3]}:${datetimeMatch[4]}`;
  const dateMatch = value.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return dateMatch ? `${dateMatch[1]}/${dateMatch[2]}` : value || '--';
}

function beijingTimestamp(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const timestamp = new Date(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}+08:00`,
  ).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function quoteIsFresh(quote: QuoteData, now = Date.now()): boolean {
  if (now - quote.fetchedAt >= 90_000) return false;
  if (quote.symbol !== 'fx_sbtcusd') return true;
  const timestamp = beijingTimestamp(quote.time);
  return timestamp != null && Math.abs(now - timestamp) <= 10 * 60 * 1000;
}

export function closeTime(symbol: string): string | null {
  if (symbol.startsWith('s_')) return '15:00';
  if (symbol.startsWith('gb_')) return '04:00';
  if (symbol.startsWith('hk')) return '16:10';
  if (symbol.startsWith('kr')) return '14:30';
  if (symbol.startsWith('sh') || symbol.startsWith('sz')) return '15:00';
  if (symbol === 'int_nikkei') return '14:30';
  if (symbol === 'b_KOSPI') return '14:30';
  if (symbol === 'b_TWSE') return '13:30';
  if (symbol === 'hf_HSI') return '03:00';
  if (symbol === 'hf_NK') return '04:15';
  if (symbol.startsWith('hf_')) return '05:00';
  return null;
}

export function quoteMarketState(
  symbol: string,
  marketStates: Map<string, MarketStateData>,
): MarketState {
  return marketStates.get(symbol)?.state ?? getMarketState(symbol);
}

export function quoteDisplayState({
  quote,
  marketState,
  futuresLive = false,
}: {
  quote: QuoteData;
  marketState: MarketState;
  futuresLive?: boolean;
}): QuoteDisplayState {
  if (futuresLive) return 'futuresLive';
  const fresh = quoteIsFresh(quote);
  if (quote.session === 'pre' && fresh) return 'pre';
  if (quote.session === 'post' && fresh) return 'post';
  if (marketState === 'live' && fresh) return 'live';
  if (marketState === 'live') return 'stale';
  return marketState;
}

export function displayStateLabel(state: QuoteDisplayState): string {
  if (state === 'futuresLive') return '期货 LIVE';
  if (state === 'live') return 'LIVE';
  if (state === 'pre') return '盘前';
  if (state === 'post') return '盘后';
  if (state === 'stale') return '延迟';
  if (state === 'break') return '午间休市';
  if (state === 'holiday') return '假期休市';
  if (state === 'weekend') return '周末休市';
  return '已收盘';
}

export function rankingStateLabel(state: MarketState): string {
  if (state === 'live') return '开盘中';
  return displayStateLabel(state);
}

export function shouldUseCloseTime(state: QuoteDisplayState): boolean {
  return state === 'closed' || state === 'holiday' || state === 'weekend';
}

export function quoteDisplayTime(
  quote: QuoteData,
  state: QuoteDisplayState,
  options: { useCloseTimeWhenClosed?: boolean } = {},
): { label: string; sort: string; estimated: boolean } {
  if (options.useCloseTimeWhenClosed && shouldUseCloseTime(state)) {
    const time = closeTime(quote.symbol);
    const match = quote.time.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (time && match) {
      return {
        label: `${match[2]}/${match[3]} ${time}`,
        sort: `${match[1]}-${match[2]}-${match[3]} ${time}:00`,
        estimated: quote.dateReliable === false,
      };
    }
  }

  return {
    label: formatQuoteTime(quote.time),
    sort: quote.time || String(quote.fetchedAt),
    estimated: quote.dateReliable === false,
  };
}
