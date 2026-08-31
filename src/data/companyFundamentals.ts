import type {
  CompanyFundamentalPoint,
  CompanyFundamentals,
  CompanyFundamentalsDataset,
} from '../types';
import { companies } from './companies';

export const COMPANIES_WITHOUT_COMPARABLE_RESEARCH_DISCLOSURE = {
  amazon: '将技术与基础设施合并披露，无法拆出可比研发费用。',
  tcs: '未持续单列可比研发费用。',
  visa: '未单列研发费用。',
  walmart: '未单列研发费用。',
} as const;

export const PARTIAL_RESEARCH_DISCLOSURE_PERIODS: Readonly<Record<string, readonly string[]>> = {
  'sk-hynix': ['FY2018', 'FY2019'],
};

export const companyFundamentalsDataset: CompanyFundamentalsDataset = {
  version: 15,
  updatedAt: '2026-08-31',
  coverage: '50 家公司 · 年度最长 9 年 · 季度最长 38 期',
  methodology: [
    '营业收入与利润指标保留公司原始披露币种及报表口径，具体利润口径以页面标签为准。',
    '研发费用仅展示公司明确单列披露的费用；未单列披露的期间不推算、不补齐。',
    '季度同比匹配上一财年同季度；半年数据优先采用公司直接披露值，否则仅由完整的两个季度相加生成。',
    '历史序列以官方披露为主，监管机构、交易所或证券行情结构化接口仅用于补齐与交叉校验。',
    '员工统计、合并范围或指标口径发生显著变化时，以虚线标示可比边界。',
    '员工人数优先采用期末披露值；官方约数或期间平均人数仅在明确标注口径时保留，不据此反推期末人数。',
    '季度或半年员工人数仅在公司持续披露时开放，具体定义以图表下方说明为准。',
  ],
  companies,
};

export function deriveHalfYear(pointsToCombine: readonly CompanyFundamentalPoint[]): CompanyFundamentalPoint[] {
  const byFiscalYear = new Map<string, Map<number, CompanyFundamentalPoint>>();
  pointsToCombine.forEach((point) => {
    const match = /^FY(\d{4}) Q([1-4])$/.exec(point.period);
    if (!match) return;
    const fiscalYear = match[1];
    const quarter = Number(match[2]);
    const quarters = byFiscalYear.get(fiscalYear) ?? new Map<number, CompanyFundamentalPoint>();
    quarters.set(quarter, point);
    byFiscalYear.set(fiscalYear, quarters);
  });

  const result: CompanyFundamentalPoint[] = [];
  Array.from(byFiscalYear.entries()).sort(([left], [right]) => left.localeCompare(right)).forEach(([year, quarters]) => {
    ([[1, 2, 'H1'], [3, 4, 'H2']] as const).forEach(([first, second, half]) => {
      const firstPoint = quarters.get(first);
      const secondPoint = quarters.get(second);
      if (!firstPoint || !secondPoint) return;
      result.push({
        period: `FY${year} ${half}`,
        periodEnd: secondPoint.periodEnd,
        revenue: firstPoint.revenue + secondPoint.revenue,
        operatingProfit: firstPoint.operatingProfit + secondPoint.operatingProfit,
        researchAndDevelopment:
          firstPoint.researchAndDevelopment != null && secondPoint.researchAndDevelopment != null
            ? firstPoint.researchAndDevelopment + secondPoint.researchAndDevelopment
            : null,
        employees: secondPoint.employees,
        derived: true,
      });
    });
  });
  return result;
}

export function companySeries(companyData: CompanyFundamentals, frequency: 'annual' | 'half' | 'quarterly') {
  if (frequency === 'annual') return companyData.annual;
  if (frequency === 'quarterly') return companyData.quarterly;
  const byPeriod = new Map(
    deriveHalfYear(companyData.quarterly).map((point) => [point.period, point]),
  );
  companyData.halfYear.forEach((point) => byPeriod.set(point.period, point));
  return [...byPeriod.values()].sort((left, right) => (
    left.periodEnd.localeCompare(right.periodEnd) || left.period.localeCompare(right.period)
  ));
}
