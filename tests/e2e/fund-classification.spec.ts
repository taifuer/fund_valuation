import { expect, test } from '@playwright/test';
import { chooseRecentRange } from './controls';
import { readFileSync } from 'node:fs';

const funds = (JSON.parse(readFileSync(new URL('../../config/universe.json', import.meta.url), 'utf8')) as {
  funds: Array<{ code: string; name: string }>;
}).funds;

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const official = (code: string) => ({ code, navDate: '2026-09-17', nav: 2.1234, officialChange: code === '270042' ? 9 : 1 });
    if (url.pathname === '/api/meta') return route.fulfill({ json: { apiSchemaVersion: 1, dashboardSchemaVersion: 1, fundManagementMode: 'open' } });
    if (url.pathname === '/api/fundestimates') return route.fulfill({ json: {
      schemaVersion: 1, generatedAt: Date.now(), fxText: '', marketStates: {},
      cards: Object.fromEntries(funds.map(fund => [fund.code, { official: official(fund.code), estimate: null }])),
    } });
    if (url.pathname === '/api/fundhistory') return route.fulfill({ json: Object.fromEntries(funds.map(fund => [fund.code, [
      { FSRQ: '2026-09-17', DWJZ: '2.1234', JZZZL: '1' },
      { FSRQ: '2026-09-16', DWJZ: '2.1024', JZZZL: '-1' },
    ]])) });
    if (url.pathname === '/api/fundnav') return route.fulfill({ json: Object.fromEntries(funds.map(fund => [fund.code, {
      fundcode: fund.code, name: fund.name, jzrq: '2026-09-17', dwjz: '2.1234',
    }])) });
    if (url.pathname === '/api/fundpurchase') return route.fulfill({ json: Object.fromEntries(funds.map(fund => [fund.code, {
      code: fund.code, name: fund.code === '022184' ? '富国全球科技互联网股票(QDII)C' : fund.name,
      purchaseStatus: '暂停申购', redeemStatus: '开放赎回', dailyLimit: '', minPurchase: '10', fetchedAt: 0,
    }])) });
    if (url.pathname === '/api/fundreturns') return route.fulfill({ json: Object.fromEntries(funds.map(fund => [fund.code, {
      code: fund.code, asOf: '2026-09-17', ranges: { '1m': {
        key: '1m', label: '近1月', returnPercent: 8, maxDrawdownPercent: -3, winRatePercent: 60,
        startDate: '2026-08-17', endDate: '2026-09-17', startNav: 1.966, endNav: 2.1234,
      } },
    }])) });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: {
      schemaVersion: 1, generatedAt: Date.now(), marketStates: {}, fxText: '',
      quotes: { sh000001: { symbol: 'sh000001', price: 3200, previousClose: 3190, time: '2026-09-18 15:00:00' } },
    } });
    return route.fulfill({ json: {} });
  });
});

