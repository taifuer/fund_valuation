import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { companies } from '../src/data/companies';
import { marketCapUnavailable } from '../src/data/companyMarketCaps';
import type { CompanyMarketCapObservation } from '../src/types';
import { mergeCompanyMarketCaps, parseCompanyMarketCaps } from './lib/company-market-caps';
import { marketCapListingPaths, singleListingWindows } from './lib/company-market-cap-sources';

const args = new Set(process.argv.slice(2));
const selected = [...args].find(arg => arg.startsWith('--company='))?.slice(10);
const outputPath = 'src/data/companyMarketCaps.json';
const output: Record<string, CompanyMarketCapObservation[]> = JSON.parse(await readFile(outputPath, 'utf8'));
const cacheDir = 'data/company-market-caps';
await mkdir(cacheDir, { recursive: true });
const targets = companies.filter(company => (!selected || company.id === selected)
  && !marketCapUnavailable[company.id] && !singleListingWindows[company.id]);
if (!targets.length) throw new Error('No eligible companies selected');
let failed = false;
for (const company of targets) {
  try {
    const path = marketCapListingPaths[company.id] ?? (company.region === 'usa' ? `stocks/${company.ticker.toLowerCase()}` : null);
    if (!path) throw new Error('No verified listing mapping');
    const dates = new Set([...company.annual, ...company.halfYear, ...company.quarterly].map(point => point.periodEnd));
    const collected: CompanyMarketCapObservation[] = [];
    for (const frequency of ['annual', 'quarterly']) {
      const url = `https://stockanalysis.com/${path}/financials/ratios/${frequency === 'quarterly' ? '?p=quarterly' : ''}`;
      const cachePath = `${cacheDir}/${company.id}-${frequency}.json`;
      let response: { body: string; retrievedAt: string };
      if (args.has('--offline')) {
        response = JSON.parse(await readFile(cachePath, 'utf8'));
      } else {
        const res = await fetch(url, { signal: AbortSignal.timeout(25_000), redirect: 'error' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        response = { body: await res.text(), retrievedAt: new Date().toISOString() };
      }
      const parsed = parseCompanyMarketCaps(response.body, url, response.retrievedAt);
      if (!args.has('--offline')) await writeFile(cachePath, JSON.stringify(response));
      collected.push(...parsed.filter(point => dates.has(point.periodEnd)));
      if (!args.has('--offline')) await new Promise(resolve => setTimeout(resolve, 400));
    }
    const rows = mergeCompanyMarketCaps(output[company.id] ?? [], collected);
    output[company.id] = rows;
    console.log(`${company.id}: ${rows.length}/${dates.size} period ends (${rows[0].currency})`);
  } catch (error) {
    failed = true;
    console.error(`${company.id}: ${String(error)}; existing data retained`);
  }
}
if (args.has('--write') && !failed) {
  await writeFile(`${outputPath}.tmp`, `${JSON.stringify(output, null, 2)}\n`);
  await rename(`${outputPath}.tmp`, outputPath);
} else if (failed) {
  console.error('Dataset unchanged. Resolve source errors or update a verified company with --company=<id>.');
  process.exitCode = 1;
}
