import type {
  QuoteData,
  FundNavData,
  FundHistoryPoint,
  FxRateData,
  MarketHistoryConfig,
  MarketHistoryPoint,
} from './types';

type Market = 'us' | 'cn_index' | 'cn_stock' | 'intl_index' | 'hk' | 'global_future' | 'crypto' | 'fund' | 'fx';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function marketType(raw: string): Market {
  if (raw === 'fx_sbtcusd') return 'crypto';
  if (raw.startsWith('fx_')) return 'fx';
  if (raw.startsWith('hf_')) return 'global_future';
  if (raw.startsWith('gb_')) return 'us';
  if (raw.startsWith('s_')) return 'cn_index';
  if (raw.startsWith('int_') || raw.startsWith('b_')) return 'intl_index';
  if (raw.startsWith('f_')) return 'fund';
  if (/^hk/.test(raw)) return 'hk';
  return 'cn_stock';
}

// Current Beijing date as YYYY-MM-DD (for markets where Sina omits the date field)
function beijingDate(): string {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().slice(0, 10);
}

function beijingDatetimeFromTimestamp(timestamp: number): string {
  const bj = new Date(timestamp + 8 * 60 * 60 * 1000);
  return bj.toISOString().slice(0, 19).replace('T', ' ');
}

function combineBeijingDateTime(date: string, time: string): string {
  const normalizedDate = date.replace(/\//g, '-');
  const normalizedTime = time.length === 5 ? `${time}:00` : time;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate) && /^\d{2}:\d{2}(:\d{2})?$/.test(normalizedTime)) {
    return `${normalizedDate} ${normalizedTime}`;
  }
  return normalizedDate || beijingDate();
}

function localDatetimeToBeijing(date: string, time: string, utcOffsetHours: number): string {
  const dateMatch = date.replace(/\//g, '-').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) return beijingDate();
  const utcTime = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]) - utcOffsetHours,
    Number(timeMatch[2]),
    Number(timeMatch[3] ?? 0),
  );
  return beijingDatetimeFromTimestamp(utcTime);
}

function usDstStartDay(year: number): number {
  const firstDay = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  return 1 + ((7 - firstDay) % 7) + 7;
}

function usDstEndDay(year: number): number {
  const firstDay = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  return 1 + ((7 - firstDay) % 7);
}

function isUsEasternDst(year: number, month: number, day: number): boolean {
  if (month > 3 && month < 11) return true;
  if (month < 3 || month > 11) return false;
  if (month === 3) return day >= usDstStartDay(year);
  return day < usDstEndDay(year);
}

function usIntradayToBeijing(datetime: string): string {
  const match = datetime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return datetime;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);

  // Sina US minute data uses Eastern Time during the regular session. If a
  // normalized backend row is already Beijing time, keep it unchanged.
  if (hour < 9 || hour > 16) return datetime;

  const easternOffset = isUsEasternDst(year, month, day) ? 4 : 5;
  const utcTime = Date.UTC(year, month - 1, day, hour + easternOffset, minute, second);
  return beijingDatetimeFromTimestamp(utcTime);
}

// Reject dates that differ from Beijing date by more than this many days (stale Sina data)
function isStale(dateStr: string, maxDiffDays = 2): boolean {
  const datePart = dateStr.slice(0, 10);
  if (!datePart) return true;
  const d = new Date(datePart + 'T00:00:00+08:00');
  const bj = new Date(beijingDate() + 'T00:00:00+08:00');
  const diff = Math.abs(d.getTime() - bj.getTime()) / (1000 * 60 * 60 * 24);
  return diff > maxDiffDays;
}

function usExtendedBeijingDatetime(raw: string, fallbackYear: string): string {
  const match = raw.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(AM|PM)\s+(EDT|EST)$/);
  if (!match || !fallbackYear) return beijingDate();
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const month = months[match[1]];
  if (month == null) return beijingDate();
  let hour = Number(match[3]);
  const minute = Number(match[4]);
  const ampm = match[5];
  const timezone = match[6];
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const offsetHours = timezone === 'EDT' ? 4 : 5;
  const utcTime = Date.UTC(Number(fallbackYear), month, Number(match[2]), hour + offsetHours, minute, 0);
  return beijingDatetimeFromTimestamp(utcTime);
}