test('fund strategies are filterable and official-only details do not fetch holdings', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fund_valuation:collapsed_fund_section', '1'));
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname); });
  await page.goto('/funds');
  await expect(page.getByRole('heading', { name: 'QDII 基金', exact: true })).toBeVisible();
  await expect(page.getByText('16 · 按实时参考（含汇率）涨跌排序', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /QDII 基金/ })).toHaveCount(0);
  await expect(page.locator('[id^="fund-"]')).toHaveCount(16);
  await expect(page.getByRole('group', { name: '基金类型筛选' }).getByRole('button', { name: '主动' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: '基金类型筛选' }).getByRole('button', { name: '指数' }).click();
  await expect(page).toHaveURL(/\/funds\?strategy=index$/);
  await expect(page.locator('[id^="fund-"]')).toHaveCount(10);
  await expect(page.getByText('10 · 按最新净值涨跌排序', { exact: true })).toBeVisible();
  await expect(page.locator('[id^="fund-"]').first()).toHaveAttribute('id', 'fund-270042');
  for (const code of ['017091', '161128']) {
    const indexCard = page.locator(`#fund-${code}`);
    await expect(indexCard).toContainText('仅官方净值');
    await expect(indexCard).not.toContainText(/待公布|实时参考|实时估算/);
  }
  await page.reload();
  await expect(page.locator('[id^="fund-"]')).toHaveCount(10);
  const card = page.locator('#fund-270042');
  await expect(card).toContainText('2.1234');
  await expect(card).toContainText('+9.00%');
  await expect(card).toContainText('仅官方净值');
  await card.getByRole('button', { name: /展开详情/ }).click();
  await expect(page).toHaveURL(/\/funds\/270042\?strategy=index$/);
  await expect(card.getByRole('button', { name: '持仓', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '净值', exact: true })).toBeVisible();
  await expect(card.getByRole('table')).toBeVisible();
  await card.getByRole('button', { name: '资料', exact: true }).click();
  await expect(card.getByText('纳斯达克100指数', { exact: true })).toBeVisible();
  await expect(card.getByText('指数基金', { exact: true })).toBeVisible();
  expect(requests).not.toContain('/api/fundholdings');
  await page.getByRole('group', { name: '基金类型筛选' }).getByRole('button', { name: '主动' }).click();
  await expect(page.locator('[id^="fund-"]')).toHaveCount(16);
  await expect(page.locator('#fund-017091')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('#fund-270042 [aria-expanded="true"]')).toBeVisible();
});

test('compact management stays visible beside mobile fund filters for every strategy', async ({ page, isMobile }, testInfo) => {
  for (const width of isMobile ? [320, 390, 640] : [1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/funds');
    const filters = page.getByRole('group', { name: '基金类型筛选' });
    const manager = page.getByRole('button', { name: '管理基金', exact: true });
    for (const name of ['主动', '指数', '全部']) {
      await filters.getByRole('button', { name, exact: true }).click();
      await expect(manager).toBeInViewport();
      const filterBox = (await filters.boundingBox())!;
      const box = (await manager.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(56);
      expect(box.width).toBeLessThanOrEqual(64);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 10);
      if (isMobile) {
        expect(box.y).toBeCloseTo(filterBox.y, 0);
        expect(box.x).toBeGreaterThanOrEqual(filterBox.x + filterBox.width + 6);
        expect(box.height).toBe(40);
        if (name !== '指数') {
          const sortBox = (await page.getByLabel('基金排序方式').boundingBox())!;
          expect(sortBox.y).toBeGreaterThanOrEqual(box.y + box.height + 6);
          expect(sortBox.x + sortBox.width).toBeLessThanOrEqual(width - 10);
        }
      }
      await manager.click();
      await expect(page.getByRole('dialog', { name: '管理基金' })).toBeVisible();
      await page.getByRole('button', { name: '关闭基金管理' }).click();
      await expect(manager).toBeFocused();
    }
    await page.screenshot({ path: testInfo.outputPath(`fund-toolbar-${width}.png`) });
  }
});

test('slow fund loading and failures stay below the toolbar without replacing the description', async ({ page }) => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/fundestimates*', async route => {
    await gate;
    await route.fulfill({ status: 503, json: { error: '基金快照暂不可用' } });
  });
  try {
    await page.goto('/funds');
    await expect(page.getByRole('heading', { name: 'QDII 基金', exact: true })).toBeVisible();
    await expect(page.getByText('估算包含汇率影响，不代表官方净值。')).toBeVisible();
    await expect(page.getByLabel('基金列表')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('status')).toHaveText('基金数据加载中...');
    await expect(page.locator('header [role="status"]')).toHaveCount(0);
    await expect(page.locator('[class*="_fxRow_"], [class*="_datetime_"]')).toHaveCount(0);
    release();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).not.toBeEmpty();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByText('估算包含汇率影响，不代表官方净值。')).toBeVisible();
  } finally { release(); }
});

