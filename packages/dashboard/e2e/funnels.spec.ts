import { expect, type Page, test } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test('shows funnel results for a selected funnel', async ({ page }) => {
  await signIn(page);
  await page.goto('/funnels?funnel=fun_1');

  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  await expect(page.locator('.funnel-chart canvas')).toBeVisible();
  await expect(page.getByText('Total visitors')).toBeVisible();
  await expect(page.getByText('Total conversion')).toBeVisible();
  await expect(
    page
      .locator('.funnel-step-table')
      .getByRole('rowheader', { name: 'View pricing', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.funnel-step-table').getByRole('rowheader', { name: 'Payment', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.funnel-step-table').getByText('$5,311')).toBeVisible();
});

test('shows an error for an unknown funnel', async ({ page }) => {
  await signIn(page);
  await page.goto('/funnels?funnel=fun_missing');

  await expect(page.getByText('Cannot load funnel')).toBeVisible();
});

test('prompts for a funnel when none is selected', async ({ page }) => {
  await signIn(page);
  await page.goto('/funnels');

  await expect(page.getByText('No funnel selected')).toBeVisible();
});
