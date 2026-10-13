import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { companies } from '../src/data/companies';
import { companySeries } from '../src/data/companyFundamentals';
import { marketCapUnavailable } from '../src/data/companyMarketCaps';
import type { CompanyMarketCapObservation } from '../src/types';
import { alignMarketCapsToSessions, calculateSecMarketCaps, calculateTwseMarketCap, parseHistoricalPrices, periodClosingPrice, type SecShareFacts } from './lib/company-market-cap-calculation';
import { parseCmcMarketCaps, verifiedHistoryAdditions } from './lib/company-market-cap-history';
import { marketCapHistorySlugs } from './lib/company-market-cap-sources';

const args = new Set(process.argv.slice(2));
const selected = [...args].find(arg => arg.startsWith('--companies='))?.slice(12).split(',');
const targets = companies.filter(company => !selected || selected.includes(company.id));
if (!targets.length || selected?.some(id => !companies.some(company => company.id === id))) throw new Error('Unknown company');
const cacheDir = 'data/company-market-cap-shares';
await mkdir(cacheDir, { recursive: true });
const path = 'src/data/companyMarketCaps.json';
const output: Record<string, CompanyMarketCapObservation[]> = JSON.parse(await readFile(path, 'utf8'));
const coverage: object[] = [];
const totals = { added: 0, covered: 0, dates: 0, complete: 0 };

async function fetchCached(key: string, url: string) {
  const cache = `${cacheDir}/${key}.json`;
  try {
    const stored = JSON.parse(await readFile(cache, 'utf8'));
    if (args.has('--offline') || (!args.has('--refresh') && stored.url === url)) return stored;
  } catch (error) { if (args.has('--offline')) throw error; }
  await new Promise(resolve => setTimeout(resolve, 400));
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000), redirect: 'error', headers: {
    'User-Agent': url.includes('sec.gov') ? process.env.SEC_USER_AGENT ?? 'fund-valuation company-data maintenance taifu@taifua.com' : 'Mozilla/5.0',
  } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 20_000_000) throw new Error('Response too large');
  const stored = { url, body, retrievedAt: new Date().toISOString() };
  await writeFile(cache, JSON.stringify(stored));
  return stored;
}

