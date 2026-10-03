import type { CompanyReleaseProbe } from './company-releases';

export interface CompanyReviewRun {
  asOf: string;
  datasetUpdatedAt: string;
  offline: boolean;
  reviewOnly: boolean;
  sec?: { completed: Array<{ status: string }>; candidates: Array<Record<string, string>>; failures: string[] };
  nonUs?: CompanyReleaseProbe[];
  calendarCandidates?: unknown[];
  summary?: ReturnType<typeof summarizeCompanyReview>;
}

export function summarizeCompanyReview(report: CompanyReviewRun) {
  const probes = report.nonUs ?? [];
  const failures = [...(report.sec?.failures ?? []), ...probes
    .filter(probe => ['访问受限', '来源异常', '需要人工核查'].includes(probe.status))
    .map(probe => `${probe.company}: ${probe.error ?? probe.status}`)];
  const candidates = [...new Map((report.sec?.candidates ?? [])
    .map(candidate => [`${candidate.company}:${candidate.source}`, candidate])).values()];
  const pendingCompanies = [...new Set([...candidates.map(candidate => candidate.company),
    ...probes.filter(probe => probe.status === '命中报告候选').map(probe => probe.company)])];
  return {
    coverage: report.offline ? 'offline' : failures.length ? 'partial' : 'completed',
    secChecked: report.sec?.completed.length ?? 0,
    secWithoutNewDisclosure: report.sec?.completed.filter(item => item.status === '未发现更新披露').length ?? 0,
    officialSourcesReachable: probes.filter(probe => probe.status === '来源可用').length,
    pendingCompanies,
    unverifiedSources: failures,
    candidates,
  };
}

export function companyReviewMarkdown(report: CompanyReviewRun): string {
  const summary = summarizeCompanyReview(report);
  const safe = (text: string) => text.replace(/[<>|\r\n]/g, ' ');
  return [
    `## Company report review (${report.asOf})`,
    `Coverage: **${summary.coverage}**. Dataset: ${report.datasetUpdatedAt}.`,
    `SEC checks: ${summary.secChecked}; no new disclosure: ${summary.secWithoutNewDisclosure}.`,
    `Official archives reachable: ${summary.officialSourcesReachable} (reachability is not verification of financial figures).`,
    `Companies awaiting review: ${summary.pendingCompanies.length}; unverified sources: ${summary.unverifiedSources.length}.`,
    '',
    ...summary.candidates.map(item => `- ${safe(item.company)}: ${safe(item.kind)} (${safe(item.filedAt ?? '')})`),
    ...summary.unverifiedSources.map(item => `- Not verified: ${safe(item)}`),
    '',
    'This job only discovers disclosures. Review original statements before changing offline data; record reviewed filings in reportReferences.',
    '',
  ].join('\n');
}
