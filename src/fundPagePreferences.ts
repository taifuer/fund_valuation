import { FUND_FILTER_KEYS, type FundFilter } from './fundClassification';
import { choiceFromSearch } from './routing';

const FUND_FILTER_KEY = 'fund_valuation:fund_page_filter';

export function readFundPageFilter(search: string): FundFilter {
  let fallback: FundFilter = 'active';
  try {
    const stored = window.localStorage.getItem(FUND_FILTER_KEY);
    if (FUND_FILTER_KEYS.includes(stored as FundFilter)) fallback = stored as FundFilter;
  } catch { /* preferences may be unavailable */ }
  return choiceFromSearch(search, 'strategy', FUND_FILTER_KEYS, fallback);
}

export function storeFundPageFilter(filter: FundFilter): void {
  try {
    window.localStorage.setItem(FUND_FILTER_KEY, filter);
  } catch { /* the URL still preserves the current filter */ }
}
