import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { companies } from '../src/data/companies';
import { marketCapUnavailable } from '../src/data/companyMarketCaps';
import type { CompanyMarketCapObservation } from '../src/types';
import { alignMarketCapHistory, parseCmcMarketCaps, parseEastmoneyMarketCaps, parseStockAnalysisMarketCapHistory, verifiedHistoryAdditions } from './lib/company-market-cap-history';
import { marketCapHistorySlugs, marketCapListingPaths, singleListingWindows } from './lib/company-market-cap-sources';

const args = new Set(process.argv.slice(2));
const selected = [...args].find(arg => arg.startsWith('--companies='))?.slice(12).split(',');
const source = [...args].find(arg => arg.startsWith('--source='))?.slice(9);
if (source && !['cmc', 'stockanalysis', 'eastmoney'].includes(source)) throw new Error('Unknown source');
const cacheDir = 'data/company-market-cap-history';
const outputPath = 'src/data/companyMarketCaps.json';
await mkdir(cacheDir, { recursive: true });
const output: Record<string, CompanyMarketCapObservation[]> = JSON.parse(await readFile(outputPath, 'utf8'));
const coverage: object[] = [];
let added = 0;
let rejected = 0;

async function fetchPage(key: string, url: string) {
  const path = `${cacheDir}/${key}.json`;
  if (args.has('--offline')) return JSON.parse(await readFile(path, 'utf8')) as { body: string; retrievedAt: string };
  await new Promise(resolve => setTimeout(resolve, 400));
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000), redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = { body: await res.text(), retrievedAt: new Date().toISOString() };
  if (data.body.length > 8_000_000) throw new Error('Response too large');
  await writeFile(path, JSON.stringify(data));
  return data;
}

const targets = companies.filter(company => !selected || selected.includes(company.id));
if (!targets.length) throw new Error('No companies selected');
for (const company of targets) {
  const dates = [...new Set([...company.annual, ...company.halfYear, ...company.quarterly].map(point => point.periodEnd))].sort();
  const old = output[company.id] ?? [];
  let rows = [...old];
  const errors: string[] = [];
  async function run(name: string, action: () => Promise<CompanyMarketCapObservation[]>) {
    if (source && source !== name) return;
    try {
      const incoming = await action();
      const byDate = new Map(rows.map(point => [point.periodEnd, point]));
      incoming.forEach(point => { if (!byDate.has(point.periodEnd)) byDate.set(point.periodEnd, point); });
      rows = [...byDate.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
    } catch (error) {
      rejected++;
      errors.push(`${name}: ${String(error)}`);
    }
  }

  const window = singleListingWindows[company.id];
  if (window) await run('eastmoney', async () => {
    const start = new Date(Date.parse(dates[0]) - 8 * 86400000).toISOString().slice(0, 10);
    const query = new URLSearchParams({ reportName: 'RPT_VALUEANALYSIS_DET', columns: 'ALL', pageNumber: '1', pageSize: '10000',
      filter: `(SECURITY_CODE="${window.code}")(TRADE_DATE>='${start}')(TRADE_DATE<'${window.before}')`,
      sortColumns: 'TRADE_DATE', sortTypes: '1', source: 'WEB', client: 'WEB' });
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?${query}`;
    const response = await fetchPage(`${company.id}-eastmoney`, url);
    return parseEastmoneyMarketCaps(response.body, window.code, window.before, dates, url, response.retrievedAt);
  });
  if (!marketCapUnavailable[company.id] && !window && old.length) {
    const currency = old[0].currency;
    // Backfilled observations cannot validate their own source on a later run.
    const references = old.filter(point => new URL(point.sourceUrl).pathname.endsWith('/financials/ratios/'));
    const path = marketCapListingPaths[company.id] ?? `stocks/${company.ticker.toLowerCase()}`;
    await run('stockanalysis', async () => {
      const url = `https://stockanalysis.com/${path}/market-cap/`;
      const response = await fetchPage(`${company.id}-stockanalysis`, url);
      const history = parseStockAnalysisMarketCapHistory(response.body, url, response.retrievedAt, currency);
      return verifiedHistoryAdditions(old, alignMarketCapHistory(dates, history, company.region === 'usa'), references);
    });
    const slug = marketCapHistorySlugs[company.id];
    if (slug && ['USD', 'EUR', 'HKD', 'INR'].includes(currency)) await run('cmc', async () => {
      const prefix = currency === 'USD' ? '' : `${currency.toLowerCase()}/`;
      const url = `https://companiesmarketcap.com/${prefix}${slug}/marketcap/`;
      const response = await fetchPage(`${company.id}-cmc`, url);
      const history = parseCmcMarketCaps(response.body, url, response.retrievedAt, currency);
      return verifiedHistoryAdditions(old, alignMarketCapHistory(dates, history, company.region === 'usa'), references);
    });
  }
  const count = rows.length - old.length;
  added += count;
  if (rows.length) output[company.id] = rows;
  const saved = new Set(rows.map(point => point.periodEnd));
  coverage.push({ company: company.id, covered: rows.length, total: dates.length, added: count,
    missing: dates.filter(date => !saved.has(date)), reason: marketCapUnavailable[company.id], errors });
  console.log(`${company.id}: ${rows.length}/${dates.length} (+${count})${errors.length ? `; ${errors.join('; ')}` : ''}`);
}
await writeFile(`${cacheDir}/coverage.json`, `${JSON.stringify(coverage, null, 2)}\n`);
if (args.has('--write')) {
  await writeFile(`${outputPath}.tmp`, `${JSON.stringify(output, null, 2)}\n`);
  await rename(`${outputPath}.tmp`, outputPath);
}
console.log(`${added} verified additions; ${rejected} source checks rejected, those sources did not overwrite existing data.`);
