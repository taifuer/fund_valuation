import { expect, type Page } from '@playwright/test';

export async function chooseRecentRange(page: Page, key: string, label: string) {
  const select = page.getByRole('combobox', { name: '近期时间区间' });
  if (await select.isVisible()) await select.selectOption(key);
  else await page.getByLabel('表现区间').getByRole('button', { name: label, exact: true }).click();
}

export async function expectRecentRange(page: Page, key: string, label: string) {
  const select = page.getByRole('combobox', { name: '近期时间区间' });
  if (await select.isVisible()) await expect(select).toHaveValue(key);
  else await expect(page.getByLabel('表现区间').getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
}
