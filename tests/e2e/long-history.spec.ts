import { expect, test } from '@playwright/test';

const monthly = Array.from({ length: 92 }, (_, i) => ({
  period: `${2019 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`,
  date: `${2019 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-28`,
  close: 100 + i * 2, source: 'tencent', sourceUrl: 'https://example.com/',
}));
const asset = {
  id: 'INX', name: '标普500', group: 'usa', basis: 'price', unit: '点', firstDate: monthly[0].date,
  lastDate: monthly.at(-1)!.date, count: monthly.length, sources: ['腾讯财经'], note: '价格涨跌，不含股息再投资。', refreshFailed: false,
  annual: [{ year: 2025, return: 20, startDate: '2024-12-31', startClose: 100, endDate: '2025-12-31', endClose: 120,
    reason: '', yearToDate: false, sourceUrl: null }],
};
const performance = { id: 'INX', startPeriod: '2019-01', endPeriod: '2026-08', months: 91,
  startClose: 100, endClose: 282, change: 182, cagr: (2.82 ** (12 / 91) - 1) * 100, reason: '', cagrReason: '' };
const fiveYear = { ...performance, startPeriod: '2021-08', months: 60,
  startClose: 162, change: (282 / 162 - 1) * 100, cagr: ((282 / 162) ** (1 / 5) - 1) * 100 };
const calendarFive = { ...performance, startPeriod: '2020-12', endPeriod: '2025-12', months: 60,
  startClose: 146, endClose: 266, change: (266 / 146 - 1) * 100, cagr: ((266 / 146) ** (1 / 5) - 1) * 100 };
const common = { ...calendarFive, startPeriod: '2019-12', months: 72,
  startClose: 122, change: (266 / 122 - 1) * 100, cagr: ((266 / 122) ** (1 / 6) - 1) * 100 };
const missing = { ...calendarFive, startClose: null, change: null, cagr: null, reason: '缺少区间起止月数据' };
const ranges = {
  '5': { startPeriod: '2021-01', endPeriod: '2025-12', rows: [calendarFive] },
  '10': { startPeriod: '2016-01', endPeriod: '2025-12', rows: [missing] },
  '20': { startPeriod: '2006-01', endPeriod: '2025-12', rows: [missing] },
  '30': { startPeriod: '1996-01', endPeriod: '2025-12', rows: [missing] },
  all: { startPeriod: null, endPeriod: null, independentPeriods: true, rows: [common] },
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/longhistory*', route => route.fulfill({ json: new URL(route.request().url()).searchParams.has('symbol')
    ? { schemaVersion: 1, generatedAt: 1, asset: { ...asset, performance: { '5': fiveYear, '10': performance, '20': performance, '30': performance, all: performance } }, points: monthly }
    : { schemaVersion: 1, generatedAt: 1, year: 2026, assets: [asset], comparisons: {
      all: ranges, china: ranges, usa: ranges, asia: ranges, assets: ranges,
    } } }));
});

