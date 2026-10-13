// Navigation groups maintained from principal businesses, not official GICS classifications.
export const COMPANY_INDUSTRIES = [
  {
    key: 'semiconductors', label: '半导体',
    companyIds: ['smic', 'tsmc', 'mediatek', 'nvidia', 'amd', 'intel', 'txn', 'qualcomm',
      'micron', 'broadcom', 'appliedMaterials', 'asml', 'arm', 'sk-hynix'],
  },
  {
    key: 'software', label: '软件与服务',
    companyIds: ['microsoft', 'crm', 'adbe', 'ibm', 'oracle', 'palantir', 'tcs'],
  },
  {
    key: 'internet', label: '互联网与电商',
    companyIds: ['alibaba', 'jd', 'pdd', 'tencent', 'meituan', 'baidu', 'alphabet', 'amazon', 'meta', 'netflix'],
  },
  {
    key: 'electronics', label: '电子与通信',
    companyIds: ['apple', 'xiaomi', 'huawei', 'foxconn', 'cisco', 'samsung'],
  },
  {
    key: 'auto', label: '汽车与电池',
    companyIds: ['byd', 'catl', 'tesla', 'toyota'],
  },
  {
    key: 'healthcare', label: '医药健康',
    companyIds: ['hengrui', 'beone', 'jnj', 'lilly', 'merck', 'pfizer', 'novoNordisk'],
  },
  { key: 'industrial', label: '工业电气', companyIds: ['siemens', 'schneider'] },
  { key: 'retail', label: '零售', companyIds: ['walmart'] },
  { key: 'payments', label: '支付服务', companyIds: ['visa'] },
] as const;

export type CompanyIndustry = typeof COMPANY_INDUSTRIES[number]['key'];

const INDUSTRY_BY_COMPANY = new Map<string, CompanyIndustry>(
  COMPANY_INDUSTRIES.flatMap(industry => industry.companyIds.map(id => [id, industry.key] as const)),
);

export function companyIndustry(companyId: string): CompanyIndustry | undefined {
  return INDUSTRY_BY_COMPANY.get(companyId);
}