function usExtendedSession(raw: string): 'pre' | 'post' | null {
  const match = raw.match(/\s(\d{1,2}):(\d{2})(AM|PM)\s/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const ampm = match[3];
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const minutes = hour * 60 + minute;
  if (minutes < 9 * 60 + 30) return 'pre';
  if (minutes >= 16 * 60) return 'post';
  return null;
}

function parseSinaVar(line: string, fetchedAt: number): { symbol: string; data: QuoteData } | null {
  const match = line.match(/^var hq_str_(\w+)="(.+)";?\s*$/);
  if (!match) return null;

  const rawSymbol = match[1];
  const fields = match[2].split(',');
  const mkt = marketType(rawSymbol);
  if (mkt === 'fund' || mkt === 'fx') return null; // handled by dedicated parsers

  let price: number;
  let previousClose: number;
  let changePct: number;
  let date = '';
  let dateReliable = true;
  let session: QuoteData['session'];

  switch (mkt) {
    case 'us':
      if (fields.length < 27) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = parseFloat(fields[26]) || price;
      changePct = parseFloat(fields[2]) || 0;
      // fields[3] is already Beijing time for Sina US quotes.
      date = fields[3] || beijingDatetimeFromTimestamp(fetchedAt);
      session = 'regular';
      if (fields.length > 29) {
        const extendedPrice = parseFloat(fields[21]) || 0;
        const extendedPct = parseFloat(fields[22]) || 0;
        const extendedTime = fields[24] || '';
        const extendedSession = usExtendedSession(extendedTime);
        if (extendedPrice > 0 && extendedSession === 'pre') {
          previousClose = price;
          price = extendedPrice;
          changePct = extendedPct;
          date = usExtendedBeijingDatetime(extendedTime, fields[29] || date.slice(0, 4));
          session = 'pre';
        } else if (extendedPrice > 0 && extendedSession === 'post') {
          price = extendedPrice;
          changePct = previousClose ? ((extendedPrice - previousClose) / previousClose) * 100 : 0;
          date = usExtendedBeijingDatetime(extendedTime, fields[29] || date.slice(0, 4));
          session = 'post';
        }
      }
      if (!date || isStale(date)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
    case 'cn_index':
      if (fields.length < 4) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = price - (parseFloat(fields[2]) || 0);
      changePct = parseFloat(fields[3]) || 0;
      date = beijingDatetimeFromTimestamp(fetchedAt);
      dateReliable = false;
      break;
    case 'intl_index':
      if (fields.length < 4) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = price - (parseFloat(fields[2]) || 0);
      changePct = parseFloat(fields[3]) || 0;
      // b_KOSPI has Korea local time; convert it to Beijing time.
      if (rawSymbol === 'b_KOSPI' && fields[6] && fields[7]) {
        date = localDatetimeToBeijing(fields[6], fields[7], 9);
      } else {
        // b_TWSE may only include date; int_nikkei currently has no date/time in Sina's short quote.
        for (let i = fields.length - 1; i >= 4; i--) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(fields[i])) {
            date = fields[i];
            break;
          }
        }
      }
      if (!date || isStale(date)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
    case 'hk':
      if (fields.length < 19) return null;
      price = parseFloat(fields[6]) || 0;
      previousClose = parseFloat(fields[3]) || price;
      changePct = parseFloat(fields[8]) || 0;
      // fields[17] = "2026/04/29", fields[18] = "16:10" (Hong Kong time, same as Beijing time)
      date = combineBeijingDateTime(fields[17] || '', fields[18] || '');
      if (isStale(date)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
    case 'global_future':
      if (fields.length < 13) return null;
      price = parseFloat(fields[0]) || 0;
      previousClose = parseFloat(fields[8]) || price;
      changePct = previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
      date = combineBeijingDateTime(fields[12] || '', fields[6] || '');
      if (isStale(date)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
    case 'crypto': {
      if (fields.length < 12) return null;
      price = parseFloat(fields[1]) || 0;
      const changeRaw = parseFloat(fields[11]) || 0;
      previousClose = price - changeRaw || price;
      changePct = parseFloat(fields[10]) || 0;
      date = combineBeijingDateTime(
        [...fields].reverse().find((field) => /^\d{4}-\d{2}-\d{2}$/.test(field)) ?? '',
        fields[0] || '',
      );
      if (isStale(date)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
    }
    case 'cn_stock':
    default:
      if (fields.length < 10) return null;
      price = parseFloat(fields[3]) || 0;
      previousClose = parseFloat(fields[2]) || price;
      changePct = previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
      for (let i = fields.length - 1; i >= Math.max(20, fields.length - 10); i--) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(fields[i])) {
          date = combineBeijingDateTime(fields[i], fields[i + 1] || '');
          break;
        }
      }
      if (!date || isStale(date)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
  }

  const change = price - previousClose;

  return {
    symbol: rawSymbol,
    data: {
      symbol: rawSymbol,
      name: rawSymbol,
      price: Number(price.toFixed(2)),
      previousClose: Number(previousClose.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePercent: Number(changePct.toFixed(2)),
      time: date,
      dateReliable,
      session,
      fetchedAt,
    },
  };
}

// Sina fund format: f_CODE="name,NAV,accNAV?,date,..."
function parseSinaFund(line: string): FundNavData | null {
  const match = line.match(/^var hq_str_f_(\w+)="(.+)";?\s*$/);
  if (!match) return null;
  const code = match[1];
  const fields = match[2].split(',');
  if (fields.length < 5) return null;
  return {
    code,
    name: fields[0],
    navDate: fields[4] || '',
    nav: parseFloat(fields[1]) || 0,
    officialChange: 0,
    estimatedNav: parseFloat(fields[1]) || 0,
    estimatedChange: 0,
  };
}

function parseSinaFx(line: string, fetchedAt: number): FxRateData | null {
  const match = line.match(/^var hq_str_fx_s(\w+)="(.+)";?\s*$/);
  if (!match) return null;
  const pair = match[1].toUpperCase();
  const fields = match[2].split(',');
  if (pair === 'USDCNY' || pair === 'EURCNY' || pair === 'JPYCNY' || pair === 'KRWCNY' || pair === 'HKDCNY') {
    const date = [...fields].reverse().find((field) => /^\d{4}-\d{2}-\d{2}$/.test(field)) ?? beijingDate();
    const currency = pair.slice(0, 3);
    return {
      currency,
      pair: `${currency}/CNY`,
      rate: parseFloat(fields[1]) || 0,
      changePercent: parseFloat(fields[10]) || 0,
      date,
      fetchedAt,
    };
  }
  return null;
}

export async function fetchAllQuotes(sinaSymbols: string[]): Promise<Map<string, QuoteData>> {
  const results = new Map<string, QuoteData>();
  const unique = [...new Set(sinaSymbols)].filter((s) => !s.startsWith('f_'));
  const chunkSize = 20;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const batch = unique.slice(i, i + chunkSize);
    const url = apiUrl(`/api/sina?list=${batch.join(',')}`);
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      const fetchedAt = Date.now();
      for (const line of text.split('\n')) {
        const parsed = parseSinaVar(line.trim(), fetchedAt);
        if (parsed) results.set(parsed.symbol, parsed.data);
      }
    } catch { /* skip */ }
  }

  return results;
}

// Fetch fund NAVs from Sina Finance (fallback for funds not in East Money)
export async function fetchSinaFundNavs(codes: string[]): Promise<Map<string, FundNavData>> {
  const results = new Map<string, FundNavData>();
  const symbols = codes.map((c) => `f_${c}`);
  const url = apiUrl(`/api/sina?list=${symbols.join(',')}`);
  try {
    const res = await fetch(url);
    if (!res.ok) return results;
    const text = await res.text();
    for (const line of text.split('\n')) {
      const parsed = parseSinaFund(line.trim());
      if (parsed) results.set(parsed.code, parsed);
    }
  } catch { /* skip */ }
  return results;
}

export async function fetchFxRates(currencies: string[]): Promise<Map<string, FxRateData>> {
  const results = new Map<string, FxRateData>([[
    'CNY',
    { currency: 'CNY', pair: 'CNY/CNY', rate: 1, changePercent: 0, date: beijingDate(), fetchedAt: Date.now() },
  ]]);
  const symbols = [
    currencies.includes('USD') ? 'fx_susdcny' : null,
    currencies.includes('EUR') ? 'fx_seurcny' : null,
    currencies.includes('JPY') ? 'fx_sjpycny' : null,
    currencies.includes('KRW') ? 'fx_skrwcny' : null,
    currencies.includes('HKD') ? 'fx_shkdcny' : null,
  ].filter((symbol): symbol is string => symbol != null);
  if (symbols.length === 0) return results;

  const url = apiUrl(`/api/sina?list=${symbols.join(',')}`);
  try {
    const res = await fetch(url);
    if (!res.ok) return results;
    const text = await res.text();
    const fetchedAt = Date.now();
    for (const line of text.split('\n')) {
      const parsed = parseSinaFx(line.trim(), fetchedAt);
      if (parsed) results.set(parsed.currency, parsed);
    }
  } catch { /* skip */ }
  return results;
}

interface EastMoneyFundRaw {
  fundcode: string;
  name: string;
  jzrq: string;
  dwjz: string;
  gsz: string;
  gszzl: string;
  gztime: string;
}

interface FundHistoryRow {
  FSRQ: string;
  DWJZ: string;
  JZZZL: string;
}

interface SinaCnKlineRow {
  day?: string;
  close?: string | number;
}

interface SinaUsKlineRow {
  d?: string;
  c?: string | number;
}

interface SinaFuturesKlineRow {
  date?: string;
  close?: string | number;
}

interface NormalizedMarketPointRow {
  date?: string;
  day?: string;
  d?: string;
  close?: string | number;
  c?: string | number;
}

type MarketHistorySource = MarketHistoryConfig['source'];

const US_INTRADAY_FUTURES_FALLBACK: Record<string, string> = {
  '.INX': 'ES',
  '.DJI': 'YM',
};

function parseSinaJsonpArray<T>(text: string): T[] {
  const match = text.match(/=\((.*)\);?\s*$/s);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseJsonArray<T>(text: string): T[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export async function fetchFundHistory(
  codes: string[],
): Promise<Map<string, { navDate: string; nav: number; officialChange: number }>> {
  const results = new Map<string, { navDate: string; nav: number; officialChange: number }>();
  const url = apiUrl(`/api/fundhistory?codes=${codes.join(',')}`);
  try {
    const res = await fetch(url);
    if (!res.ok) return results;
    const json = await res.json();
    for (const code of codes) {
      const rows: FundHistoryRow[] | undefined = json[code];
      if (!rows || rows.length < 2) continue;
      // rows[0] = latest (T-1), rows[1] = previous (T-2)
      const nav = parseFloat(rows[0].DWJZ) || 0;
      const prevNav = parseFloat(rows[1].DWJZ) || nav;
      const officialChange = prevNav ? ((nav - prevNav) / prevNav) * 100 : 0;
      results.set(code, {
        navDate: rows[0].FSRQ,
        nav,
        officialChange: Number(officialChange.toFixed(2)),
      });
    }
  } catch { /* skip */ }
  return results;
}

export async function fetchFundHistorySeries(
  code: string,
  targetSize = 3000,
): Promise<FundHistoryPoint[]> {
  try {
    const url = apiUrl(`/api/fundhistory?codes=${code}&pageSize=${targetSize}&pageIndex=1`);
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    const rows: FundHistoryRow[] = json[code] ?? [];

    const uniqueRows = [...new Map(rows.map((row) => [row.FSRQ, row])).values()];
    return uniqueRows
      .slice(0, targetSize)
      .map((row) => ({
        date: row.FSRQ,
        nav: parseFloat(row.DWJZ) || 0,
        changePercent: parseFloat(row.JZZZL) || 0,
      }))
      .filter((point) => point.date && point.nav > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

function parseClose(value: unknown): number {
  return typeof value === 'number' ? value : parseFloat(String(value ?? ''));
}

function latestIntradaySession(points: MarketHistoryPoint[]): MarketHistoryPoint[] {
  const valid = points
    .filter((point) => (
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(point.date) &&
      Number.isFinite(point.close) &&
      point.close > 0
    ))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (valid.length === 0) return [];

  const latestDate = valid[valid.length - 1].date.slice(0, 10);
  if (isStale(latestDate, 5)) return [];
  return [...new Map(
    valid
      .filter((point) => point.date.slice(0, 10) === latestDate)
      .map((point) => [point.date, point]),
  ).values()];
}

function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00+08:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function latestUsIntradaySession(points: MarketHistoryPoint[]): MarketHistoryPoint[] {
  const valid = points
    .filter((point) => (
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(point.date) &&
      Number.isFinite(point.close) &&
      point.close > 0
    ))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (valid.length === 0) return [];

  const latest = valid[valid.length - 1].date;
  const latestDate = latest.slice(0, 10);
  if (isStale(latestDate, 5)) return [];
  const latestHour = Number(latest.slice(11, 13));
  const startDate = latestHour <= 5 ? previousDate(latestDate) : latestDate;
  const start = `${startDate} 20:00:00`;
  const endDate = latestHour <= 5 ? latestDate : startDate;
  const end = latestHour <= 5 ? `${endDate} 06:00:00` : `${endDate} 23:59:59`;

  return [...new Map(
    valid
      .filter((point) => point.date >= start && point.date <= end)
      .map((point) => [point.date, point]),
  ).values()];
}

function intradaySource(
  config: MarketHistoryConfig,
  currentSymbol?: string,
): { source: MarketHistorySource; symbol: string } {
  if (currentSymbol?.startsWith('hf_')) {
    return { source: 'sina-futures', symbol: currentSymbol.slice(3) };
  }
  return config;
}

async function fetchResolvedMarketIntraday(
  resolved: { source: MarketHistorySource; symbol: string },
): Promise<MarketHistoryPoint[]> {
  const params = new URLSearchParams({
    source: resolved.source,
    symbol: resolved.symbol,
  });
  const res = await fetch(apiUrl(`/api/marketintraday?${params.toString()}`));
  if (!res.ok) return [];
  const text = await res.text();
  let points: MarketHistoryPoint[] = [];
  const normalizedRows = parseJsonArray<NormalizedMarketPointRow>(text);

  if (normalizedRows.length > 0) {
    points = normalizedRows.map((row) => ({
      date: resolved.source === 'sina-us'
        ? usIntradayToBeijing(row.date ?? row.day ?? row.d ?? '')
        : row.date ?? row.day ?? row.d ?? '',
      close: parseClose(row.close ?? row.c),
    }));
  } else if (resolved.source === 'sina-cn') {
    const rows = JSON.parse(text) as SinaCnKlineRow[];
    points = (Array.isArray(rows) ? rows : []).map((row) => ({
      date: row.day ?? '',
      close: parseClose(row.close),
    }));
  } else if (resolved.source === 'sina-us') {
    const rows = parseSinaJsonpArray<SinaUsKlineRow>(text);
    points = rows.map((row) => ({
      date: usIntradayToBeijing(row.d ?? ''),
      close: parseClose(row.c),
    }));
  } else if (resolved.source === 'sina-futures') {
    const json = JSON.parse(text);
    const rows = Array.isArray(json?.minLine_1d) ? json.minLine_1d as unknown[][] : [];
    points = rows.map((row) => {
      const isHeadRow = row.length >= 10;
      return {
        date: String(isHeadRow ? row[9] : row[5] ?? ''),
        close: parseClose(isHeadRow ? row[5] : row[1]),
      };
    });
  }

  return resolved.source === 'sina-us' ? latestUsIntradaySession(points) : latestIntradaySession(points);
}

export async function fetchMarketHistory(config: MarketHistoryConfig): Promise<MarketHistoryPoint[]> {
  try {
    const params = new URLSearchParams({
      source: config.source,
      symbol: config.symbol,
    });
    const res = await fetch(apiUrl(`/api/markethistory?${params.toString()}`));
    if (!res.ok) return [];
    const text = await res.text();
    let points: MarketHistoryPoint[] = [];
    const normalizedRows = parseJsonArray<NormalizedMarketPointRow>(text);

    if (normalizedRows.length > 0) {
      points = normalizedRows.map((row) => ({
        date: row.date ?? row.day ?? row.d ?? '',
        close: parseClose(row.close ?? row.c),
      }));
    } else if (config.source === 'sina-cn') {
      const rows = JSON.parse(text) as SinaCnKlineRow[];
      points = (Array.isArray(rows) ? rows : []).map((row) => ({
        date: row.day ?? '',
        close: typeof row.close === 'number' ? row.close : parseFloat(row.close ?? ''),
      }));
    } else if (config.source === 'sina-us') {
      const rows = parseSinaJsonpArray<SinaUsKlineRow>(text);
      points = rows.map((row) => ({
        date: row.d ?? '',
        close: typeof row.c === 'number' ? row.c : parseFloat(row.c ?? ''),
      }));
    } else if (config.source === 'sina-futures') {
      const json = JSON.parse(text);
      const rows = Array.isArray(json) ? (json as SinaFuturesKlineRow[]) : [];
      points = rows.map((row) => ({
        date: row.date ?? '',
        close: typeof row.close === 'number' ? row.close : parseFloat(row.close ?? ''),
      }));
    }

    return points
      .filter((point) => (
        /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
        point.date <= beijingDate() &&
        Number.isFinite(point.close) &&
        point.close > 0
      ))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

export async function fetchMarketIntraday(
  config: MarketHistoryConfig,
  currentSymbol?: string,
): Promise<MarketHistoryPoint[]> {
  const resolved = intradaySource(config, currentSymbol);
  try {
    const primary = await fetchResolvedMarketIntraday(resolved);
    if (primary.length >= 2) return primary;

    const fallbackSymbol = resolved.source === 'sina-us'
      ? US_INTRADAY_FUTURES_FALLBACK[resolved.symbol]
      : undefined;
    if (fallbackSymbol) {
      return fetchResolvedMarketIntraday({ source: 'sina-futures', symbol: fallbackSymbol });
    }

    return primary;
  } catch {
    return [];
  }
}

export async function fetchFundNavs(codes: string[]): Promise<Map<string, FundNavData>> {
  const results = new Map<string, FundNavData>();
  const url = apiUrl(`/api/fundnav?codes=${codes.join(',')}`);
  try {
    const res = await fetch(url);
    if (!res.ok) return results;
    const json = await res.json();
    for (const code of codes) {
      const raw: EastMoneyFundRaw | undefined = json[code];
      if (!raw) continue;
      results.set(code, {
        code: raw.fundcode,
        name: raw.name,
        navDate: raw.jzrq,
        nav: parseFloat(raw.dwjz) || 0,
        officialChange: 0, // filled later via fetchFundHistory
        estimatedNav: parseFloat(raw.gsz) || 0,
        estimatedChange: parseFloat(raw.gszzl) || 0,
      });
    }
  } catch { /* skip */ }
  return results;
}
