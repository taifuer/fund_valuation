import { expect, test } from '@playwright/test';
import { chooseRecentRange, expectRecentRange } from './controls';

function dashboardPayload(price: number, generatedAt: number) {
  return {
    schemaVersion: 1,
    generatedAt,
    quotes: {
      sh000001: {
        symbol: 'sh000001',
        price,
        previousClose: 3190,
        change: price - 3190,
        changePercent: ((price - 3190) / 3190) * 100,
        time: '2026-08-07 15:00:00',
        fetchedAt: generatedAt,
      },
    },
    quotesText: '',
    fxText: '',
    marketStates: {
      sh000001: {
        symbol: 'sh000001',
        market: 'cn',
        state: 'closed',
        source: 'test',
      },
    },
  };
}

for (const [path, activeLabel] of [['/', '概览'], ['/funds', '基金'], ['/returns', '走势'], ['/risk', '走势'], ['/companies', '公司'], ['/about', '关于']] as const) {
  test(`${path} survives direct navigation`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: '全球资产看板' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '页面切换' }).getByRole('button'))
      .toHaveText(['概览', '走势', '基金', '公司', '关于']);
    await expect(
      page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: activeLabel, exact: true }),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText('页面加载失败');
  });
}

test('company fundamentals are bundled offline and open a focused trend', async ({ page }) => {
  const companyApiRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/companies')) companyApiRequests.push(request.url());
  });

  await page.goto('/companies');
  await expect(page.getByRole('heading', { name: '公司经营趋势' })).toBeVisible();
  await expect(page.getByText(/北京时间/)).toHaveCount(0);
  const mobileCompanySelect = page.getByLabel('公司', { exact: true });
  if (await mobileCompanySelect.isVisible()) {
    await mobileCompanySelect.selectOption('apple');
  } else {
    await page.getByRole('button', { name: /美国/ }).click();
    await page.getByRole('group', { name: '美国公司' }).getByRole('button', { name: /苹果/ }).click();
  }
  await expect(page.getByRole('heading', { name: '苹果' })).toBeVisible();
  await expect(page.getByRole('img', { name: '苹果营业收入趋势' })).toBeVisible();
  expect(companyApiRequests).toEqual([]);
});

test('company report calendar keeps official events readable without a runtime data request', async ({ page }) => {
  const companyApiRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/companies')) companyApiRequests.push(request.url());
  });

  await page.goto('/companies?panel=calendar');
  await expect(page.getByRole('heading', { name: '财报日历' })).toBeVisible();
  await expect(page.getByRole('grid', { name: /财报日历/ })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '选择财报月份' })).toBeVisible();
  await expect(page.getByText('当月事项')).toBeVisible();
  await page.getByRole('combobox', { name: '选择财报月份' }).selectOption('2026-01');
  await expect(page.getByText('已披露').first()).toBeVisible();
  expect(companyApiRequests).toEqual([]);

  const pageGeometry = await page.locator('body').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(pageGeometry.scrollWidth).toBeLessThanOrEqual(pageGeometry.clientWidth + 1);
});

test('company trend chart fits narrow screens without internal horizontal scrolling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile chart behavior');

  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/companies?company=asml&metric=employees&period=annual');
  const chart = page.getByRole('img', { name: '阿斯麦员工人数趋势' });
  await expect(chart).toBeVisible();
  const geometry = await chart.evaluate((element) => {
    const parent = element.parentElement;
    return {
      chartWidth: element.getBoundingClientRect().width,
      parentWidth: parent?.getBoundingClientRect().width ?? 0,
      parentScrollWidth: parent?.scrollWidth ?? 0,
    };
  });
  expect(geometry.chartWidth).toBeLessThanOrEqual(geometry.parentWidth + 1);
  expect(geometry.parentScrollWidth).toBeLessThanOrEqual(geometry.parentWidth + 1);
  await expect(page.getByText(/FY2024 起员工口径纳入 ASML Berlin GmbH/)).toBeVisible();
});

