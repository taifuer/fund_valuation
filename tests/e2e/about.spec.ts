import { expect, test } from '@playwright/test';

test('about and company pages share heading typography, gutters and header spacing', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const marketRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/api\/(dashboard|overview|fundnav|fundestimates|marketreturns)/.test(request.url())) marketRequests.push(request.url());
  });
  let expected: unknown;
  for (const [path, title] of [['/about', '关于本站'], ['/companies', '公司经营趋势']]) {
    await page.goto(path);
    const heading = page.getByRole('heading', { name: title, exact: true });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS('font-size', '20px');
    await expect(heading).toHaveCSS('color', 'rgb(30, 41, 59)');
    await expect(page.getByText(/北京时间/)).toHaveCount(0);
    const layout = await heading.evaluate(element => {
      const main = element.closest('main')!;
      const rect = element.getBoundingClientRect();
      const siteHeader = document.querySelector('header')!.getBoundingClientRect();
      const brand = document.querySelector('h1')!.closest('[class*="_brand_"]')!.getBoundingClientRect();
      return {
        topGap: rect.top - siteHeader.bottom,
        leftOffset: rect.left - brand.left,
        mainWidth: main.getBoundingClientRect().width,
        font: getComputedStyle(element).font,
      };
    });
    expect(layout.topGap).toBe(page.viewportSize()!.width <= 640 ? 20 : 28);
    expect(layout.leftOffset).toBe(0);
    if (expected) expect(layout).toEqual(expected);
    expected = layout;
    await page.screenshot({ path: testInfo.outputPath(`${path.slice(1)}-shared-heading.png`) });
  }
  expect(marketRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('about text and links stay readable across narrow and intermediate widths', async ({ page }, testInfo) => {
  for (const width of [320, 390, 640, 720]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/about');
    const main = page.getByRole('main', { name: '关于本站' });
    await expect(main).toBeVisible();
    for (const selector of ['section > p', 'dd', 'li p']) {
      await expect(main.locator(selector).first()).toHaveCSS('font-size', '14px');
      await expect(main.locator(selector).first()).toHaveCSS('color', 'rgb(30, 41, 59)');
    }
    await expect(main.locator('time').first()).toHaveCSS('font-size', '12px');
    const layout = await main.evaluate(element => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      textOverflow: [...element.querySelectorAll('p, dd, h2, h3, h4')]
        .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent),
      contentWidth: element.querySelector('section > p')!.getBoundingClientRect().width,
      innerWidth: element.clientWidth - parseFloat(getComputedStyle(element).paddingLeft) - parseFloat(getComputedStyle(element).paddingRight),
    }));
    expect(layout.overflow).toBe(0);
    expect(layout.textOverflow).toEqual([]);
    expect(layout.contentWidth).toBe(layout.innerWidth);
    const source = main.getByRole('link', { name: 'GitHub · fund_valuation' });
    await source.focus();
    await expect(source).toHaveCSS('outline-style', 'solid');
    await expect(source).toHaveAttribute('rel', 'noreferrer');
    await expect(main.getByRole('link', { name: 'taifu@taifua.com' })).toHaveAttribute('href', 'mailto:taifu@taifua.com');
    await page.screenshot({ path: testInfo.outputPath(`about-${width}.png`), fullPage: true });
  }
});
