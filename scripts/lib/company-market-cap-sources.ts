export const marketCapListingPaths: Record<string, string> = {
  alibaba: 'stocks/baba', jd: 'stocks/jd', pdd: 'stocks/pdd', baidu: 'stocks/bidu',
  tencent: 'quote/hkg/0700', meituan: 'quote/hkg/3690', xiaomi: 'quote/hkg/1810',
  tsmc: 'quote/tpe/2330', mediatek: 'quote/tpe/2454', foxconn: 'quote/tpe/2317',
  novoNordisk: 'stocks/nvo', asml: 'stocks/asml', arm: 'stocks/arm',
  siemens: 'quote/etr/SIE', schneider: 'quote/epa/SU', toyota: 'quote/tyo/7203',
  tcs: 'quote/nse/TCS', 'sk-hynix': 'quote/krx/000660', samsung: 'quote/krx/005930',
};

export const marketCapHistorySlugs: Record<string, string> = {
  alibaba: 'alibaba', jd: 'jingdong-mall', pdd: 'pinduoduo', baidu: 'baidu',
  tencent: 'tencent', meituan: 'meituan-dianping', xiaomi: 'xiaomi',
  netflix: 'netflix', visa: 'visa', walmart: 'walmart', ibm: 'ibm',
  microsoft: 'microsoft', alphabet: 'alphabet-google', crm: 'salesforce', adbe: 'adobe',
  nvidia: 'nvidia', amd: 'amd', intel: 'intel', txn: 'texas-instruments', cisco: 'cisco',
  qualcomm: 'qualcomm', apple: 'apple', tesla: 'tesla', jnj: 'johnson-and-johnson',
  lilly: 'eli-lilly', merck: 'merck', pfizer: 'pfizer', amazon: 'amazon', meta: 'meta-platforms',
  micron: 'micron-technology', broadcom: 'broadcom', appliedMaterials: 'applied-materials',
  oracle: 'oracle', palantir: 'palantir', novoNordisk: 'novo-nordisk', asml: 'asml',
  siemens: 'siemens', schneider: 'schneider-electric', arm: 'arm-holdings', tcs: 'tata-consultancy-services',
};

// After these H-share listings an A-price-times-total-shares series is not the combined market cap.
export const singleListingWindows: Record<string, { code: string; before: string }> = {
  catl: { code: '300750', before: '2025-05-20' },
  hengrui: { code: '600276', before: '2025-05-23' },
};