test('company disclosure shows revenue in the initial mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/companies?company=samsung&period=quarterly');

  const table = page.getByRole('table', { name: '三星电子披露明细' });
  await expect(table).toBeVisible();
  const geometry = await table.evaluate((element) => {
    const scroller = element.parentElement;
    const revenueHeader = element.querySelectorAll('th')[2];
    const scrollerRect = scroller?.getBoundingClientRect();
    const revenueRect = revenueHeader?.getBoundingClientRect();
    return {
      scrollLeft: scroller?.scrollLeft ?? -1,
      scrollerRight: scrollerRect?.right ?? 0,
      revenueRight: revenueRect?.right ?? Number.POSITIVE_INFINITY,
      overflowingPeriods: [...element.querySelectorAll('tbody td:first-child')].filter(cell => cell.scrollWidth > cell.clientWidth + 1).length,
    };
  });

  expect(geometry.scrollLeft).toBe(0);
  expect(geometry.revenueRight).toBeLessThanOrEqual(geometry.scrollerRight + 1);
  expect(geometry.overflowingPeriods).toBe(0);
});

test('overview market groups have a consistent visible separation', async ({ page }) => {
  await page.goto('/');
  const toggles = page.getByRole('button', { name: /^[+-]\s*(A股|美股|亚太|资产|ETF)\s*·/ });
  await expect(toggles).toHaveCount(5);
  // Read all geometry in one frame; quote/font loading can move the page.
  const geometry = await toggles.evaluateAll(buttons => ({
    groups: buttons.map(button => ({ top: button.getBoundingClientRect().top,
      bottom: button.parentElement!.getBoundingClientRect().bottom })),
    footer: document.querySelector('footer')!.getBoundingClientRect().top,
  }));
  geometry.groups.slice(1).forEach((group, index) => {
    expect(group.top - geometry.groups[index].bottom).toBeGreaterThanOrEqual(20);
  });
  expect(geometry.footer - geometry.groups.at(-1)!.bottom).toBeGreaterThanOrEqual(32);
});

test('company choices wrap on narrow screens without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/companies');
  await page.getByLabel('地区筛选').getByRole('button', { name: /全部/ }).click();

  const companyOptions = page.getByRole('group', { name: '全部公司' });
  const geometry = await companyOptions.evaluate((element) => {
    const rowPositions = Array.from(element.children).map((child) => Math.round(child.getBoundingClientRect().top));
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      rows: new Set(rowPositions).size,
    };
  });

  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.rows).toBeGreaterThan(1);
});

