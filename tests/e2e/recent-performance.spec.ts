import { expect, test } from '@playwright/test';
import { chooseRecentRange, expectRecentRange } from './controls';
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
  await chooseRecentRange(page, 'today', '最新');
  await expect(table.getByRole('columnheader')).toHaveCount(7);
  await expect(table.getByRole('columnheader', { name: '涨跌幅 ↓' })).toHaveAttribute('aria-sort', 'descending');
  await chooseRecentRange(page, '1m', '近1月');
  await expect(table.getByRole('columnheader')).toHaveCount(10);
  expect(apiRequests.filter(path => path === '/api/marketreturns')).toHaveLength(1);
  expect(apiRequests.some(path => /^\/api\/fund/.test(path))).toBe(false);
});

test('slow recent loading stays in the content area without requesting global FX', async ({ page }) => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dashboardRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/dashboard')) dashboardRequests.push(request.url());
  });
  await page.route('**/api/marketreturns*', async route => { await gate; await route.fallback(); });
  try {
    await page.goto('/returns?category=index&range=1m');
    await expect(page.getByRole('heading', { name: '资产走势' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '近期表现加载中...' })).toBeVisible();
    await expect(page.getByText('按各市场交易日统计，历史指标截至最近可用数据。')).toBeVisible();
    await expect(page.locator('header [role="status"]')).toHaveCount(0);
    await expect(page.getByRole('table').locator('tbody')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[class*="_fxRow_"], [class*="_datetime_"]')).toHaveCount(0);
    release();
    await expect(page.getByRole('table', { name: '近期表现' })).toContainText('+123.45%');
    await expect(page.getByRole('status').filter({ hasText: '近期表现加载中...' })).toHaveCount(0);
    expect(dashboardRequests.every(url => new URL(url).searchParams.get('currencies') === '')).toBe(true);
  } finally { release(); }
});

test('recent subcategories share a row with the right-aligned mobile range', async ({ page, isMobile }, testInfo) => {
  await page.goto('/returns?range=5y&category=etf');
  for (const width of isMobile ? [320, 390, 720] : [1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [label, subLabel] of [['ETF', 'ETF类型筛选'], ['基金', '基金类型筛选'], ['指数', ''], ['资产', ''], ['全部', '']]) {
      await page.getByLabel('分类筛选', { exact: true }).getByRole('button', { name: label, exact: true }).click();
      await expectRecentRange(page, '5y', '近5年');
      const geometry = await page.evaluate(subLabel => {
        const category = document.querySelector('[aria-label="分类筛选"]')!;
        const toolbar = category.parentElement!.getBoundingClientRect();
        const primary = category.firstElementChild!.getBoundingClientRect();
        const sub = subLabel ? document.querySelector(`[aria-label="${subLabel}"]`)!.firstElementChild!.getBoundingClientRect() : null;
        const select = document.querySelector('[aria-label="近期时间区间"]')!.getBoundingClientRect();
        const range = document.querySelector('[aria-label="表现区间"]')!.getBoundingClientRect();
        return { toolbarRight: toolbar.right, primary: primary.toJSON(), sub: sub?.toJSON(),
          select: select.toJSON(), range: range.toJSON(), overflow: document.documentElement.scrollWidth - innerWidth };
      }, subLabel);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      if (isMobile) {
        expect(geometry.select.top).toBeGreaterThanOrEqual(geometry.primary.bottom + 8);
        expect(geometry.select.right).toBeCloseTo(geometry.toolbarRight, 0);
        if (geometry.sub) {
          expect(geometry.sub.top).toBeGreaterThanOrEqual(geometry.primary.bottom + 8);
          expect(geometry.sub.top).toBeCloseTo(geometry.select.top, 0);
          expect(geometry.sub.height).toBeCloseTo(geometry.select.height, 0);
          expect(geometry.sub.left).toBeCloseTo(geometry.primary.left, 0);
          expect(geometry.select.left - geometry.sub.right).toBeGreaterThanOrEqual(8);
        }
        if (width === 390 && subLabel) await page.screenshot({ path: testInfo.outputPath(`filters-${subLabel}.png`) });
      } else {
        expect(geometry.range.top).toBeCloseTo(geometry.primary.top, 0);
        if (geometry.sub) expect(geometry.sub.top).toBeGreaterThan(geometry.range.bottom);
      }
    }
  }
});

