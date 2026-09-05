import type { CompanyFundamentals } from '../../src/types';
import type {
  SecPeriodicFiling,
  SecRecentFilings,
} from '../../src/data/companyReportMaintenance';

interface SecTickerRecord {
  cik_str: number;
  ticker: string;
}

export interface SecSubmissionResponse {
  filings: { recent: SecRecentFilings; files?: Array<{ name: string; filingTo: string }> };
}

const SEC_HEADERS = {
  Accept: 'application/json',
  'User-Agent': process.env.SEC_USER_AGENT
    ?? 'fund-valuation company-data maintenance taifu@taifua.com',
};

export async function fetchSecJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: SEC_HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json() as Promise<T>;
}

export async function mapWithConcurrency<T, R>(
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
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

export async function loadSecCikByTicker(): Promise<Map<string, number>> {
  const records = await fetchSecJson<Record<string, SecTickerRecord>>(
    'https://www.sec.gov/files/company_tickers.json',
  );
  return new Map(
    Object.values(records).map((record) => [record.ticker.toUpperCase(), record.cik_str]),
  );
}

export async function fetchSecSubmissions(cik: number): Promise<SecSubmissionResponse> {
  return fetchSecJson<SecSubmissionResponse>(
    `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`,
  );
}

export function secArchiveUrl(cik: number, filing: SecPeriodicFiling): string {
  const accession = filing.accessionNumber.replaceAll('-', '');
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${filing.primaryDocument}`;
}

export function secDomesticCompanies(
  companies: readonly CompanyFundamentals[],
): CompanyFundamentals[] {
  return companies.filter((company) => company.region === 'usa');
}
