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
  SystemStatus,
} from './types';
import { globalFutureReferencePrice } from './quoteMath';

type Market = 'us' | 'cn_index' | 'cn_full_index' | 'cn_stock' | 'intl_index' | 'hk' | 'global_future' | 'crypto' | 'fund' | 'fx';

const API_BASE = ((import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

// Guard against malformed upstream responses (e.g. HTML error pages, error
// objects) being cast as typed JSON and silently propagating NaN/undefined
// into estimates. Returns null for anything that isn't a plain object.
function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function marketType(raw: string): Market {
  if (raw === 'fx_sbtcusd') return 'crypto';
  if (raw.startsWith('fx_')) return 'fx';
  if (raw.startsWith('hf_')) return 'global_future';
  if (raw.startsWith('gb_')) return 'us';
  if (raw.startsWith('s_')) return 'cn_index';
  if (/^(sh000|sz399)\d{3}$/.test(raw)) return 'cn_full_index';
  if (raw.startsWith('int_') || raw.startsWith('b_')) return 'intl_index';
  if (raw.startsWith('f_')) return 'fund';
  if (/^hk/.test(raw)) return 'hk';
  return 'cn_stock';
}

// Beijing date as YYYY-MM-DD (for markets where Sina omits the date field).
function beijingDate(timestamp = Date.now()): string {
  const now = new Date(timestamp);
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

// Reject dates that differ from Beijing date by more than this many days (stale Sina data)
function isStale(dateStr: string, referenceTimestamp: number, maxDiffDays = 2): boolean {
  const datePart = dateStr.slice(0, 10);
  if (!datePart) return true;
  const d = new Date(datePart + 'T00:00:00+08:00');
  const bj = new Date(beijingDate(referenceTimestamp) + 'T00:00:00+08:00');
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

function maxReasonableChangePercent(market: Market): number {
  if (market === 'global_future') return 25;
  if (market === 'cn_index' || market === 'cn_full_index' || market === 'intl_index' || market === 'hk') return 25;
  if (market === 'cn_stock') return 80;
  if (market === 'us') return 120;
  if (market === 'crypto') return 120;
  return 80;
}

function quoteLooksValid(market: Market, price: number, previousClose: number, changePercent: number): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(previousClose) || !Number.isFinite(changePercent)) return false;
  if (price <= 0 || previousClose <= 0) return false;
  return Math.abs(changePercent) <= maxReasonableChangePercent(market);
}

export function parseSinaVar(line: string, fetchedAt: number): { symbol: string; data: QuoteData } | null {
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
      if (!date) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      } else if (isStale(date, fetchedAt)) {
        dateReliable = false;
      }
      break;
    case 'cn_index':
      if (fields.length < 4) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = price - (parseFloat(fields[2]) || 0);
      changePct = parseFloat(fields[3]) || 0;
      for (let i = fields.length - 1; i >= 4; i--) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(fields[i])) {
          date = combineBeijingDateTime(fields[i], fields[i + 1] || '');
          break;
        }
      }
      if (!date || isStale(date, fetchedAt)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
    case 'intl_index':
      if (fields.length < 4) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = price - (parseFloat(fields[2]) || 0);
      changePct = parseFloat(fields[3]) || 0;
      let hasExplicitIntlDate = false;
      // Sina's global-index feed already reports Asia-Pacific timestamps in
      // Beijing time, including b_KOSPI.
      if (rawSymbol === 'b_KOSPI' && fields[6] && fields[7]) {
        date = combineBeijingDateTime(fields[6], fields[7]);
        hasExplicitIntlDate = true;
      } else {
        // b_TWSE may only include date; int_nikkei currently has no date/time in Sina's short quote.
        for (let i = fields.length - 1; i >= 4; i--) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(fields[i])) {
            const maybeTime = fields[i + 1] ?? '';
            date = /^\d{2}:\d{2}(:\d{2})?$/.test(maybeTime)
              ? combineBeijingDateTime(fields[i], maybeTime)
              : fields[i];
            hasExplicitIntlDate = true;
            break;
          }
        }
      }
      if (!date || isStale(date, fetchedAt)) {
        if (hasExplicitIntlDate) {
          dateReliable = false;
        } else {
          if (rawSymbol === 'int_nikkei') return null;
          date = beijingDatetimeFromTimestamp(fetchedAt);
          dateReliable = false;
        }
      }
      break;
    case 'hk':
      if (fields.length < 19) return null;
      price = parseFloat(fields[6]) || 0;
      previousClose = parseFloat(fields[3]) || price;
      changePct = parseFloat(fields[8]) || 0;
      // fields[17] = "2026/04/29", fields[18] = "16:10" (Hong Kong time, same as Beijing time)
      date = combineBeijingDateTime(fields[17] || '', fields[18] || '');
      if (isStale(date, fetchedAt)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
    case 'global_future':
      if (fields.length < 13) return null;
      price = parseFloat(fields[0]) || 0;
      previousClose = globalFutureReferencePrice(fields[7], fields[8], price);
      changePct = previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
      date = combineBeijingDateTime(fields[12] || '', fields[6] || '');
      if (isStale(date, fetchedAt)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
    case 'crypto': {
      if (fields.length < 12) return null;
      price = parseFloat(fields[1]) || 0;
      const changeRaw = parseFloat(fields[11]);
      previousClose = Number.isFinite(changeRaw) ? price - changeRaw : price;
      if (!Number.isFinite(previousClose) || previousClose === 0) previousClose = price;
      changePct = parseFloat(fields[10]) || 0;
      date = combineBeijingDateTime(
        [...fields].reverse().find((field) => /^\d{4}-\d{2}-\d{2}$/.test(field)) ?? '',
        fields[0] || '',
      );
      if (isStale(date, fetchedAt)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
    }
    case 'cn_full_index':
    case 'cn_stock':
    default:
      if (fields.length < 10) return null;
      price = parseFloat(fields[3]) || 0;
      previousClose = parseFloat(fields[2]) || price;
      if (price <= 0 && previousClose > 0) price = previousClose;
      changePct = previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
      for (let i = fields.length - 1; i >= Math.max(20, fields.length - 10); i--) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(fields[i])) {
          date = combineBeijingDateTime(fields[i], fields[i + 1] || '');
          break;
        }
      }
      if (!date || isStale(date, fetchedAt)) {
        date = beijingDatetimeFromTimestamp(fetchedAt);
        dateReliable = false;
      }
      break;
  }

  const change = price - previousClose;
  if (!quoteLooksValid(mkt, price, previousClose, changePct)) return null;

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
      const parsedSymbols = new Set<string>();
      for (const line of text.split('\n')) {
        const parsed = parseSinaVar(line.trim(), fetchedAt);
        if (parsed) {
          parsedSymbols.add(parsed.symbol);
          quoteCache.set(parsed.symbol, parsed.data);
          results.set(parsed.symbol, parsed.data);
        }
      }
      for (const symbol of batch) {
        if (!parsedSymbols.has(symbol)) {
          quoteCache.delete(symbol);
          results.delete(symbol);
        }
      }
    } catch { /* skip */ }
  }));

  return results;
}

