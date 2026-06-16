import type {
  QuoteData,
  Fund,
  FundNavData,
  Holding,
  FundPurchaseData,
  FundHistoryPoint,
  FundReturnSummary,
  FundBacktestSummary,
  FxRateData,
  MarketHistoryConfig,
  MarketHistoryPoint,
  MarketReturnSummary,
  MarketStateData,
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
  let regularPrice: number | undefined;
  let regularChangePercent: number | undefined;
  let regularTime: string | undefined;

  switch (mkt) {
    case 'us':
      if (fields.length < 27) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = parseFloat(fields[26]) || price;
      changePct = parseFloat(fields[2]) || 0;
      // fields[3] is already Beijing time for Sina US quotes.
      date = fields[3] || beijingDatetimeFromTimestamp(fetchedAt);
      session = 'regular';
      regularPrice = price;
      regularChangePercent = changePct;
      regularTime = date;
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
      let hasExplicitIntlDate = false;
      // b_KOSPI has Korea local time; convert it to Beijing time.
      if (rawSymbol === 'b_KOSPI' && fields[6] && fields[7]) {
        date = localDatetimeToBeijing(fields[6], fields[7], 9);
        hasExplicitIntlDate = true;
      } else {
        // b_TWSE may only include date; int_nikkei currently has no date/time in Sina's short quote.
        for (let i = fields.length - 1; i >= 4; i--) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(fields[i])) {
            date = fields[i];
            hasExplicitIntlDate = true;
            break;
          }
        }
      }
      if (!date || isStale(date)) {
        if (hasExplicitIntlDate) return null;
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
      regularPrice: regularPrice == null ? undefined : Number(regularPrice.toFixed(2)),
      regularChangePercent: regularChangePercent == null ? undefined : Number(regularChangePercent.toFixed(2)),
      regularTime,
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
    const time = fields.find((field) => /^\d{2}:\d{2}:\d{2}$/.test(field)) ?? '';
    const currency = pair.slice(0, 3);
    return {
      currency,
      pair: `${currency}/CNY`,
      rate: parseFloat(fields[1]) || 0,
      changePercent: parseFloat(fields[10]) || 0,
      date,
      time: time || undefined,
      datetime: time ? `${date} ${time}` : date,
      fetchedAt,
    };
  }
  return null;
}

const QUOTE_CACHE_TTL_MS = 15_000;
const quoteCache = new Map<string, QuoteData>();

export async function fetchAllQuotes(sinaSymbols: string[]): Promise<Map<string, QuoteData>> {
  const results = new Map<string, QuoteData>();
  const unique = [...new Set(sinaSymbols)].filter((s) => !s.startsWith('f_'));
  const chunkSize = 140;
  const now = Date.now();
  const missing: string[] = [];

  for (const symbol of unique) {
    const cached = quoteCache.get(symbol);
    if (cached && now - cached.fetchedAt < QUOTE_CACHE_TTL_MS) {
      results.set(symbol, cached);
    } else {
      missing.push(symbol);
    }
  }

  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += chunkSize) {
    batches.push(missing.slice(i, i + chunkSize));
  }

  await Promise.all(batches.map(async (batch) => {
    const url = apiUrl(`/api/sina?list=${batch.join(',')}`);
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const text = await res.text();
      const fetchedAt = Date.now();
      for (const line of text.split('\n')) {
        const parsed = parseSinaVar(line.trim(), fetchedAt);
        if (parsed) {
          quoteCache.set(parsed.symbol, parsed.data);
          results.set(parsed.symbol, parsed.data);
        }
      }
    } catch { /* skip */ }
  }));

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

const FX_RATE_CACHE_TTL_MS = 15_000;
const fxRateCache = new Map<string, FxRateData>();

export async function fetchFxRates(currencies: string[]): Promise<Map<string, FxRateData>> {
  const today = beijingDate();
  const results = new Map<string, FxRateData>([[
    'CNY',
    { currency: 'CNY', pair: 'CNY/CNY', rate: 1, changePercent: 0, date: today, time: '00:00:00', datetime: `${today} 00:00:00`, fetchedAt: Date.now() },
  ]]);
  const now = Date.now();
  const requested = [...new Set(currencies)];
  for (const currency of requested) {
    const cached = fxRateCache.get(currency);
    if (cached && now - cached.fetchedAt < FX_RATE_CACHE_TTL_MS) {
      results.set(currency, cached);
    }
  }
  const missing = requested.filter((currency) => currency !== 'CNY' && !results.has(currency));
  const symbols = [
    missing.includes('USD') ? 'fx_susdcny' : null,
    missing.includes('EUR') ? 'fx_seurcny' : null,
    missing.includes('JPY') ? 'fx_sjpycny' : null,
    missing.includes('KRW') ? 'fx_skrwcny' : null,
    missing.includes('HKD') ? 'fx_shkdcny' : null,
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
      if (parsed) {
        fxRateCache.set(parsed.currency, parsed);
        results.set(parsed.currency, parsed);
      }
    }
  } catch { /* skip */ }
  return results;
}

