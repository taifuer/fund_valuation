import { companyFundamentalsDataset } from '../src/data/companyFundamentals';

const rows = companyFundamentalsDataset.companies.map((company) => {
  const annualResearch = company.annual.filter(
    (point) => point.researchAndDevelopment != null,
  ).length;
  const annualEmployees = company.annual.filter((point) => point.employees != null).length;
  const quarterlyResearch = company.quarterly.filter(
    (point) => point.researchAndDevelopment != null,
  ).length;
  const quarterlyEmployees = company.quarterly.filter((point) => point.employees != null).length;
  return {
    company: company.name,
    annual: company.annual.length,
    quarterly: company.quarterly.length,
    firstQuarter: company.quarterly[0]?.period ?? '-',
    latestQuarter: company.quarterly.at(-1)?.period ?? '-',
    annualResearch,
    quarterlyResearch,
    annualEmployees,
    quarterlyEmployees,
  };
});

console.log(`Company fundamentals dataset v${companyFundamentalsDataset.version}`);
console.log(`${companyFundamentalsDataset.updatedAt} · ${companyFundamentalsDataset.coverage}`);
console.table(rows);

const quarterlyCompanies = rows.filter((row) => row.quarterly > 0);
const longFormCompanies = quarterlyCompanies.filter((row) => row.quarterly >= 26);
const annualOnlyCompanies = rows.filter((row) => row.quarterly === 0);

console.log(
  `Core quarterly histories: ${quarterlyCompanies.length}/${rows.length}; `
  + `extended histories (26+ quarters): ${longFormCompanies.length}/${quarterlyCompanies.length}; `
  + `annual-only: ${annualOnlyCompanies.map((row) => row.company).join(', ') || 'none'}.`,
);
