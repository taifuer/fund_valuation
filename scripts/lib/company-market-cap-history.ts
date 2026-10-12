import { parse, type DefaultTreeAdapterMap } from 'parse5';
import ts from 'typescript';
import type { CompanyMarketCapObservation } from '../../src/types';

type Node = DefaultTreeAdapterMap['node'];
export type MarketCapHistoryPoint = CompanyMarketCapObservation & { bucket?: 'annual' | 'quarterly' };

function htmlParts(body: string, url: string) {
  if (body.length > 2_000_000) throw new Error('Response exceeds size limit');
  let canonical = '';
  const scripts: string[] = [];
  function content(node: Node): string {
    return 'value' in node && node.nodeName === '#text' ? node.value
      : 'childNodes' in node ? node.childNodes.map(content).join(' ') : '';
  }
  function walk(node: Node) {
    if ('tagName' in node && node.tagName === 'script') scripts.push(content(node));
    if ('tagName' in node && node.tagName === 'link' && node.attrs.some(a => a.name === 'rel' && a.value === 'canonical')) {
      canonical = node.attrs.find(a => a.name === 'href')?.value ?? '';
    }
    if ('childNodes' in node) node.childNodes.forEach(walk);
  }
  walk(parse(body));
  if (canonical.replace(/\/$/, '') !== url.split('?')[0].replace(/\/$/, '')) throw new Error('Unexpected source redirect');
  return scripts.join('\n');
}

function checkedPoint(date: string, value: number, currency: string, sourceUrl: string, retrievedAt: string): MarketCapHistoryPoint {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date || !Number.isFinite(Date.parse(retrievedAt))
    || date > retrievedAt.slice(0, 10) || !Number.isFinite(value) || value <= 0) throw new Error('Invalid historical market cap');
  return { periodEnd: date, observationDate: date, value: Math.round(value), currency, sourceUrl, retrievedAt };
}

export function parseCmcMarketCaps(body: string, sourceUrl: string, retrievedAt: string, currency: string): MarketCapHistoryPoint[] {
  const url = new URL(sourceUrl);
  const prefix = currency === 'USD' ? '/' : `/${currency.toLowerCase()}/`;
  if (url.origin !== 'https://companiesmarketcap.com' || !['USD', 'HKD', 'EUR', 'INR'].includes(currency)
    || !url.pathname.startsWith(prefix) || url.pathname.split('/').filter(Boolean).length !== (currency === 'USD' ? 2 : 3)) {
    throw new Error('Unsupported historical currency/source');
  }
  const scripts = htmlParts(body, sourceUrl);
  const symbol = /chart1\.currencySymbol\s*=\s*'([^']+)'/.exec(scripts)?.[1];
  const locale = /\bcurrent_locale\s*=\s*"([a-z]+)"/.exec(scripts)?.[1];
  if (locale !== currency.toLowerCase()
    || symbol !== ({ USD: '$', HKD: '$', EUR: '€', INR: '₹' } as Record<string, string>)[currency]) {
    throw new Error(`Unexpected chart currency ${symbol}`);
  }
  const raw = /\bdata\s*=\s*(\[[\s\S]*?\]);/.exec(scripts)?.[1];
  const rows = raw ? JSON.parse(raw) : null;
  if (!Array.isArray(rows) || !rows.length) throw new Error('No public market cap history');
  return rows.map(row => {
    if (!Number.isFinite(row.d) || row.d < 0 || typeof row.m !== 'number') throw new Error('Invalid chart point');
    return checkedPoint(new Date(row.d * 1000).toISOString().slice(0, 10), row.m * 100000, currency, sourceUrl, retrievedAt);
  });
}

// Read only literal fields from the public table window; never run the page's JavaScript.
function parseTableArray(array: ts.ArrayLiteralExpression): Array<{ d: string; v: number }> {
  return array.elements.flatMap(element => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error('Non-literal table row');
    let d: string | undefined;
    let v: number | undefined;
    let unavailable = false;
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) throw new Error('Invalid table field');
      const name = property.name.text;
      if (name === 'd' && ts.isStringLiteral(property.initializer)) d = property.initializer.text;
      else if (name === 'v' && ts.isNumericLiteral(property.initializer)) v = Number(property.initializer.text);
      else if (name === 'v' && ((ts.isStringLiteral(property.initializer) && property.initializer.text === '[PRO]')
        || property.initializer.kind === ts.SyntaxKind.NullKeyword)) unavailable = true;
      else if (name !== 'p') throw new Error('Invalid table value');
    }
    if (unavailable) return [];
    if (d == null || v == null) throw new Error('Missing table date/value');
    return [{ d, v }];
  });
}

