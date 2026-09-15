import type { CompanyFundamentals, CompanyRegion } from '../types';

export type CompanyReportFreshnessStatus = 'current' | 'upcoming' | 'review' | 'annualOnly';

export interface CompanyReportFreshness {
  status: CompanyReportFreshnessStatus;
  latestPeriod: string;
  latestPeriodEnd: string;
  expectedPeriod?: string;
  expectedPeriodEnd?: string;
  reviewAfter?: string;
}

export interface SecRecentFilings {
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
  form: string[];
  primaryDocument: string[];
  items?: string[];
}

export interface SecReviewFiling {
  accessionNumber: string;
  filingDate: string;
  reportDate: string;
  form: string;
  primaryDocument: string;
  items: string;
}

const PERIODIC_FORMS = new Set(['10-Q', '10-K', '20-F', '40-F']);

export function isSecPeriodicReport(form: string): boolean {
  return PERIODIC_FORMS.has(form.replace(/\/A$/, ''));
}

export function companySecCik(company: CompanyFundamentals, cikByTicker: Map<string, number>): number | undefined {
  for (const ticker of company.ticker.toUpperCase().split(/\s*\/\s*/)) {
    const cik = cikByTicker.get(ticker.trim());
    if (cik != null) return cik;
  }
  return undefined;
}

export function listSecReviewFilings(filings: SecRecentFilings, asOf: string): SecReviewFiling[] {
  return filings.form.flatMap((form, index) => {
    const accessionNumber = filings.accessionNumber[index];
    const primaryDocument = filings.primaryDocument[index];
    const filingDate = filings.filingDate[index];
    if ((!isSecPeriodicReport(form) && !['8-K', '6-K'].includes(form))
      || !/^\d{10}-\d{2}-\d{6}$/.test(accessionNumber ?? '')
      || !/^[\w.-]+\.(?:htm|html)$/i.test(primaryDocument ?? '')
      || !/^\d{4}-\d{2}-\d{2}$/.test(filingDate ?? '') || filingDate > asOf) return [];
    return [{ form, accessionNumber, primaryDocument, filingDate,
      reportDate: filings.reportDate[index] ?? '', items: filings.items?.[index] ?? '' }];
  }).sort((left, right) => right.filingDate.localeCompare(left.filingDate)
    || right.accessionNumber.localeCompare(left.accessionNumber));
}

export function hasReviewedSecFiling(company: CompanyFundamentals, filing: SecReviewFiling): boolean {
  const accession = filing.accessionNumber.replace(/-/g, '');
  // Generated source links locate documents; only explicit references imply review.
  return [...(company.reportReferences ?? []), ...(company.latestReport ? [company.latestReport] : [])]
    .some(reference => {
      try {
        const url = new URL(reference.sourceUrl);
        return ['www.sec.gov', 'sec.gov'].includes(url.hostname) && url.pathname.includes(`/${accession}/`);
      } catch { return false; }
    });
}

export function secPeriodicReviewReason(company: CompanyFundamentals, filing: SecReviewFiling): string | undefined {
  if (!isSecPeriodicReport(filing.form) || !/^\d{4}-\d{2}-\d{2}$/.test(filing.reportDate)
    || hasReviewedSecFiling(company, filing)) return undefined;
  if (filing.reportDate > latestCompanyPeriodEnd(company)) return '新报告期';
  const annual = filing.form.replace(/\/A$/, '') !== '10-Q';
  const points = annual ? company.annual : company.quarterly;
  const point = points.find(candidate => candidate.periodEnd === filing.reportDate);
  if (!point) return undefined;
  if (filing.form.endsWith('/A')) return '同期间修订报告';
  const missing = [
    annual && point.employees == null && points.some(candidate => candidate.employees != null) ? '员工人数' : '',
    point.researchAndDevelopment == null && points.some(candidate => candidate.researchAndDevelopment != null) ? '研发费用' : '',
  ].filter(Boolean);
  if (missing.length) return `同期间正式报告，待核查${missing.join('、')}`;
  const periods = new Set([...company.annual, ...company.quarterly]
    .filter(candidate => candidate.periodEnd === filing.reportDate).map(candidate => candidate.period));
  const earlierReference = [...(company.reportReferences ?? []), ...(company.latestReport ? [company.latestReport] : [])]
    .some(reference => periods.has(reference.period) && reference.publishedAt <= filing.filingDate);
  return earlierReference ? '同期间正式报告，待复核公告数据' : undefined;
}

export function secAnnouncementCandidates(
  company: CompanyFundamentals, filings: SecReviewFiling[], asOf: string, limit = 2,
): SecReviewFiling[] {
  const since = addDays(asOf, -45);
  const reviewedAt = [...(company.reportReferences ?? []), ...(company.latestReport ? [company.latestReport] : [])]
    .reduce((latest, reference) => reference.publishedAt > latest ? reference.publishedAt : latest, '');
  return filings.filter(filing => ['8-K', '6-K'].includes(filing.form)
    && filing.filingDate >= since && filing.filingDate <= asOf
    && filing.filingDate >= reviewedAt
    && !hasReviewedSecFiling(company, filing)
    && (filing.form === '6-K' || !filing.items || /(?:^|[,\s])2\.02(?:$|[,\s])/.test(filing.items)))
    .slice(0, Math.max(0, limit));
}

