import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const projected = {
      kind: 'preview', targetDate: '2026-10-12', comparisonDate: '2026-10-09', estimatedNav: 1.01,
      changePercent: 1, rawChangePercent: 1, cumulativeChangePercent: 1, localChangePercent: 1,
      coverage: 0.5, residualWeight: 0.5, pricedHoldingCount: 1, missingQuoteCount: 1,
      benchmarkSource: 'sina-us', benchmarkSymbol: '.NDX', model: 'coverageNormalizedFallback',
      calibration: { applied: false, sampleCount: 0, reason: 'insufficientSamples' },
      phase: 'PRE', complete: false, asOf: Date.parse('2026-10-12T19:00:00+08:00'),
      quoteAsOf: Date.parse('2026-10-10T04:00:00+08:00'), snapshotId: 'review-snapshot',
      quality: { status: 'limited', reasons: ['coverageFallback'], oldestPriceTime: '2026-10-10 04:00:00', oldestFxDate: '2026-10-09', fxCarried: true },
      holdingContributions: [{ sinaSymbol: 'gb_aapl', symbol: 'AAPL', name: 'Apple', weight: 0.5, currency: 'USD',
        basePrice: 100, targetPrice: 101, priceChangePercent: 1, baseFxRate: 7, targetFxRate: 7,
        fxChangePercent: 0, combinedChangePercent: 1, contributionPercent: 1,
        priceInput: { date: '2026-10-09', time: '2026-10-10 04:00:00', source: 'stock-history', session: 'closed' },
        fxInput: { date: '2026-10-09', source: 'fx-history' },
      }],
    };
    const official = { code: '017436', navDate: '2026-10-09', nav: 1, officialChange: 0.5 };
    const estimate = { code: '017436', modelVersion: 'date_aligned_benchmark_v3', officialNavDate: official.navDate,
      officialNav: 1, officialChange: 0.5, holdingReportDate: '2026-06-30', preview: projected,
      pending: { ...projected, kind: 'pending', targetDate: '2026-10-09', phase: 'CLOSED', complete: true },
      holdings: [{ symbol: 'AAPL', name: 'Apple', sinaSymbol: 'gb_aapl', currency: 'USD', weight: 0.5, reportDate: '2026-06-30' }],
      holdingQuotes: {}, holdingMarketStates: {},
    };
    if (url.pathname === '/api/meta') return route.fulfill({ json: { apiSchemaVersion: 1, dashboardSchemaVersion: 1, fundManagementMode: 'disabled' } });
    if (url.pathname === '/api/fundestimates') return route.fulfill({ json: url.searchParams.get('view') === 'cards'
      ? { schemaVersion: 1, generatedAt: Date.now(), fxText: '', marketStates: {}, cards: { '017436': { official, estimate } } }
      : { '017436': estimate } });
    if (url.pathname === '/api/fundhistory') return route.fulfill({ json: { '017436': [
      { FSRQ: '2026-10-09', DWJZ: '1.02', JZZZL: '1' },
      { FSRQ: '2026-09-30', DWJZ: '1.01', JZZZL: '1' },
      { FSRQ: '2026-09-29', DWJZ: '1', JZZZL: '0' },
    ] } });
    return route.fulfill({ json: {} });
  });
});

test('fund links retain estimate mode, ordering and detail tab with keyboard readings', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/funds/017436?mode=pending&order=asc&tab=trend&strategy=active');
  const card = page.locator('#fund-017436');
  await expect(page.getByRole('button', { name: '待公布估值', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /当前低到高/ })).toBeVisible();
  await expect(card.getByRole('button', { name: '走势', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const chart = card.getByRole('img', { name: /官方历史单位净值走势/ });
  await expect(chart).toBeVisible();
  await chart.focus();
  await page.keyboard.press('End');
  await expect(card).toContainText('2026-10-09');
  await expect(card).toContainText('1.0200');
  await page.reload();
  await expect(card.getByRole('button', { name: '走势', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await card.getByRole('button', { name: '持仓', exact: true }).click();
  await expect(page).toHaveURL(/tab=holdings/);
  await expect(card.getByText('10/10 04:00', { exact: true })).toBeVisible();
  await expect(card.getByText(/最早参考日期：2026-10-09/)).toBeVisible();
  await expect(card.getByLabel('估算输入受限')).toBeVisible();
  await page.reload();
  await expect(card.getByRole('button', { name: '持仓', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => {
    const cardBox = await card.boundingBox();
    const toolbar = await page.locator('[class*="_fundToolbar_"]').boundingBox();
    return cardBox!.y - toolbar!.y - toolbar!.height;
  }).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath('fund-input-quality.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('company search with no matches does not show unrelated company charts', async ({ page }, testInfo) => {
  await page.goto('/companies?company=apple');
  const search = page.getByRole('searchbox', { name: '搜索公司' });
  await expect(page.locator('#company-trend-panel')).toBeVisible();
  await search.fill('no-matching-company-xyz');
  await expect(page.getByText('未找到匹配公司')).toBeVisible();
  await expect(page.locator('#company-trend-panel')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('company-empty-search.png'), fullPage: true });
  await search.clear();
  await expect(page.locator('#company-trend-panel')).toBeVisible();
});