// Fetch fund NAVs from Sina Finance (fallback for funds not in East Money)
export async function fetchSinaFundNavs(codes: string[], refresh = false): Promise<Map<string, FundNavData>> {
  const results = new Map<string, FundNavData>();
  const symbols = codes.map((c) => `f_${c}`);
  const refreshParam = refresh ? '&refresh=1' : '';
  const url = apiUrl(`/api/sina?list=${symbols.join(',')}${refreshParam}`);
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

export interface OverviewSnapshot extends DashboardSnapshot {
  fundSummaries: Map<string, FundNavData>;
}

export interface DataHealth {
  status: 'ok' | 'degraded';
  updatedAt: number;
  upstream: {
    total: number;
    staleCount: number;
    errorCount: number;
    issueCount?: number;
    issues?: Array<{
      key: string;
      kind: string;
      cacheKey: string;
      source: string;
      status?: number | null;
      error?: string;
      failureCount?: number;
    }>;
  };
  cache: {
    total: number;
    byKind: Record<string, number>;
    latestAt: number;
  };
  fundHistory: {
    total: number;
    missing: number;
    stale: number;
    sampleMissing?: string[];
    sampleStale?: string[];
    latestDate: string;
  };
  marketHistory: {
    total: number;
    missing: number;
    stale: number;
    sampleMissing?: string[];
    sampleStale?: string[];
    latestDate: string;
  };
  backgroundRefresh: {
    started: boolean;
    lastRunAt: number;
    lastSuccessAt: number;
    lastErrorAt: number;
    lastError: string;
    runCount: number;
  };
}

const dashboardSnapshotPending = new Map<string, Promise<DashboardSnapshot | null>>();
const overviewSnapshotPending = new Map<string, Promise<OverviewSnapshot | null>>();
const DASHBOARD_BROWSER_CACHE_TTL_MS = 2 * 60 * 1000;

function dashboardStorageKey(cacheKey: string): string {
  let hash = 5381;
  for (let index = 0; index < cacheKey.length; index += 1) {
    hash = ((hash << 5) + hash) ^ cacheKey.charCodeAt(index);
  }
  return `fund_valuation:dashboard:v1:${hash >>> 0}`;
}

function readStoredDashboard(cacheKey: string): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(dashboardStorageKey(cacheKey));
    if (!raw) return null;
    const stored = asObject(JSON.parse(raw));
    const payload = stored ? asObject(stored.payload) : null;
    const savedAt = Number(stored?.savedAt);
    if (!payload || !Number.isFinite(savedAt) || Date.now() - savedAt > DASHBOARD_BROWSER_CACHE_TTL_MS) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function storeDashboard(cacheKey: string, payload: unknown) {
  try {
    window.localStorage.setItem(
      dashboardStorageKey(cacheKey),
      JSON.stringify({ savedAt: Date.now(), payload }),
    );
  } catch { /* storage may be unavailable or full */ }
}

async function fetchWithTimeout(url: string, timeoutMs = 4_000): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export function parseDashboardSnapshotPayload(
  json: { schemaVersion?: unknown; quotes?: unknown; quotesText?: unknown; fxText?: unknown; marketStates?: Record<string, MarketStateData> },
  symbols: string[],
  fetchedAt: number,
): DashboardSnapshot {
  const quotes = new Map<string, QuoteData>();
  const fxRates = new Map<string, FxRateData>([[
    'CNY',
    { currency: 'CNY', pair: 'CNY/CNY', rate: 1, changePercent: 0, date: beijingDate(), time: '00:00:00', datetime: `${beijingDate()} 00:00:00`, fetchedAt },
  ]]);
  const marketStates = new Map<string, MarketStateData>();

  const structuredQuotes = json.schemaVersion === 1 ? asObject(json.quotes) : null;
  if (structuredQuotes) {
    for (const symbol of symbols) {
      const raw = asObject(structuredQuotes[symbol]);
      if (!raw) continue;
      const price = Number(raw.price);
      const previousClose = Number(raw.previousClose);
      const changePercent = Number(raw.changePercent);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(previousClose) || previousClose <= 0 || !Number.isFinite(changePercent)) continue;
      const quote: QuoteData = {
        symbol,
        name: symbol,
        price,
        previousClose,
        change: Number(raw.change) || price - previousClose,
        changePercent,
        time: String(raw.time ?? ''),
        dateReliable: raw.dateReliable !== false,
        fetchedAt: Number(raw.fetchedAt) || fetchedAt,
        session: raw.session === 'pre' || raw.session === 'post' ? raw.session : 'regular',
        regularPrice: Number.isFinite(Number(raw.regularPrice)) ? Number(raw.regularPrice) : undefined,
        regularChangePercent: Number.isFinite(Number(raw.regularChangePercent)) ? Number(raw.regularChangePercent) : undefined,
        regularTime: raw.regularTime ? String(raw.regularTime) : undefined,
      };
      quoteCache.set(symbol, quote);
      quotes.set(symbol, quote);
    }
  }

  for (const line of String(json.quotesText ?? '').split('\n')) {
    const parsed = parseSinaVar(line.trim(), fetchedAt);
    if (parsed && !quotes.has(parsed.symbol)) {
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

  for (const symbol of symbols) {
    const raw = json.marketStates?.[symbol];
    if (raw) marketStates.set(symbol, raw);
  }

  return { quotes, fxRates, marketStates };
}

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

  const stored = readStoredDashboard(cacheKey);
  const storedSnapshot = stored
    ? parseDashboardSnapshotPayload(stored, uniqueSymbols, Date.now())
    : null;

  const request = (async () => {
    const params = new URLSearchParams({
      symbols: uniqueSymbols.join(','),
      currencies: uniqueCurrencies.join(','),
    });
    const res = await fetchWithTimeout(apiUrl(`/api/dashboard?${params.toString()}`));
    if (!res.ok) return storedSnapshot;
    const json = await res.json();
    storeDashboard(cacheKey, json);
    const fetchedAt = Date.now();
    return parseDashboardSnapshotPayload(json, uniqueSymbols, fetchedAt);
  })().catch(() => storedSnapshot).finally(() => {
    dashboardSnapshotPending.delete(cacheKey);
  });

  dashboardSnapshotPending.set(cacheKey, request);
  return request;
}

export async function fetchOverviewSnapshot(
  symbols: string[],
  currencies: string[],
  fundCodes: string[],
): Promise<OverviewSnapshot | null> {
  const uniqueSymbols = [...new Set(symbols.filter(Boolean))];
  const uniqueCurrencies = [...new Set(currencies.filter((currency) => currency !== 'CNY'))];
  const uniqueFundCodes = [...new Set(fundCodes.filter(Boolean))];
  if (uniqueSymbols.length > 160 || uniqueFundCodes.length > 50) return null;
  const cacheKey = `${uniqueSymbols.join(',')}|${uniqueCurrencies.join(',')}|${uniqueFundCodes.join(',')}`;
  const pending = overviewSnapshotPending.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const params = new URLSearchParams({
      symbols: uniqueSymbols.join(','),
      currencies: uniqueCurrencies.join(','),
      fundCodes: uniqueFundCodes.join(','),
    });
    const res = await fetchWithTimeout(apiUrl(`/api/overview?${params.toString()}`));
    if (!res.ok) return null;
    const json = await res.json();
    const fetchedAt = Date.now();
    const snapshot = parseDashboardSnapshotPayload(json, uniqueSymbols, fetchedAt);
    const fundSummaries = new Map<string, FundNavData>();
    for (const code of uniqueFundCodes) {
      const raw = json.fundSummaries?.[code];
      if (!raw) continue;
      const nav = Number(raw.nav);
      fundSummaries.set(code, {
        code,
        name: code,
        navDate: String(raw.navDate ?? ''),
        nav: Number.isFinite(nav) ? nav : 0,
        officialChange: Number(raw.officialChange) || 0,
        estimatedNav: Number.isFinite(nav) ? nav : 0,
        estimatedChange: 0,
      });
    }
    return { ...snapshot, fundSummaries };
  })().catch(() => null).finally(() => {
    overviewSnapshotPending.delete(cacheKey);
  });

  overviewSnapshotPending.set(cacheKey, request);
  return request;
}

