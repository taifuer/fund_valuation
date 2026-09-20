import { expect, test } from '@playwright/test';

test('authenticated history diagnostics remain readable and locally scrollable', async ({ page }) => {
  await page.route('**/api/diagnostics/quotes**', route => route.fulfill({ json: {
    historyCoverage: {
      summary: { marketsStale: 1, marketRefreshErrors: 1 },
      markets: [
        { item: 'yahoo-index:RUT', name: '罗素2000', count: 100, endDate: '2026-09-15', expectedDate: '2026-09-18', stale: true,
          refresh: { error: 'History HTTP 429', lastSuccessAt: 0 } },
        { item: 'yahoo-index:SOX', name: '费城半导体', count: 100, endDate: '2026-09-18', expectedDate: '2026-09-18', stale: false,
          refresh: { error: '', lastSuccessAt: 1789707600000 } },
      ],
    },
  } }));
  await page.goto('/diagnostics');
  await page.getByLabel('诊断令牌').fill('test-only');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByRole('heading', { name: '行情历史更新' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '罗素2000' })).toContainText('未追平');
  await expect(page.getByRole('row').filter({ hasText: '费城半导体' })).toContainText('已追平');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const table = page.getByRole('table').filter({ has: page.getByText('罗素2000', { exact: true }) });
  const canScroll = await table.evaluate(element => {
    const wrapper = element.parentElement!;
    wrapper.scrollLeft = wrapper.scrollWidth;
    return wrapper.scrollWidth <= wrapper.clientWidth || wrapper.scrollLeft > 0;
  });
  expect(canScroll).toBe(true);
  await page.screenshot({ path: test.info().outputPath('history-diagnostics.png'), fullPage: true });
});
