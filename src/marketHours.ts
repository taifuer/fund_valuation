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

// Holiday data is keyed by year. Add a new year block here when the year rolls
// over; unknown years fall back to an empty set (weekend-only detection), so
// the calendar degrades gracefully instead of breaking on Jan 1.
const HOLIDAYS_BY_YEAR: Record<string, Record<string, string[]>> = {
  '2026': {
    cn: [
      '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
      '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19',
      '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
    ],
    hk: [
      '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-03', '2026-04-06',
      '2026-04-07', '2026-05-01', '2026-05-25', '2026-07-01', '2026-09-26',
      '2026-10-01', '2026-10-19', '2026-12-25',
    ],
    us: [
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
      '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    ],
    jp: [
      '2026-01-01', '2026-01-02', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20',
      '2026-04-29', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11',
      '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23',
      '2026-12-31',
    ],
    kr: [
      '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-01',
      '2026-05-05', '2026-05-25', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-26',
      '2026-10-05', '2026-10-09', '2026-12-25', '2026-12-31',
    ],
    tw: [
      '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
      '2026-02-27', '2026-04-03', '2026-04-06', '2026-05-01', '2026-06-19',
      '2026-09-25', '2026-10-09',
    ],
  },
};

const HALF_DAYS_BY_YEAR: Record<string, Record<string, Record<string, Session[]>>> = {
  '2026': {
    hk: {
      '2026-12-24': [{ start: [9, 30], end: [12, 10] }],
      '2026-12-31': [{ start: [9, 30], end: [12, 10] }],
    },
    us: {
      '2026-11-27': [{ start: [9, 30], end: [13, 0] }],
      '2026-12-24': [{ start: [9, 30], end: [13, 0] }],
    },
  },
};

const holidayCache = new Map<string, Set<string>>();
function holidaysFor(market: string, year: string): Set<string> {
  const cacheKey = `${market}:${year}`;
  const cached = holidayCache.get(cacheKey);
  if (cached) return cached;
  const list = HOLIDAYS_BY_YEAR[year]?.[market] ?? [];
  const set = new Set(list);
  holidayCache.set(cacheKey, set);
  return set;
}

function halfDaysFor(market: string, year: string): Record<string, Session[]> {
  return HALF_DAYS_BY_YEAR[year]?.[market] ?? {};
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
