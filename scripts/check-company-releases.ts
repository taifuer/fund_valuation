import { companyFundamentalsDataset } from '../src/data/companyFundamentals';
import {
  assessCompanyReportFreshness,
  latestCompanyPeriodEnd,
  latestSecPeriodicFiling,
  type SecRecentFilings,
} from '../src/data/companyReportMaintenance';

interface SecTickerRecord {
  cik_str: number;
  ticker: string;
}

interface SecSubmissionResponse {
  filings: { recent: SecRecentFilings };
}

const SEC_HEADERS = {
  Accept: 'application/json',
  'User-Agent': process.env.SEC_USER_AGENT
    ?? 'fund-valuation company-data audit taifu@taifua.com',
};

const args = new Set(process.argv.slice(2));
const asOfArg = [...args].find((arg) => arg.startsWith('--as-of='));
const asOf = asOfArg?.slice('--as-of='.length) ?? new Date().toISOString().slice(0, 10);
const offline = args.has('--offline');
const showAll = args.has('--all');
const strict = args.has('--strict');

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: SEC_HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

const localCandidates = companyFundamentalsDataset.companies
  .map((company) => ({ company, freshness: assessCompanyReportFreshness(company, asOf) }))
  .filter(({ freshness }) => freshness.status === 'upcoming' || freshness.status === 'review')
  .map(({ company, freshness }) => ({
    company: company.name,
    latest: `${freshness.latestPeriod} · ${freshness.latestPeriodEnd}`,
    expected: `${freshness.expectedPeriod} · ${freshness.expectedPeriodEnd}`,
    reviewAfter: freshness.reviewAfter,
    status: freshness.status === 'review' ? '需要核查' : '即将进入核查窗口',
    source: company.sourceUrl,
  }));

console.log(`Company report check · dataset ${companyFundamentalsDataset.updatedAt} · as of ${asOf}`);
if (localCandidates.length > 0) {
  console.log('\nCalendar-based review candidates:');
  console.table(localCandidates);
} else {
  console.log('\nNo companies are inside the calendar-based review window.');
}

if (!offline) {
  const tickerRecords = await fetchJson<Record<string, SecTickerRecord>>(
    'https://www.sec.gov/files/company_tickers.json',
  );
  const cikByTicker = new Map(
    Object.values(tickerRecords).map((record) => [record.ticker.toUpperCase(), record.cik_str]),
  );
  const companies = companyFundamentalsDataset.companies.filter(
    (company) => company.region === 'usa',
  );
  const failures: string[] = [];

  const filings = await mapWithConcurrency(companies, 4, async (company) => {
    const cik = cikByTicker.get(company.ticker.toUpperCase());
    if (cik == null) {
      failures.push(`${company.name}: ticker ${company.ticker} not found`);
      return undefined;
    }
    try {
      const paddedCik = String(cik).padStart(10, '0');
      const submission = await fetchJson<SecSubmissionResponse>(
        `https://data.sec.gov/submissions/CIK${paddedCik}.json`,
      );
      const filing = latestSecPeriodicFiling(submission.filings.recent);
      if (!filing) {
        failures.push(`${company.name}: no recent 10-Q/10-K`);
        return undefined;
      }
      const accession = filing.accessionNumber.replaceAll('-', '');
      return {
        company: company.name,
        ticker: company.ticker,
        datasetThrough: latestCompanyPeriodEnd(company),
        secReportThrough: filing.reportDate,
        filedAt: filing.filingDate,
        form: filing.form,
        status: filing.reportDate > latestCompanyPeriodEnd(company) ? '有新财报' : '已同步',
        source: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${filing.primaryDocument}`,
      };
    } catch (error) {
      failures.push(`${company.name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  });

  const completed = filings.filter((filing) => filing != null);
  const updates = completed.filter((filing) => filing.status === '有新财报');
  console.log('\nSEC filing comparison:');
  if (updates.length > 0 || showAll) console.table(showAll ? completed : updates);
  console.log(`${completed.length}/${companies.length} checked; ${updates.length} update(s) found.`);
  if (failures.length > 0) {
    console.warn(`SEC checks with errors: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else if (strict && updates.length > 0) {
    process.exitCode = 2;
  }
}
