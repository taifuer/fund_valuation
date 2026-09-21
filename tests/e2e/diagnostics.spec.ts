import { expect, test } from '@playwright/test';

test('authenticated history diagnostics remain readable and locally scrollable', async ({ page }) => {
  await page.route('**/api/diagnostics/quotes**', route => route.fulfill({ json: {
    status: 'degraded', publicStatus: { status: 'ok' }, total: 1006, healthy: 1004, issueCount: 2,
    marketQuoteIssueCount: 0, holdingQuoteIssueCount: 2,
    issues: [{ symbol: 'gb_atai', scope: 'holding', state: 'live', quoteTime: '2026-09-19 09:30:10',
      source: 'upstream', reason: 'quote date 2026-09-19 before 2026-09-21' }],
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
  await expect(page.getByText('服务状态').locator('..')).toContainText('正常');
  await expect(page.getByText('行情状态').locator('..')).toContainText('部分异常');
  await expect(page.getByRole('row').filter({ hasText: 'gb_atai' })).toContainText('持仓/估值');
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

for (const state of [
  { status: 'ok', holdingQuoteIssueCount: 2, reasons: [], label: '服务运行正常（2 项持仓行情待更新）', color: 'rgb(22, 163, 74)' },
  { status: 'degraded', holdingQuoteIssueCount: 0, reasons: ['worker-stale'], label: '后台刷新延迟', color: 'rgb(217, 119, 6)' },
  { status: 'offline', holdingQuoteIssueCount: 0, reasons: [], label: '服务状态暂不可用', color: 'rgb(148, 163, 184)' },
]) test(`overview status dot reports ${state.status} separately from individual quotes`, async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ status: state.status === 'offline' ? 503 : 200, json: {
    ...state, quoteIssueCount: state.holdingQuoteIssueCount, marketQuoteIssueCount: 0,
    quoteTotal: 1006, updatedAt: Date.now(), workerLastSuccessAt: Date.now(),
  } }));
  await page.goto('/');
  const dot = page.getByLabel(state.label, { exact: true });
  await expect(dot).toBeVisible();
  await expect(dot).toHaveCSS('background-color', state.color);
  await expect(dot).toHaveAttribute('title', state.label);
});
