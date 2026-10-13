import { describe, expect, it } from 'vitest';
import {
  alignMarketCapsToSessions, calculateSecMarketCaps, calculateTwseMarketCap, parseHistoricalPrices, periodClosingPrice,
  type HistoricalPrices, type SecShareFacts,
} from '../../scripts/lib/company-market-cap-calculation';

const retrievedAt = '2026-10-13T00:00:00Z';
const sourceUrl = 'https://query2.finance.yahoo.com/v8/finance/chart/TEST';
const prices: HistoricalPrices = {
  currency: 'USD', rows: [{ date: '2018-03-29', close: 10 }, { date: '2018-04-02', close: 12 }],
  splits: [{ date: '2020-08-31', ratio: 4 }],
};
const first = { end: '2018-03-31', val: 100, filed: '2018-04-25', form: '10-Q', accn: '0000000001-18-000001' };
function facts(rows = [first]): SecShareFacts {
  return { cik: 1, facts: { 'us-gaap': { CommonStockSharesOutstanding: { units: { shares: rows } } } } };
}
const calculate = (input = facts(), history = prices) => calculateSecMarketCaps(input, 1, ['2018-03-31'], history, sourceUrl, retrievedAt);
function chart() {
  return { chart: { result: [{ meta: { symbol: 'TEST', currency: 'USD', exchangeTimezoneName: 'America/New_York' },
    timestamp: [1522344600, 1522690200], indicators: { quote: [{ close: [10, 12] }], adjclose: [{ adjclose: [5, 6] }] },
    events: { splits: { split: { date: 1598880600, numerator: 4, denominator: 1 } } },
  }], error: null } };
}

