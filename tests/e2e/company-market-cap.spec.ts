import { expect, test } from '@playwright/test';

test('offline market caps retain fiscal dates, currency and mobile table access', async ({ page, isMobile }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('/companies?company=apple&metric=marketCap');
  await expect(page.getByRole('img', { name: '苹果期末市值趋势', exact: true })).toBeVisible();
  await expect(page.getByText(/市值币种：USD/)).toBeVisible();
  await page.getByRole('button', { name: '半年', exact: true }).click();
  await expect(page.getByRole('button', { name: '半年', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '同比', exact: true }).click();
  await expect(page.getByRole('img', { name: '苹果期末市值同比趋势', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '期末市值', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const width of isMobile ? [320, 390] : [1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const button of await page.getByLabel('趋势指标', { exact: true }).getByRole('button').all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    const table = page.getByRole('table', { name: '苹果披露明细' });
    const revenue = table.getByRole('columnheader', { name: '营业收入', exact: true });
    await revenue.scrollIntoViewIfNeeded();
    const box = (await revenue.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    const cap = table.getByRole('columnheader', { name: '期末市值*', exact: true });
    await expect(cap).toHaveAttribute('scope', 'col');
    await table.locator('..').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    const capBox = (await cap.boundingBox())!;
    expect(capBox.x + capBox.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (!isMobile) await table.locator('..').evaluate(element => { element.scrollLeft = 0; });
    await page.getByRole('button', { name: '期末市值', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`market-cap-${width}.png`), fullPage: true });
  }
  await page.goto('/companies?company=tencent&metric=marketCap');
  await expect(page.getByRole('img', { name: '腾讯期末市值趋势', exact: true })).toBeVisible();
  await expect(page.getByText(/市值币种：HKD/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'CompaniesMarketCap', exact: true }).first()).toBeVisible();
  await page.goto('/companies?company=samsung&metric=marketCap');
  await expect(page.getByRole('img', { name: '三星电子期末市值趋势', exact: true })).toBeVisible();
  await expect(page.getByText(/包含普通股和优先股/)).toBeVisible();
  await page.goto('/companies?company=catl&metric=marketCap');
  await expect(page.getByRole('img', { name: '宁德时代期末市值趋势', exact: true })).toBeVisible();
  await expect(page.getByText(/仅收录港股上市前可核验的期末市值/)).toBeVisible();
  await page.goto('/companies?company=huawei');
  await expect(page.getByRole('button', { name: '期末市值', exact: true })).toBeDisabled();
  await expect(page.getByText(/未上市，不展示推测估值/)).toBeVisible();
  expect(errors).toEqual([]);
});