test('historical route keeps navigation, year returns and exact chart pointer positions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('/history?asset=INX&scale=linear');
  await expect(page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: '收益', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: '收益分析视图' }).getByRole('button', { name: '历史' })).toHaveAttribute('aria-current', 'page');
  const chart = page.getByRole('img', { name: '标普500长期走势' });
  await expect(chart).toBeVisible();
  await expect(page.getByRole('table', { name: '标普500年度收益' })).toContainText('+20.00%');
  await chart.scrollIntoViewIfNeeded();
  const coordinates = await chart.evaluate(svg => {
    const target = svg as SVGSVGElement;
    const matrix = target.getScreenCTM()!;
    const point = target.createSVGPoint();
    point.x = 62;
    point.y = 180;
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(coordinates.x, coordinates.y);
  await expect(chart.locator('circle')).toHaveAttribute('cx', '62');
  const crosshair = chart.getByTestId('history-crosshair');
  await expect(crosshair.locator('line')).toHaveCount(2);
  const guides = await crosshair.locator('line').evaluateAll(lines => lines.map(line => ({
    x1: line.getAttribute('x1'), x2: line.getAttribute('x2'), y1: line.getAttribute('y1'), y2: line.getAttribute('y2'),
  })));
  expect(guides[0].x1).toBe(guides[0].x2);
  expect(guides[1].y1).toBe(guides[1].y2);
  await expect(chart).toBeFocused();
  await expect(chart).toHaveCSS('outline-style', 'none');
  await chart.focus();
  await page.keyboard.press('End');
  const selectedX = Number(await chart.locator('circle').getAttribute('cx'));
  expect(selectedX).toBeGreaterThan(200);
  await page.getByRole('button', { name: '对数', exact: true }).click();
  await expect(page).toHaveURL(/scale=log/);
  await page.reload();
  await expect(page.getByRole('button', { name: '对数', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('keyboard chart focus remains visible and history controls share the returns foundation', async ({ page }) => {
  await page.goto('/history');
  const linear = page.getByRole('button', { name: '线性', exact: true });
  await linear.click();
  await page.getByRole('button', { name: '对数', exact: true }).focus();
  await page.keyboard.press('Tab');
  const chart = page.getByRole('img', { name: '标普500长期走势' });
  await expect(chart).toBeFocused();
  await expect(chart).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Home');
  await expect(chart.locator('circle')).toHaveAttribute('cx', '62');
  const historyClass = await linear.getAttribute('class');
  expect(historyClass).toMatch(/segmentButton/);
  await expect(page.getByRole('region', { name: '长期历史' })).toContainText('当前月份不纳入');
  await expect(page.getByRole('region', { name: '长期历史' }).getByRole('link')).toHaveCount(0);
  await expect(page.getByText('长期走势与年度收益')).toHaveCount(0);
  await expect(page.getByText('历史数据加载中...')).toHaveCount(0);
});

test('opening history does not load live quotes or fund estimates', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/history');
  await expect(page.getByRole('table', { name: '标普500年度收益' })).toBeVisible();
  expect(requests.filter(url => /fundestimates|fundnav|fundhistory|marketreturns/.test(url))).toEqual([]);
  expect(requests.filter(url => url.includes('/api/dashboard')).every(url => new URL(url).searchParams.get('symbols') === '')).toBe(true);
});

test('company and history charts share their visual foundation and accessible point selection', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'mobile-chromium') await page.setViewportSize({ width: 320, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('/history?range=5');
  const history = page.getByRole('img', { name: '标普500长期走势' });
  await expect(history).toBeVisible();
  const historyStyle = await history.evaluate(svg => ({
    background: getComputedStyle(svg).backgroundColor,
    color: getComputedStyle(svg.querySelector('path')!).stroke,
    lineWidth: getComputedStyle(svg.querySelector('path')!).strokeWidth,
    labelSize: getComputedStyle(svg.querySelector('text')!).fontSize,
    labelColor: getComputedStyle(svg.querySelector('text')!).fill,
    height: svg.getBoundingClientRect().height,
  }));
  await page.goto('/companies?company=tencent');
  const chart = page.getByRole('img', { name: '腾讯营业收入趋势' });
  await expect(chart).toBeVisible();
  expect(await chart.evaluate(svg => ({
    background: getComputedStyle(svg).backgroundColor,
    color: getComputedStyle(svg.querySelector('path')!).stroke,
    lineWidth: getComputedStyle(svg.querySelector('path')!).strokeWidth,
    labelSize: getComputedStyle(svg.querySelector('text')!).fontSize,
    labelColor: getComputedStyle(svg.querySelector('text')!).fill,
    height: svg.getBoundingClientRect().height,
  }))).toEqual(historyStyle);
  expect(historyStyle.background).toBe('rgb(255, 255, 255)');
  await expect(chart).toHaveCSS('touch-action', 'pan-y');
  await expect(chart.locator('[tabindex]')).toHaveCount(0);
  await chart.scrollIntoViewIfNeeded();
  await chart.click({ position: { x: 75, y: 60 } });
  await expect(chart).toHaveCSS('outline-style', 'none');
  await chart.focus();
  await page.keyboard.press('Home');
  const reading = () => chart.evaluate(svg => svg.parentElement!.previousElementSibling!.textContent);
  const firstReading = await reading();
  const crosshair = chart.getByTestId('company-crosshair');
  await expect(crosshair.locator('line')).toHaveCount(2);
  const target = await chart.evaluate(svg => {
    const element = svg as SVGSVGElement;
    const guide = svg.querySelector('[data-testid="company-crosshair"] line')!;
    const point = element.createSVGPoint();
    point.x = Number(guide.getAttribute('x1')) + 1;
    point.y = 60;
    const screen = point.matrixTransform(element.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.keyboard.press('End');
  expect(await reading()).not.toBe(firstReading);
  if (testInfo.project.name === 'mobile-chromium') await page.touchscreen.tap(target.x, target.y);
  else await page.mouse.click(target.x, target.y);
  expect(await reading()).toBe(firstReading);
  await chart.focus();
  await page.keyboard.press('ArrowRight');
  expect(await reading()).not.toBe(firstReading);
  await page.keyboard.press('Tab');
  await expect(chart).not.toBeFocused();
  await expect(page.getByRole('button', { name: '季度', exact: true })).toHaveCSS('background-color', 'rgb(15, 23, 42)');
  for (const [first, last] of [['数值', '同比'], ['季度', '年度']]) {
    const left = await page.getByRole('button', { name: first, exact: true }).boundingBox();
    const right = await page.getByRole('button', { name: last, exact: true }).boundingBox();
    expect(Math.abs(left!.y - right!.y)).toBeLessThanOrEqual(1);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('company-shared-chart.png'), fullPage: true });
});

test('large lifetime returns do not overlap the annualized column on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('**/api/longhistory*', route => route.fulfill({ json: {
    schemaVersion: 1, year: 2026, assets: [{ ...asset, id: 'BTC', name: '比特币', group: 'assets', unit: 'USD' }], comparisons: { all: {
      all: { startPeriod: null, endPeriod: null, independentPeriods: true,
        rows: [{ ...performance, id: 'BTC', change: 116267514.73, cagr: 138.30, startClose: .0625, endClose: 1000000000.12 }] },
    } },
  } }));
  await page.goto('/history?view=change&range=all');
  const table = page.getByRole('table', { name: '区间涨幅' });
  await expect(table).toContainText('+116267514.73%');
  const overflow = await table.evaluate(table => [...table.querySelectorAll('td,th')]
    .filter(cell => cell.scrollWidth > cell.clientWidth + 1).map(cell => cell.textContent));
  expect(overflow).toEqual([]);
  const values = table.locator('tbody tr td:nth-child(5)');
  await expect(values).toHaveText('$0.0625 → 1,000,000,000.12');
  await expect(values).toHaveAttribute('title', '基准：2019-01；期末：2026-08；单位：美元 USD');
  expect(await values.locator('span span').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
  await table.getByRole('button', { name: '年化涨幅' }).click();
  await expect(table.getByRole('columnheader', { name: '年化涨幅' })).toHaveAttribute('aria-sort', 'descending');
});

test('comparison opens from the catalog, fits ranked columns and keeps the mobile toolbar in two rows', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'mobile-chromium') await page.setViewportSize({ width: 320, height: 844 });
  const historyRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/longhistory')) historyRequests.push(request.url()); });
  await page.goto('/history?view=change');
  const table = page.getByRole('table', { name: '区间涨幅' });
  await expect(table).toContainText(`+${common.change.toFixed(2)}%`);
  await expect(table.getByRole('columnheader')).toHaveText(['排名', '名称', '涨幅↓', '年化涨幅', '起止值', '区间']);
  await expect(table.locator('tbody tr td:nth-child(5)')).toHaveText('122 → 266 点');
  await expect(table.locator('tbody tr td:nth-child(5)')).toHaveAttribute('title', '基准：2019-12；期末：2025-12；单位：点');
  const valueLayout = await table.locator('tbody tr td:nth-child(5)').evaluate(cell => {
    const pair = cell.firstElementChild!;
    const [start, arrow, end] = [...pair.children].map(item => item.getBoundingClientRect());
    return {
      gaps: [arrow.left - start.right, end.left - arrow.right],
      width: pair.getBoundingClientRect().width,
      right: cell.getBoundingClientRect().right - parseFloat(getComputedStyle(cell).paddingRight) - end.right,
    };
  });
  for (const gap of valueLayout.gaps) expect(gap).toBeCloseTo(4, 0);
  expect(valueLayout.width).toBeLessThan(90);
  expect(Math.abs(valueLayout.right)).toBeLessThanOrEqual(1);
  await expect(table.locator('tbody tr').first().locator('td').first()).toHaveText('#1');
  await expect(page.getByRole('combobox', { name: '历史涨幅年度' })).toHaveCount(0);
  if (testInfo.project.name === 'mobile-chromium') {
    await expect(page.getByRole('combobox', { name: '历史时间区间' })).toHaveValue('all');
  } else {
    await expect(page.getByRole('group', { name: '走势范围' }).getByRole('button', { name: '全部', exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  expect(historyRequests.some(url => new URL(url).searchParams.has('symbol'))).toBe(false);
  const geometry = await page.getByRole('region', { name: '长期历史' }).evaluate(region => {
    const range = region.querySelector('[aria-label="走势范围"]')!.getBoundingClientRect();
    const modes = region.querySelector('[aria-label="历史视图"]')!.getBoundingClientRect();
    const groups = region.querySelector('[aria-label="历史资产类别"]')!.getBoundingClientRect();
    const table = region.querySelector('table')!;
    const cells = [...table.querySelectorAll('thead th')].map(cell => cell.getBoundingClientRect());
    const viewport = table.parentElement!.getBoundingClientRect();
    return { rangeRight: range.right, rangeTop: range.top, modesTop: modes.top, modesLeft: modes.left,
      groupsLeft: groups.left, groupsRight: groups.right, groupsBottom: groups.bottom,
      contentLeft: region.getBoundingClientRect().left + parseFloat(getComputedStyle(region).paddingLeft),
      contentRight: region.getBoundingClientRect().right - parseFloat(getComputedStyle(region).paddingRight),
      lastColumnRight: cells.at(-1)!.right, tableRight: table.getBoundingClientRect().right,
      thirdColumnRight: cells[2].right, viewportRight: viewport.right,
      overflowingCells: [...table.querySelectorAll('th,td')].filter(cell => cell.scrollWidth > cell.clientWidth + 1).map(cell => cell.textContent),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(Math.abs(geometry.rangeRight - geometry.contentRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.rangeTop - geometry.modesTop)).toBeLessThanOrEqual(1);
  expect(geometry.lastColumnRight).toBeLessThanOrEqual(geometry.tableRight + 1);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.overflowingCells).toEqual([]);
  await expect(page.getByLabel('涨幅统计区间')).toHaveCount(0);
  await expect(table.locator('tbody tr').first().locator('td').last()).toHaveText('2019-12 至 2025-12');
  if (testInfo.project.name === 'mobile-chromium') {
    expect(geometry.thirdColumnRight).toBeLessThanOrEqual(geometry.viewportRight + 1);
    const scroller = page.getByRole('region', { name: '涨幅表格', exact: true });
    const rowHeight = await table.locator('tbody tr').first().evaluate(row => row.getBoundingClientRect().height);
    expect(rowHeight).toBeLessThanOrEqual(50);
    await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    expect(await scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    const finalCell = await table.getByRole('columnheader', { name: '区间', exact: true }).boundingBox();
    expect(finalCell!.x + finalCell!.width).toBeLessThanOrEqual(geometry.viewportRight + 1);
    await scroller.evaluate(element => { element.scrollLeft = 0; });
    expect(Math.abs(geometry.groupsLeft - geometry.contentLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.groupsRight - geometry.contentRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.modesLeft - geometry.contentLeft)).toBeLessThanOrEqual(1);
    expect(geometry.modesTop - geometry.groupsBottom).toBeGreaterThanOrEqual(9);
  }
  await table.getByRole('button', { name: '涨幅', exact: true }).click();
  await expect(table.getByRole('columnheader', { name: '涨幅', exact: true })).toHaveAttribute('aria-sort', 'ascending');
  await table.getByRole('button', { name: '年化涨幅' }).click();
  await expect(table.getByRole('columnheader', { name: '年化涨幅' })).toHaveAttribute('aria-sort', 'descending');
  await table.getByRole('button', { name: '标普500' }).click();
  await expect(page.getByRole('img', { name: '标普500长期走势' })).toBeVisible();
  await page.getByRole('tab', { name: '涨幅' }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: '涨幅' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('table', { name: '区间涨幅' })).toBeVisible();
});

test('five-year selection survives reload and switches between rolling and full-calendar-year boundaries', async ({ page }, testInfo) => {
  const historyRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/longhistory')) historyRequests.push(request.url()); });
  await page.goto('/history');
  const chart = page.getByRole('img', { name: '标普500长期走势' });
  await expect(chart).toBeVisible();
  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('combobox', { name: '历史时间区间' }).selectOption('5');
  } else {
    await page.getByRole('button', { name: '近5年', exact: true }).click();
  }
  await expect(page).toHaveURL(/range=5/);
  await expect(page.getByText('2021-08 至 2026-08', { exact: true })).toBeVisible();
  await chart.focus();
  await page.keyboard.press('Home');
  await expect(page.getByText('2021-08', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '涨幅' }).click();
  const table = page.getByRole('table', { name: '区间涨幅' });
  await expect(table).toContainText(`+${calendarFive.change.toFixed(2)}%`);
  await expect(table).toContainText(`+${calendarFive.cagr.toFixed(2)}%`);
  await expect(table.locator('tbody tr td:nth-child(5)')).toHaveText('146 → 266 点');
  await expect(table.locator('tbody tr').first().locator('td').last()).toHaveText('2021-01 至 2025-12');
  expect(historyRequests).toHaveLength(2);
  await page.reload();
  await expect(page).toHaveURL(/range=5/);
  await expect(table).toContainText(`+${calendarFive.change.toFixed(2)}%`);
  await table.getByRole('button', { name: '标普500', exact: true }).click();
  await chart.focus();
  await page.keyboard.press('Home');
  await expect(page.getByText('2021-08', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/range=5/);
  await page.screenshot({ path: testInfo.outputPath('history-five-year.png'), fullPage: true });
});

test('ten and twenty year comparisons retain full calendar-year boundaries even with missing archives', async ({ page }, testInfo) => {
  await page.goto('/history?view=change&range=10');
  const table = page.getByRole('table', { name: '区间涨幅' });
  await expect(table.locator('tbody tr').first().locator('td').last()).toHaveText('2016-01 至 2025-12');
  await expect(table).toContainText('缺少区间起止月数据');
  await expect(table.getByText('#1', { exact: true })).toHaveCount(0);
  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('combobox', { name: '历史时间区间' }).selectOption('20');
  } else {
    await page.getByRole('button', { name: '近20年', exact: true }).click();
  }
  await expect(table.locator('tbody tr').first().locator('td').last()).toHaveText('2006-01 至 2025-12');
  await expect(page).toHaveURL(/range=20/);
});
