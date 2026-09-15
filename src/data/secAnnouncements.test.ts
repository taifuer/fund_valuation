import { describe, expect, it } from 'vitest';
import { parseSecAnnouncement, probeSecAnnouncement } from '../../scripts/lib/sec-announcements';
import { companySecCik } from './companyReportMaintenance';
import { companyFundamentalsDataset } from './companyFundamentals';

const source = 'https://www.sec.gov/Archives/edgar/data/796343/000079634326000147/adbe8k.htm';

describe('SEC earnings announcements', () => {
  it('follows an earnings exhibit only inside the same SEC accession', () => {
    const body = '<h2>Item 2.02 Results of Operations and Financial Condition</h2>'
      + '<a href="adbeex991q326.htm">Exhibit 99.1</a>'
      + '<a href="https://example.com/results.htm">99.1</a><a href="../other/press.htm">99.1</a>';
    expect(parseSecAnnouncement(body, source)).toEqual({ earnings: true,
      links: [source.replace('adbe8k.htm', 'adbeex991q326.htm')] });
  });

  it('does not confuse a future earnings date or a script with reported results', () => {
    expect(parseSecAnnouncement('<p>We will announce Q4 results next month.</p>'
      + '<script>"Condensed consolidated statements of income"</script>', source).earnings).toBe(false);
  });

  it('verifies exhibit content before returning its link', async () => {
    const requests: string[] = [];
    const result = await probeSecAnnouncement(source, async url => {
      requests.push(url);
      return url === source ? '<a href="ex991.htm">99.1</a>'
        : '<h2>Condensed Consolidated Statements of Income</h2><p>Three months ended August 28, 2026</p>';
    });
    expect(requests).toHaveLength(2);
    expect(result?.source).toBe(source.replace('adbe8k.htm', 'ex991.htm'));
  });

  it('propagates source failures rather than reporting that no updates exist', async () => {
    await expect(probeSecAnnouncement(source, async () => { throw new Error('HTTP 403'); }))
      .rejects.toThrow('HTTP 403');
  });

  it('resolves US-listed ADRs independently of the company geographic region', () => {
    const company = companyFundamentalsDataset.companies.find(item => item.id === 'tsmc')!;
    expect(companySecCik(company, new Map([['TSM', 1046179]]))).toBe(1046179);
    expect(companySecCik(company, new Map())).toBeUndefined();
  });
});