export interface SecPeriodicFiling {
  accessionNumber: string;
  filingDate: string;
  reportDate: string;
  form: '10-Q' | '10-K';
  primaryDocument: string;
}

const REVIEW_LAG_DAYS: Record<CompanyRegion, number> = {
  china: 65,
  usa: 50,
  europe: 55,
  asiaPacific: 55,
};

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function addMonths(value: string, months: number): string {
  const date = parseDate(value);
  const targetMonth = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const sourceFinalDay = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  const finalDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return formatDate(new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    date.getUTCDate() === sourceFinalDay ? finalDay : Math.min(date.getUTCDate(), finalDay),
  )));
}

function nextQuarter(period: string): string | undefined {
  const match = /^FY(\d{4}) Q([1-4])$/.exec(period);
  if (!match) return undefined;
  const fiscalYear = Number(match[1]);
  const quarter = Number(match[2]);
  return quarter === 4 ? `FY${fiscalYear + 1} Q1` : `FY${fiscalYear} Q${quarter + 1}`;
}

function nextHalfYearPeriod(period: string): string | undefined {
  const halfMatch = /^FY(\d{4}) H([12])$/.exec(period);
  if (halfMatch) {
    const fiscalYear = Number(halfMatch[1]);
    return halfMatch[2] === '1' ? `FY${fiscalYear}` : `FY${fiscalYear + 1} H1`;
  }
  const annualMatch = /^FY(\d{4})$/.exec(period);
  return annualMatch ? `FY${Number(annualMatch[1]) + 1} H1` : undefined;
}

function latestCompanyPoint(company: CompanyFundamentals) {
  const points = [...company.annual, ...company.halfYear, ...company.quarterly]
    .sort((left, right) => (
      left.periodEnd.localeCompare(right.periodEnd) || left.period.localeCompare(right.period)
    ));
  return points[points.length - 1];
}

export function assessCompanyReportFreshness(
  company: CompanyFundamentals,
  asOf: string,
  upcomingDays = 14,
): CompanyReportFreshness {
  const latest = latestCompanyPoint(company);

  if (!latest) {
    return { status: 'annualOnly', latestPeriod: '-', latestPeriodEnd: '-' };
  }
  if (company.quarterly.length === 0 && company.halfYear.length === 0) {
    return {
      status: 'annualOnly',
      latestPeriod: latest.period,
      latestPeriodEnd: latest.periodEnd,
    };
  }

  const halfYearCadence = company.quarterly.length === 0;
  const expectedPeriod = halfYearCadence
    ? nextHalfYearPeriod(latest.period)
    : nextQuarter(latest.period);
  const expectedPeriodEnd = addMonths(latest.periodEnd, halfYearCadence ? 6 : 3);
  const reviewAfter = addDays(expectedPeriodEnd, REVIEW_LAG_DAYS[company.region]);
  const daysUntilReview = Math.ceil(
    (parseDate(reviewAfter).getTime() - parseDate(asOf).getTime()) / 86_400_000,
  );

  return {
    status: daysUntilReview < 0
      ? 'review'
      : daysUntilReview <= upcomingDays ? 'upcoming' : 'current',
    latestPeriod: latest.period,
    latestPeriodEnd: latest.periodEnd,
    expectedPeriod,
    expectedPeriodEnd,
    reviewAfter,
  };
}

export function latestSecPeriodicFiling(
  filings: SecRecentFilings,
): SecPeriodicFiling | undefined {
  return listSecPeriodicFilings(filings)[0];
}

export function listSecPeriodicFilings(
  filings: SecRecentFilings,
  filingYear?: number,
): SecPeriodicFiling[] {
  return filings.form.flatMap((form, index) => {
    if (form !== '10-Q' && form !== '10-K') return [];
    const filingDate = filings.filingDate[index];
    const accessionNumber = filings.accessionNumber[index];
    const reportDate = filings.reportDate[index];
    const primaryDocument = filings.primaryDocument[index];
    if (!filingDate || !accessionNumber || !reportDate || !primaryDocument) return [];
    if (filingYear != null && !filingDate.startsWith(`${filingYear}-`)) return [];
    return [{
      accessionNumber,
      filingDate,
      reportDate,
      form: form as SecPeriodicFiling['form'],
      primaryDocument,
    }];
  }).sort((left, right) => (
    right.filingDate.localeCompare(left.filingDate)
      || right.accessionNumber.localeCompare(left.accessionNumber)
  ));
}

export function latestCompanyPeriodEnd(company: CompanyFundamentals): string {
  return [...company.annual, ...company.halfYear, ...company.quarterly]
    .reduce((latest, point) => point.periodEnd > latest ? point.periodEnd : latest, '');
}
