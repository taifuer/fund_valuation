import type {
  CompanyEmployeeMethodologyMarker,
  CompanyFundamentalPoint,
  CompanyFundamentals,
  CompanyMetricMethodologyMarker,
  CompanyRegion,
  CompanyReportReference,
} from '../../types';

export type RawPoint = readonly [
  period: string,
  periodEnd: string,
  revenue: number,
  operatingProfit: number,
  employees?: number,
];

export interface ResearchAndDevelopmentSeries {
  annual?: Readonly<Record<string, number>>;
  halfYear?: Readonly<Record<string, number>>;
  quarterly?: Readonly<Record<string, number>>;
}

export interface CompanyDefinition {
  id: string;
  name: string;
  nameEn: string;
  ticker: string;
  region: CompanyRegion;
  regionLabel: string;
  currency: string;
  sourceName: string;
  sourceUrl: string;
  latestReport?: CompanyReportReference;
  reportReferences?: readonly CompanyReportReference[];
  methodologyNote?: string;
  profitMetricLabel?: string;
  researchMetricLabel?: string;
  employeeScope: string;
  employeeMarkers?: readonly CompanyEmployeeMethodologyMarker[];
  metricMarkers?: readonly CompanyMetricMethodologyMarker[];
  moneyScale: number;
  researchAndDevelopment?: ResearchAndDevelopmentSeries;
  annual: readonly RawPoint[];
  halfYear?: readonly RawPoint[];
  quarterly: readonly RawPoint[];
}

export const MILLION = 1_000_000;
export const BILLION = 1_000_000_000;

function points(
  rows: readonly RawPoint[],
  moneyScale: number,
  researchAndDevelopment: Readonly<Record<string, number>> = {},
): CompanyFundamentalPoint[] {
  return rows.map(([period, periodEnd, revenue, operatingProfit, employees]) => ({
    period,
    periodEnd,
    revenue: revenue * moneyScale,
    operatingProfit: operatingProfit * moneyScale,
    researchAndDevelopment: researchAndDevelopment[period] == null
      ? null
      : researchAndDevelopment[period] * moneyScale,
    employees: employees ?? null,
  }));
}

export function defineCompany(definition: CompanyDefinition): CompanyFundamentals {
  return {
    id: definition.id,
    name: definition.name,
    nameEn: definition.nameEn,
    ticker: definition.ticker,
    region: definition.region,
    regionLabel: definition.regionLabel,
    currency: definition.currency,
    sourceName: definition.sourceName,
    sourceUrl: definition.sourceUrl,
    latestReport: definition.latestReport,
    reportReferences: definition.reportReferences ? [...definition.reportReferences] : undefined,
    methodologyNote: definition.methodologyNote,
    profitMetricLabel: definition.profitMetricLabel,
    researchMetricLabel: definition.researchMetricLabel,
    employeeScope: definition.employeeScope,
    employeeMarkers: definition.employeeMarkers ? [...definition.employeeMarkers] : undefined,
    metricMarkers: definition.metricMarkers ? [...definition.metricMarkers] : undefined,
    annual: points(
      definition.annual,
      definition.moneyScale,
      definition.researchAndDevelopment?.annual,
    ),
    halfYear: points(
      definition.halfYear ?? [],
      definition.moneyScale,
      definition.researchAndDevelopment?.halfYear,
    ),
    quarterly: points(
      definition.quarterly,
      definition.moneyScale,
      definition.researchAndDevelopment?.quarterly,
    ),
  };
}
