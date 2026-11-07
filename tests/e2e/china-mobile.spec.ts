import { expect, test } from '@playwright/test';

test('China Mobile uses existing offline company controls and renders verified reports on desktop and mobile', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('/companies?company=chinaMobile&period=quarterly');
  await expect(page.getByRole('heading', { name: '中国移动', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '中国移动营业收入趋势', exact: true })).toBeVisible();
  const industry = page.getByRole('combobox', { name: '行业筛选' });
  await industry.selectOption('electronics');
  await expect(industry.locator('option:checked')).toHaveText('电子与通信 · 4');
  await expect(page.getByRole('heading', { name: '中国移动', exact: true })).toBeVisible();
  const table = page.getByRole('table', { name: '中国移动披露明细' });
  await expect(table.locator('tbody tr').first()).toContainText('2026 Q3');
  await expect(table.locator('tbody tr').first().getByRole('link', { name: '中国移动 FY2026 Q3官方报告' }))
    .toHaveAttribute('href', 'https://static.cninfo.com.cn/finalpage/2026-10-21/1225613028.PDF');
  await page.getByRole('button', { name: '研发费用', exact: true }).click();
  await expect(page.getByRole('img', { name: '中国移动研发费用趋势', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '员工人数', exact: true }).click();
  const employeeChart = page.getByRole('img', { name: '中国移动员工人数趋势', exact: true });
  await expect(employeeChart).toBeVisible();
  const bridges = page.getByTestId('company-disclosure-bridges');
  await expect(bridges).toHaveAttribute('d', /M .+ L /);
  expect(await bridges.evaluate(element => getComputedStyle(element).strokeDasharray)).not.toBe('none');
  await expect(page.getByText(/虚线连接相邻披露点/)).toBeVisible();
  await employeeChart.focus();
  await page.keyboard.press('Home');
  const reading = page.locator('[aria-live="polite"]').filter({ hasText: 'FY2021 Q2' });
  await expect(reading).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: 'FY2021 Q4' })).toBeVisible();
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: viewport.height });
  await expect.poll(async () => {
    const first = await employeeChart.getByText('披露约数', { exact: true }).boundingBox();
    const last = await employeeChart.getByText('合并范围', { exact: true }).boundingBox();
    return last!.x - first!.x - first!.width;
  }).toBeGreaterThan(4);
  await page.setViewportSize(viewport);
  await page.screenshot({ path: testInfo.outputPath('china-mobile-quarterly-employees.png'), fullPage: true });
  await page.getByRole('button', { name: '半年', exact: true }).click();
  await expect(bridges).toHaveCount(1);
  await expect(page.getByText('公司披露与区间汇总', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '员工人数', exact: true }).click();
  await expect(page.getByRole('img', { name: '中国移动员工人数趋势', exact: true })).toBeVisible();
  await expect(page.getByText(/期末在职员工，保留官方约数/)).toBeVisible();
  await expect(page.getByText(/FY2023 H1 起部分半年员工人数采用官方约数/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('china-mobile-employees.png'), fullPage: true });
  await page.getByRole('button', { name: '年度', exact: true }).click();
  await page.getByRole('button', { name: '显示全部 28 期' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(28);
  await expect(table.locator('tbody tr').last()).toContainText('FY1998');
  await page.reload();
  await expect(page.getByRole('heading', { name: '中国移动', exact: true })).toBeVisible();
  await expect(industry).toHaveValue('electronics');
  await expect(page.getByRole('img', { name: '中国移动员工人数趋势', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '期末市值', exact: true }).click();
  await expect(page.getByRole('img', { name: '中国移动期末市值趋势', exact: true })).toBeVisible();
  await expect(page.getByText('港股口径 · HKD', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '季度', exact: true }).click();
  const newest = table.locator('tbody tr').first();
  await expect(newest).toContainText('2026 Q3');
  await expect(newest).toContainText('HK$');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('china-mobile-market-cap.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('China Mobile extended history trims unavailable metrics and keeps mobile boundary labels readable', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('/companies?company=chinaMobile&period=annual');
  const chart = page.locator('svg[role="img"]');
  await chart.focus();
  await page.keyboard.press('Home');
  const reading = page.locator('[aria-live="polite"]');
  await expect(reading).toContainText('FY1998');
  await expect(reading).toContainText('1998.12.31');
  await page.getByRole('button', { name: '营业利润率', exact: true }).click();
  await chart.focus();
  await page.keyboard.press('Home');
  await expect(reading).toContainText('FY2018');
  await expect(reading).toContainText('20.6%');
  await page.getByRole('button', { name: '期末市值', exact: true }).click();
  await chart.focus();
  await page.keyboard.press('Home');
  await expect(reading).toContainText('FY2000');
  await expect(reading).toContainText('港股口径 · HKD');

  await page.setViewportSize({ width: 320, height: 850 });
  for (const metric of ['营业收入', '员工人数']) {
    await page.getByRole('button', { name: metric, exact: true }).click();
    await expect.poll(async () => chart.evaluate(svg => {
      const bounds = svg.getBoundingClientRect();
      const labels = Array.from(svg.querySelectorAll('text[class*="methodologyLabel"]'))
        .map(label => label.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      return labels.every((label, index) => label.left >= bounds.left && label.right <= bounds.right
        && (!index || label.left >= labels[index - 1].right + 3));
    })).toBe(true);
  }
  await page.getByRole('button', { name: '显示全部 28 期' }).click();
  const oldest = page.getByRole('table', { name: '中国移动披露明细' }).locator('tbody tr').last();
  await expect(oldest.getByRole('cell').nth(3)).toHaveText('--');
  await expect(oldest.getByRole('cell').nth(5)).toHaveText('--');
  await expect(oldest.getByRole('cell').last()).toHaveText('--');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});
