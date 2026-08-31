import {
  COMPANIES_WITHOUT_COMPARABLE_RESEARCH_DISCLOSURE,
  PARTIAL_RESEARCH_DISCLOSURE_PERIODS,
  companyFundamentalsDataset,
} from '../src/data/companyFundamentals';

const noComparableResearch = new Set(
  Object.keys(COMPANIES_WITHOUT_COMPARABLE_RESEARCH_DISCLOSURE),
);
const unexpectedResearchGaps: string[] = [];
const employeeGaps: string[] = [];

const rows = companyFundamentalsDataset.companies.map((company) => {
  const annualResearch = company.annual.filter(
    (point) => point.researchAndDevelopment != null,
  ).length;
  const annualEmployees = company.annual.filter((point) => point.employees != null).length;
  const directHalfYears = company.halfYear.length;
  const quarterlyResearch = company.quarterly.filter(
    (point) => point.researchAndDevelopment != null,
  ).length;
  const quarterlyEmployees = company.quarterly.filter((point) => point.employees != null).length;
  const missingAnnualResearch = company.annual
    .filter((point) => point.researchAndDevelopment == null)
    .map((point) => point.period);
  const allowedPartialPeriods = new Set(PARTIAL_RESEARCH_DISCLOSURE_PERIODS[company.id] ?? []);

  if (noComparableResearch.has(company.id)) {
    if (annualResearch > 0) {
      unexpectedResearchGaps.push(`${company.id}: expected no standalone research series`);
    }
  } else {
    missingAnnualResearch
      .filter((period) => !allowedPartialPeriods.has(period))
      .forEach((period) => unexpectedResearchGaps.push(`${company.id} ${period}`));
  }

  company.annual
    .filter((point) => point.employees == null)
    .forEach((point) => employeeGaps.push(`${company.id} ${point.period}`));

  return {
    company: company.name,
    annual: company.annual.length,
    directHalfYears,
    quarterly: company.quarterly.length,
    firstQuarter: company.quarterly[0]?.period ?? '-',
    latestQuarter: company.quarterly.at(-1)?.period ?? '-',
    annualResearch: `${annualResearch}/${company.annual.length}`,
    quarterlyResearch,
    annualEmployees: `${annualEmployees}/${company.annual.length}`,
    quarterlyEmployees,
  };
});

console.log(`Company fundamentals dataset v${companyFundamentalsDataset.version}`);
console.log(`${companyFundamentalsDataset.updatedAt} · ${companyFundamentalsDataset.coverage}`);
console.table(rows);

const quarterlyCompanies = rows.filter((row) => row.quarterly > 0);
const longFormCompanies = quarterlyCompanies.filter((row) => row.quarterly >= 26);
const directHalfYearCompanies = rows.filter((row) => row.directHalfYears > 0);
const annualOnlyCompanies = rows.filter((row) => row.quarterly === 0 && row.directHalfYears === 0);

console.log(
  `Core quarterly histories: ${quarterlyCompanies.length}/${rows.length}; `
  + `extended histories (26+ quarters): ${longFormCompanies.length}/${quarterlyCompanies.length}; `
  + `direct half-year: ${directHalfYearCompanies.map((row) => row.company).join(', ') || 'none'}; `
  + `annual-only: ${annualOnlyCompanies.map((row) => row.company).join(', ') || 'none'}.`,
);

console.log(
  `No comparable standalone research disclosure: ${[...noComparableResearch].join(', ')}.`,
);
console.log(
  `Remaining verified employee gaps: ${employeeGaps.join(', ') || 'none'}.`,
);

if (unexpectedResearchGaps.length > 0) {
  console.error(`Unexpected annual research gaps: ${unexpectedResearchGaps.join(', ')}`);
  process.exitCode = 1;
}