test('pending headings only separate distinct groups and reappear for mixed funds', async ({ page }) => {
  await page.route('**/api/fundestimates*', route => route.fulfill({ json: {
    schemaVersion: 1, generatedAt: Date.now(), fxText: '', marketStates: {},
    cards: Object.fromEntries(funds.map(fund => [fund.code, {
      official: { code: fund.code, navDate: '2026-09-17', nav: 2.1234, officialChange: 1 },
      estimate: { code: fund.code, pending: { kind: 'pending', targetDate: '2026-09-18',
        estimatedNav: 2.2, changePercent: 2, localChangePercent: 2, coverage: 1, phase: 'CLOSED' } },
    }])),
  } }));
  await page.goto('/funds');
  await expect(page.locator('[id^="fund-"]')).toHaveCount(16);
  await page.getByRole('button', { name: '待公布估值', exact: true }).click();
  const groups = page.locator('[class*="_fundSortGroup_"]');
  await expect(groups).toHaveCount(0);
  await expect(page.getByText('16 · 按待公布估值涨跌排序', { exact: true })).toBeVisible();
  await page.getByRole('group', { name: '基金类型筛选' }).getByRole('button', { name: '全部', exact: true }).click();
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toContainText('待公布');
  await expect(groups.last()).toContainText('仅官方净值');
  await page.getByRole('group', { name: '基金类型筛选' }).getByRole('button', { name: '主动', exact: true }).click();
  await expect(groups).toHaveCount(0);
});

test('returning to funds refreshes silently without hiding cached cards', async ({ page }) => {
  await page.goto('/funds');
  await expect(page.locator('[id^="fund-"]')).toHaveCount(16);
  const navigation = page.getByRole('navigation', { name: '页面切换' });
  await navigation.getByRole('button', { name: '公司', exact: true }).click();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let refreshing = false;
  await page.route('**/api/fundestimates*', async route => {
    refreshing = true;
    await gate;
    await route.fulfill({ status: 503, json: {} });
  });
  try {
    await navigation.getByRole('button', { name: '基金', exact: true }).click();
    await expect.poll(() => refreshing).toBe(true);
    await page.waitForTimeout(1100);
    await expect(page.locator('[id^="fund-"]')).toHaveCount(16);
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByLabel('基金列表')).toHaveCount(0);
    release();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('[id^="fund-"]')).toHaveCount(16);
  } finally { release(); }
});

