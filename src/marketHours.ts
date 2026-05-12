interface Session {
  start: [number, number];
  end: [number, number];
}

interface MarketCalendar {
  timezone: string;
  sessions: Session[];
  holidays2026: Set<string>;
  halfDays2026?: Record<string, Session[]>;
}

interface FuturesCalendar {
  timezone: string;
  sessions: Session[];
  holidays2026: Set<string>;
}

const HOLIDAYS_2026 = {
  cn: new Set([
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
    '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19',
    '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  ]),
  hk: new Set([
    '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-03', '2026-04-06',
    '2026-04-07', '2026-05-01', '2026-05-25', '2026-07-01', '2026-09-26',
    '2026-10-01', '2026-10-19', '2026-12-25',
  ]),
  us: new Set([
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
    '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  ]),
  jp: new Set([
    '2026-01-01', '2026-01-02', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20',
    '2026-04-29', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11',
    '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23',
    '2026-12-31',
  ]),
  kr: new Set([
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-01',
    '2026-05-05', '2026-05-25', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-26',
    '2026-10-05', '2026-10-09', '2026-12-25', '2026-12-31',
  ]),
  tw: new Set([
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
    '2026-02-27', '2026-04-03', '2026-04-06', '2026-05-01', '2026-06-19',
    '2026-09-25', '2026-10-09',
  ]),
};

const MARKETS: Record<string, MarketCalendar> = {
  cn: {
    timezone: 'Asia/Shanghai',
    sessions: [
      { start: [9, 30], end: [11, 30] },
      { start: [13, 0], end: [15, 0] },
    ],
    holidays2026: HOLIDAYS_2026.cn,
  },
  hk: {
    timezone: 'Asia/Hong_Kong',
    sessions: [
      { start: [9, 30], end: [12, 0] },
      { start: [13, 0], end: [16, 10] },
    ],
    holidays2026: HOLIDAYS_2026.hk,
    halfDays2026: {
      '2026-12-24': [{ start: [9, 30], end: [12, 10] }],
      '2026-12-31': [{ start: [9, 30], end: [12, 10] }],
    },
  },
  us: {
    timezone: 'America/New_York',
    sessions: [{ start: [9, 30], end: [16, 0] }],
    holidays2026: HOLIDAYS_2026.us,
    halfDays2026: {
      '2026-11-27': [{ start: [9, 30], end: [13, 0] }],
      '2026-12-24': [{ start: [9, 30], end: [13, 0] }],
    },
  },
  jp: {
    timezone: 'Asia/Tokyo',
    sessions: [
      { start: [9, 0], end: [11, 30] },
      { start: [12, 30], end: [15, 30] },
    ],
    holidays2026: HOLIDAYS_2026.jp,
  },
  kr: {
    timezone: 'Asia/Seoul',
    sessions: [{ start: [9, 0], end: [15, 30] }],
    holidays2026: HOLIDAYS_2026.kr,
  },
  tw: {
    timezone: 'Asia/Taipei',
    sessions: [{ start: [9, 0], end: [13, 30] }],
    holidays2026: HOLIDAYS_2026.tw,
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
    holidays2026: HOLIDAYS_2026.hk,
  },
  jp_futures: {
    timezone: 'Asia/Tokyo',
    sessions: [
      { start: [7, 30], end: [14, 25] },
      { start: [14, 55], end: [5, 15] },
    ],
    holidays2026: HOLIDAYS_2026.jp,
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

function isWeekday(weekday: string): boolean {
  return weekday !== 'Sat' && weekday !== 'Sun';
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
  return calendar.sessions.some((s) => {
    const start = s.start[0] * 60 + s.start[1];
    const end = s.end[0] * 60 + s.end[1];

    if (start < end) {
      return (
        local.minutes >= start &&
        local.minutes < end &&
        isTradingDate(local.date, local.weekday, calendar.holidays2026)
      );
    }

    if (local.minutes >= start) {
      return isTradingDate(local.date, local.weekday, calendar.holidays2026);
    }

    if (local.minutes < end) {
      const prevDate = previousDate(local.date);
      const prevWeekday = previousWeekday(local.weekday);
      return isTradingDate(prevDate, prevWeekday, calendar.holidays2026);
    }

    return false;
  });
}

function futuresMarketKey(sinaSymbol: string): string | null {
  if (sinaSymbol === 'hf_NQ' || sinaSymbol === 'hf_ES' || sinaSymbol === 'hf_YM') return 'us_futures';
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
  return null;
}

export type MarketState = 'live' | 'closed';

export function getMarketState(sinaSymbol: string, now = new Date()): MarketState {
  const key = marketKey(sinaSymbol);
  if (!key) return 'closed';

  if (key === 'us_futures') {
    const local = zonedNow('America/New_York', now);
    const maintenanceStart = 17 * 60;
    const maintenanceEnd = 18 * 60;

    if (local.weekday === 'Sat') return 'closed';
    if (local.weekday === 'Sun') return local.minutes >= maintenanceEnd ? 'live' : 'closed';
    if (local.weekday === 'Fri') return local.minutes < maintenanceStart ? 'live' : 'closed';
    if (local.minutes >= maintenanceStart && local.minutes < maintenanceEnd) return 'closed';
    return 'live';
  }

  if (key === 'hk_futures' || key === 'jp_futures') {
    const calendar = FUTURES_MARKETS[key];
    const local = zonedNow(calendar.timezone, now);
    return isInFuturesSession(calendar, local) ? 'live' : 'closed';
  }

  const calendar = MARKETS[key];
  const local = zonedNow(calendar.timezone, now);
  if (local.weekday === 'Sat' || local.weekday === 'Sun') return 'closed';
  if (calendar.holidays2026.has(local.date)) return 'closed';

  const sessions = calendar.halfDays2026?.[local.date] ?? calendar.sessions;
  return isInSession(sessions, local.minutes) ? 'live' : 'closed';
}
