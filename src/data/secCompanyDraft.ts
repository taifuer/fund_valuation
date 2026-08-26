import type { SecPeriodicFiling } from './companyReportMaintenance';

export interface SecCompanyFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number;
  fp?: string;
  form: string;
  filed: string;
  frame?: string;
}

export interface SecCompanyFactMetric {
  label: string;
  units: Record<string, SecCompanyFact[]>;
}

export interface SecCompanyFactsResponse {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, SecCompanyFactMetric>>;
}

export interface SecMetricCandidate {
  tag: string;
  label: string;
  unit: string;
  value: number;
  start: string;
  end: string;
  filed: string;
  accessionNumber: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
}

const TAG_CANDIDATES = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
  ],
  operatingProfit: ['OperatingIncomeLoss'],
  researchAndDevelopment: ['ResearchAndDevelopmentExpense'],
} as const;

function durationDays(fact: SecCompanyFact) {
  if (!fact.start) return Number.POSITIVE_INFINITY;
  return Math.round(
    (new Date(`${fact.end}T00:00:00Z`).getTime() - new Date(`${fact.start}T00:00:00Z`).getTime())
      / 86_400_000,
  );
}

function expectedDuration(filing: SecPeriodicFiling) {
  return filing.form === '10-K' ? 365 : 91;
}

function validDuration(filing: SecPeriodicFiling, duration: number) {
  return filing.form === '10-K'
    ? duration >= 300 && duration <= 390
    : duration >= 70 && duration <= 110;
}

export function selectSecMetricCandidate(
  response: SecCompanyFactsResponse,
  filing: SecPeriodicFiling,
  tags: readonly string[],
  unit = 'USD',
): SecMetricCandidate | undefined {
  for (const tag of tags) {
    const metric = response.facts['us-gaap']?.[tag];
    const facts = metric?.units[unit] ?? [];
    const candidates = facts
      .filter((fact) => (
        fact.end === filing.reportDate
        && fact.start != null
        && validDuration(filing, durationDays(fact))
      ))
      .sort((left, right) => {
        const accessionDifference = Number(right.accn === filing.accessionNumber)
          - Number(left.accn === filing.accessionNumber);
        if (accessionDifference !== 0) return accessionDifference;
        const durationDifference = Math.abs(durationDays(left) - expectedDuration(filing))
          - Math.abs(durationDays(right) - expectedDuration(filing));
        if (durationDifference !== 0) return durationDifference;
        return right.filed.localeCompare(left.filed);
      });
    const selected = candidates[0];
    if (!selected?.start) continue;
    return {
      tag,
      label: metric.label,
      unit,
      value: selected.val,
      start: selected.start,
      end: selected.end,
      filed: selected.filed,
      accessionNumber: selected.accn,
      fiscalYear: selected.fy,
      fiscalPeriod: selected.fp,
    };
  }
  return undefined;
}

export function buildSecCompanyDraft(
  response: SecCompanyFactsResponse,
  filing: SecPeriodicFiling,
  unit = 'USD',
) {
  return {
    entityName: response.entityName,
    cik: response.cik,
    filing,
    metrics: {
      revenue: selectSecMetricCandidate(response, filing, TAG_CANDIDATES.revenue, unit),
      operatingProfit: selectSecMetricCandidate(
        response,
        filing,
        TAG_CANDIDATES.operatingProfit,
        unit,
      ),
      researchAndDevelopment: selectSecMetricCandidate(
        response,
        filing,
        TAG_CANDIDATES.researchAndDevelopment,
        unit,
      ),
    },
  };
}
