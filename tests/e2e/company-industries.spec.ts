import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
});

test('company industries combine with regions and search without fetching new data', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const companyRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/api/companies')) companyRequests.push(request.url());
  });
  await page.goto('/companies');
  const industry = page.getByRole('combobox', { name: '行业筛选' });
  const regions = page.getByLabel('地区筛选', { exact: true });
  const search = page.getByRole('searchbox', { name: '搜索公司' });
  await expect(industry).toHaveValue('all');
  await expect(industry.locator('option:checked')).toHaveText('全部行业');
  await expect(regions.getByRole('button', { name: /美国/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Adobe', exact: true })).toBeVisible();
  await industry.selectOption('semiconductors');
  await expect(industry.locator('option:checked')).toHaveText('半导体 · 8');
  await expect(page.getByRole('group', { name: '美国公司' }).getByRole('button')).toHaveCount(8);
  await regions.getByRole('button', { name: /全部/ }).click();
  await expect(industry.locator('option:checked')).toHaveText('半导体 · 14');
  await expect(page.getByRole('group', { name: '全部公司' }).getByRole('button')).toHaveCount(14);
  await search.fill('QCOM');
  await expect(industry.locator('option:checked')).toHaveText('半导体 · 1');
  await page.getByRole('button', { name: '高通', exact: true }).click();
  await expect(search).toHaveValue('QCOM');
  await expect(page.getByRole('heading', { name: '高通', exact: true })).toBeVisible();
  await page.reload();
  await expect(industry).toHaveValue('semiconductors');
  await expect(search).toHaveValue('QCOM');
  await expect(regions.getByRole('button', { name: /全部/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: '高通', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: '页面切换' });
  await navigation.getByRole('link', { name: '关于', exact: true }).click();
  await navigation.getByRole('link', { name: '公司', exact: true }).click();
  await expect(industry).toHaveValue('semiconductors');
  await expect(search).toHaveValue('QCOM');
  await regions.getByRole('button', { name: /中国/ }).click();
  await expect(page.getByText('未找到匹配公司')).toBeVisible();
  await expect(page.locator('#company-trend-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(industry).toHaveValue('all');
  await expect(search).toHaveValue('');
  await expect(page.getByRole('group', { name: '全部公司' }).getByRole('button')).toHaveCount(52);
  await page.screenshot({ path: testInfo.outputPath('company-industry-reset.png') });
  expect(errors).toEqual([]);
  expect(companyRequests).toEqual([]);
});

test('industry and search controls align, fit their labels and retain touch and keyboard contrast', async ({ page, isMobile }, testInfo) => {
  await page.goto('/companies?region=all&industry=internet&company=tencent');
  const industry = page.getByRole('combobox', { name: '行业筛选' });
  const search = page.getByRole('searchbox', { name: '搜索公司' });
  const regions = page.getByLabel('地区筛选', { exact: true });
  await expect(page.getByRole('heading', { name: '腾讯', exact: true })).toBeVisible();
  for (const width of isMobile ? [320, 390, 720] : [768, 820, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    const box = (await industry.boundingBox())!;
    const searchBox = (await search.boundingBox())!;
    const regionBox = (await regions.boundingBox())!;
    expect(box.height).toBe(width <= 720 ? 40 : 32);
    expect(searchBox.height).toBe(box.height);
    expect(regionBox.height).toBe(box.height);
    expect(searchBox.y).toBe(box.y);
    expect(searchBox.x - box.x - box.width).toBe(8);
    expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(width);
    if (width <= 800) expect(box.y).toBeGreaterThanOrEqual(regionBox.y + regionBox.height);
    else expect(box.y).toBe(regionBox.y);
    const clipped = await industry.evaluate(element => {
      const select = element as HTMLSelectElement;
      const style = getComputedStyle(select);
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return [...select.options].some(option => context.measureText(option.text).width > available);
    });
    expect(clipped).toBe(false);
    await expect(industry).toHaveCSS('font-size', '12px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`company-industry-${width}.png`) });
  }
  if (isMobile) await industry.tap();
  else await industry.click();
  await page.keyboard.press('Escape');
  await industry.selectOption('software');
  await expect(industry).toHaveCSS('outline-style', 'none');
  await expect(industry).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
  await expect(industry).toHaveCSS('color', 'rgb(30, 41, 59)');
  await page.keyboard.press('ArrowDown');
  await expect(industry).toHaveCSS('outline-width', '2px');
  await expect(industry).toHaveCSS('outline-style', 'solid');
});