test('enlarged mobile filter text wraps the range without squeezing or clipping labels', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile filter wrapping');
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/returns?range=5y&category=etf');
  await page.getByRole('combobox', { name: '近期时间区间' }).waitFor();
  await page.addStyleTag({ content: '[aria-label="ETF类型筛选"] button { font-size: 18px; }' });
  const geometry = await page.evaluate(() => {
    const sub = document.querySelector('[aria-label="ETF类型筛选"]')!;
    const select = document.querySelector('[aria-label="近期时间区间"]')!.getBoundingClientRect();
    return { bottom: sub.getBoundingClientRect().bottom, top: select.top, right: select.right,
      toolbarRight: sub.parentElement!.getBoundingClientRect().right,
      clipped: [...sub.querySelectorAll('button')].some(button => button.scrollWidth > button.clientWidth + 1),
      overflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.bottom + 8);
  expect(geometry.right).toBeCloseTo(geometry.toolbarRight, 0);
  expect(geometry.clipped).toBe(false);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
});

test('five-year controls persist and the selected header shares the long-term style', async ({ page, isMobile }) => {
  await page.goto('/returns?range=5y');
  await expectRecentRange(page, '5y', '近5年');
  await chooseRecentRange(page, '1m', '近1月');
  await expect(page.getByRole('table', { name: '近期表现' })).toContainText('+123.45%');
  const sort = page.getByRole('button', { name: '涨跌幅 ↓', exact: true });
  await expect(sort).toHaveCSS('background-color', 'rgb(241, 245, 249)');
  await expect(sort).toHaveCSS('border-color', 'rgb(226, 232, 240)');
  await chooseRecentRange(page, '5y', '近5年');
  await page.reload();
  await expectRecentRange(page, '5y', '近5年');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  if (isMobile) {
    await expect(page.getByLabel('表现区间').getByRole('button', { name: '近5年', exact: true })).toHaveCount(0);
    const select = page.getByRole('combobox', { name: '近期时间区间' });
    await expect(select).toHaveCSS('font-size', '12px');
    await expect(select).toHaveCSS('height', '40px');
    await select.tap();
    await expect(select).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Escape');
  }
  await page.getByRole('navigation', { name: '走势分析视图' }).getByRole('button', { name: '长期' }).click();
  await expect(page).toHaveURL(/\/history$/);
});

test('recent rows open lazy charts and preserve sorting, focus and scrolling', async ({ page }, testInfo) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/markethistory?**', route => route.fulfill({ json: [
    { date: '2025-12-31', close: 51000 }, { date: '2026-08-14', close: 55249.85 },
    { date: '2026-08-15', close: 55249.85 }, { date: '2026-08-31', close: 54000 },
    { date: '2026-09-10', close: 65000 }, { date: '2026-09-15', close: 123456.78 },
    { date: '2026-09-16', close: 999999 },
  ] }));
  await page.goto('/returns?category=etf&range=1m&sort=drawdown');
  const row = page.getByRole('table').locator('tbody tr').first();
  await expect(row).toContainText('+123.45%');
  expect(requests.some(url => url.includes('/api/markethistory?'))).toBe(false);
  const url = page.url();
  const button = row.getByRole('button');
  const name = await button.getAttribute('aria-label');
  await row.locator('td').nth(2).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('img')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '1月', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog).toContainText('2026-08-15 至 2026-09-15');
  await expect(dialog).not.toContainText('999,999');
  expect(await dialog.getByRole('img').locator('path').first().getAttribute('d')).toMatch(/^M.+L/);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(dialog.getByRole('button', { name: '关闭' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('img')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '关闭' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('recent-history-dialog.png'), fullPage: true });
  const bodyY = await page.evaluate(() => scrollY);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => scrollY)).toBe(bodyY);
  await expect(page.getByRole('columnheader', { name: '回撤 ↓' })).toHaveAttribute('aria-sort', 'descending');

  const scroller = page.getByRole('region', { name: '近期表现表格' });
  await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const scrollLeft = await scroller.evaluate(element => element.scrollLeft);
  await button.focus();
  await button.press('Enter');
  await expect(dialog.getByRole('img')).toBeVisible();
  await dialog.getByRole('button', { name: '关闭' }).click();
  expect(await scroller.evaluate(element => element.scrollLeft)).toBe(scrollLeft);
  expect(requests.filter(url => url.includes('/api/markethistory?'))).toHaveLength(1);
  await expect(button).toHaveAttribute('aria-label', name!);
  expect(requests.some(url => /\/api\/fund/.test(url))).toBe(false);
  expect(errors).toEqual([]);
});

test('latest defaults to one month and fund charts request only the selected official NAV series', async ({ page }, testInfo) => {
  const requests: URL[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(new URL(request.url())); });
  await page.route('**/api/fundhistory?**', route => {
    const code = new URL(route.request().url()).searchParams.get('codes')!;
    return route.fulfill({ json: { [code]: [
      { FSRQ: '2026-09-15', DWJZ: '12.3456', JZZZL: '1' },
      { FSRQ: '2026-09-14', DWJZ: '12.2234', JZZZL: '1' },
      { FSRQ: '2026-08-15', DWJZ: '10', JZZZL: '1' },
    ] } });
  });
  await page.goto('/returns?category=fund&strategy=index');
  const button = page.getByRole('button', { name: '广发纳指100ETF联接A走势' });
  await expect(button).toBeVisible();
  const before = requests.filter(url => url.pathname === '/api/fundhistory').length;
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('img')).toBeVisible();
  await expect(dialog).toContainText('官方单位净值');
  await expect(dialog.getByRole('button', { name: '1月', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const history = requests.filter(url => url.pathname === '/api/fundhistory').slice(before);
  expect(history).toHaveLength(1);
  expect(history[0].searchParams.get('codes')).toBe('270042');
  expect(history[0].searchParams.get('performance')).toBe('1');
  expect(requests.some(url => ['/api/fundestimates', '/api/fundholdings', '/api/fundpurchase'].includes(url.pathname))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('recent-fund-history-dialog.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('a mobile horizontal swipe never opens a history dialog', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Native touch gesture');
  await page.goto('/returns?category=asset&range=1m');
  const scroller = page.getByRole('region', { name: '近期表现表格' });
  const row = scroller.locator('tbody tr').first();
  await expect(row).toContainText('+123.45%');
  const box = (await row.locator('td').nth(3).boundingBox())!;
  const x = box.x + box.width - 10;
  const y = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 6; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * 20, y }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Chrome consumes a touch that stops kinetic scrolling instead of sending a click.
  await scroller.evaluate(element => new Promise<void>(resolve => {
    let previous = element.scrollLeft;
    let stableFrames = 0;
    const settle = () => {
      stableFrames = element.scrollLeft === previous ? stableFrames + 1 : 0;
      previous = element.scrollLeft;
      if (stableFrames >= 12) resolve();
      else requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }));
  await row.getByRole('button').tap();
  await expect(page.getByRole('dialog')).toBeVisible();
});
