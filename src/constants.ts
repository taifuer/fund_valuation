import type { Fund, Holding, IndexConfig } from './types';

// Helper to create US stock holding
const us = (symbol: string, name: string, weight: number): Holding => ({
  symbol, name, sinaSymbol: `gb_${symbol.toLowerCase()}`, weight, currency: 'USD',
});
const cn = (symbol: string, name: string, weight: number): Holding => ({
  symbol, name, sinaSymbol: symbol.toLowerCase(), weight, currency: 'CNY',  // e.g. "sz300502"
});
const hk = (symbol: string, name: string, weight: number): Holding => ({
  symbol, name, sinaSymbol: `hk${symbol}`, weight, currency: 'HKD',
});
const kr = (symbol: string, name: string, weight: number): Holding => ({
  symbol, name, sinaSymbol: `kr${symbol}`, weight, currency: 'KRW',
});

export const INDICES: IndexConfig[] = [
  // A股
  { symbol: 'SH000001', name: '上证指数', sinaSymbol: 's_sh000001', history: { source: 'sina-cn', symbol: 'sh000001' } },
  { symbol: 'SZ399006', name: '创业板指', sinaSymbol: 's_sz399006', history: { source: 'sina-cn', symbol: 'sz399006' } },
  { symbol: 'SH000300', name: '沪深300', sinaSymbol: 's_sh000300', history: { source: 'sina-cn', symbol: 'sh000300' } },
  { symbol: 'SH000905', name: '中证500', sinaSymbol: 's_sh000905', history: { source: 'sina-cn', symbol: 'sh000905' } },
  // 美股
  { symbol: 'IXIC', name: '纳斯达克', sinaSymbol: 'gb_ixic', history: { source: 'sina-us', symbol: '.IXIC' } },
  { symbol: 'NDX', name: '纳指100', sinaSymbol: 'gb_ndx', futures: { sinaSymbol: 'hf_NQ', label: '纳指100期货' }, history: { source: 'sina-us', symbol: '.NDX' } },
  { symbol: 'INX', name: '标普500', sinaSymbol: 'gb_inx', futures: { sinaSymbol: 'hf_ES', label: '标普500期货' }, history: { source: 'sina-us', symbol: '.INX' } },
  { symbol: 'DJI', name: '道琼斯', sinaSymbol: 'gb_dji', futures: { sinaSymbol: 'hf_YM', label: '道指期货' }, history: { source: 'sina-us', symbol: '.DJI' } },
  // 亚太
  { symbol: 'HSI', name: '恒生指数', sinaSymbol: 'hkHSI', futures: { sinaSymbol: 'hf_HSI', label: '恒指期货' }, history: { source: 'sina-futures', symbol: 'HSI' } },
  { symbol: 'N225', name: '日经225', sinaSymbol: 'int_nikkei', futures: { sinaSymbol: 'hf_NK', label: '日经225期货' }, history: { source: 'sina-futures', symbol: 'NK' } },
  { symbol: 'KOSPI', name: '韩国KOSPI', sinaSymbol: 'b_KOSPI' },
  { symbol: 'TWSE', name: '台湾加权', sinaSymbol: 'b_TWSE' },
];

export const MARKET_ASSETS: IndexConfig[] = [
  { symbol: 'GC', name: '黄金', sinaSymbol: 'hf_GC', history: { source: 'sina-futures', symbol: 'GC' } },
  { symbol: 'SI', name: '白银', sinaSymbol: 'hf_SI', history: { source: 'sina-futures', symbol: 'SI' } },
  { symbol: 'CL', name: '原油', sinaSymbol: 'hf_CL', history: { source: 'sina-futures', symbol: 'CL' } },
  { symbol: 'BTC', name: '比特币', sinaSymbol: 'fx_sbtcusd' },
];