test('fund filters remember user choices while explicit links and history keep their own selection', async ({ page }) => {
  const filters = page.getByRole('group', { name: '基金类型筛选' });
  const navigation = page.getByRole('navigation', { name: '页面切换' });
  await page.goto('/');
  await navigation.getByRole('button', { name: '基金', exact: true }).click();
  await expect(page).toHaveURL(/\/funds\?strategy=active$/);
  await expect(filters.getByRole('button', { name: '主动' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[id^="fund-"]')).toHaveCount(16);

  for (const [label, strategy, count] of [['全部', 'all', 26], ['指数', 'index', 10]] as const) {
    await filters.getByRole('button', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`/funds\\?strategy=${strategy}$`));
    await page.reload();
    await expect(filters.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[id^="fund-"]')).toHaveCount(count);
    await navigation.getByRole('button', { name: '概览', exact: true }).click();
    await page.reload();
    await navigation.getByRole('button', { name: '基金', exact: true }).click();
    await expect(filters.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[id^="fund-"]')).toHaveCount(count);
  }

  await page.goto('/returns?category=fund&strategy=active');
  await navigation.getByRole('button', { name: '基金', exact: true }).click();
  await expect(filters.getByRole('button', { name: '指数' })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/funds?strategy=active');
  await expect(filters.getByRole('button', { name: '主动' })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/funds?strategy=all');
  await expect(filters.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await expect(filters.getByRole('button', { name: '主动' })).toHaveAttribute('aria-pressed', 'true');
  await page.goForward();
  await expect(filters.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
});

test('fund filter links survive reload even when local storage is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('storage blocked'); };
    Storage.prototype.setItem = () => { throw new Error('storage blocked'); };
  });
  await page.goto('/funds');
  const filters = page.getByRole('group', { name: '基金类型筛选' });
  await expect(filters.getByRole('button', { name: '主动' })).toHaveAttribute('aria-pressed', 'true');
  await filters.getByRole('button', { name: '全部' }).click();
  await page.reload();
  await expect(filters.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[id^="fund-"]')).toHaveCount(26);
});

test('adding an unclassified fund switches to all so the new card is visible', async ({ page }) => {
  await page.route('**/api/fundnav?codes=118001*', route => route.fulfill({ json: {
    '118001': { fundcode: '118001', name: '测试自定义基金', jzrq: '2026-09-17', dwjz: '1.2345' },
  } }));
  await page.goto('/funds');
  await expect(page.locator('[id^="fund-"]')).toHaveCount(16);
  await page.getByRole('button', { name: '管理基金', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '管理基金' });
  await dialog.getByPlaceholder('基金代码或基金名称').fill('118001');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toContainText('已添加 测试自定义基金');
  await dialog.getByRole('button', { name: '关闭基金管理' }).click();
  await expect(page.getByRole('group', { name: '基金类型筛选' }).getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#fund-118001')).toContainText('测试自定义基金');
  await expect(page.locator('[id^="fund-"]')).toHaveCount(27);
});

test('index funds participate in confirmed returns and risk without estimate requests', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname); });
  await page.goto('/returns?category=fund&strategy=index&range=1m');
  const rows = page.getByRole('table', { name: '近期表现' }).locator('tbody tr');
  await expect(rows).toHaveCount(10);
  await expect(rows.first()).toContainText('+8.00%');
  await expect(rows.first()).toContainText('-3.00%');
  await expect(rows.first()).toContainText('60.00%');
  await expect(rows.first()).toContainText('指数基金');
  await chooseRecentRange(page, 'today', '最新');
  await expect(rows.first()).toContainText('2.1234');
  await expect(page.getByRole('columnheader', { name: /回撤/ })).toHaveCount(0);
  expect(requests).not.toContain('/api/fundestimates');
  expect(requests).not.toContain('/api/fundholdings');
});

test('share labels stay consistent across fund details and returns', async ({ page }, testInfo) => {
  const widths = testInfo.project.name === 'mobile-chromium' ? [320, 375] : [1280];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/funds/022184');
    const card = page.locator('#fund-022184');
    await expect(card.getByRole('button', { name: /富国全球科技互联网C 022184/ })).toBeVisible();
    await card.getByRole('button', { name: '资料', exact: true }).click();
    await expect(card.getByText('C 类', { exact: true })).toBeVisible();
    await expect(card.getByText('人民币（CNY）', { exact: true })).toBeVisible();
    await expect(card.getByText('富国全球科技互联网股票(QDII)C', { exact: true })).toBeVisible();
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`share-profile-${width}.png`), fullPage: true });
  }
  await page.goto('/returns?category=fund');
  await expect(page.getByRole('table').getByText('富国全球科技互联网C', { exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByText('华宝纳斯达克精选A', { exact: true })).toBeVisible();
});

test('fund controls fit narrow widths, navigation preserves filters and detail links reveal the fund', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const widths = testInfo.project.name === 'mobile-chromium' ? [320, 375, 430] : [1280];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/funds?strategy=index');
    await expect(page.locator('[id^="fund-"]')).toHaveCount(10);
    const filters = page.getByRole('group', { name: '基金类型筛选' });
    expect(await filters.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`index-funds-${width}.png`), fullPage: true });
    await filters.getByRole('button', { name: '全部' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.getByRole('group', { name: '基金类型筛选' }).getByRole('button', { name: '主动' }).click();
  await page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: '概览', exact: true }).click();
  await expect(page.locator('[id^="fund-"]')).toHaveCount(0);
  await page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: '基金', exact: true }).click();
  await expect(page.getByRole('group', { name: '基金类型筛选' }).getByRole('button', { name: '主动' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[id^="fund-"]')).toHaveCount(16);
  await page.goto('/funds/270042?strategy=active');
  await expect(page.locator('#fund-270042 [aria-expanded="true"]')).toBeVisible();
  await expect(page.getByRole('group', { name: '基金类型筛选' }).getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
