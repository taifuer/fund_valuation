import { companyFundamentalsDataset } from '../src/data/companyFundamentals';
import {
  latestCompanyPeriodEnd,
  latestSecPeriodicFiling,
  type SecPeriodicFiling,
} from '../src/data/companyReportMaintenance';
import {
  buildSecCompanyDraft,
  type SecCompanyFactsResponse,
} from '../src/data/secCompanyDraft';
import {
  fetchSecJson,
  fetchSecSubmissions,
  loadSecCikByTicker,
  mapWithConcurrency,
  secArchiveUrl,
  secDomesticCompanies,
} from './lib/sec';

const args = new Set(process.argv.slice(2));
const tickerArgument = [...args].find((argument) => argument.startsWith('--ticker='));
const unitArgument = [...args].find((argument) => argument.startsWith('--unit='));
const ticker = tickerArgument?.slice('--ticker='.length).trim().toUpperCase();
const unit = unitArgument?.slice('--unit='.length).trim().toUpperCase() ?? 'USD';
const allUpdates = args.has('--all-updates');

if (!ticker && !allUpdates) {
  throw new Error(
    'Usage: npm run data:companies:draft -- --ticker=CSCO [--unit=USD] | --all-updates',
  );
}

async function buildDraft(cik: number, filing: SecPeriodicFiling, currency: string) {
  const facts = await fetchSecJson<SecCompanyFactsResponse>(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`,
  );
  return {
    sourceUrl: secArchiveUrl(cik, filing),
    ...buildSecCompanyDraft(facts, filing, currency),
  };
}

const cikByTicker = await loadSecCikByTicker();

if (ticker) {
  const cik = cikByTicker.get(ticker);
  if (cik == null) throw new Error(`SEC ticker not found: ${ticker}`);
  const submissions = await fetchSecSubmissions(cik);
  const filing = latestSecPeriodicFiling(submissions.filings.recent);
  if (!filing) throw new Error(`No recent 10-Q/10-K found for ${ticker}`);
  const draft = await buildDraft(cik, filing, unit);

  console.log(JSON.stringify({
    warning: 'Review against the original filing before editing the offline dataset. This command never writes company data.',
    ticker,
    ...draft,
  }, null, 2));
} else {
  const companies = secDomesticCompanies(companyFundamentalsDataset.companies);
  const failures: string[] = [];
  const results = await mapWithConcurrency(companies, 4, async (company) => {
    const cik = cikByTicker.get(company.ticker.toUpperCase());
    if (cik == null) {
      failures.push(`${company.name}: ticker ${company.ticker} not found`);
      return undefined;
    }
    try {
      const submissions = await fetchSecSubmissions(cik);
      const filing = latestSecPeriodicFiling(submissions.filings.recent);
      if (!filing) {
        failures.push(`${company.name}: no recent 10-Q/10-K`);
        return undefined;
      }
      const datasetThrough = latestCompanyPeriodEnd(company);
      if (filing.reportDate <= datasetThrough) {
        return { companyId: company.id, status: 'current' as const };
      }
      return {
        companyId: company.id,
        company: company.name,
        ticker: company.ticker,
        datasetThrough,
        status: 'update' as const,
        ...(await buildDraft(cik, filing, company.currency)),
      };
    } catch (error) {
      failures.push(`${company.name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  });
  const completed = results.filter((result) => result != null);
  const updates = completed.filter((result) => result.status === 'update');

  console.log(JSON.stringify({
    warning: 'Only new SEC 10-Q/10-K candidates are included. Review every metric against the original filing before editing company data.',
    checked: completed.length,
    updates,
    failures,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}