const symbols: Record<string, string> = {
  tencent: '0700.HK', meituan: '3690.HK', xiaomi: '1810.HK', alibaba: 'BABA', jd: 'JD', baidu: 'BIDU',
  novoNordisk: 'NVO', asml: 'ASML', schneider: 'SU.PA', tcs: 'TCS.NS',
  tsmc: '2330.TW', mediatek: '2454.TW', foxconn: '2317.TW',
};
let tickerRecords: Record<string, { ticker: string; cik_str: number }> | undefined;
for (const company of targets) {
  const old = output[company.id] ?? [];
  const dates = [...new Set([...company.annual, ...company.halfYear, ...company.quarterly].map(point => point.periodEnd))].sort();
  const existing = new Map(old.map(point => [point.periodEnd, point]));
  const errors: string[] = [];
  const symbol = symbols[company.id] ?? (company.region === 'usa' ? company.ticker : undefined);
  const currency = old[0]?.currency;
  const references = old.filter(point => new URL(point.sourceUrl).pathname.endsWith('/financials/ratios/'));
  if (symbol && currency && !marketCapUnavailable[company.id] && dates.some(date => !existing.has(date))) {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=1483228800&period2=${Math.floor(Date.now() / 86400000 + 1) * 86400}&interval=1d&events=splits`;
      const priceResponse = await fetchCached(`${company.id}-prices`, url);
      const prices = parseHistoricalPrices(priceResponse.body, symbol, currency);
      async function add(name: string, action: () => Promise<CompanyMarketCapObservation[]>) {
        try {
          const candidates = await action();
          const additions = verifiedHistoryAdditions([...existing.values()], candidates, references);
          additions.forEach(point => existing.set(point.periodEnd, point));
        } catch (error) { errors.push(`${name}: ${String(error)}`); }
      }
      if (company.region === 'usa') await add('sec', async () => {
        tickerRecords ??= JSON.parse((await fetchCached('tickers', 'https://www.sec.gov/files/company_tickers.json')).body);
        const cik = Object.values(tickerRecords!).find(row => row.ticker === symbol)?.cik_str;
        if (!cik) throw new Error('SEC issuer missing');
        const response = await fetchCached(`${company.id}-facts`, `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`);
        return calculateSecMarketCaps(JSON.parse(response.body) as SecShareFacts, cik, dates, prices,
          priceResponse.url, response.retrievedAt > priceResponse.retrievedAt ? response.retrievedAt : priceResponse.retrievedAt);
      });
      if (symbol.endsWith('.TW')) await add('twse', async () => {
        const checkDates = new Set(['2022-03-31', '2023-06-30', '2024-12-31']);
        const candidates: CompanyMarketCapObservation[] = [];
        for (const date of dates.filter(date => !existing.has(date) || checkDates.has(date))) {
          const price = periodClosingPrice(prices, date);
          if (!price) continue;
          const dateKey = price.date.replaceAll('-', '');
          const sharesUrl = `https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date=${dateKey}&selectType=ALLBUT0999&response=json`;
          const closeUrl = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${dateKey}&type=ALLBUT0999&response=json`;
          try {
            const shareResponse = await fetchCached(`twse-${dateKey}-shares`, sharesUrl);
            const closeResponse = await fetchCached(`twse-${dateKey}-prices`, closeUrl);
            candidates.push(calculateTwseMarketCap(shareResponse.body, closeResponse.body, symbol.split('.')[0], date, price.date,
              sharesUrl, closeUrl, closeResponse.retrievedAt));
          } catch (error) { errors.push(`twse ${date}: ${String(error)}`); }
        }
        return candidates;
      });
      const slug = marketCapHistorySlugs[company.id];
      if (slug && ['USD', 'EUR', 'HKD', 'INR'].includes(currency)) await add('cmc-sessions', async () => {
        const prefix = currency === 'USD' ? '' : `${currency.toLowerCase()}/`;
        const sourceUrl = `https://companiesmarketcap.com/${prefix}${slug}/marketcap/`;
        const cache = JSON.parse(await readFile(`data/company-market-cap-history/${company.id}-cmc.json`, 'utf8'));
        const points = parseCmcMarketCaps(cache.body, sourceUrl, cache.retrievedAt, currency);
        return alignMarketCapsToSessions(dates, points, prices);
      });
    } catch (error) { errors.push(String(error)); }
  }
  const rows = [...existing.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  if (rows.length) output[company.id] = rows;
  const frequencies = Object.fromEntries((['annual', 'half', 'quarterly'] as const).map(frequency => {
    const points = companySeries(company, frequency);
    return [frequency, { covered: points.filter(point => existing.has(point.periodEnd)).length, total: points.length }];
  }));
  coverage.push({ company: company.id, covered: rows.length, total: dates.length, frequencies,
    added: rows.length - old.length, missing: dates.filter(date => !existing.has(date)), errors });
  totals.added += rows.length - old.length;
  totals.covered += rows.length;
  totals.dates += dates.length;
  if (rows.length === dates.length) totals.complete++;
  console.log(`${company.id}: ${rows.length}/${dates.length} (+${rows.length - old.length})${errors.length ? `; ${errors.join('; ')}` : ''}`);
}
await writeFile(`${cacheDir}/coverage.json`, `${JSON.stringify(coverage, null, 2)}\n`);
if (args.has('--write')) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(output, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
console.log(`${totals.added} verified additions; ${totals.covered}/${totals.dates} fiscal endpoints; ${totals.complete} companies fully covered. Source rejections are listed in ${cacheDir}/coverage.json.`);
