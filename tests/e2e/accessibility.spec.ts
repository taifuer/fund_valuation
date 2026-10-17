import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/meta') return route.fulfill({ json: { apiSchemaVersion: 1, dashboardSchemaVersion: 1, fundManagementMode: 'disabled' } });
    if (url.pathname === '/api/status') return route.fulfill({ json: { status: 'ok', updatedAt: Date.now() } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      schemaVersion: 1, generatedAt: Date.now(), fxText: '', marketStates: {},
      quotes: { sh000001: { symbol: 'sh000001', price: 3200, previousClose: 3190,
        change: 10, changePercent: 0.31, time: '2026-10-16 15:00:00', fetchedAt: Date.now() } },
    } });
    if (url.pathname === '/api/fundestimates') return route.fulfill({ json: {
      schemaVersion: 1, generatedAt: Date.now(), fxText: '', marketStates: {},
      cards: { '017436': { official: { code: '017436', navDate: '2026-10-16', nav: 1.1, officialChange: -0.2 },
        estimate: { code: '017436', officialNav: 1.1, officialNavDate: '2026-10-16',
          preview: { targetDate: '2026-10-16', estimatedNav: 1.11, changePercent: 1,
            complete: true, phase: 'CLOSED', asOf: Date.now(), coverage: 1 } } } },
    } });
    return route.fulfill({ json: {} });
  });
});

for (const [path, heading] of [['/', '全球资产看板'], ['/funds', 'QDII 基金'],
  ['/returns', '资产走势'], ['/companies', '公司经营趋势'], ['/about', '关于本站']] as const) {
  test(`${path} has accessible contrast and control semantics`, async ({ page }, info) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    if (path === '/funds') await expect(page.locator('#fund-017436')).toContainText('1.1000');
    const results = await new AxeBuilder({ page }).withRules(['color-contrast', 'aria-prohibited-attr',
      'button-name', 'link-name', 'select-name', 'label']).analyze();
    expect(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, reason: n.failureSummary })) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('page.png'), fullPage: true });
  });
}

test('failed route chunk offers recovery and keeps navigation', async ({ page }) => {
  await page.route('**/assets/CompaniesPage-*.js', route => route.abort());
  await page.goto('/companies');
  await expect(page.getByRole('alert')).toContainText('页面暂时无法显示');
  await expect(page.getByRole('button', { name: '刷新页面' })).toBeVisible();
  await page.getByRole('navigation', { name: '页面切换' }).getByRole('link', { name: '关于' }).click();
  await expect(page.getByRole('heading', { name: '关于本站' })).toBeVisible();
});
