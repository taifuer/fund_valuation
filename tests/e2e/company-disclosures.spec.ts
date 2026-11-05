import { expect, test } from '@playwright/test';

test('reviewed November reports display offline with correct fiscal periods and sources', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  for (const [id, name, period, end] of [
    ['apple', '苹果', 'FY2026 Q4', '2026-09-26'],
    ['byd', '比亚迪', 'FY2026 Q3', '2026-09-30'],
    ['samsung', '三星电子', 'FY2026 Q3', '2026-09-30'],
    ['toyota', '丰田汽车', 'FY2027 Q2', '2026-09-30'],
    ['novoNordisk', '诺和诺德', 'FY2026 Q3', '2026-09-30'],
  ]) {
    await page.goto(`/companies?company=${id}&period=quarterly`);
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    const chart = page.getByRole('img', { name: `${name}营业收入趋势`, exact: true });
    await expect(chart).toBeVisible();
    expect((await chart.locator('path').getAttribute('d'))?.length).toBeGreaterThan(100);
    const row = page.getByRole('table', { name: `${name}披露明细` }).locator('tbody tr').first();
    await expect(row).toContainText(period.replace('FY', ''));
    await expect(row).toContainText(end.replaceAll('-', '.'));
    const report = row.getByRole('link', { name: `${name} ${period}官方报告`, exact: true });
    await expect(report).toHaveAttribute('href', /^https:\/\//);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (id === 'byd') await page.screenshot({ path: testInfo.outputPath('november-company-report.png'), fullPage: true });
  }
  expect(errors).toEqual([]);
});
