import type { QuoteData, FundNavData } from './types';

type Market = 'us' | 'cn_index' | 'cn_stock' | 'intl_index' | 'hk' | 'fund';

function marketType(raw: string): Market {
  if (raw.startsWith('gb_')) return 'us';
  if (raw.startsWith('s_')) return 'cn_index';
  if (raw.startsWith('int_') || raw.startsWith('b_')) return 'intl_index';
  if (raw.startsWith('f_')) return 'fund';
  if (/^hk/.test(raw)) return 'hk';
  return 'cn_stock';
}

function parseSinaVar(line: string): { symbol: string; data: QuoteData } | null {
  const match = line.match(/^var hq_str_(\w+)="(.+)";?\s*$/);
  if (!match) return null;

  const rawSymbol = match[1];
  const fields = match[2].split(',');
  const mkt = marketType(rawSymbol);
  if (mkt === 'fund') return null; // handled by parseSinaFund

  let price: number;
  let previousClose: number;
  let changePct: number;

  switch (mkt) {
    case 'us':
      if (fields.length < 27) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = parseFloat(fields[26]) || price;
      changePct = parseFloat(fields[2]) || 0;
      break;
    case 'cn_index':
    case 'intl_index':
      if (fields.length < 4) return null;
      price = parseFloat(fields[1]) || 0;
      previousClose = price - (parseFloat(fields[2]) || 0);
      changePct = parseFloat(fields[3]) || 0;
      break;
    case 'hk':
      if (fields.length < 10) return null;
      price = parseFloat(fields[6]) || 0;
      previousClose = parseFloat(fields[3]) || price;
      changePct = parseFloat(fields[8]) || 0;
      break;
    case 'cn_stock':
    default:
      if (fields.length < 10) return null;
      price = parseFloat(fields[3]) || 0;
      previousClose = parseFloat(fields[2]) || price;
      changePct = previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
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
      for (const line of text.split('\n')) {
        const parsed = parseSinaVar(line.trim());
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

export async function fetchFundHistory(
  codes: string[],
): Promise<Map<string, { officialChange: number }>> {
  const results = new Map<string, { officialChange: number }>();
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
      results.set(code, { officialChange: Number(officialChange.toFixed(2)) });
    }
  } catch { /* skip */ }
  return results;
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