export function parseStockAnalysisMarketCapHistory(body: string, sourceUrl: string, retrievedAt: string, expectedCurrency: string): MarketCapHistoryPoint[] {
  const url = new URL(sourceUrl);
  if (url.origin !== 'https://stockanalysis.com' || !url.pathname.endsWith('/market-cap/')) throw new Error('Unsupported history source');
  const scripts = htmlParts(body, sourceUrl);
  const currency = /curr:\{main:"([A-Z]{3})"/.exec(scripts)?.[1];
  if (currency !== expectedCurrency) throw new Error('History currency differs');
  const source = ts.createSourceFile('source.js', scripts, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const tables: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'tables'
      && ts.isObjectLiteralExpression(node.initializer)) tables.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (tables.length !== 1) throw new Error('No unambiguous public market cap tables');
  const result: MarketCapHistoryPoint[] = [];
  for (const bucket of ['annual', 'quarterly'] as const) {
    const property = tables[0].properties.find(prop => ts.isPropertyAssignment(prop)
      && ts.isIdentifier(prop.name) && prop.name.text === bucket);
    if (!property || !ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) {
      throw new Error(`Missing ${bucket} history`);
    }
    result.push(...parseTableArray(property.initializer).map(row => ({ ...checkedPoint(row.d, row.v, currency, sourceUrl, retrievedAt), bucket })));
  }
  return result;
}

export function alignMarketCapHistory(
  dates: readonly string[], points: readonly MarketCapHistoryPoint[], allowWeekend: boolean,
): CompanyMarketCapObservation[] {
  return dates.flatMap(periodEnd => {
    const target = new Date(`${periodEnd}T00:00:00Z`);
    const candidates = points.filter(point => {
      if (point.periodEnd > periodEnd) return false;
      if (point.periodEnd === periodEnd) return true;
      const gap = (target.getTime() - Date.parse(point.periodEnd)) / 86400000;
      const sameMonth = point.periodEnd.slice(0, 7) === periodEnd.slice(0, 7);
      const monthEnd = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      if (periodEnd === monthEnd && sameMonth && gap <= 7
        && ((point.bucket === 'annual' && target.getUTCMonth() === 11)
          || (point.bucket === 'quarterly' && [2, 5, 8, 11].includes(target.getUTCMonth())))) return true;
      // A Friday/Saturday observation can cover a US fiscal weekend, never a missing trading weekday.
      return allowWeekend && [0, 6].includes(target.getUTCDay()) && gap <= (target.getUTCDay() === 0 ? 2 : 1);
    }).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
    const found = candidates[0];
    if (!found) return [];
    const { bucket: _bucket, ...point } = found;
    return [{ ...point, periodEnd }];
  });
}

export function verifiedHistoryAdditions(
  existing: readonly CompanyMarketCapObservation[], candidates: readonly CompanyMarketCapObservation[],
  references: readonly CompanyMarketCapObservation[] = existing,
) {
  const known = new Map(existing.map(point => [point.periodEnd, point]));
  const baseline = new Map(references.map(point => [point.periodEnd, point]));
  const comparisons = candidates.filter(point => baseline.has(point.periodEnd)).map(point => {
    const reference = baseline.get(point.periodEnd)!;
    if (reference.currency !== point.currency) throw new Error('Historical currency mismatch');
    return Math.abs(point.value / reference.value - 1);
  }).sort((a, b) => a - b);
  if (comparisons.length < 3) {
    throw new Error(`Historical source failed overlap cross-check: only ${comparisons.length} reference periods`);
  }
  const median = comparisons[Math.floor(comparisons.length / 2)];
  const maximum = comparisons[comparisons.length - 1];
  if (median > 0.02 || maximum > 0.05) {
    throw new Error(`Historical source failed overlap cross-check: median ${(median * 100).toFixed(2)}%, max ${(maximum * 100).toFixed(2)}%`);
  }
  return candidates.filter(point => !known.has(point.periodEnd));
}

export function parseEastmoneyMarketCaps(body: string, code: string, before: string, dates: readonly string[], sourceUrl: string, retrievedAt: string) {
  const payload = JSON.parse(body);
  if (!payload.success || !Array.isArray(payload.result?.data) || payload.result.pages !== 1) throw new Error('Incomplete valuation history');
  const points = payload.result.data.map((row: Record<string, unknown>) => {
    if (row.SECURITY_CODE !== code || typeof row.TRADE_DATE !== 'string'
      || typeof row.TOTAL_MARKET_CAP !== 'number' || typeof row.CLOSE_PRICE !== 'number' || typeof row.TOTAL_SHARES !== 'number'
      || !Number.isFinite(row.CLOSE_PRICE) || row.CLOSE_PRICE <= 0 || !Number.isFinite(row.TOTAL_SHARES) || row.TOTAL_SHARES <= 0
      || Math.abs(row.TOTAL_MARKET_CAP / (row.CLOSE_PRICE * row.TOTAL_SHARES) - 1) > 0.000001) throw new Error('Invalid valuation scope');
    return checkedPoint(row.TRADE_DATE.slice(0, 10), row.TOTAL_MARKET_CAP, 'CNY', sourceUrl, retrievedAt);
  }).sort((a: MarketCapHistoryPoint, b: MarketCapHistoryPoint) => a.periodEnd.localeCompare(b.periodEnd));
  return dates.filter(date => date < before).flatMap(periodEnd => {
    const found = points.filter((point: MarketCapHistoryPoint) => point.periodEnd <= periodEnd).at(-1);
    if (!found || (Date.parse(periodEnd) - Date.parse(found.periodEnd)) / 86400000 > 7) return [];
    // Full daily history establishes the last trading session, including exchange holidays.
    return [{ ...found, periodEnd } as CompanyMarketCapObservation];
  });
}
