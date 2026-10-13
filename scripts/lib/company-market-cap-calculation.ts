import type { CompanyMarketCapObservation } from '../../src/types';

interface SecShareFact {
  end: string; start?: string; val: number; filed: string; form: string; accn: string;
  basis?: 'outstanding' | 'issued-minus-treasury';
}
export interface SecShareFacts {
  cik: number;
  facts: Record<string, Record<string, { units: Record<string, SecShareFact[]> }>>;
}
export interface HistoricalPrices {
  currency: string;
  rows: Array<{ date: string; close: number | null }>;
  splits: Array<{ date: string; ratio: number }>;
}
const day = 86400000;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

export function parseHistoricalPrices(body: string, symbol: string, currency: string): HistoricalPrices {
  const payload = JSON.parse(body);
  const result = payload.chart?.result;
  if (payload.chart?.error || !Array.isArray(result) || result.length !== 1) throw new Error('Missing price history');
  const chart = result[0];
  if (chart.meta?.symbol !== symbol || chart.meta?.currency !== currency || !chart.meta?.exchangeTimezoneName) {
    throw new Error('Price symbol/currency/timezone mismatch');
  }
  const dateFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: chart.meta.exchangeTimezoneName, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const localDate = (timestamp: number) => {
    if (!positive(timestamp)) throw new Error('Invalid price timestamp');
    return dateFormat.format(new Date(timestamp * 1000));
  };
  const closes = chart.indicators?.quote?.[0]?.close;
  if (!Array.isArray(chart.timestamp) || !Array.isArray(closes) || chart.timestamp.length !== closes.length) {
    throw new Error('Misaligned price history');
  }
  const rows = chart.timestamp.map((timestamp: number, index: number) => {
    const close: unknown = closes[index];
    if (close != null && !positive(close)) throw new Error('Invalid closing price');
    return { date: localDate(timestamp), close: close ?? null };
  }) as HistoricalPrices['rows'];
  if (rows.some((row, index) => index > 0 && row.date <= rows[index - 1].date)) throw new Error('Unordered/duplicate sessions');
  const splits = Object.values(chart.events?.splits ?? {}).map((split: any) => {
    if (!positive(split.numerator) || !positive(split.denominator)) throw new Error('Invalid split');
    return { date: localDate(split.date), ratio: split.numerator / split.denominator };
  });
  return { currency, rows, splits };
}

export function periodClosingPrice(prices: HistoricalPrices, periodEnd: string) {
  if (!validDate(periodEnd)) throw new Error('Invalid fiscal date');
  const index = prices.rows.findIndex(row => row.date > periodEnd) - 1;
  // Require a following session: a truncated or stale response cannot prove a closing date.
  if (index < 0) return undefined;
  const row = prices.rows[index];
  if (row.close == null || (Date.parse(periodEnd) - Date.parse(row.date)) / day > 7
    || (Date.parse(prices.rows[index + 1].date) - Date.parse(periodEnd)) / day > 7) return undefined;
  const splitFactor = prices.splits.filter(split => split.date > row.date).reduce((value, split) => value * split.ratio, 1);
  return { date: row.date, close: row.close, splitFactor, unadjustedClose: row.close * splitFactor };
}

