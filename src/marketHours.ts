import holidaysData from '../data/holidays.json';

interface Session {
  start: [number, number];
  end: [number, number];
}

interface MarketCalendar {
  timezone: string;
  sessions: Session[];
  holidays: (year: string) => Set<string>;
  halfDays: (year: string) => Record<string, Session[]>;
}

interface FuturesCalendar {
  timezone: string;
  sessions: Session[];
  holidays: (year: string) => Set<string>;
}

// Holiday data is loaded from data/holidays.json (shared with the backend) so
// adding a new year is a data edit, not a code change. Unknown years fall back
// to an empty set (weekend-only detection) — the calendar degrades gracefully
// instead of breaking on Jan 1.
type HolidaysJson = {
  years: Record<string, Record<string, {
    holidays?: string[];
    halfDays?: Record<string, [string, string][]>;
  }>>;
};
const HOLIDAYS_BY_YEAR = (holidaysData as unknown as HolidaysJson).years;

function parseHHMM(value: string): [number, number] {
  const [h, m] = value.split(':').map(Number);
  return [h, m];
}

const holidayCache = new Map<string, Set<string>>();
function holidaysFor(market: string, year: string): Set<string> {
  const cacheKey = `${market}:${year}`;
  const cached = holidayCache.get(cacheKey);
  if (cached) return cached;
  const list = HOLIDAYS_BY_YEAR[year]?.[market]?.holidays ?? [];
  const set = new Set(list);
  holidayCache.set(cacheKey, set);
  return set;
}

function halfDaysFor(market: string, year: string): Record<string, Session[]> {
  const raw = HOLIDAYS_BY_YEAR[year]?.[market]?.halfDays ?? {};
  const result: Record<string, Session[]> = {};
  for (const [date, sessions] of Object.entries(raw)) {
    result[date] = sessions.map(([start, end]) => ({ start: parseHHMM(start), end: parseHHMM(end) }));
  }
  return result;
}

const MARKETS: Record<string, MarketCalendar> = {
  cn: {
    timezone: 'Asia/Shanghai',
    sessions: [
      { start: [9, 30], end: [11, 30] },
      { start: [13, 0], end: [15, 0] },
    ],
    holidays: (year) => holidaysFor('cn', year),
    halfDays: () => ({}),
  },
  hk: {
    timezone: 'Asia/Hong_Kong',
    sessions: [
      { start: [9, 30], end: [12, 0] },
      { start: [13, 0], end: [16, 10] },
    ],
    holidays: (year) => holidaysFor('hk', year),
    halfDays: (year) => halfDaysFor('hk', year),
  },
  us: {
    timezone: 'America/New_York',
    sessions: [{ start: [9, 30], end: [16, 0] }],
    holidays: (year) => holidaysFor('us', year),
    halfDays: (year) => halfDaysFor('us', year),
  },
  jp: {
    timezone: 'Asia/Tokyo',
    sessions: [
      { start: [9, 0], end: [11, 30] },
      { start: [12, 30], end: [15, 30] },
    ],
    holidays: (year) => holidaysFor('jp', year),
    halfDays: () => ({}),
  },
  kr: {
    timezone: 'Asia/Seoul',
    sessions: [{ start: [9, 0], end: [15, 30] }],
    holidays: (year) => holidaysFor('kr', year),
    halfDays: () => ({}),
  },
  tw: {
    timezone: 'Asia/Taipei',
    sessions: [{ start: [9, 0], end: [13, 30] }],
    holidays: (year) => holidaysFor('tw', year),
    halfDays: () => ({}),
  },
};

const FUTURES_MARKETS: Record<string, FuturesCalendar> = {
  hk_futures: {
    timezone: 'Asia/Hong_Kong',
    sessions: [
      { start: [9, 15], end: [12, 0] },
      { start: [13, 0], end: [16, 30] },
      { start: [17, 15], end: [3, 0] },
    ],
    holidays: (year) => holidaysFor('hk', year),
  },
  jp_futures: {
    timezone: 'Asia/Tokyo',
    sessions: [
      { start: [7, 30], end: [14, 25] },
      { start: [14, 55], end: [5, 15] },
    ],
    holidays: (year) => holidaysFor('jp', year),
  },
};

interface ZonedNow {
  date: string;
  weekday: string;
  minutes: number;
}

function zonedNow(timezone: string, date = new Date()): ZonedNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    hour12: false,
  }).formatToParts(date);

  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));

  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    weekday: value('weekday'),
    minutes: hour * 60 + minute,
  };
}

function isInSession(sessions: Session[], minutes: number): boolean {
  return sessions.some((s) => {
    const start = s.start[0] * 60 + s.start[1];
    const end = s.end[0] * 60 + s.end[1];
    return minutes >= start && minutes < end;
  });
}