test('performance subpages keep their routes while sharing one primary entry', async ({ page }) => {
  await page.goto('/returns');
  const viewNav = page.getByRole('navigation', { name: '走势分析视图' });
  await expect(viewNav.getByRole('button', { name: '近期' })).toHaveAttribute('aria-current', 'page');
  await expect(viewNav.getByRole('button')).toHaveCount(2);
  await viewNav.getByRole('button', { name: '长期' }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(viewNav.getByRole('button', { name: '长期' })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(viewNav.getByRole('button', { name: '近期' })).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(viewNav.getByRole('button', { name: '长期' })).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: '走势', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('mobile pages keep wide data tables inside local scrollers', async ({ page }) => {
  for (const path of ['/returns', '/risk', '/companies']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    expect(overflow, `${path} page overflow`).toBeLessThanOrEqual(1);
  }
});

test('market metadata has balanced spacing and a stable loading slot', async ({ page }) => {
  for (const path of ['/', '/funds', '/returns', '/risk']) {
    await page.goto(path);
    await expect(page.getByText(/北京时间/)).toBeVisible();
    const selector = path === '/' ? '[class*="_sectionToggle_"]'
      : path === '/funds' ? '[class*="_fundToolbar_"]' : '[aria-label="走势分析视图"]';
    await expect(page.locator(selector).first()).toBeVisible();
    const geometry = await page.evaluate(selector => {
      const header = document.querySelector('header')!.getBoundingClientRect();
      const time = document.querySelector('[class*="_datetime_"]')!.getBoundingClientRect();
      const fx = document.querySelector('[class*="_fxRow_"]')!.getBoundingClientRect();
      const content = document.querySelector(selector)!;
      const before = content.getBoundingClientRect().top;
      document.querySelector('[class*="_statusMessage_"]')!.textContent = '行情数据加载中...';
      return {
        top: time.top - header.bottom,
        bottom: before - fx.bottom,
        shift: content.getBoundingClientRect().top - before,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    }, selector);
    expect(geometry.top, `${path} top spacing`).toBe(20);
    expect(geometry.bottom, `${path} bottom spacing`).toBe(20);
    expect(geometry.shift, `${path} loading shift`).toBe(0);
    expect(geometry.overflow, `${path} overflow`).toBeLessThanOrEqual(1);
  }
});

test('mobile navigation keeps the active style after client-side navigation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile navigation behavior');

  await page.goto('/');
  const primaryNavigation = page.getByRole('navigation', { name: '页面切换' });
  const performanceButton = primaryNavigation.getByRole('button', { name: '走势', exact: true });
  await performanceButton.click();
  await expect(page).toHaveURL(/\/returns$/);
  await expect(performanceButton).toHaveAttribute('aria-current', 'page');
  const backgroundAfterClick = await performanceButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  await page.reload();
  const reloadedButton = page
    .getByRole('navigation', { name: '页面切换' })
    .getByRole('button', { name: '走势', exact: true });
  await expect(reloadedButton).toHaveAttribute('aria-current', 'page');
  const backgroundAfterReload = await reloadedButton.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  expect(backgroundAfterClick).toBe('rgb(15, 23, 42)');
  expect(backgroundAfterReload).toBe(backgroundAfterClick);
});

for (const returnVia of ['navigation', 'brand'] as const) {
  test(`returning to overview via ${returnVia} keeps cached market cards visible`, async ({ page }) => {
    let holdRefresh = false;
    let refreshRequested = false;
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    await page.route('**/api/dashboard?*', async (route) => {
      const isRefresh = holdRefresh;
      if (isRefresh) {
        refreshRequested = true;
        await refreshGate;
      }
      await route.fulfill({
        json: isRefresh
          ? dashboardPayload(3210, 200)
          : dashboardPayload(3200, 100),
      });
    });

    await page.goto('/');
    const navigation = page.getByRole('navigation', { name: '页面切换' });
    const shanghaiCard = page.getByRole('button').filter({ hasText: '上证指数' }).first();
    await expect(shanghaiCard).toContainText('3,200');

    await navigation.getByRole('button', { name: '基金', exact: true }).click();
    await expect(page).toHaveURL(/\/funds\?strategy=active$/);
    holdRefresh = true;
    if (returnVia === 'navigation') {
      await navigation.getByRole('button', { name: '概览', exact: true }).click();
    } else {
      await page.getByRole('button', { name: '全球资产看板', exact: true }).click();
    }
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => refreshRequested).toBe(true);

    await expect(shanghaiCard).toContainText('3,200');
    releaseRefresh();
    await expect(shanghaiCard).toContainText('3,210');
  });
}

test('overview loads only market data and funds load after navigating to their page', async ({ page }) => {
  const requests: URL[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/')) requests.push(new URL(request.url()));
  });
  await page.route('**/api/dashboard?*', route => {
    return route.fulfill({ json: dashboardPayload(3200, 100) });
  });

  await page.goto('/');
  const shanghaiCard = page.getByRole('button').filter({ hasText: '上证指数' }).first();
  await expect(shanghaiCard).toContainText('3,200');
  await expect(page.locator('button[aria-label^="查看 "][aria-label$=" 详情"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看估值', exact: true })).toHaveCount(0);
  const refresh = page.waitForResponse(response => response.url().includes('/api/dashboard?'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refresh;
  expect(requests.filter(url => /^\/api\/(fund|overview)/.test(url.pathname))).toEqual([]);
  expect(requests.some(url => url.searchParams.has('fundCodes'))).toBe(false);

  await page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: '基金', exact: true }).click();
  await expect(page.getByRole('heading', { name: /QDII 基金 · 16/ })).toBeVisible();
  await expect.poll(() => requests.some(url => url.pathname === '/api/fundestimates')).toBe(true);
  await page.locator('#fund-004877').getByRole('button', { name: /展开详情/ }).click();

  await expect(page).toHaveURL(/\/funds\/004877\?strategy=active$/);
  await expect(page.locator('#fund-004877 [aria-expanded="true"]')).toBeVisible();
  await expect(page.locator('#fund-004877')).not.toContainText('仅官方净值');
});

