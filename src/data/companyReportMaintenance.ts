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
