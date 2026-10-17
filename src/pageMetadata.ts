import type { PageKey } from './routing';

const TITLES: Record<PageKey, string> = {
  overview: '市场概览', funds: 'QDII 基金估值', ranking: '资产走势', history: '长期资产走势',
  companies: '公司经营趋势', about: '关于本站', diagnostics: '运行诊断',
};

export function updatePageMetadata(page: PageKey) {
  document.title = `${TITLES[page]} · 全球资产看板`;
  const description = document.querySelector('meta[name="description"]');
  description?.setAttribute('content', `${TITLES[page]}。主要市场指数、资产、ETF、公司财报与 QDII 基金公开数据，仅供参考，不构成投资建议。`);
}
