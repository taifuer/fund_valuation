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
  const finalDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return formatDate(new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(date.getUTCDate(), finalDay),
  )));
}

function nextQuarter(period: string): string | undefined {
  const match = /^FY(\d{4}) Q([1-4])$/.exec(period);
  if (!match) return undefined;
  const fiscalYear = Number(match[1]);
  const quarter = Number(match[2]);
  return quarter === 4 ? `FY${fiscalYear + 1} Q1` : `FY${fiscalYear} Q${quarter + 1}`;
}

export function assessCompanyReportFreshness(
  company: CompanyFundamentals,
  asOf: string,
  upcomingDays = 14,
): CompanyReportFreshness {
  const latest = company.quarterly[company.quarterly.length - 1]
    ?? company.annual[company.annual.length - 1];

  if (!latest) {
    return { status: 'annualOnly', latestPeriod: '-', latestPeriodEnd: '-' };
  }
  if (company.quarterly.length === 0) {
    return {
      status: 'annualOnly',
      latestPeriod: latest.period,
      latestPeriodEnd: latest.periodEnd,
    };
  }

  const expectedPeriod = nextQuarter(latest.period);
  const expectedPeriodEnd = addMonths(latest.periodEnd, 3);
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
  const index = filings.form.findIndex((form) => form === '10-Q' || form === '10-K');
  if (index < 0) return undefined;
  return {
    accessionNumber: filings.accessionNumber[index],
    filingDate: filings.filingDate[index],
    reportDate: filings.reportDate[index],
    form: filings.form[index] as SecPeriodicFiling['form'],
    primaryDocument: filings.primaryDocument[index],
  };
}

export function latestCompanyPeriodEnd(company: CompanyFundamentals): string {
  return [...company.annual, ...company.quarterly]
    .reduce((latest, point) => point.periodEnd > latest ? point.periodEnd : latest, '');
}
