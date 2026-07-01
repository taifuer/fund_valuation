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
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '管理基金' })).toBeHidden();
});
