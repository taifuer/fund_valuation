import { describe, expect, it } from 'vitest';
import type { SecPeriodicFiling } from './companyReportMaintenance';
import {
  buildSecCompanyDraft,
  selectSecMetricCandidate,
  type SecCompanyFactsResponse,
} from './secCompanyDraft';

const filing: SecPeriodicFiling = {
  accessionNumber: '0000000000-26-000001',
  filingDate: '2026-05-01',
  reportDate: '2026-03-31',
  form: '10-Q',
  primaryDocument: 'report.htm',
};

const response: SecCompanyFactsResponse = {
  cik: 1,
  entityName: 'Example Inc.',
  facts: {
    'us-gaap': {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: 'Revenue',
        units: {
          USD: [
            {
              start: '2026-01-01', end: '2026-03-31', val: 120,
              accn: filing.accessionNumber, form: '10-Q', filed: filing.filingDate,
              fy: 2026, fp: 'Q1',
            },
            {
              start: '2025-07-01', end: '2026-03-31', val: 340,
              accn: filing.accessionNumber, form: '10-Q', filed: filing.filingDate,
              fy: 2026, fp: 'Q1',
            },
          ],
        },
      },
      OperatingIncomeLoss: {
        label: 'Operating income',
        units: {
          USD: [{
            start: '2026-01-01', end: '2026-03-31', val: 30,
            accn: filing.accessionNumber, form: '10-Q', filed: filing.filingDate,
          }],
        },
      },
    },
  },
};

describe('SEC company facts draft selection', () => {
  it('selects the direct quarter instead of a year-to-date fact', () => {
    const selected = selectSecMetricCandidate(
      response,
      filing,
      ['RevenueFromContractWithCustomerExcludingAssessedTax'],
    );
    expect(selected?.value).toBe(120);
    expect(selected?.start).toBe('2026-01-01');
  });

  it('keeps unavailable metrics empty instead of deriving them silently', () => {
    const draft = buildSecCompanyDraft(response, filing);
    expect(draft.metrics.operatingProfit?.value).toBe(30);
    expect(draft.metrics.researchAndDevelopment).toBeUndefined();
  });
});
