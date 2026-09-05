import { companyFundamentalsDataset } from '../src/data/companyFundamentals';
import {
  assessCompanyReportFreshness,
  latestCompanyPeriodEnd,
  latestSecPeriodicFiling,
} from '../src/data/companyReportMaintenance';
import {
  fetchSecSubmissions,
  loadSecCikByTicker,
  mapWithConcurrency,
  secArchiveUrl,
  secDomesticCompanies,
} from './lib/sec';
import { probeCompanyReleaseSource } from './lib/company-releases';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = new Set(process.argv.slice(2));
const asOfArg = [...args].find((arg) => arg.startsWith('--as-of='));
const asOf = asOfArg?.slice('--as-of='.length) ?? new Date().toISOString().slice(0, 10);
const offline = args.has('--offline');
const showAll = args.has('--all');
const strict = args.has('--strict');
const output = [...args].find(arg => arg.startsWith('--output='))?.slice('--output='.length);
const ids = [...args].find(arg => arg.startsWith('--companies='))?.slice('--companies='.length).split(',');
const selected = companyFundamentalsDataset.companies.filter(company => !ids || ids.includes(company.id));
if (!selected.length) throw new Error('No matching companies');
const report: Record<string, unknown> = { asOf, datasetUpdatedAt: companyFundamentalsDataset.updatedAt, offline, reviewOnly: true };

const localCandidates = selected
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
  const failures: string[] = [];
  const companies = secDomesticCompanies(selected);
  let cikByTicker = new Map<string, number>();
  if (companies.length) {
    try { cikByTicker = await loadSecCikByTicker(); }
    catch (error) { failures.push(`SEC ticker lookup: ${String(error)}`); }
  }

  const filings = await mapWithConcurrency(companies, 1, async (company) => {
    const cik = cikByTicker.get(company.ticker.toUpperCase());
    if (cik == null) {
      failures.push(`${company.name}: ticker ${company.ticker} not found`);
      return undefined;
    }
    try {
      const submission = await fetchSecSubmissions(cik);
      const filing = latestSecPeriodicFiling(submission.filings.recent);
      if (!filing) {
        failures.push(`${company.name}: no recent 10-Q/10-K`);
        return undefined;
      }
      return {
        company: company.name,
        ticker: company.ticker,
        datasetThrough: latestCompanyPeriodEnd(company),
        secReportThrough: filing.reportDate,
        filedAt: filing.filingDate,
        form: filing.form,
        status: filing.reportDate > latestCompanyPeriodEnd(company) ? '有新财报' : '已同步',
        source: secArchiveUrl(cik, filing),
      };
    } catch (error) {
      failures.push(`${company.name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  });

  const completed = filings.filter((filing) => filing != null);
  const updates = completed.filter((filing) => filing.status === '有新财报');
  report.sec = { completed, failures };
  console.log('\nSEC filing comparison:');
  if (updates.length > 0 || showAll) console.table(showAll ? completed : updates);
  console.log(`${completed.length}/${companies.length} checked; ${updates.length} update(s) found.`);
  if (failures.length > 0) {
    console.warn(`SEC checks with errors: ${failures.join('; ')}`);
    process.exitCode = 1;
  } else if (strict && updates.length > 0) {
    process.exitCode = 2;
  }

  const nonUsCompanies = selected
    .filter((company) => company.region !== 'usa');
  const probes = await mapWithConcurrency(nonUsCompanies, 1, async (company) => (
    probeCompanyReleaseSource(company, assessCompanyReportFreshness(company, asOf))
  ));
  const actionable = probes.filter((probe) => probe.status !== '来源可用');
  const candidates = probes.filter((probe) => probe.status === '命中报告候选');
  const sourceFailures = probes.filter((probe) => probe.status === '来源异常');
  const restrictedSources = probes.filter((probe) => probe.status === '访问受限');
  report.nonUs = probes;

  console.log('\nNon-US official-source check:');
  if (showAll || actionable.length > 0) console.table(showAll ? probes : actionable);
  console.log(
    `${probes.length}/${nonUsCompanies.length} checked; `
    + `${candidates.length} candidate(s), ${restrictedSources.length} access-restricted, `
    + `${sourceFailures.length} source error(s).`,
  );
  if (sourceFailures.length > 0) {
    console.warn(
      `Non-US source checks with errors: ${sourceFailures
        .map((probe) => `${probe.company}: ${probe.error ?? 'unknown error'}`)
        .join('; ')}`,
    );
  }
  if (restrictedSources.length > 0) {
    console.warn(
      `Non-US sources requiring browser/manual fallback: ${restrictedSources
        .map((probe) => probe.company)
        .join(', ')}`,
    );
  }
  if (strict && (candidates.length > 0 || sourceFailures.length > 0)) {
    process.exitCode = candidates.length > 0 ? 2 : 1;
  }
}
report.calendarCandidates = localCandidates;
if (output) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Review-only report: ${output}. Financial figures and source references were not modified.`);
}
