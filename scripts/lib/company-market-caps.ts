import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { CompanyMarketCapObservation } from '../../src/types';

type Node = DefaultTreeAdapterMap['node'];

function text(node: Node): string {
  if ('value' in node && node.nodeName === '#text') return node.value;
  return 'childNodes' in node ? node.childNodes.map(text).join(' ') : '';
}

export function parseCompanyMarketCaps(body: string, sourceUrl: string, retrievedAt: string): CompanyMarketCapObservation[] {
  if (body.length > 2_000_000) throw new Error('Response exceeds size limit');
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('Invalid retrieval timestamp');
  const source = new URL(sourceUrl);
  if (source.origin !== 'https://stockanalysis.com' || !source.pathname.endsWith('/financials/ratios/')) {
    throw new Error('Unsupported market cap source');
  }
  const document = parse(body);
  const scripts: string[] = [];
  let canonical = '';
  function walk(node: Node) {
    if ('tagName' in node) {
      if (node.tagName === 'script') scripts.push(text(node));
      if (node.tagName === 'link' && node.attrs.some(attr => attr.name === 'rel' && attr.value === 'canonical')) {
        canonical = node.attrs.find(attr => attr.name === 'href')?.value ?? '';
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(walk);
  }
  walk(document);
  if (canonical.split('?')[0] !== `${source.origin}${source.pathname}`) throw new Error('Unexpected company/source redirect');
  const currency = /Market cap in millions ([A-Z]{3})\b/.exec(text(document))?.[1];
  if (!currency || !['USD', 'EUR', 'HKD', 'CNY', 'TWD', 'KRW', 'JPY', 'INR', 'GBP', 'CHF', 'CAD'].includes(currency)) {
    throw new Error('Missing/unsupported market cap currency');
  }
  const payload = scripts.find(script => script.includes('financialData:{'))?.split('financialData:{')[1]?.split('},map:')[0];
  if (!payload) throw new Error('Missing financial data');
  // Only decode JSON arrays, never evaluate upstream JavaScript or read TTM/current values.
  function array(key: string): unknown[] {
    const raw = new RegExp(`(?:^|,)${key}:(\\[[^\\[\\]]*\\])`).exec(payload!)?.[1];
    const value = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(value)) throw new Error(`Missing ${key} array`);
    return value;
  }
  const dates = array('datekey');
  const values = array('marketcap');
  if (dates.length !== values.length) throw new Error('Misaligned dates and values');
  const result: CompanyMarketCapObservation[] = [];
  const seen = new Set<string>();
  dates.forEach((date, index) => {
    if (date === 'TTM' || date === 'Current') return;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date
      || date > retrievedAt.slice(0, 10) || seen.has(date)) throw new Error('Invalid/duplicate period end');
    seen.add(date);
    const value = values[index];
    if (value == null) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Invalid market cap');
    result.push({ periodEnd: date, value: Math.round(value), currency, sourceUrl, retrievedAt });
  });
  if (!result.length) throw new Error('No historical market caps');
  return result.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

export function mergeCompanyMarketCaps(
  previous: readonly CompanyMarketCapObservation[],
  candidates: readonly CompanyMarketCapObservation[],
): CompanyMarketCapObservation[] {
  if (!candidates.length) throw new Error('No exact fiscal-date matches');
  if (new Set([...previous, ...candidates].map(point => point.currency)).size !== 1) {
    throw new Error('Currency changes require manual review');
  }
  const incoming = new Map<string, CompanyMarketCapObservation>();
  for (const point of candidates) {
    const duplicate = incoming.get(point.periodEnd);
    if (duplicate && (duplicate.currency !== point.currency || Math.abs(duplicate.value / point.value - 1) > 0.000001)) {
      throw new Error(`Annual/quarterly values disagree: ${point.periodEnd}`);
    }
    incoming.set(point.periodEnd, point);
  }
  const merged = new Map(previous.map(point => [point.periodEnd, point]));
  incoming.forEach((point, date) => merged.set(date, point));
  const rows = [...merged.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  return rows;
}
