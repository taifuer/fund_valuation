export type PageKey = 'overview' | 'funds' | 'ranking' | 'risk' | 'diagnostics';

export const PAGE_PATHS: Record<PageKey, string> = {
  overview: '/',
  funds: '/funds',
  ranking: '/returns',
  risk: '/risk',
  diagnostics: '/diagnostics',
};

export function pageFromPathname(pathname: string): PageKey {
  if (pathname === '/funds' || pathname === '/fund' || pathname.startsWith('/funds/')) return 'funds';
  if (pathname === '/returns' || pathname === '/ranking') return 'ranking';
  if (pathname === '/risk') return 'risk';
  if (pathname === '/diagnostics') return 'diagnostics';
  return 'overview';
}

export function expandedFundCodeFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/funds\/(\d{6})$/);
  return match ? match[1] : null;
}

export function canonicalPathForPage(page: PageKey): string {
  return PAGE_PATHS[page];
}

export function fundExpansionPath(code: string, expanded: boolean): string {
  return expanded ? `/funds/${code}` : '/funds';
}

export function choiceFromSearch<T extends string>(
  search: string,
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = new URLSearchParams(search).get(key);
  return value && choices.includes(value as T) ? value as T : fallback;
}

export function replaceSearchParams(updates: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  const target = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', target);
}
