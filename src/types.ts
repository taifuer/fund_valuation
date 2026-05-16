export interface QuoteData {
  symbol: string;
  name: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
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

export interface MarketHistoryPoint {
  date: string;
  close: number;
}

export interface MarketHistoryConfig {
  source: 'sina-cn' | 'sina-us' | 'sina-futures';
  symbol: string;
}

export interface FxRateData {
  currency: string;
  pair: string;
  rate: number;
  changePercent: number;
  date: string;
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