test('fund page has a non-collapsible title and strategy filters', async ({ page }) => {
  await page.goto('/funds');

  await expect(page.getByRole('heading', { name: /QDII 基金 · 16/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /QDII 基金/ })).toHaveCount(0);
  await expect(page.getByRole('group', { name: '基金类型筛选' })).toBeVisible();
  await expect(page.locator('#fund-004877')).toContainText('汇添富全球医疗');
});

test('mobile return and risk tables keep every column in a horizontal scroller', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'Mobile table behavior');

  for (const width of [320, 360, 375, 390, 430]) {
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
        const fifthRect = element.nextElementSibling?.getBoundingClientRect();
        return {
          fifthStartsOutside: Boolean(scrollerRect && fifthRect && fifthRect.left >= scrollerRect.right - 1),
          fourthFits: Boolean(scrollerRect && element.getBoundingClientRect().right <= scrollerRect.right + 1),
        };
      });
      await expect(thirdHeader).toBeVisible();
      expect(primaryViewport).toEqual({ fifthStartsOutside: true, fourthFits: true });

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

test('old risk links open recent performance with return and value before risk metrics', async ({ page }) => {
  await page.goto('/risk');
  const headerCells = page.locator('table thead th');
  await expect(page).toHaveURL(/\/returns\?range=ytd&sort=drawdown$/);
  await expect(headerCells).toHaveCount(10);
  const headers = await headerCells.allTextContents();
  expect(headers.map((header) => header.trim().replace(/[↑↓]/g, '').trim())).toEqual([
    '排名',
    '名称',
    '涨跌幅',
    '现值',
    '回撤',
    '收益回撤比',
    '胜率',
    '状态',
    '分类',
    '截至',
  ]);
});

test('legacy risk links preserve largest drawdown sorting and reset it for latest quotes', async ({ page }) => {
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
  const drawdownCells = page.locator('table tbody tr td:nth-child(5)');
  await expect(drawdownCells.first()).toBeVisible();
  const drawdowns = (await drawdownCells.allTextContents())
    .map((value) => Math.abs(Number.parseFloat(value)))
    .filter(Number.isFinite);
  expect(drawdowns).toEqual([12, 8, 5]);
  await chooseRecentRange(page, 'today', '最新');
  await expect(page.getByRole('button', { name: '涨跌幅 ↓', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader')).toHaveCount(7);
  await expect(page).toHaveURL(/\/returns$/);
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
      expect(widths.name).toBeLessThanOrEqual(141);
    } else {
      expect(widths.name / widths.table).toBeLessThanOrEqual(0.205);
    }
  }
});

test('return and risk filters survive direct navigation and reload', async ({ page }) => {
  await page.goto('/returns?category=etf&etf=sector&range=1y&sort=value&order=asc');
  await expect(page.getByLabel('分类筛选').getByRole('button', { name: 'ETF', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('ETF类型筛选').getByRole('button', { name: '行业ETF' })).toHaveAttribute('aria-pressed', 'true');
  await expectRecentRange(page, '1y', '近1年');
  await expect(page).toHaveURL(/sort=value&order=asc/);
  await page.reload();
  await expect(page.getByLabel('ETF类型筛选').getByRole('button', { name: '行业ETF' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/risk?category=asset&range=1m&sort=winRate&order=asc');
  await expect(page.getByLabel('分类筛选').getByRole('button', { name: '资产' })).toHaveAttribute('aria-pressed', 'true');
  await expectRecentRange(page, '1m', '近1月');
  await expect(page).toHaveURL(/\/returns\?/);
  await expect(page).toHaveURL(/sort=winRate&order=asc/);
  await page.reload();
  await expect(page.getByRole('columnheader', { name: /胜率/ })).toHaveAttribute('aria-sort', 'ascending');
});

test('diagnostics route stays hidden from primary navigation and requires a token', async ({ page }) => {
  await page.goto('/diagnostics');
  await expect(page.getByRole('heading', { name: '运行诊断' })).toBeVisible();
  await expect(page.getByLabel('诊断令牌')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '页面切换' })).not.toContainText('诊断');
});

test('fund manager opens as a dialog and closes with Escape', async ({ page }) => {
  await page.route('**/api/meta', route => route.fulfill({ json: {
    apiSchemaVersion: 1, dashboardSchemaVersion: 1, fundManagementMode: 'open',
  } }));
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
