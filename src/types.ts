export interface QuoteData {
  symbol: string;
  name: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  regularPrice?: number;
  regularChangePercent?: number;
  regularTime?: string;
  session?: 'regular' | 'pre' | 'post';
  time: string; // 行情更新时间
  dateReliable: boolean;
  fetchedAt: number;
}

export interface Holding {
  symbol: string;
  name: string;
  sinaSymbol: string; // sina format: gb_AAPL, sz300502, etc.
  weight: number;
  currency: 'CNY' | 'USD' | 'EUR' | 'JPY' | 'KRW' | 'HKD';
  market?: string;
  reportDate?: string;
  quoteSupported?: boolean;
}

export interface Fund {
  symbol: string;
  name: string;
  code: string; // Chinese fund code for NAV fetch
  profile?: {
    inceptionDate: string;
    assetScale: string;
    scaleDate: string;
    managementFee: string;
    custodianFee: string;
    salesServiceFee: string;
  };
  holdings: Holding[];
}

export interface FundNavData {
  code: string;
  name: string;
  navDate: string; // 净值日期
  nav: number; // 单位净值
  officialChange: number; // T-1 官方涨跌幅 (%)
  estimatedNav: number; // 实时估算净值
  estimatedChange: number; // 平台估算涨跌幅 (%)
}

export interface FundPurchaseData {
  code: string;
  name: string;
  fundType: string;
  navDate: string;
  purchaseStatus: string;
  redeemStatus: string;
  nextOpenDate: string;
  minPurchase: string;
  dailyLimit: string;
  feeRate: string;
  fetchedAt: number;
}

export interface FundHistoryPoint {
  date: string;
  nav: number;
  changePercent: number;
}

export type FundReturnRangeKey = '1w' | '1m' | '3m' | '6m' | '1y' | '3y' | 'ytd';

export interface FundRangeReturn {
  key: FundReturnRangeKey;
  label: string;
  returnPercent: number;
  maxDrawdownPercent?: number | null;
  winRatePercent?: number | null;
  startDate: string;
  endDate: string;
  startNav: number;
  endNav: number;
}

export interface FundReturnSummary {
  code: string;
  asOf: string;
  ranges: Partial<Record<FundReturnRangeKey, FundRangeReturn>>;
}

export interface MarketHistoryPoint {
  date: string;
  close: number;
}

export interface MarketReturnSummary {
  source: MarketHistoryConfig['source'];
  symbol: string;
  asOf?: string;
  latest?: MarketLatestReturn;
  ranges?: Partial<Record<FundReturnRangeKey, MarketRangeReturn>>;
  label: string;
  returnPercent: number;
  startDate: string;
  endDate: string;
  startClose: number;
  endClose: number;
}

export interface MarketLatestReturn {
  key: 'latest';
  label: string;
  returnPercent: number;
  startDate: string;
  endDate: string;
  startClose: number;
  endClose: number;
}

export interface MarketRangeReturn {
  key: FundReturnRangeKey;
  label: string;
  returnPercent: number;
  maxDrawdownPercent?: number | null;
  winRatePercent?: number | null;
  startDate: string;
  endDate: string;
  startClose: number;
  endClose: number;
}

export type MarketState = 'live' | 'break' | 'closed' | 'holiday' | 'weekend';

export interface MarketStateData {
  symbol: string;
  market: string;
  date?: string;
  state: MarketState;
  source: string;
  /** Most recent trading day the symbol's quote could reflect (today if open,
   *  else previous trading day). Used to date quotes from sources that omit
   *  the date field (e.g. Sina int_nikkei). */
  lastTradingDay?: string | null;
}

export interface SystemStatus {
  status: 'ok' | 'degraded' | 'offline';
  updatedAt: number;
  quoteIssueCount: number;
  quoteTotal: number;
  workerLastSuccessAt: number;
}

export interface MarketHistoryConfig {
  source: 'sina-cn' | 'sina-us' | 'sina-futures' | 'tencent-hk' | 'twse-official';
  symbol: string;
}

export interface FxRateData {
  currency: string;
  pair: string;
  rate: number;
  changePercent: number;
  date: string;
  time?: string;
  datetime?: string;
  fetchedAt: number;
}

export interface IndexConfig {
  symbol: string;
  name: string;
  sinaSymbol: string;
  futures?: {
    sinaSymbol: string;
    label: string;
  };
  history?: MarketHistoryConfig;
}
