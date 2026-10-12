import { describe, expect, it } from 'vitest';
import {
  alignMarketCapHistory, parseCmcMarketCaps, parseEastmoneyMarketCaps,
  parseStockAnalysisMarketCapHistory, verifiedHistoryAdditions,
  type MarketCapHistoryPoint,
} from '../../scripts/lib/company-market-cap-history';
import { companyMarketCaps } from './companyMarketCaps';

const retrievedAt = '2026-10-12T00:00:00.000Z';
const sourceUrl = 'https://stockanalysis.com/stocks/aapl/market-cap/';
const point = (periodEnd: string, value = 100): MarketCapHistoryPoint => ({
  periodEnd, observationDate: periodEnd, value, currency: 'USD', sourceUrl, retrievedAt,
});
const sa = (annual: string, quarterly = '[]') => `<link rel="canonical" href="${sourceUrl}">
  <script>const page = {curr:{main:"USD"},tables:{annual:${annual},quarterly:${quarterly}}};</script>`;
const cmcUrl = 'https://companiesmarketcap.com/hkd/tencent/marketcap/';
const cmc = (locale = 'hkd') => `<link rel="canonical" href="${cmcUrl}">
  <script>current_locale = "${locale}"; chart1.currencySymbol = '$';
  data = [{"d":1546214400,"m":29887390.18108}];</script>`;

describe('historical market cap backfill', () => {
  it('reads public rows around protected values without interpreting page JavaScript', () => {
    const html = sa('[{d:"2020-12-31",v:"[PRO]",p:"[PRO]"},{d:"2021-12-31",v:125,p:-2}]',
      '[{d:"2022-03-31",v:null,p:null},{d:"2022-06-30",v:150,p:20}]');
    expect(parseStockAnalysisMarketCapHistory(html, sourceUrl, retrievedAt, 'USD').map(row => row.value)).toEqual([125, 150]);
    expect(() => parseStockAnalysisMarketCapHistory(sa('[{d:"2021-12-31",v:dangerous(),p:0}]'), sourceUrl, retrievedAt, 'USD')).toThrow('Invalid table value');
  });

  it('rejects redirected, ambiguous or differently denominated history', () => {
    const html = sa('[{d:"2021-12-31",v:125,p:0}]');
    expect(() => parseStockAnalysisMarketCapHistory(html.replace('/aapl/', '/msft/'), sourceUrl, retrievedAt, 'USD')).toThrow('redirect');
    expect(() => parseStockAnalysisMarketCapHistory(html, sourceUrl, retrievedAt, 'HKD')).toThrow('currency');
    expect(() => parseStockAnalysisMarketCapHistory(html + '<script>const x={tables:{annual:[],quarterly:[]}};</script>', sourceUrl, retrievedAt, 'USD')).toThrow('unambiguous');
  });

  it('uses locale as well as dollar symbol to distinguish HKD from USD and applies the source scale', () => {
    expect(parseCmcMarketCaps(cmc(), cmcUrl, retrievedAt, 'HKD')[0]).toMatchObject({
      periodEnd: '2018-12-31', currency: 'HKD', value: 2988739018108,
    });
    expect(() => parseCmcMarketCaps(cmc('usd'), cmcUrl, retrievedAt, 'HKD')).toThrow('currency');
    expect(() => parseCmcMarketCaps(cmc(), cmcUrl, retrievedAt, 'USD')).toThrow('source');
    expect(() => parseCmcMarketCaps(cmc().replace('29887390.18108', '0'), cmcUrl, retrievedAt, 'HKD')).toThrow('Invalid');
  });

  it('uses exact observations or a preceding US fiscal-weekend close, never future or stale weekly points', () => {
    const points = [point('2025-09-26'), point('2025-09-29', 110)];
    const dates = ['2025-09-27', '2025-09-28', '2025-09-30', '2025-10-04'];
    expect(alignMarketCapHistory(dates, points, true).map(row => [row.periodEnd, row.observationDate])).toEqual([
      ['2025-09-27', '2025-09-26'], ['2025-09-28', '2025-09-26'],
    ]);
    expect(alignMarketCapHistory(dates, points, false)).toEqual([]);
    expect(alignMarketCapHistory(['2025-09-25'], points, true)).toEqual([]);
  });

  it('accepts explicitly annual/quarterly closing observations for the corresponding calendar endpoint only', () => {
    const annual: MarketCapHistoryPoint = { ...point('2024-12-30'), bucket: 'annual' };
    expect(alignMarketCapHistory(['2024-12-31'], [annual], false)[0].observationDate).toBe('2024-12-30');
    expect(alignMarketCapHistory(['2024-12-29', '2025-01-01'], [annual], true)).toEqual([]);
    expect(alignMarketCapHistory(['2024-12-31'], [point('2024-12-30')], false)).toEqual([]);
  });

  it('requires overlapping reference periods and preserves primary values rather than replacing them', () => {
    const old = [point('2024-03-31'), point('2024-06-30'), point('2024-09-30')];
    const candidates = [...old.map(row => ({ ...row, value: 101 })), point('2023-12-31')];
    expect(verifiedHistoryAdditions(old, candidates)).toEqual([point('2023-12-31')]);
    expect(() => verifiedHistoryAdditions(old, candidates.slice(1))).toThrow('cross-check');
    expect(() => verifiedHistoryAdditions(old, candidates.map(row => ({ ...row, value: row.value * 1000 })))).toThrow('cross-check');
    expect(() => verifiedHistoryAdditions(old, candidates.map(row => ({ ...row, currency: 'HKD' })))).toThrow('currency');
    expect(() => verifiedHistoryAdditions(old, candidates.map((row, i) => ({ ...row, value: i === 0 ? 120 : row.value })))).toThrow('cross-check');
    expect(() => verifiedHistoryAdditions([...old, ...candidates], candidates, old.slice(0, 2))).toThrow('cross-check');
  });

  it('takes the last available trading close from complete daily data only before a second listing', () => {
    const rows = ['2025-03-28', '2025-03-31', '2025-06-30'].map((date, i) => ({
      SECURITY_CODE: '300750', TRADE_DATE: `${date} 00:00:00`, TOTAL_MARKET_CAP: (100 + i) * 10,
      CLOSE_PRICE: 100 + i, TOTAL_SHARES: 10,
    }));
    const payload = { success: true, result: { pages: 1, data: rows } };
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
    const parse = (body: unknown) => parseEastmoneyMarketCaps(JSON.stringify(body), '300750', '2025-05-20',
      ['2025-03-31', '2025-04-10', '2025-06-30'], url, retrievedAt);
    expect(parse(payload)).toEqual([{ ...point('2025-03-31', 1010), currency: 'CNY', sourceUrl: url }]);
    expect(() => parse({ ...payload, result: { ...payload.result, pages: 2 } })).toThrow('Incomplete');
    expect(() => parse({ ...payload, result: { pages: 1, data: [{ ...rows[0], TOTAL_MARKET_CAP: 5 }] } })).toThrow('scope');
    expect(() => parse({ ...payload, result: { pages: 1, data: [{ ...rows[0], SECURITY_CODE: '600276' }] } })).toThrow('scope');
  });

  it('keeps the verified Samsung common-and-preferred share scope', () => {
    const value = companyMarketCaps.samsung.find(row => row.periodEnd === '2024-12-31')!;
    expect(value.currency).toBe('KRW');
    expect(value.value).toBe(5_969_782_550 * 53_200 + 822_886_700 * 44_200);
  });
});
