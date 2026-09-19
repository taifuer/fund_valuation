export type PageKey = 'overview' | 'funds' | 'companies' | 'ranking' | 'history' | 'about' | 'diagnostics';

export const PAGE_PATHS: Record<PageKey, string> = {
  overview: '/',
  funds: '/funds',
  companies: '/companies',
  ranking: '/returns',
  history: '/history',
  about: '/about',
  diagnostics: '/diagnostics',
};

export function pageFromPathname(pathname: string): PageKey {
  if (pathname === '/funds' || pathname === '/fund' || pathname.startsWith('/funds/')) return 'funds';
  if (pathname === '/companies' || pathname === '/company') return 'companies';
  if (pathname === '/returns' || pathname === '/ranking' || pathname === '/risk') return 'ranking';
  if (pathname === '/history') return 'history';
  if (pathname === '/about') return 'about';
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

export function canonicalizePageLocation(): PageKey {
  const { pathname, search, hash } = window.location;
  const page = pageFromPathname(pathname);
  const params = new URLSearchParams(search);
  // Old risk links omitted their default range and sort, unlike recent returns.
  if (pathname === '/risk') {
    if (!params.has('range')) params.set('range', 'ytd');
    if (!params.has('sort')) params.set('sort', 'drawdown');
  }
  const canonical = page === 'funds' && expandedFundCodeFromPathname(pathname)
    ? pathname : canonicalPathForPage(page);
  if (pathname !== canonical) {
    const query = params.toString();
    window.history.replaceState({}, '', `${canonical}${query ? `?${query}` : ''}${hash}`);
  }
  return page;
}

const pageSearch = new Map<PageKey, string>();

export function rememberPageSearch() {
  pageSearch.set(pageFromPathname(window.location.pathname), window.location.search);
}

export function restoredPagePath(page: PageKey): string {
  return `${PAGE_PATHS[page]}${pageSearch.get(page) ?? ''}`;
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
  rememberPageSearch();
}
