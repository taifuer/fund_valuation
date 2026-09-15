import { companyFundamentalsDataset } from '../src/data/companyFundamentals';
import {
  assessCompanyReportFreshness,
  latestCompanyPeriodEnd,
  listSecReviewFilings,
  isSecPeriodicReport,
  secPeriodicReviewReason,
  secAnnouncementCandidates,
  companySecCik,
} from '../src/data/companyReportMaintenance';
import {
  fetchSecSubmissions,
  loadSecCikByTicker,
  mapWithConcurrency,
  secArchiveUrl,
  fetchSecText,
} from './lib/sec';
import { probeCompanyReleaseSource } from './lib/company-releases';
import { probeSecAnnouncement } from './lib/sec-announcements';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const args = new Set(process.argv.slice(2));
const asOfArg = [...args].find((arg) => arg.startsWith('--as-of='));
const asOf = asOfArg?.slice('--as-of='.length) ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf))
  || new Date(asOf).toISOString().slice(0, 10) !== asOf) throw new Error('Invalid --as-of date');
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
  let cikByTicker = new Map<string, number>();
  try { cikByTicker = await loadSecCikByTicker(); }
  catch (error) { failures.push(`SEC ticker lookup: ${String(error)}`); }
  const companies = selected.filter(company => company.region === 'usa' || companySecCik(company, cikByTicker) != null);
  const candidates: Array<Record<string, string>> = [];
  const reviewSince = new Date(`${asOf}T00:00:00Z`);
  reviewSince.setUTCDate(reviewSince.getUTCDate() - 45);

  const filings = await mapWithConcurrency(companies, 1, async (company) => {
    const cik = companySecCik(company, cikByTicker);
    if (cik == null) {
      failures.push(`${company.name}: ticker ${company.ticker} not found`);
      return undefined;
    }
    try {
      const submission = await fetchSecSubmissions(cik);
      const available = listSecReviewFilings(submission.filings.recent, asOf);
      const periodic = available.filter(filing => isSecPeriodicReport(filing.form));
      const filing = [...periodic].sort((left, right) => right.reportDate.localeCompare(left.reportDate)
        || right.filingDate.localeCompare(left.filingDate))[0];
      const annual = periodic.find(item => /^(?:10-K|20-F|40-F)$/.test(item.form));
      const review = [...new Map([filing, annual, ...periodic.filter(item => item.form.endsWith('/A')
        && item.filingDate >= reviewSince.toISOString().slice(0, 10))]
        .filter(item => item != null).map(item => [item.accessionNumber, item])).values()];
      const companyCandidates: Array<Record<string, string>> = [];
      let announcementCheckFailed = false;
      for (const item of review) {
        const reason = secPeriodicReviewReason(company, item);
        if (reason) companyCandidates.push({ company: company.name, kind: reason, form: item.form,
          reportThrough: item.reportDate, filedAt: item.filingDate, source: secArchiveUrl(cik, item) });
      }
      for (const announcement of secAnnouncementCandidates(company, available, asOf)) {
        try {
          const evidence = await probeSecAnnouncement(secArchiveUrl(cik, announcement), fetchSecText);
          if (evidence) companyCandidates.push({ company: company.name, kind: '业绩公告待核查',
            form: announcement.form, filedAt: announcement.filingDate, ...evidence });
        } catch (error) {
          announcementCheckFailed = true;
          failures.push(`${company.name} ${announcement.form}: ${String(error)}`);
        }
      }
      candidates.push(...companyCandidates);
      return {
        company: company.name,
        ticker: company.ticker,
        datasetThrough: latestCompanyPeriodEnd(company),
        secReportThrough: filing?.reportDate ?? '',
        filedAt: filing?.filingDate ?? '',
        form: filing?.form ?? '',
        status: announcementCheckFailed ? '部分披露核查失败' : companyCandidates.length
          ? '有待核查披露' : filing ? '未发现更新披露' : '无定期申报，参考官方来源',
        candidateCount: companyCandidates.length,
        source: filing ? secArchiveUrl(cik, filing) : company.sourceUrl,
      };
    } catch (error) {
      failures.push(`${company.name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  });

  const completed = filings.filter((filing) => filing != null);
  const updates = completed.filter((filing) => filing.candidateCount > 0);
  report.sec = { completed, candidates, failures };
  console.log('\nSEC filing comparison:');
  if (updates.length > 0 || showAll) console.table(showAll ? completed : updates);
  console.log(`${completed.length}/${companies.length} checked; ${updates.length} company/companies with review candidates.`);
  if (candidates.length) console.table(candidates);
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
  const nonUsCandidates = probes.filter((probe) => probe.status === '命中报告候选');
  const sourceFailures = probes.filter((probe) => probe.status === '来源异常');
  const restrictedSources = probes.filter((probe) => probe.status === '访问受限');
  report.nonUs = probes;

  console.log('\nNon-US official-source check:');
  if (showAll || actionable.length > 0) console.table(showAll ? probes : actionable);
  console.log(
    `${probes.length}/${nonUsCompanies.length} checked; `
    + `${nonUsCandidates.length} candidate(s), ${restrictedSources.length} access-restricted, `
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
  if (strict && (nonUsCandidates.length > 0 || sourceFailures.length > 0)) {
    process.exitCode = sourceFailures.length > 0 ? 1 : process.exitCode || 2;
  }
}
report.calendarCandidates = localCandidates;
if (output) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Review-only report: ${output}. Financial figures and source references were not modified.`);
}