export interface DashboardSnapshot {
  quotes: Map<string, QuoteData>;
  fxRates: Map<string, FxRateData>;
  marketStates: Map<string, MarketStateData>;
}

const dashboardSnapshotPending = new Map<string, Promise<DashboardSnapshot | null>>();

export async function fetchDashboardSnapshot(
  symbols: string[],
  currencies: string[],
): Promise<DashboardSnapshot | null> {
  const uniqueSymbols = [...new Set(symbols.filter(Boolean))];
  const uniqueCurrencies = [...new Set(currencies.filter((currency) => currency !== 'CNY'))];
  if (uniqueSymbols.length > 160) return null;
  const cacheKey = `${uniqueSymbols.join(',')}|${uniqueCurrencies.join(',')}`;
  const pending = dashboardSnapshotPending.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const params = new URLSearchParams({
      symbols: uniqueSymbols.join(','),
      currencies: uniqueCurrencies.join(','),
    });
    const res = await fetch(apiUrl(`/api/dashboard?${params.toString()}`));
    if (!res.ok) return null;
    const json = await res.json();
    const fetchedAt = Date.now();
    const quotes = new Map<string, QuoteData>();
    const fxRates = new Map<string, FxRateData>([[
      'CNY',
      { currency: 'CNY', pair: 'CNY/CNY', rate: 1, changePercent: 0, date: beijingDate(), time: '00:00:00', datetime: `${beijingDate()} 00:00:00`, fetchedAt },
    ]]);
    const marketStates = new Map<string, MarketStateData>();

    for (const line of String(json.quotesText ?? '').split('\n')) {
      const parsed = parseSinaVar(line.trim(), fetchedAt);
      if (parsed) {
        quoteCache.set(parsed.symbol, parsed.data);
        quotes.set(parsed.symbol, parsed.data);
      }
    }

    for (const line of String(json.fxText ?? '').split('\n')) {
      const parsed = parseSinaFx(line.trim(), fetchedAt);
      if (parsed) {
        fxRateCache.set(parsed.currency, parsed);
        fxRates.set(parsed.currency, parsed);
      }
    }

    for (const symbol of uniqueSymbols) {
      const raw: MarketStateData | undefined = json.marketStates?.[symbol];
      if (raw) marketStates.set(symbol, raw);
    }

    return { quotes, fxRates, marketStates };
  })().catch(() => null).finally(() => {
    dashboardSnapshotPending.delete(cacheKey);
  });

  dashboardSnapshotPending.set(cacheKey, request);
  return request;
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

