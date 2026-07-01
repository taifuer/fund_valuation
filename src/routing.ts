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
