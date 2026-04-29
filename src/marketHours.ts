// Trading sessions in Beijing time (UTC+8)
interface Session { start: [number, number]; end: [number, number] }

const SESSIONS: Record<string, Session[]> = {
  cn: [
    { start: [9, 30], end: [11, 30] },
    { start: [13, 0], end: [15, 0] },
  ],
  hk: [
    { start: [9, 30], end: [12, 0] },
    { start: [13, 0], end: [16, 0] },
  ],
  us: [
    // 9:30 AM ET = 21:30 Beijing (EDT); close 4:00 PM ET = 04:00 Beijing next day → 28:00
    { start: [21, 30], end: [28, 0] },
  ],
  jp: [
    { start: [8, 0], end: [10, 0] },
    { start: [11, 30], end: [14, 0] },
  ],
  kr: [{ start: [8, 0], end: [14, 0] }],
  tw: [{ start: [9, 0], end: [13, 30] }],
};

// Current Beijing time as minutes since midnight (0-1439)
function beijingMinutes(): number {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return bj.getUTCHours() * 60 + bj.getUTCMinutes();
}

function isInSession(sessions: Session[]): boolean {
  const mins = beijingMinutes();
  return sessions.some((s) => {
    const start = s.start[0] * 60 + s.start[1];
    const end = s.end[0] * 60 + s.end[1];
    return mins >= start && mins < end;
  });
}

// Map sinaSymbol prefix to market key
function marketKey(sinaSymbol: string): string | null {
  if (sinaSymbol.startsWith('gb_')) return 'us';
  if (sinaSymbol.startsWith('hk')) return 'hk';
  if (sinaSymbol.startsWith('s_') || /^(sz|sh)\d/.test(sinaSymbol)) return 'cn';
  if (sinaSymbol === 'int_nikkei') return 'jp';
  if (sinaSymbol === 'b_KOSPI') return 'kr';
  if (sinaSymbol === 'b_TWSE') return 'tw';
  return null;
}

export type MarketState = 'live' | 'closed';

export function getMarketState(sinaSymbol: string): MarketState {
  const key = marketKey(sinaSymbol);
  if (!key || !SESSIONS[key]) return 'closed';
  return isInSession(SESSIONS[key]) ? 'live' : 'closed';
}