interface FundHoldingRaw {
  symbol?: string;
  name?: string;
  sinaSymbol?: string;
  weight?: number;
  currency?: Holding['currency'];
  market?: string;
  reportDate?: string;
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

export async function fetchFundPurchaseStatuses(codes: string[]): Promise<Map<string, FundPurchaseData>> {
  const results = new Map<string, FundPurchaseData>();
  if (codes.length === 0) return results;

  const url = apiUrl(`/api/fundpurchase?codes=${codes.join(',')}`);
  try {
    const res = await fetch(url);
    if (!res.ok) return results;
    const json = await res.json();
    for (const code of codes) {
      const raw: FundPurchaseData | undefined = json[code];
      if (raw) results.set(code, raw);
    }
  } catch { /* skip */ }
  return results;
}

export async function fetchFundProfiles(codes: string[]): Promise<Map<string, NonNullable<Fund['profile']>>> {
  const results = new Map<string, NonNullable<Fund['profile']>>();
  if (codes.length === 0) return results;

  try {
    const res = await fetch(apiUrl(`/api/fundprofiles?codes=${codes.join(',')}`));
    if (!res.ok) return results;
    const json = await res.json();
    for (const code of codes) {
      const raw: Fund['profile'] | undefined = json[code];
      if (raw?.inceptionDate) results.set(code, raw);
    }
  } catch { /* skip */ }
  return results;
}

export async function fetchFundHoldings(codes: string[]): Promise<Map<string, Holding[]>> {
  const results = new Map<string, Holding[]>();
  if (codes.length === 0) return results;

  try {
    const res = await fetch(apiUrl(`/api/fundholdings?codes=${codes.join(',')}`));
    if (!res.ok) return results;
    const json = await res.json();
    for (const code of codes) {
      const rows: FundHoldingRaw[] | undefined = json[code];
      if (!Array.isArray(rows)) continue;
      const holdings = rows
        .map((row): Holding | null => {
          const symbol = String(row.symbol ?? '').trim();
          const name = String(row.name ?? '').trim();
          const sinaSymbol = String(row.sinaSymbol ?? '').trim();
          const weight = Number(row.weight);
          const currency = row.currency ?? 'CNY';
          if (!symbol || !name || !Number.isFinite(weight) || weight <= 0) return null;
          return {
            symbol,
            name,
            sinaSymbol,
            weight,
            currency,
            market: row.market,
            reportDate: row.reportDate,
            quoteSupported: Boolean(sinaSymbol),
          } satisfies Holding;
        })
        .filter((item): item is Holding => item != null);
      if (holdings.length > 0) results.set(code, holdings);
    }
  } catch { /* skip */ }

  return results;
}

export async function fetchFundReturnSummaries(codes: string[]): Promise<Map<string, FundReturnSummary>> {
  const results = new Map<string, FundReturnSummary>();
  if (codes.length === 0) return results;

  try {
    const res = await fetch(apiUrl(`/api/fundreturns?codes=${codes.join(',')}`));
    if (!res.ok) return results;
    const json = await res.json();
    for (const code of codes) {
      const raw: FundReturnSummary | undefined = json[code];
      if (raw) results.set(code, raw);
    }
  } catch { /* skip */ }
  return results;
}

export async function fetchFundBacktest(
  code: string,
  days = 90,
  refresh = false,
): Promise<FundBacktestSummary | null> {
  try {
    const params = new URLSearchParams({
      codes: code,
      days: String(days),
    });
    if (refresh) params.set('refresh', '1');
    const res = await fetch(apiUrl(`/api/fundbacktest?${params.toString()}`));
    if (!res.ok) return null;
    const json = await res.json();
    return json[code] ?? null;
  } catch {
    return null;
  }
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
    } else if (config.source === 'tencent-hk') {
      const json = JSON.parse(text);
      const rows = json?.data?.[config.symbol]?.day;
      points = (Array.isArray(rows) ? rows : []).map((row) => ({
        date: row?.[0] ?? '',
        close: parseFloat(String(row?.[2] ?? '')),
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

const MARKET_RETURN_SUMMARY_TTL_MS = 5 * 60 * 1000;
const marketReturnSummaryCache = new Map<string, { summary: MarketReturnSummary; fetchedAt: number }>();

export async function fetchMarketReturnSummaries(
  configs: MarketHistoryConfig[],
): Promise<Map<string, MarketReturnSummary>> {
  const results = new Map<string, MarketReturnSummary>();
  const unique = [...new Map(configs.map((config) => [`${config.source}:${config.symbol}`, config])).values()];
  if (unique.length === 0) return results;

  const now = Date.now();
  const missing: MarketHistoryConfig[] = [];
  for (const config of unique) {
    const key = `${config.source}:${config.symbol}`;
    const cached = marketReturnSummaryCache.get(key);
    if (cached && now - cached.fetchedAt < MARKET_RETURN_SUMMARY_TTL_MS) {
      results.set(key, cached.summary);
    } else {
      missing.push(config);
    }
  }
  if (missing.length === 0) return results;

  try {
    const items = missing.map((config) => `${config.source}:${config.symbol}`).join(',');
    const res = await fetch(apiUrl(`/api/marketreturns?items=${encodeURIComponent(items)}`));
    if (!res.ok) return results;
    const json = await res.json();
    for (const config of missing) {
      const key = `${config.source}:${config.symbol}`;
      const raw: MarketReturnSummary | undefined = json[key];
      if (raw) {
        marketReturnSummaryCache.set(key, { summary: raw, fetchedAt: Date.now() });
        results.set(key, raw);
      }
    }
  } catch { /* skip */ }

  return results;
}

export async function fetchMarketStates(symbols: string[]): Promise<Map<string, MarketStateData>> {
  const results = new Map<string, MarketStateData>();
  const unique = [...new Set(symbols.filter(Boolean))];
  if (unique.length === 0) return results;

  try {
    const res = await fetch(apiUrl(`/api/marketstates?symbols=${unique.join(',')}`));
    if (!res.ok) return results;
    const json = await res.json();
    for (const symbol of unique) {
      const raw: MarketStateData | undefined = json[symbol];
      if (raw) results.set(symbol, raw);
    }
  } catch { /* skip */ }

  return results;
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
