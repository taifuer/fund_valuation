import {
  latestSecPeriodicFiling,
  type SecRecentFilings,
} from '../src/data/companyReportMaintenance';
import {
  buildSecCompanyDraft,
  type SecCompanyFactsResponse,
} from '../src/data/secCompanyDraft';

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
    ?? 'fund-valuation company-data draft taifu@taifua.com',
};

const tickerArgument = process.argv.find((argument) => argument.startsWith('--ticker='));
const unitArgument = process.argv.find((argument) => argument.startsWith('--unit='));
const ticker = tickerArgument?.slice('--ticker='.length).trim().toUpperCase();
const unit = unitArgument?.slice('--unit='.length).trim().toUpperCase() ?? 'USD';

if (!ticker) {
  throw new Error('Usage: npm run data:companies:draft -- --ticker=CSCO [--unit=USD]');
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: SEC_HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json() as Promise<T>;
}

const tickerRecords = await fetchJson<Record<string, SecTickerRecord>>(
  'https://www.sec.gov/files/company_tickers.json',
);
const tickerRecord = Object.values(tickerRecords).find(
  (record) => record.ticker.toUpperCase() === ticker,
);
if (!tickerRecord) throw new Error(`SEC ticker not found: ${ticker}`);

const paddedCik = String(tickerRecord.cik_str).padStart(10, '0');
const [submissions, facts] = await Promise.all([
  fetchJson<SecSubmissionResponse>(`https://data.sec.gov/submissions/CIK${paddedCik}.json`),
  fetchJson<SecCompanyFactsResponse>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`),
]);
const filing = latestSecPeriodicFiling(submissions.filings.recent);
if (!filing) throw new Error(`No recent 10-Q/10-K found for ${ticker}`);

const accession = filing.accessionNumber.replaceAll('-', '');
const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${tickerRecord.cik_str}/${accession}/${filing.primaryDocument}`;
const draft = buildSecCompanyDraft(facts, filing, unit);

console.log(JSON.stringify({
  warning: 'Review against the original filing before editing the offline dataset. This command never writes company data.',
  ticker,
  sourceUrl,
  ...draft,
}, null, 2));
