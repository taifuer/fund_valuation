import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const universe = JSON.parse(readFileSync(new URL('../../config/universe.json', import.meta.url), 'utf8')) as {
  funds: Array<{ code: string; name: string }>;
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const range = {
      key: '1m', label: '近1月', returnPercent: 123.45, startDate: '2026-08-15', endDate: '2026-09-15',
      startClose: 55249.85, endClose: 123456.78, maxDrawdownPercent: -12.34, winRatePercent: 65,
    };
    if (url.pathname === '/api/marketreturns') return route.fulfill({ json: Object.fromEntries(
      (url.searchParams.get('items') ?? '').split(',').map(key => {
        const [source, symbol] = key.split(':');
        return [key, { ...range, source, symbol, latest: { ...range, key: 'latest' }, ranges: { '1m': range } }];
      }),
    ) });
    if (url.pathname === '/api/fundnav') return route.fulfill({ json: Object.fromEntries(universe.funds.map(fund => [fund.code, {
      fundcode: fund.code, name: fund.name, jzrq: '2026-09-15', dwjz: '12.3456', gsz: '99', gszzl: '99',
    }])) });
    if (url.pathname === '/api/fundhistory') return route.fulfill({ json: Object.fromEntries(universe.funds.map(fund => [fund.code, [
      { FSRQ: '2026-09-15', DWJZ: '12.3456', JZZZL: '-12.34' },
    ]])) });
    if (url.pathname === '/api/fundreturns') return route.fulfill({ json: Object.fromEntries(universe.funds.map(fund => [fund.code, {
      code: fund.code, asOf: '2026-09-15', ranges: { '1m': { ...range, startNav: 10, endNav: 12.3456 } },
    }])) });
    if (url.pathname === '/api/meta') return route.fulfill({ json: { apiSchemaVersion: 1, dashboardSchemaVersion: 1, fundManagementMode: 'disabled' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      schemaVersion: 1, generatedAt: Date.now(), quotes: {
        sh000001: { symbol: 'sh000001', name: '上证指数', price: 3000, changePercent: 1, time: '2026-09-15 15:00:00', fetchedAt: Date.now() },
      }, marketStates: {}, fxText: '', quotesText: '',
    } });
    return route.fulfill({ json: {} });
  });
});

test('populated recent tables fit four mobile columns and keep the rest scrollable', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const widths = testInfo.project.name === 'mobile-chromium' ? [320, 360, 375, 390, 430] : [1280];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const category of ['asset', 'fund']) {
      await page.goto(`/returns?category=${category}&range=1m`);
      const table = page.getByRole('table', { name: '近期表现' });
      await expect(table.locator('tbody tr').first()).toContainText('+123.45%');
      await expect(table.locator('tbody tr').first()).toContainText(category === 'asset' ? '123,456.78' : '12.35');
      const geometry = await table.evaluate(element => {
        const scroller = element.parentElement!;
        const ths = [...element.querySelectorAll('thead th')];
        return {
          overflow: document.documentElement.scrollWidth - innerWidth,
          overflowingCells: [...element.querySelectorAll('th, td')].filter(cell => cell.scrollWidth > cell.clientWidth + 1).map(cell => cell.textContent),
          fourthRight: ths[3].getBoundingClientRect().right,
          lastRight: ths.at(-1)!.getBoundingClientRect().right,
          fifthLeft: ths[4].getBoundingClientRect().left,
          scrollerRight: scroller.getBoundingClientRect().right,
          nameLeft: ths[1].getBoundingClientRect().left,
        };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.overflowingCells).toEqual([]);
      if (width > 720) expect(geometry.lastRight).toBeLessThanOrEqual(geometry.scrollerRight + 1);
      await page.screenshot({ path: testInfo.outputPath(`recent-${category}-${width}.png`), fullPage: true });
      if (width <= 720) {
        expect(geometry.fourthRight).toBeLessThanOrEqual(geometry.scrollerRight + 1);
        expect(geometry.fifthLeft).toBeGreaterThanOrEqual(geometry.scrollerRight - 1);
        const scroller = page.getByRole('region', { name: '近期表现表格' });
        await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
        expect(await scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
        const finalCell = await table.getByRole('columnheader', { name: '截至', exact: true }).boundingBox();
        expect(finalCell!.x + finalCell!.width).toBeLessThanOrEqual(geometry.scrollerRight + 1);
        const stickyName = await table.getByRole('columnheader', { name: '名称', exact: true }).boundingBox();
        expect(stickyName!.x).toBeCloseTo(geometry.nameLeft, 0);
        await page.screenshot({ path: testInfo.outputPath(`recent-${category}-${width}-scrolled.png`), fullPage: true });
      }
    }
  }
  expect(errors).toEqual([]);
});

test('switching recent ranges shares history data and never loads fund estimates', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/')) apiRequests.push(new URL(request.url()).pathname);
  });
  await page.goto('/returns?category=asset&range=1m');
  const table = page.getByRole('table', { name: '近期表现' });
  await expect(table).toContainText('123,456.78');
  await expect(table.getByRole('columnheader')).toHaveCount(10);
  await table.getByRole('button', { name: '胜率', exact: true }).click();
  await page.getByLabel('收益区间').getByRole('button', { name: '最新', exact: true }).click();
  await expect(table.getByRole('columnheader')).toHaveCount(7);
  await expect(table.getByRole('columnheader', { name: '收益 ↓' })).toHaveAttribute('aria-sort', 'descending');
  await page.getByLabel('收益区间').getByRole('button', { name: '近1月', exact: true }).click();
  await expect(table.getByRole('columnheader')).toHaveCount(10);
  expect(apiRequests.filter(path => path === '/api/marketreturns')).toHaveLength(1);
  expect(apiRequests.some(path => /^\/api\/fund/.test(path))).toBe(false);
});
