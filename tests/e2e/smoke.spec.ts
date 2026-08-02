import { expect, test } from '@playwright/test';

for (const [path, activeLabel] of [['/', '概览'], ['/funds', '基金'], ['/returns', '收益'], ['/risk', '风险'], ['/about', '关于']] as const) {
  test(`${path} survives direct navigation`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: '全球资产看板' })).toBeVisible();
    await expect(page.getByRole('button', { name: activeLabel, exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('页面加载失败');
  });
}

test('mobile layout keeps page-level content within the viewport', async ({ page }) => {
  await page.goto('/returns');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('mobile navigation keeps the active style after client-side navigation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile navigation behavior');

  await page.goto('/');
  const returnsButton = page.getByRole('button', { name: '收益', exact: true });
  await returnsButton.click();
  await expect(page).toHaveURL(/\/returns$/);
  await expect(returnsButton).toHaveAttribute('aria-current', 'page');
  const backgroundAfterClick = await returnsButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  await page.reload();
  const reloadedButton = page.getByRole('button', { name: '收益', exact: true });
  await expect(reloadedButton).toHaveAttribute('aria-current', 'page');
  const backgroundAfterReload = await reloadedButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  expect(backgroundAfterClick).toBe('rgb(15, 23, 42)');
  expect(backgroundAfterReload).toBe(backgroundAfterClick);
});

test('mobile return and risk tables keep every column in a horizontal scroller', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile table behavior');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/returns', '/risk']) {
      await page.goto(path);
      const table = page.locator('table');
      const scroller = table.locator('..');
      const nameHeader = table.locator('thead th').filter({ hasText: '名称' });
      const thirdHeader = table.locator('thead th:nth-child(3)');
      const fourthHeader = table.locator('thead th:nth-child(4)');
      await expect(table.locator('thead th').filter({ hasText: '截至' })).toBeVisible();

      const before = await scroller.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollLeft: element.scrollLeft,
        scrollWidth: element.scrollWidth,
      }));
      expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);
      const primaryViewport = await fourthHeader.evaluate((element) => {
        const scrollerRect = element.closest('section')?.getBoundingClientRect();
        const thirdRect = element.previousElementSibling?.getBoundingClientRect();
        return {
          fourthStartsOutside: Boolean(scrollerRect && element.getBoundingClientRect().left >= scrollerRect.right - 1),
          thirdFits: Boolean(scrollerRect && thirdRect && thirdRect.right <= scrollerRect.right + 1),
        };
      });
      await expect(thirdHeader).toBeVisible();
      expect(primaryViewport).toEqual({ fourthStartsOutside: true, thirdFits: true });

      const stickyLeftBefore = await nameHeader.evaluate(
        (element) => element.getBoundingClientRect().left,
      );
      await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      const stickyLeftAfter = await nameHeader.evaluate(
        (element) => element.getBoundingClientRect().left,
      );
      expect(Math.abs(stickyLeftAfter - stickyLeftBefore)).toBeLessThanOrEqual(1);
    }
  }
});

test('risk table places drawdown before return', async ({ page }) => {
  await page.goto('/risk');
  const headerCells = page.locator('table thead th');
  await expect(headerCells).toHaveCount(8);
  const headers = await headerCells.allTextContents();
  expect(headers.map((header) => header.trim().replace(/[↑↓]/g, '').trim()).slice(0, 4)).toEqual([
    '排名',
    '名称',
    '回撤',
    '收益',
  ]);
});

test('risk table defaults to the largest drawdown first', async ({ page }) => {
  await page.route('**/api/marketreturns?*', async (route) => {
    const range = (returnPercent: number, maxDrawdownPercent: number) => ({
      label: '今年',
      returnPercent,
      maxDrawdownPercent,
      winRatePercent: 50,
      startDate: '2026-01-01',
      endDate: '2026-07-31',
      startClose: 100,
      endClose: 100 + returnPercent,
    });
    await route.fulfill({
      json: {
        'sina-cn:sh000001': {
          source: 'sina-cn',
          symbol: 'sh000001',
          ranges: { ytd: range(8, -5) },
        },
        'sina-cn:sz399006': {
          source: 'sina-cn',
          symbol: 'sz399006',
          ranges: { ytd: range(4, -12) },
        },
        'sina-cn:sh000300': {
          source: 'sina-cn',
          symbol: 'sh000300',
          ranges: { ytd: range(6, -8) },
        },
      },
    });
  });
  await page.goto('/risk');
  await expect(page.getByRole('button', { name: '回撤 ↓' })).toBeVisible();
  const drawdownCells = page.locator('table tbody tr td:nth-child(3)');
  await expect(drawdownCells.first()).toBeVisible();
  const drawdowns = (await drawdownCells.allTextContents())
    .map((value) => Math.abs(Number.parseFloat(value)))
    .filter(Number.isFinite);
  expect(drawdowns).toEqual([12, 8, 5]);
});

test('return and risk tables keep the name column compact', async ({ page }, testInfo) => {
  for (const path of ['/returns', '/risk']) {
    await page.goto(path);
    const table = page.locator('table');
    const nameHeader = table.locator('thead th').filter({ hasText: '名称' });
    await expect(nameHeader).toBeVisible();
    const widths = await table.evaluate((element) => ({
      name: element.querySelector('thead th:nth-child(2)')?.getBoundingClientRect().width ?? 0,
      table: element.getBoundingClientRect().width,
    }));
    expect(widths.name).toBeGreaterThan(0);
    if (testInfo.project.name === 'mobile-chromium') {
      expect(widths.name).toBeLessThanOrEqual(113);
    } else {
      expect(widths.name / widths.table).toBeLessThanOrEqual(0.205);
    }
  }
});

test('return and risk filters survive direct navigation and reload', async ({ page }) => {
  await page.goto('/returns?category=etf&etf=sector&range=1y&sort=value&order=asc');
  await expect(page.getByLabel('分类筛选').getByRole('button', { name: 'ETF', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('ETF类型筛选').getByRole('button', { name: '行业ETF' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('收益区间').getByRole('button', { name: '近1年' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/sort=value&order=asc/);
  await page.reload();
  await expect(page.getByLabel('ETF类型筛选').getByRole('button', { name: '行业ETF' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/risk?category=asset&range=1m&sort=winRate&order=asc');
  await expect(page.getByLabel('分类筛选').getByRole('button', { name: '资产' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('风险区间').getByRole('button', { name: '近1月' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/sort=winRate&order=asc/);
});

test('diagnostics route stays hidden from primary navigation and requires a token', async ({ page }) => {
  await page.goto('/diagnostics');
  await expect(page.getByRole('heading', { name: '运行诊断' })).toBeVisible();
  await expect(page.getByLabel('诊断令牌')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '页面切换' })).not.toContainText('诊断');
});

test('fund manager opens as a dialog and closes with Escape', async ({ page }) => {
  await page.goto('/funds');
  await page.getByRole('button', { name: '管理基金', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '管理基金' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '关闭基金管理' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '恢复默认' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '管理基金' })).toBeHidden();
});
