import { describe, expect, it } from 'vitest';
import { companies } from './companies';
import { COMPANY_INDUSTRIES, companyIndustry } from './companyIndustries';

describe('company industries', () => {
  it('assigns every company to exactly one maintained group without unknown IDs', () => {
    const ids = COMPANY_INDUSTRIES.flatMap(industry => [...industry.companyIds]);
    expect([...ids].sort()).toEqual(companies.map(company => company.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(COMPANY_INDUSTRIES.map(industry => industry.key)).size).toBe(COMPANY_INDUSTRIES.length);
    expect(COMPANY_INDUSTRIES.every(industry => industry.companyIds.length > 0)).toBe(true);
  });

  it('uses reviewed primary-business groups for diversified companies', () => {
    expect(companyIndustry('samsung')).toBe('electronics');
    expect(companyIndustry('amazon')).toBe('internet');
    expect(companyIndustry('broadcom')).toBe('semiconductors');
    expect(companyIndustry('xiaomi')).toBe('electronics');
    expect(companyIndustry('visa')).toBe('payments');
  });

  it('does not infer industries from names or unknown identifiers', () => {
    expect(companyIndustry('全球科技')).toBeUndefined();
    expect(companyIndustry('unknown')).toBeUndefined();
  });
});
