import { expect, test, type Locator } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/meta') return route.fulfill({ json: {
      apiSchemaVersion: 1, dashboardSchemaVersion: 1, fundManagementMode: 'open',
    } });
    if (path === '/api/longhistory') return route.fulfill({ json: {
      schemaVersion: 1, generatedAt: 1, year: 2026, assets: [], comparisons: {},
    } });
    return route.fulfill({ json: {} });
  });
});

async function expectSelected(button: Locator) {
  await expect(button).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(button).toHaveCSS('background-color', 'rgb(15, 23, 42)');
}

test('company selections keep contrast after touch, hover, keyboard and page changes', async ({ page, isMobile }, testInfo) => {
  await page.goto('/companies');
  const regions = page.getByLabel('地区筛选', { exact: true });
  const selected = regions.getByRole('button', { name: /美国/ });
  if (isMobile) await selected.tap();
  else await selected.click();
  await expectSelected(selected);
  await selected.hover();
  await expectSelected(selected);
  const company = page.getByRole('group', { name: '美国公司' }).getByRole('button', { name: '苹果', exact: true });
  if (isMobile) await company.tap();
  else await company.click();
  await expect(company).toHaveCSS('color', 'rgb(30, 41, 59)');
  await expect(company).toHaveCSS('background-color', 'rgb(241, 245, 249)');
  await company.hover();
  await expect(company).toHaveCSS('background-color', 'rgb(241, 245, 249)');
  await selected.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(selected).toBeFocused();
  await expect(selected).toHaveCSS('outline-style', 'solid');
  await expectSelected(selected);
  await page.screenshot({ path: testInfo.outputPath('company-controls.png') });
  await page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: '走势', exact: true }).click();
  await page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: '公司', exact: true }).click();
  await expectSelected(regions.locator('[aria-pressed="true"]'));
});

