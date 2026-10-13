import { describe, expect, it } from 'vitest';
import { mergeCompanyMarketCaps, parseCompanyMarketCaps } from '../../scripts/lib/company-market-caps';
import { companyMarketCaps, marketCapUnavailable, withCompanyMarketCaps } from './companyMarketCaps';
import { companyFundamentalsDataset, companySeries } from './companyFundamentals';
import type { CompanyFundamentalPoint, CompanyMarketCapObservation } from '../types';

const sourceUrl = 'https://stockanalysis.com/stocks/aapl/financials/ratios/?p=quarterly';
const retrievedAt = '2026-10-12T00:00:00.000Z';
function fixture(dates: string, values: string, currency = 'USD') {
  return `<link rel="canonical" href="${sourceUrl}"><p>Market cap in millions ${currency}.</p>
    <script>const page = {financialData:{datekey:${dates},marketcap:${values}},map:[]};</script>`;
}
function point(period: string, periodEnd: string): CompanyFundamentalPoint {
  return { period, periodEnd, revenue: 100, operatingProfit: 10, researchAndDevelopment: null, employees: null };
}

describe('offline company market caps', () => {
  it('decodes explicit source values in base currency units, excluding current/TTM', () => {
    const rows = parseCompanyMarketCaps(fixture('["TTM","2025-09-27","2025-06-28"]', '[999,3791126029400,3003295892080]'), sourceUrl, retrievedAt);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ periodEnd: '2025-09-27', value: 3791126029400, currency: 'USD', sourceUrl, retrievedAt });
  });

  it('keeps listing currency distinct from financial reporting currency', () => {
    expect(parseCompanyMarketCaps(fixture('["2025-12-31"]', '[5410660009615]', 'HKD'), sourceUrl, retrievedAt)[0].currency).toBe('HKD');
  });

  it.each([
    ['["2025-12-31"]', '[]'],
    ['["2025-12-31","2025-12-31"]', '[1,2]'],
    ['["2025-02-30"]', '[1]'],
    ['["2027-12-31"]', '[1]'],
    ['["2025-12-31"]', '[-1]'],
    ['["2025-12-31"]', '[0]'],
    ['["2025-12-31"]', '["123"]'],
    ['["2025-12-31"]', '[(()=>{throw Error("executed")})()]'],
  ])('fails closed for malformed or misleading source data %s / %s', (dates, values) => {
    expect(() => parseCompanyMarketCaps(fixture(dates, values), sourceUrl, retrievedAt)).toThrow();
  });

  it('rejects redirects to another company and unknown currency', () => {
    const html = fixture('["2025-12-31"]', '[123]');
    expect(() => parseCompanyMarketCaps(html.replace('/aapl/', '/msft/'), sourceUrl, retrievedAt)).toThrow('redirect');
    expect(() => parseCompanyMarketCaps(html.replace('USD', ''), sourceUrl, retrievedAt)).toThrow('currency');
  });

  it('preserves missing periods instead of treating them as zero or carrying values forward', () => {
    const observations: CompanyMarketCapObservation[] = [{ periodEnd: '2025-09-30', value: 100, currency: 'USD', sourceUrl, retrievedAt }];
    const rows = withCompanyMarketCaps([point('FY2025 Q3', '2025-09-27'), point('FY2025', '2025-12-31')], observations);
    expect(rows.every(row => row.marketCap == null)).toBe(true);
  });

  it('retains older history outside the public source window and rejects conflicting imports without mutation', () => {
    const older = { periodEnd: '2020-12-31', value: 100, currency: 'USD', sourceUrl, retrievedAt };
    const latest = { ...older, periodEnd: '2025-12-31', value: 200 };
    expect(mergeCompanyMarketCaps([older], [latest])).toEqual([older, latest]);
    expect(() => mergeCompanyMarketCaps([older], [])).toThrow();
    expect(() => mergeCompanyMarketCaps([older], [latest, { ...latest, value: 210 }])).toThrow('disagree');
    expect(() => mergeCompanyMarketCaps([older], [{ ...latest, currency: 'HKD' }])).toThrow('Currency');
    expect(older.value).toBe(100);
  });

  it('uses the final quarter endpoint for a derived half year rather than adding market caps', () => {
    const apple = companyFundamentalsDataset.companies.find(company => company.id === 'apple')!;
    const quarter = companySeries(apple, 'quarterly').find(row => row.period === 'FY2025 Q2')!;
    const half = companySeries(apple, 'half').find(row => row.period === 'FY2025 H1')!;
    expect(quarter.marketCap?.value).toBeGreaterThan(0);
    expect(half.marketCap).toEqual(quarter.marketCap);
  });

  it('retains the verified 2018-2020 backfill in all three reporting frequencies', () => {
    for (const id of ['apple', 'adbe', 'amd', 'intel', 'cisco', 'qualcomm', 'micron', 'appliedMaterials',
      'tsmc', 'mediatek', 'foxconn', 'schneider']) {
      const company = companyFundamentalsDataset.companies.find(company => company.id === id)!;
      for (const frequency of ['annual', 'half', 'quarterly'] as const) {
        const historical = companySeries(company, frequency).filter(point => point.periodEnd >= '2018-01-01' && point.periodEnd <= '2020-12-31');
        if (company.id !== 'schneider' || frequency !== 'quarterly') expect(historical.length, `${id} ${frequency}`).toBeGreaterThan(0);
        expect(historical.every(point => point.marketCap != null), `${id} ${frequency}`).toBe(true);
      }
    }
  });

  it('audits every saved row for matching fiscal date, positive value, one currency and provenance', () => {
    expect(Object.keys(companyMarketCaps).length).toBeGreaterThan(0);
    for (const [id, rows] of Object.entries(companyMarketCaps)) {
      const company = companyFundamentalsDataset.companies.find(item => item.id === id)!;
      expect(company, id).toBeDefined();
      expect(marketCapUnavailable[id], id).toBeUndefined();
      const dates = new Set([...company.annual, ...company.halfYear, ...company.quarterly].map(row => row.periodEnd));
      expect(new Set(rows.map(row => row.periodEnd)).size, id).toBe(rows.length);
      expect(new Set(rows.map(row => row.currency)).size, id).toBe(1);
      expect(rows.map(row => row.periodEnd)).toEqual(rows.map(row => row.periodEnd).sort());
      for (const row of rows) {
        expect(dates.has(row.periodEnd), `${id} ${row.periodEnd}`).toBe(true);
        expect(row.value).toBeGreaterThan(0);
        expect(Number.isFinite(row.value)).toBe(true);
        expect(['stockanalysis.com', 'companiesmarketcap.com', 'datacenter-web.eastmoney.com', 'www.sec.gov', 'www.twse.com.tw']).toContain(new URL(row.sourceUrl).hostname);
        if (row.calculation) {
          expect(row.calculation.shares).toBeGreaterThan(0);
          if (row.calculation.sharesFiled) expect(row.calculation.sharesFiled >= row.periodEnd).toBe(true);
          expect(row.calculation.close).toBeGreaterThan(0);
          expect(row.calculation.splitFactor).toBeGreaterThan(0);
          expect(row.value).toBe(Math.round(row.calculation.shares * row.calculation.close * row.calculation.splitFactor));
          expect(['query2.finance.yahoo.com', 'www.twse.com.tw']).toContain(new URL(row.calculation.priceSourceUrl).hostname);
        }
        if (row.observationDate) {
          expect(row.observationDate <= row.periodEnd).toBe(true);
          expect((Date.parse(row.periodEnd) - Date.parse(row.observationDate)) / 86400000).toBeLessThanOrEqual(7);
        }
        expect(row.periodEnd <= row.retrievedAt.slice(0, 10)).toBe(true);
      }
    }
  });
});