export async function fetchDataHealth(): Promise<DataHealth | null> {
  try {
    const res = await fetch(apiUrl('/api/datahealth'));
    if (!res.ok) return null;
    return await res.json() as DataHealth;
  } catch {
    return null;
  }
}

export async function fetchSystemStatus(): Promise<SystemStatus> {
  try {
    const res = await fetch(apiUrl('/api/status'), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    return {
      status: raw.status === 'ok' ? 'ok' : 'degraded',
      updatedAt: Number(raw.updatedAt) || Date.now(),
      quoteIssueCount: Number(raw.quoteIssueCount) || 0,
      quoteTotal: Number(raw.quoteTotal) || 0,
      workerLastSuccessAt: Number(raw.workerLastSuccessAt) || 0,
    };
  } catch {
    return {
      status: 'offline',
      updatedAt: Date.now(),
      quoteIssueCount: 0,
      quoteTotal: 0,
      workerLastSuccessAt: 0,
    };
  }
}

export async function fetchQuoteDiagnostics(token: string): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl('/api/diagnostics/quotes'), {
    cache: 'no-store',
    headers: { 'X-Diagnostics-Token': token },
  });
  if (!res.ok) {
    throw new Error(res.status === 403 ? '诊断令牌无效或服务端未启用诊断' : `诊断请求失败（${res.status}）`);
  }
  return await res.json() as Record<string, unknown>;
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
    const json = asObject(await res.json());
    if (!json) return results;
    for (const code of codes) {
      const rawRows = json[code];
      if (!Array.isArray(rawRows) || rawRows.length < 2) continue;
      const rows = rawRows as FundHistoryRow[];
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

export async function fetchFundProfiles(codes: string[], refresh = false): Promise<Map<string, NonNullable<Fund['profile']>>> {
  const results = new Map<string, NonNullable<Fund['profile']>>();
  if (codes.length === 0) return results;

  try {
    const refreshParam = refresh ? '&refresh=1' : '';
    const res = await fetch(apiUrl(`/api/fundprofiles?codes=${codes.join(',')}${refreshParam}`));
    if (!res.ok) return results;
    const json = await res.json();
    for (const code of codes) {
      const raw: Fund['profile'] | undefined = json[code];
      if (raw?.inceptionDate) results.set(code, raw);
    }
  } catch { /* skip */ }
  return results;
}

export async function fetchFundHoldings(codes: string[], refresh = false): Promise<Map<string, Holding[]>> {
  const results = new Map<string, Holding[]>();
  if (codes.length === 0) return results;

  try {
    const refreshParam = refresh ? '&refresh=1' : '';
    const res = await fetch(apiUrl(`/api/fundholdings?codes=${codes.join(',')}${refreshParam}`));
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
  options: { force?: boolean } = {},
): Promise<Map<string, MarketReturnSummary>> {
  const results = new Map<string, MarketReturnSummary>();
  const unique = [...new Map(configs.map((config) => [`${config.source}:${config.symbol}`, config])).values()];
  if (unique.length === 0) return results;

  const now = Date.now();
  const missing: MarketHistoryConfig[] = [];
  for (const config of unique) {
    const key = `${config.source}:${config.symbol}`;
    const cached = marketReturnSummaryCache.get(key);
    if (!options.force && cached && now - cached.fetchedAt < MARKET_RETURN_SUMMARY_TTL_MS) {
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

export async function fetchFundNavs(codes: string[], refresh = false): Promise<Map<string, FundNavData>> {
  const results = new Map<string, FundNavData>();
  const refreshParam = refresh ? '&refresh=1' : '';
  const url = apiUrl(`/api/fundnav?codes=${codes.join(',')}${refreshParam}`);
  try {
    const res = await fetch(url);
    if (!res.ok) return results;
    const json = asObject(await res.json());
    if (!json) return results;
    for (const code of codes) {
      const raw = json[code];
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as EastMoneyFundRaw;
      results.set(code, {
        code: r.fundcode,
        name: r.name,
        navDate: r.jzrq,
        nav: parseFloat(r.dwjz) || 0,
        officialChange: 0, // filled later via fetchFundHistory
        estimatedNav: parseFloat(r.gsz) || 0,
        estimatedChange: parseFloat(r.gszzl) || 0,
      });
    }
  } catch { /* skip */ }
  return results;
}