function isBetweenSessions(sessions: Session[], minutes: number): boolean {
  const ordered = sessions
    .map((s) => ({
      start: s.start[0] * 60 + s.start[1],
      end: s.end[0] * 60 + s.end[1],
    }))
    .filter((s) => s.start < s.end)
    .sort((a, b) => a.start - b.start);

  return ordered.some((session, index) => {
    const next = ordered[index + 1];
    return next ? minutes >= session.end && minutes < next.start : false;
  });
}

function isWeekday(weekday: string): boolean {
  return weekday !== 'Sat' && weekday !== 'Sun';
}

function isWeekend(weekday: string): boolean {
  return weekday === 'Sat' || weekday === 'Sun';
}

function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function previousWeekday(weekday: string): string {
  const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const index = order.indexOf(weekday);
  return order[(index + 6) % 7];
}

function isTradingDate(date: string, weekday: string, holidays: Set<string>): boolean {
  return isWeekday(weekday) && !holidays.has(date);
}

function isInFuturesSession(calendar: FuturesCalendar, local: ZonedNow): boolean {
  const holidays = calendar.holidays(local.date.slice(0, 4));
  return calendar.sessions.some((s) => {
    const start = s.start[0] * 60 + s.start[1];
    const end = s.end[0] * 60 + s.end[1];

    if (start < end) {
      return (
        local.minutes >= start &&
        local.minutes < end &&
        isTradingDate(local.date, local.weekday, holidays)
      );
    }

    if (local.minutes >= start) {
      return isTradingDate(local.date, local.weekday, holidays);
    }

    if (local.minutes < end) {
      const prevDate = previousDate(local.date);
      const prevWeekday = previousWeekday(local.weekday);
      // prevDate may fall in the prior calendar year (e.g. Jan 1 -> Dec 31);
      // look up its own year's holidays so a Dec-31 holiday is honored.
      const prevHolidays = calendar.holidays(prevDate.slice(0, 4));
      return isTradingDate(prevDate, prevWeekday, prevHolidays);
    }

    return false;
  });
}

function futuresMarketKey(sinaSymbol: string): string | null {
  if (
    sinaSymbol === 'hf_NQ' ||
    sinaSymbol === 'hf_ES' ||
    sinaSymbol === 'hf_YM' ||
    sinaSymbol === 'hf_GC' ||
    sinaSymbol === 'hf_SI' ||
    sinaSymbol === 'hf_CL'
  ) return 'us_futures';
  if (sinaSymbol === 'hf_HSI') return 'hk_futures';
  if (sinaSymbol === 'hf_NK') return 'jp_futures';
  return null;
}

function marketKey(sinaSymbol: string): string | null {
  const futuresKey = futuresMarketKey(sinaSymbol);
  if (futuresKey) return futuresKey;
  if (sinaSymbol.startsWith('gb_')) return 'us';
  if (sinaSymbol.startsWith('hk')) return 'hk';
  if (sinaSymbol.startsWith('s_') || /^(sz|sh)\d/.test(sinaSymbol)) return 'cn';
  if (sinaSymbol === 'int_nikkei') return 'jp';
  if (sinaSymbol === 'b_KOSPI') return 'kr';
  if (sinaSymbol === 'b_TWSE') return 'tw';
  if (sinaSymbol === 'fx_sbtcusd') return 'crypto';
  return null;
}

export type MarketState = 'live' | 'break' | 'closed' | 'holiday' | 'weekend';

const FUTURES_TIMEZONE: Record<string, string> = {
  us_futures: 'America/New_York',
  hk_futures: 'Asia/Hong_Kong',
  jp_futures: 'Asia/Tokyo',
};

/**
 * Return the market-local calendar date (YYYY-MM-DD) for a Sina quote whose
 * `time` field is a Beijing-time string ("YYYY-MM-DD HH:MM:SS"). Used to tell
 * whether a quote represents a trading day strictly after the fund's official
 * NAV date — a quote whose trading day is on or before navDate has already
 * been baked into that NAV and must not be re-added to the T-day estimate.
 */