test('filters and date controls share dimensions across routes and breakpoints', async ({ page, isMobile }, testInfo) => {
  for (const width of isMobile ? [320, 390, 680, 720] : [800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const height = width <= 720 ? 40 : 32;
    async function controlsFit(selectors: string[]) {
      for (const selector of selectors) {
        const control = page.locator(selector);
        await expect(control).toBeVisible();
        expect((await control.boundingBox())!.height, `${selector} at ${width}px`).toBe(height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    await page.goto('/companies');
    await controlsFit(['[aria-label="地区筛选"]', '[aria-label="趋势口径"]', '[aria-label="趋势周期"]', 'input[type="search"]']);
    await page.getByRole('button', { name: '财报日历', exact: true }).click();
    await controlsFit(['select[aria-label="选择财报月份"]', '[aria-label="月份切换"]']);
    const month = page.getByRole('combobox', { name: '选择财报月份' });
    await expect(month).toHaveCSS('width', '172px');
    const clipped = await month.evaluate(element => {
      const select = element as HTMLSelectElement;
      const style = getComputedStyle(select);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d')!;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return [...select.options].some(option => context.measureText(option.text).width > available);
    });
    expect(clipped).toBe(false);
    await expectSelected(page.getByRole('button', { name: '本月', exact: true }));
    await page.screenshot({ path: testInfo.outputPath(`calendar-controls-${width}.png`) });
    for (const [category, label] of [['etf', 'ETF类型筛选'], ['fund', '基金类型筛选']]) {
      await page.goto(`/returns?category=${category}`);
      await controlsFit(['[aria-label="分类筛选"]', `[aria-label="${label}"]`,
        width <= 720 ? '[aria-label="近期时间区间"]' : '[aria-label="表现区间"]']);
      await page.screenshot({ path: testInfo.outputPath(`recent-${category}-${width}.png`) });
    }
    await page.goto('/history');
    await controlsFit(['[aria-label="历史资产类别"]', '[aria-label="历史视图"]',
      width <= 720 ? '[aria-label="历史时间区间"]' : '[aria-label="走势范围"]']);
    await page.goto('/funds');
    await controlsFit(['[aria-label="基金类型筛选"]', '[aria-label="基金排序方式"]', 'button[aria-label="管理基金"]']);
    await page.screenshot({ path: testInfo.outputPath(`fund-controls-${width}.png`) });
    await page.getByRole('button', { name: '管理基金', exact: true }).click();
    const manager = page.getByRole('dialog', { name: '管理基金', exact: true });
    await expect(manager.getByPlaceholder('基金代码或基金名称')).toHaveCSS('height', '40px');
    await expect(manager.getByPlaceholder('基金代码或基金名称')).toHaveCSS('font-size', '13px');
    expect((await manager.getByRole('button', { name: '添加', exact: true }).boundingBox())!.height).toBe(40);
    await expectSelected(manager.getByRole('button', { name: '添加', exact: true }));
    await page.keyboard.press('Escape');
  }
});

test('calendar month selection uses the shared touch and keyboard focus treatment', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Native touch picker');
  await page.goto('/companies?panel=calendar');
  const select = page.getByRole('combobox', { name: '选择财报月份' });
  await expect(select).toHaveCSS('font-size', '12px');
  await select.tap();
  await page.keyboard.press('Escape');
  await select.selectOption('2026-01');
  await expect(select).toHaveCSS('outline-style', 'none');
  await expect(select).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
  await page.keyboard.press('ArrowDown');
  await expect(select).toHaveCSS('outline-width', '2px');
  await expect(select).toHaveCSS('outline-style', 'solid');
});

test('page headings and content retain the same gutters at intermediate widths', async ({ page, isMobile }) => {
  for (const width of isMobile ? [320, 640, 680, 720] : [800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const expectedLeft = Math.max(0, (width - 1040) / 2) + (width <= 720 ? 12 : 16);
    for (const [route, title, content] of [
      ['/companies', '公司经营趋势', '[aria-label="公司选择"]'],
      ['/returns', '资产走势', '[aria-label="分类筛选"]'],
      ['/history', '资产走势', '[aria-label="历史资产类别"]'],
      ['/funds', 'QDII 基金', '[aria-label="基金类型筛选"]'],
      ['/about', '关于本站', 'main section'],
      ['/diagnostics', '运行诊断', 'input[aria-label="诊断令牌"]'],
    ]) {
      await page.goto(route);
      const heading = page.getByRole('heading', { name: title, exact: true });
      await expect(heading).toBeVisible();
      await expect(heading).toHaveCSS('font-size', '20px');
      expect((await heading.boundingBox())!.x).toBe(expectedLeft);
      if (route !== '/diagnostics') expect((await page.locator(content).first().boundingBox())!.x).toBe(expectedLeft);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    // Password inputs do not expose a textbox role.
    const token = page.getByLabel('诊断令牌', { exact: true });
    await expect(token).toHaveCSS('height', width <= 720 ? '40px' : '32px');
    await expect(page.getByRole('button', { name: '查询', exact: true })).toHaveCSS('min-height', width <= 720 ? '40px' : '32px');
    await token.focus();
    await expect(token).toHaveCSS('border-color', 'rgb(100, 116, 139)');
  }
});

test('fund details, pagination and chart ranges share the same control foundation', async ({ page, isMobile }, testInfo) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 900 });
  await page.route('**/api/fundestimates*', route => route.fulfill({ json: {
    schemaVersion: 1, generatedAt: Date.now(), fxText: '', marketStates: {},
    cards: { '270042': { official: { code: '270042', navDate: '2026-09-21', nav: 2.1234, officialChange: 1 }, estimate: null } },
  } }));
  await page.route('**/api/fundhistory*', route => route.fulfill({ json: { '270042': Array.from({ length: 20 }, (_, i) => ({
    FSRQ: `2026-09-${String(21 - i).padStart(2, '0')}`, DWJZ: '2.1234', JZZZL: '1',
  })) } }));
  await page.goto('/funds?strategy=index');
  const card = page.locator('#fund-270042');
  await card.getByRole('button', { name: /展开详情/ }).click();
  const tabs = card.getByRole('group', { name: '基金详情视图' });
  const height = isMobile ? 40 : 32;
  await expect(tabs).toBeVisible();
  expect((await tabs.boundingBox())!.height).toBe(height);
  await expectSelected(tabs.getByRole('button', { name: '净值', exact: true }));
  const previous = card.getByRole('button', { name: '上一页', exact: true });
  const next = card.getByRole('button', { name: '下一页', exact: true });
  await expect(previous).toBeDisabled();
  expect((await next.boundingBox())!.height).toBe(height);
  await expect(next).toHaveCSS('font-size', '12px');
  await next.click();
  await expect(previous).toBeEnabled();
  await tabs.getByRole('button', { name: '走势', exact: true }).click();
  const ranges = card.getByLabel('历史净值区间', { exact: true });
  await expect(ranges).toBeVisible();
  await expect(ranges.getByRole('button').first()).toHaveCSS('min-width', '38px');
  await expect(ranges.getByRole('button').first()).toHaveCSS('min-height', `${height - 6}px`);
  await expectSelected(ranges.locator('[aria-pressed="true"]'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('fund-details-controls.png') });
});

test('history dialogs keep explicit icon and range sizes after lazy page navigation', async ({ page, isMobile }) => {
  await page.goto('/companies');
  await page.getByRole('navigation', { name: '页面切换' }).getByRole('button', { name: '走势', exact: true }).click();
  await page.getByRole('button', { name: '上证指数走势', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: '关闭', exact: true });
  await expect(close).toHaveCSS('font-size', '22px');
  await expect(close).toHaveCSS('height', isMobile ? '40px' : '32px');
  const ranges = dialog.getByLabel('历史行情区间', { exact: true });
  await expect(ranges.getByRole('button').first()).toHaveCSS('min-width', '38px');
  await expectSelected(ranges.locator('[aria-pressed="true"]'));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(close).toHaveCSS('outline-color', 'rgb(100, 116, 139)');
});
