import { expect, test } from '@playwright/test';

for (const [path, activeLabel] of [['/', '概览'], ['/funds', '基金'], ['/returns', '收益'], ['/risk', '风险']] as const) {
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

test('mobile return and risk tables keep every column in a horizontal scroller', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile table behavior');

  for (const path of ['/returns', '/risk']) {
    await page.goto(path);
    const table = page.locator('table');
    const scroller = table.locator('..');
    const nameHeader = table.locator('thead th').filter({ hasText: '名称' });
    await expect(table.locator('thead th').filter({ hasText: '截至' })).toBeVisible();

    const before = await scroller.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
    }));
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);

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
});

test('return and risk filters survive direct navigation and reload', async ({ page }) => {
  await page.goto('/returns?category=etf&etf=sector&range=1y&sort=value&order=asc');
  await expect(page.getByLabel('分类筛选').getByRole('button', { name: 'ETF', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('ETF类型筛选').getByRole('button', { name: '行业ETF' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('收益区间').getByRole('button', { name: '近1年' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/sort=value&order=asc/);
  await page.reload();
  await expect(page.getByLabel('ETF类型筛选').getByRole('button', { name: '行业ETF' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/risk?category=asset&range=1m&sort=winRate&order=desc');
  await expect(page.getByLabel('分类筛选').getByRole('button', { name: '资产' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('风险区间').getByRole('button', { name: '近1月' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/sort=winRate&order=desc/);
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