export function marketLocalDate(sinaSymbol: string, beijingTime: string): string | null {
  const key = marketKey(sinaSymbol);
  if (!key) return null;
  const tz = FUTURES_TIMEZONE[key] ?? MARKETS[key]?.timezone;
  if (!tz) return null;
  const d = new Date(`${beijingTime.replace(' ', 'T')}+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Last regular-session end minute-of-day for a market (the official close). */
function marketRegularCloseMinutes(key: string): number | null {
  // Futures markets trade overnight; their "close" semantics differ and they
  // are not fund holdings, so this is only meaningful for equity markets.
  const calendar = MARKETS[key];
  if (!calendar) return null;
  let maxEnd = -1;
  for (const s of calendar.sessions) {
    // Only count same-day sessions (start < end); ignore overnight legs.
    if (s.start[0] * 60 + s.start[1] < s.end[0] * 60 + s.end[1]) {
      maxEnd = Math.max(maxEnd, s.end[0] * 60 + s.end[1]);
    }
  }
  return maxEnd >= 0 ? maxEnd : null;
}

/**
 * Decide whether a quote's market-local timestamp reflects information strictly
 * AFTER the official NAV date's regular close — i.e. it carries new information
 * not already baked into the navDate NAV and should be counted toward the T-day
 * estimate.
 *
 * - Trading day strictly after navDate  → true (next day's pre/regular/post)
 * - Trading day == navDate, time after regular close → true (after-hours)
 * - Trading day == navDate, at or before regular close → false (already in NAV)
 * - Trading day before navDate → false (stale)
 *
 * Returns null when the decision cannot be made reliably (unknown market,
 * unparseable time, no regular close known) — callers should treat null as
 * "keep" (don't drop a possibly-fresh quote on a technicality).
 */
export function quoteIsAfterNavClose(
  sinaSymbol: string,
  beijingTime: string,
  navDate: string,
): boolean | null {
  const key = marketKey(sinaSymbol);
  if (!key) return null;
  const tz = FUTURES_TIMEZONE[key] ?? MARKETS[key]?.timezone;
  if (!tz) return null;
  const d = new Date(`${beijingTime.replace(' ', 'T')}+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', hour12: false,
  }).formatToParts(d);
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const localDate = `${v('year')}-${v('month')}-${v('day')}`;
  const localMinutes = Number(v('hour')) * 60 + Number(v('minute'));

  if (localDate > navDate) return true;
  if (localDate < navDate) return false;
  // Same day as navDate: count only if the quote time is after the regular
  // close (after-hours session). A regular-session or pre-market quote on
  // navDate itself was already reflected in the official NAV.
  const closeMinutes = marketRegularCloseMinutes(key);
  if (closeMinutes == null) return null;
  return localMinutes > closeMinutes;
}

export function getMarketState(sinaSymbol: string, now = new Date()): MarketState {
  const key = marketKey(sinaSymbol);
  if (!key) return 'closed';

  if (key === 'us_futures') {
    const local = zonedNow('America/New_York', now);
    const maintenanceStart = 17 * 60;
    const maintenanceEnd = 18 * 60;

    if (local.weekday === 'Sat') return 'weekend';
    if (local.weekday === 'Sun') return local.minutes >= maintenanceEnd ? 'live' : 'closed';
    if (local.weekday === 'Fri') return local.minutes < maintenanceStart ? 'live' : 'closed';
    if (local.minutes >= maintenanceStart && local.minutes < maintenanceEnd) return 'closed';
    return 'live';
  }

  if (key === 'hk_futures' || key === 'jp_futures') {
    const calendar = FUTURES_MARKETS[key];
    const local = zonedNow(calendar.timezone, now);
    if (isInFuturesSession(calendar, local)) return 'live';
    if (isWeekend(local.weekday)) return 'weekend';
    if (calendar.holidays(local.date.slice(0, 4)).has(local.date)) return 'holiday';
    return 'closed';
  }

  if (key === 'crypto') return 'live';

  const calendar = MARKETS[key];
  const local = zonedNow(calendar.timezone, now);
  if (isWeekend(local.weekday)) return 'weekend';
  if (calendar.holidays(local.date.slice(0, 4)).has(local.date)) return 'holiday';

  const sessions = calendar.halfDays(local.date.slice(0, 4))[local.date] ?? calendar.sessions;
  if (isInSession(sessions, local.minutes)) return 'live';
  return isBetweenSessions(sessions, local.minutes) ? 'break' : 'closed';
}

/**
 * Polling interval policy (plan B): 60s when any tracked symbol is live,
 * 5min when everything is closed/holiday/weekend. Driven by marketStates
 * (from the backend) with a getMarketState fallback for symbols not in the map.
 */
export const POLL_INTERVAL_LIVE_MS = 60_000;
export const POLL_INTERVAL_CLOSED_MS = 5 * 60_000;

export function pickPollInterval(
  symbols: string[],
  marketStates: Map<string, { state?: string }>,
  now = new Date(),
): number {
  for (const symbol of symbols) {
    const state = marketStates.get(symbol)?.state ?? getMarketState(symbol, now);
    if (state === 'live' || state === 'pre' || state === 'post' || state === 'break') {
      return POLL_INTERVAL_LIVE_MS;
    }
  }
  return POLL_INTERVAL_CLOSED_MS;
}