describe('period-end market caps from historical shares', () => {
  it('uses market-local dates and split-adjusted closes, not dividend-adjusted closes', () => {
    const parsed = parseHistoricalPrices(JSON.stringify(chart()), 'TEST', 'USD');
    expect(parsed.rows).toEqual(prices.rows);
    expect(parsed.splits).toEqual(prices.splits);
    expect(calculate(facts(), parsed)[0]).toMatchObject({ periodEnd: '2018-03-31', observationDate: '2018-03-29', value: 4000,
      calculation: { shares: 100, close: 10, splitFactor: 4, sharesFiled: '2018-04-25' } });
  });

  it('uses original period-end shares rather than later split-restated shares', () => {
    expect(calculate(facts([{ ...first, val: 400, filed: '2021-04-25' }, first]))[0].value).toBe(4000);
    expect(calculate(facts([{ ...first, end: '2018-04-20' }]))).toEqual([]);
    expect(calculate(facts([{ ...first, filed: '2019-04-25' }]))).toEqual([]);
  });

  it('rejects conflicting first disclosures and splits before filing instead of guessing', () => {
    expect(calculate(facts([first, { ...first, val: 200 }]))).toEqual([]);
    expect(calculate(facts(), { ...prices, splits: [{ date: '2018-04-10', ratio: 2 }] })).toEqual([]);
  });

  it('does not use issued shares, weighted average shares or cover-page dates', () => {
    const data = facts([]);
    data.facts['us-gaap'].CommonStockSharesIssued = { units: { shares: [first] } };
    data.facts['us-gaap'].WeightedAverageNumberOfSharesOutstandingBasic = { units: { shares: [first] } };
    data.facts.dei = { EntityCommonStockSharesOutstanding: { units: { shares: [{ ...first, end: '2018-04-20' }] } } };
    expect(calculate(data)).toEqual([]);
  });

  it('accepts a cover-page count only on the exact period end', () => {
    const data = facts([]);
    data.facts.dei = { EntityCommonStockSharesOutstanding: { units: { shares: [first] } } };
    expect(calculate(data)[0].value).toBe(4000);
  });

  it('subtracts treasury shares only from the same filing and date', () => {
    const data = facts([]);
    data.facts['us-gaap'].CommonStockSharesIssued = { units: { shares: [{ ...first, val: 110 }] } };
    data.facts['us-gaap'].TreasuryStockShares = { units: { shares: [{ ...first, val: 10 }] } };
    expect(calculate(data)[0]).toMatchObject({ value: 4000, calculation: { sharesBasis: 'issued-minus-treasury' } });
    data.facts['us-gaap'].TreasuryStockShares.units.shares[0].accn = '0000000001-19-000001';
    expect(calculate(data)).toEqual([]);
  });

  it('rejects a different issuer, currency and future fiscal dates', () => {
    expect(() => calculate({ ...facts(), cik: 2 })).toThrow('issuer');
    expect(() => calculate(facts(), { ...prices, currency: 'EUR' })).toThrow('currency');
    expect(() => calculateSecMarketCaps(facts(), 1, ['2027-03-31'], prices, sourceUrl, retrievedAt)).toThrow('Future');
  });

  it('requires both enclosing sessions and does not skip a null latest close', () => {
    expect(periodClosingPrice({ ...prices, rows: prices.rows.slice(0, 1) }, '2018-03-31')).toBeUndefined();
    expect(periodClosingPrice({ ...prices, rows: [{ ...prices.rows[0], close: null }, prices.rows[1]] }, '2018-03-31')).toBeUndefined();
    expect(periodClosingPrice(prices, '2018-04-20')).toBeUndefined();
    expect(periodClosingPrice(prices, '2018-03-28')).toBeUndefined();
    expect(() => periodClosingPrice(prices, '2018-02-30')).toThrow('fiscal date');
  });

  it('aligns holiday/weekend observations using actual sessions, never arbitrary earlier points', () => {
    const point = { periodEnd: '2018-03-29', observationDate: '2018-03-29', value: 100, currency: 'USD', sourceUrl, retrievedAt };
    expect(alignMarketCapsToSessions(['2018-03-31'], [point], prices)[0]).toMatchObject({ periodEnd: '2018-03-31', observationDate: '2018-03-29' });
    expect(alignMarketCapsToSessions(['2018-03-31'], [{ ...point, periodEnd: '2018-03-28' }], prices)).toEqual([]);
  });

  it('validates source identity, aligned rows, price values and split ratios', () => {
    expect(() => parseHistoricalPrices(JSON.stringify(chart()), 'OTHER', 'USD')).toThrow('symbol');
    expect(() => parseHistoricalPrices(JSON.stringify(chart()), 'TEST', 'HKD')).toThrow('currency');
    const badRows = chart(); badRows.chart.result[0].indicators.quote[0].close = [10];
    expect(() => parseHistoricalPrices(JSON.stringify(badRows), 'TEST', 'USD')).toThrow('Misaligned');
    const badPrice = chart(); badPrice.chart.result[0].indicators.quote[0].close[0] = -10;
    expect(() => parseHistoricalPrices(JSON.stringify(badPrice), 'TEST', 'USD')).toThrow('closing price');
    const badSplit = chart(); badSplit.chart.result[0].events.splits.split.denominator = 0;
    expect(() => parseHistoricalPrices(JSON.stringify(badSplit), 'TEST', 'USD')).toThrow('split');
  });
});

describe('TWSE daily market capitalization', () => {
  const shares = { stat: 'OK', date: '20190329', fields: ['證券代號', '發行股數'], data: [['2330', '25,930,380,458']] };
  const closes = { stat: 'OK', date: '20190329', tables: [{ fields: ['證券代號', '收盤價'], data: [['2330', '245.50']] }] };
  const calculate = (s = shares, p = closes) => calculateTwseMarketCap(JSON.stringify(s), JSON.stringify(p), '2330',
    '2019-03-31', '2019-03-29', 'https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS',
    'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX', retrievedAt);

  it('uses period-close exchange shares and unadjusted price with explicit currency and provenance', () => {
    expect(calculate()).toMatchObject({ value: Math.round(25930380458 * 245.5), currency: 'TWD',
      periodEnd: '2019-03-31', observationDate: '2019-03-29', calculation: { sharesBasis: 'exchange-issued', splitFactor: 1 } });
  });

  it('rejects wrong dates, symbols, suspended prices and duplicate securities', () => {
    expect(() => calculate({ ...shares, date: '20260329' })).toThrow('date');
    expect(() => calculate({ ...shares, data: [['2317', '25,930,380,458']] })).toThrow('security');
    expect(() => calculate(shares, { ...closes, tables: [{ ...closes.tables[0], data: [['2330', '--']] }] })).toThrow('value');
    expect(() => calculate({ ...shares, data: [...shares.data, ...shares.data] })).toThrow('security');
    expect(() => calculate(shares, { ...closes, tables: [...closes.tables, ...closes.tables] })).toThrow('Ambiguous');
  });
});