export function calculateSecMarketCaps(
  facts: SecShareFacts, expectedCik: number, dates: readonly string[], prices: HistoricalPrices,
  priceSourceUrl: string, retrievedAt: string,
): CompanyMarketCapObservation[] {
  if (facts.cik !== expectedCik || prices.currency !== 'USD') throw new Error('SEC issuer/currency mismatch');
  const retrievedDate = retrievedAt.slice(0, 10);
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('Invalid retrieval date');
  const gaap = facts.facts['us-gaap'] ?? {};
  const treasury = gaap.TreasuryStockShares?.units?.shares ?? [];
  const netIssued: SecShareFact[] = (gaap.CommonStockSharesIssued?.units?.shares ?? []).flatMap(issued => {
    const sameFiling = treasury.filter(row => row.end === issued.end && row.accn === issued.accn && !row.start);
    if (issued.start || !sameFiling.length || new Set(sameFiling.map(row => row.val)).size !== 1) return [];
    const held = sameFiling[0].val;
    if (!Number.isFinite(held) || held < 0 || !positive(issued.val) || held >= issued.val) return [];
    return [{ ...issued, val: issued.val - held, basis: 'issued-minus-treasury' as const }];
  });
  const shareGroups = [gaap.CommonStockSharesOutstanding?.units?.shares ?? [], netIssued,
    // Some issuers report the exact quarter endpoint on the cover; accept only exact dates.
    facts.facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []];
  return dates.flatMap(periodEnd => {
    if (periodEnd > retrievedDate) throw new Error('Future fiscal date');
    // Use the first filing, not a later split-restated comparative or cover-page share count.
    const candidates = shareGroups.map(group => group.filter(fact => fact.end === periodEnd && !fact.start
      && ['10-Q', '10-K'].includes(fact.form) && validDate(fact.filed) && fact.filed >= periodEnd
      && fact.filed <= retrievedDate && (Date.parse(fact.filed) - Date.parse(periodEnd)) / day <= 120
      && positive(fact.val) && /^\d{10}-\d{2}-\d{6}$/.test(fact.accn))
      .sort((a, b) => a.filed.localeCompare(b.filed))).find(group => group.length) ?? [];
    const fact = candidates[0];
    const price = periodClosingPrice(prices, periodEnd);
    if (!fact || !price) return [];
    if (candidates.some(other => other.filed === fact.filed && other.val !== fact.val)) return [];
    // A split before the first filing can restate the shares; don't guess that filing's basis.
    if (prices.splits.some(split => split.date > price.date && split.date <= fact.filed)) return [];
    const value = Math.round(price.unadjustedClose * fact.val);
    if (!positive(value)) throw new Error('Invalid calculated market cap');
    return [{ periodEnd, observationDate: price.date, value, currency: 'USD', retrievedAt,
      sourceUrl: `https://www.sec.gov/Archives/edgar/data/${expectedCik}/${fact.accn.replace(/-/g, '')}/`,
      calculation: { shares: fact.val, sharesFiled: fact.filed, close: price.close,
        splitFactor: price.splitFactor, priceSourceUrl, sharesBasis: fact.basis ?? 'outstanding' } }];
  });
}

export function calculateTwseMarketCap(
  sharesBody: string, pricesBody: string, code: string, periodEnd: string, observationDate: string,
  sourceUrl: string, priceSourceUrl: string, retrievedAt: string,
): CompanyMarketCapObservation {
  const shares = JSON.parse(sharesBody);
  const prices = JSON.parse(pricesBody);
  if (!validDate(periodEnd) || !validDate(observationDate) || observationDate > periodEnd
    || (Date.parse(periodEnd) - Date.parse(observationDate)) / day > 7
    || !Number.isFinite(Date.parse(retrievedAt)) || periodEnd > retrievedAt.slice(0, 10)) throw new Error('Invalid TWSE endpoint');
  const date = observationDate.replace(/-/g, '');
  if (shares.stat !== 'OK' || prices.stat !== 'OK' || shares.date !== date || prices.date !== date) {
    throw new Error('TWSE response date mismatch');
  }
  function field(table: { fields: string[]; data: unknown[][] }, name: string): number {
    if (!Array.isArray(table?.fields) || !Array.isArray(table?.data)) throw new Error('Missing TWSE table');
    const index = table.fields.indexOf(name);
    const symbolIndex = table.fields.indexOf('證券代號');
    const matches = table.data.filter(row => row[symbolIndex] === code);
    if (index < 0 || symbolIndex < 0 || matches.length !== 1) throw new Error('Missing/ambiguous TWSE security');
    const raw = matches[0][index];
    if (typeof raw !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) throw new Error('Invalid TWSE value');
    const value = Number(raw.replace(/,/g, ''));
    if (!positive(value)) throw new Error('Invalid TWSE value');
    return value;
  }
  const priceTables = prices.tables?.filter((table: { fields: string[] }) => table.fields?.includes('證券代號') && table.fields?.includes('收盤價'));
  if (priceTables?.length !== 1) throw new Error('Ambiguous TWSE prices');
  const count = field(shares, '發行股數');
  const close = field(priceTables[0], '收盤價');
  return { periodEnd, observationDate, value: Math.round(count * close), currency: 'TWD', sourceUrl, retrievedAt,
    calculation: { shares: count, close, splitFactor: 1, priceSourceUrl, sharesBasis: 'exchange-issued' } };
}

export function alignMarketCapsToSessions(
  dates: readonly string[], points: readonly CompanyMarketCapObservation[], prices: HistoricalPrices,
): CompanyMarketCapObservation[] {
  return dates.flatMap(periodEnd => {
    const close = periodClosingPrice(prices, periodEnd);
    if (!close) return [];
    const point = points.find(row => row.periodEnd === periodEnd) ?? points.find(row => row.periodEnd === close.date);
    return point ? [{ ...point, periodEnd }] : [];
  });
}