export const FUNDS: Fund[] = [
  // ──── 纳斯达克/美股科技 ────
  {
    symbol: '017436', name: '华宝纳斯达克精选', code: '017436',
    holdings: [
      us('NFLX', 'Netflix', 0.0932), us('NVDA', 'NVIDIA', 0.0928),
      us('AAPL', 'Apple', 0.0776), us('MSFT', 'Microsoft', 0.075),
      us('AVGO', 'Broadcom', 0.0743), us('TSLA', 'Tesla', 0.0733),
      us('GOOGL', 'Alphabet', 0.0682), us('AMZN', 'Amazon', 0.0634),
      us('META', 'Meta', 0.0577), us('MRVL', 'Marvell', 0.0496),
    ],
  },
  {
    symbol: '017091', name: '景顺长城纳斯达克科技', code: '017091',
    holdings: [
      us('NVDA', 'NVIDIA', 0.1269), us('AAPL', 'Apple', 0.1231),
      us('MSFT', 'Microsoft', 0.1212), us('AVGO', 'Broadcom', 0.0725),
      us('META', 'Meta', 0.0679), us('GOOGL', 'Alphabet A', 0.0610),
      us('GOOG', 'Alphabet C', 0.0569), us('MU', '美光科技', 0.0294),
      us('PLTR', 'Palantir', 0.0245), us('AMD', 'AMD', 0.024),
    ],
  },
  {
    symbol: '022184', name: '富国全球科技互联网', code: '022184',
    holdings: [
      us('TSM', '台积电', 0.1006), us('NVDA', 'NVIDIA', 0.0980),
      us('GOOGL', 'Alphabet A', 0.0856), hk('09899', '网易云音乐', 0.0817),
      us('AMD', 'AMD', 0.0740), hk('00522', 'ASMPT', 0.0629),
      kr('000660', 'SK海力士', 0.0411), us('INTC', 'Intel', 0.0366),
      us('ASML', 'ASML', 0.0358), kr('005930', '三星电子', 0.0333),
    ],
  },
  {
    symbol: '161128', name: '易方达标普信息科技', code: '161128',
    holdings: [
      us('AAPL', 'Apple', 0.16), us('MSFT', 'Microsoft', 0.15),
      us('NVDA', 'NVIDIA', 0.14), us('AVGO', 'Broadcom', 0.06),
      us('CRM', 'Salesforce', 0.04), us('ORCL', 'Oracle', 0.04),
      us('CSCO', 'Cisco', 0.03), us('ACN', 'Accenture', 0.03),
      us('IBM', 'IBM', 0.03), us('ADBE', 'Adobe', 0.03),
    ],
  },
  // ──── 全球科技 ────
  {
    symbol: '006555', name: '浦银安盛全球智能科技', code: '006555',
    holdings: [
      us('NVDA', 'NVIDIA', 0.0811), us('GOOG', 'Alphabet', 0.0787),
      us('TSM', '台积电', 0.0745), us('AVGO', 'Broadcom', 0.0731),
      us('TSLA', 'Tesla', 0.0623), us('MU', '美光科技', 0.0603),
      us('MSFT', 'Microsoft', 0.0395), us('AMZN', 'Amazon', 0.0369),
      us('AAPL', 'Apple', 0.0329), us('LITE', 'Lumentum', 0.0295),
    ],
  },
  {
    symbol: '006373', name: '国富全球科技互联', code: '006373',
    holdings: [
      us('NVDA', 'NVIDIA', 0.09), us('MSFT', 'Microsoft', 0.08),
      us('AAPL', 'Apple', 0.07), us('GOOGL', 'Alphabet', 0.07),
      us('AMZN', 'Amazon', 0.06), us('META', 'Meta', 0.06),
      us('TSM', '台积电', 0.05), us('AVGO', 'Broadcom', 0.05),
      us('TSLA', 'Tesla', 0.04), us('NFLX', 'Netflix', 0.03),
    ],
  },
  {
    symbol: '270023', name: '广发全球精选', code: '270023',
    holdings: [
      us('ASML', '阿斯麦', 0.0521), us('GOOG', 'Alphabet', 0.0494),
      us('NVDA', 'NVIDIA', 0.0447), us('AAPL', 'Apple', 0.0407),
      us('AMZN', 'Amazon', 0.0402), us('LRCX', '泛林集团', 0.0401),
      us('MU', '美光科技', 0.0326), us('AVGO', 'Broadcom', 0.0327),
      us('MSFT', 'Microsoft', 0.03), us('TSM', '台积电', 0.03),
    ],
  },
  {
    symbol: '001668', name: '汇添富全球移动互联', code: '001668',
    holdings: [
      us('NVDA', 'NVIDIA', 0.0896), us('GOOGL', 'Alphabet', 0.0814),
      us('MSFT', 'Microsoft', 0.05), us('AMZN', 'Amazon', 0.0484),
      us('AAPL', 'Apple', 0.0445), us('AVGO', 'Broadcom', 0.0389),
      us('META', 'Meta', 0.0348), us('TSM', '台积电', 0.0334),
      us('NFLX', 'Netflix', 0.0236), us('MU', '美光科技', 0.0221),
    ],
  },
  {
    symbol: '000043', name: '嘉实美国成长', code: '000043',
    holdings: [
      us('AAPL', 'Apple', 0.0968), us('NVDA', 'NVIDIA', 0.0867),
      us('MSFT', 'Microsoft', 0.0714), us('AMZN', 'Amazon', 0.0664),
      us('META', 'Meta', 0.0518), us('GOOGL', 'Alphabet', 0.058),
      us('AVGO', 'Broadcom', 0.0289), us('LLY', 'Eli Lilly', 0.0244),
      us('NFLX', 'Netflix', 0.0192), us('TSLA', 'Tesla', 0.0186),
    ],
  },
  {
    symbol: '008253', name: '华宝致远混合', code: '008253',
    holdings: [
      us('NVDA', 'NVIDIA', 0.08), us('AAPL', 'Apple', 0.07),
      us('MSFT', 'Microsoft', 0.07), us('GOOGL', 'Alphabet', 0.06),
      us('AMZN', 'Amazon', 0.05), us('META', 'Meta', 0.05),
      us('TSLA', 'Tesla', 0.04), us('TSM', '台积电', 0.04),
      us('AVGO', 'Broadcom', 0.03), us('NFLX', 'Netflix', 0.03),
    ],
  },
  // ──── 全球成长/产业升级 ────
  {
    symbol: '012920', name: '易方达全球成长精选', code: '012920',
    holdings: [
      us('TSM', '台积电', 0.0888), us('LITE', 'Lumentum', 0.0868),
      cn('sz300502', '新易盛', 0.0602), us('GLW', 'Corning', 0.0467),
      us('AXTI', 'AXT Inc', 0.0467), cn('sz300308', '中际旭创', 0.0467),
      cn('sh688498', '源杰科技', 0.0449), us('TSEM', 'Tower', 0.0372),
      us('GOOGL', 'Alphabet', 0.0336), cn('sz002384', '东山精密', 0.0267),
    ],
  },
  {
    symbol: '017730', name: '嘉实全球产业升级', code: '017730',
    holdings: [
      us('NVDA', 'NVIDIA', 0.09), us('AVGO', 'Broadcom', 0.08),
      us('TSM', '台积电', 0.07), us('ASML', '阿斯麦', 0.06),
      us('MSFT', 'Microsoft', 0.06), us('AMZN', 'Amazon', 0.05),
      us('AAPL', 'Apple', 0.05), us('META', 'Meta', 0.05),
      us('GOOGL', 'Alphabet', 0.04), us('MU', '美光科技', 0.04),
    ],
  },
  {
    symbol: '016664', name: '天弘全球高端制造', code: '016664',
    holdings: [
      us('NVDA', 'NVIDIA', 0.09), us('TSM', '台积电', 0.08),
      us('ASML', '阿斯麦', 0.07), us('AVGO', 'Broadcom', 0.07),
      us('AMD', 'AMD', 0.06), us('AMAT', '应用材料', 0.06),
      us('LRCX', '泛林集团', 0.05), us('MU', '美光科技', 0.05),
      us('MRVL', 'Marvell', 0.04), us('QCOM', '高通', 0.04),
    ],
  },
  // ──── 海外科技/数字经济 ────
  {
    symbol: '501312', name: '华宝海外科技', code: '501312',
    holdings: [
      us('NVDA', 'NVIDIA', 0.09), us('AAPL', 'Apple', 0.08),
      us('MSFT', 'Microsoft', 0.08), us('AMZN', 'Amazon', 0.06),
      us('META', 'Meta', 0.06), us('GOOGL', 'Alphabet', 0.06),
      us('TSLA', 'Tesla', 0.05), us('AVGO', 'Broadcom', 0.05),
      us('AMD', 'AMD', 0.03), us('NFLX', 'Netflix', 0.03),
    ],
  },
  {
    symbol: '005698', name: '华夏全球科技先锋', code: '005698',
    holdings: [
      us('CIEN', 'Ciena', 0.0556), us('TSM', '台积电', 0.0487),
      us('LITE', 'Lumentum', 0.0472), us('COHR', 'Coherent', 0.0459),
      us('VIAV', 'Viavi Solutions', 0.0452), us('GLW', 'Corning', 0.0415),
      us('MU', '美光科技', 0.023), us('AEIS', 'Advanced Energy', 0.0163),
      us('TER', 'Teradyne', 0.0162), us('NVDA', 'NVIDIA', 0.015),
    ],
  },
  {
    symbol: '016701', name: '银华海外数字经济', code: '016701',
    holdings: [
      us('NVDA', 'NVIDIA', 0.09), us('MSFT', 'Microsoft', 0.08),
      us('AAPL', 'Apple', 0.07), us('GOOGL', 'Alphabet', 0.07),
      us('AMZN', 'Amazon', 0.06), us('META', 'Meta', 0.06),
      us('AVGO', 'Broadcom', 0.05), us('TSM', '台积电', 0.04),
      us('TSLA', 'Tesla', 0.04), us('CRM', 'Salesforce', 0.03),
    ],
  },
  // ──── 新兴市场/其他 ────
  {
    symbol: '539002', name: '建信新兴市场混合', code: '539002',
    holdings: [
      us('TSM', '台积电', 0.08), us('BABA', '阿里巴巴', 0.06),
      us('NVDA', 'NVIDIA', 0.05), us('SE', 'Sea Limited', 0.04),
      us('NU', 'Nu Holdings', 0.04), us('MELI', 'MercadoLibre', 0.04),
      us('GRAB', 'Grab', 0.03), us('BEKE', '贝壳', 0.03),
      us('PDD', '拼多多', 0.03), us('TCOM', '携程', 0.03),
    ],
  },
];

export const COLORS = { up: '#16a34a', down: '#dc2626' } as const;
