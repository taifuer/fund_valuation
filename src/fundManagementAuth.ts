export type FundManagementMode = 'disabled' | 'open' | 'token';

const TOKEN_KEY = 'fund_valuation:fund_management_token';

export function readFundManagementToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function storeFundManagementToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token.trim());
  } catch { /* session storage may be unavailable */ }
}

export function clearFundManagementToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* session storage may be unavailable */ }
}

export function fundManagementHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const token = readFundManagementToken();
  return token ? { ...headers, 'X-Fund-Management-Token': token } : headers;
}
