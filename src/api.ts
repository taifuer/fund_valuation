import type {
  QuoteData,
  FundNavData,
  FundHistoryPoint,
  FxRateData,
  MarketHistoryConfig,
  MarketHistoryPoint,
} from './types';

type Market = 'us' | 'cn_index' | 'cn_stock' | 'intl_index' | 'hk' | 'global_future' | 'crypto' | 'fund' | 'fx';

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

// Reject dates that differ from Beijing date by more than this many days (stale Sina data)
function isStale(dateStr: string, maxDiffDays = 2): boolean {
  if (!dateStr) return true;
  const d = new Date(dateStr + 'T00:00:00+08:00');
  const bj = new Date(beijingDate() + 'T00:00:00+08:00');
  const diff = Math.abs(d.getTime() - bj.getTime()) / (1000 * 60 * 60 * 24);
  return diff > maxDiffDays;
}

// Determine the US trading date from Sina's Beijing-time datetime.
// US market opens 9:30 AM ET = 21:30 Beijing (EDT). Before open, the last
// completed session was the previous calendar day.
function usTradingDate(beijingDatetime: string): string {
  const parts = beijingDatetime.split(' ');
  if (!parts[0] || !parts[1]) return beijingDate();
  const datePart = parts[0];
  const [hour, minute] = parts[1].split(':').map(Number);
  // 21:30 Beijing = 9:30 AM ET market open (EDT; 22:30 during EST — 1h window tolerable)
  if (hour < 21 || (hour === 21 && minute < 30)) {
    const d = new Date(datePart + 'T12:00:00+08:00');
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return datePart;
}

function usExtendedDate(raw: string, fallbackYear: string): string {
  const match = raw.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+/);
  if (!match || !fallbackYear) return beijingDate();
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const month = months[match[1]];
  if (!month) return beijingDate();
  return `${fallbackYear}-${month}-${match[2].padStart(2, '0')}`;
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
      // fields[3] = "2026-04-29 09:41:59" Beijing time → derive US trading date
      date = usTradingDate(fields[3] || '');
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
          date = usExtendedDate(extendedTime, fields[29] || date.slice(0, 4));
          session = 'pre';
        } else if (extendedPrice > 0 && extendedSession === 'post') {
          price = extendedPrice;
          changePct = previousClose ? ((extendedPrice - previousClose) / previousClose) * 100 : 0;
          date = usExtendedDate(extendedTime, fields[29] || date.slice(0, 4));
          session = 'post';
        }
      }
      break;
    case 'cn_index':
      if (fields.length < 4) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = price - (parseFloat(fields[2]) || 0);
      changePct = parseFloat(fields[3]) || 0;
      date = beijingDate();
      dateReliable = false;
      break;
    case 'intl_index':
      if (fields.length < 4) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = price - (parseFloat(fields[2]) || 0);
      changePct = parseFloat(fields[3]) || 0;
      // b_KOSPI: fields[6]="2026-04-29"; b_TWSE: fields[5]="2025-09-26"; int_nikkei: no date
      for (let i = fields.length - 1; i >= 4; i--) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(fields[i])) {
          date = fields[i];
          break;
        }
      }
      if (!date || isStale(date)) {
        date = beijingDate();
        dateReliable = false;
      }
      break;
    case 'hk':
      if (fields.length < 19) return null;
      price = parseFloat(fields[6]) || 0;
      previousClose = parseFloat(fields[3]) || price;
      changePct = parseFloat(fields[8]) || 0;
      // fields[17] = "2026/04/29"
      date = (fields[17] || '').replace(/\//g, '-');
      if (isStale(date)) {
        date = beijingDate();
        dateReliable = false;
      }
      break;
    case 'global_future':
      if (fields.length < 13) return null;
      price = parseFloat(fields[0]) || 0;
      previousClose = parseFloat(fields[8]) || price;
      changePct = previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
      date = fields[12] || beijingDate();
      if (isStale(date)) {
        date = beijingDate();
        dateReliable = false;
      }
      break;
    case 'crypto': {
      if (fields.length < 12) return null;
      price = parseFloat(fields[1]) || 0;
      const changeRaw = parseFloat(fields[11]) || 0;
      previousClose = price - changeRaw || price;
      changePct = parseFloat(fields[10]) || 0;
      date = [...fields].reverse().find((field) => /^\d{4}-\d{2}-\d{2}$/.test(field)) ?? beijingDate();
      if (isStale(date)) {
        date = beijingDate();
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
          date = fields[i];
          break;
        }
      }
      if (!date || isStale(date)) {
        date = beijingDate();
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
  if (pair === 'USDCNY') {
    const date = [...fields].reverse().find((field) => /^\d{4}-\d{2}-\d{2}$/.test(field)) ?? beijingDate();
    return {
      currency: 'USD',
      pair: 'USD/CNY',
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
    const url = `/api/sina?list=${batch.join(',')}`;
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
  const url = `/api/sina?list=${symbols.join(',')}`;
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
  const symbols = currencies.includes('USD') ? ['fx_susdcny'] : [];
  if (symbols.length === 0) return results;

  const url = `/api/sina?list=${symbols.join(',')}`;
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

export async function fetchFundHistory(
  codes: string[],
): Promise<Map<string, { navDate: string; nav: number; officialChange: number }>> {
  const results = new Map<string, { navDate: string; nav: number; officialChange: number }>();
  const url = `/api/fundhistory?codes=${codes.join(',')}`;
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
  // East Money caps this endpoint at 20 rows even when a larger pageSize is requested.
  const pageSize = 20;
  const maxPages = Math.ceil(targetSize / pageSize);
  const rows: FundHistoryRow[] = [];
  let previousFirstDate = '';

  try {
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
      const url = `/api/fundhistory?codes=${code}&pageSize=${pageSize}&pageIndex=${pageIndex}`;
      const res = await fetch(url);
      if (!res.ok) break;
      const json = await res.json();
      const pageRows: FundHistoryRow[] | undefined = json[code];
      if (!pageRows || pageRows.length === 0) break;
      if (pageRows[0]?.FSRQ === previousFirstDate) break;
      previousFirstDate = pageRows[0]?.FSRQ ?? '';
      rows.push(...pageRows);
      if (rows.length >= targetSize) break;
    }

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

export async function fetchMarketHistory(config: MarketHistoryConfig): Promise<MarketHistoryPoint[]> {
  try {
    const params = new URLSearchParams({
      source: config.source,
      symbol: config.symbol,
    });
    const res = await fetch(`/api/markethistory?${params.toString()}`);
    if (!res.ok) return [];
    const text = await res.text();
    let points: MarketHistoryPoint[] = [];

    if (config.source === 'sina-cn') {
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

export async function fetchFundNavs(codes: string[]): Promise<Map<string, FundNavData>> {
  const results = new Map<string, FundNavData>();
  const url = `/api/fundnav?codes=${codes.join(',')}`;
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
