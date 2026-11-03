import { expect, type Page, test } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test('shows KPI values from the overview endpoint', async ({ page }) => {
  await signIn(page);

  await expect(page.getByText('12,840')).toBeVisible();
  await expect(page.getByText('$5,311')).toBeVisible();
  await expect(page.getByText('42.0%')).toBeVisible();
});

test('the period preset writes the range to the URL', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('12,840')).toBeVisible();

  await page.getByRole('button', { name: 'Last 30 days' }).click();

  await expect(page).toHaveURL(/startAt=\d{4}-\d{2}-\d{2}/);
  await expect(page).toHaveURL(/endAt=\d{4}-\d{2}-\d{2}/);
  await expect(page.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the compare toggle shows delta chips', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('12,840')).toBeVisible();

  await page.getByLabel('Compare to previous').check();

  await expect(page).toHaveURL(/compare=previous/);
  await expect(page.getByText('+7.7%')).toBeVisible();
});

test('renders the timeseries chart with a data-table fallback', async ({ page }) => {
  await signIn(page);

  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Timeseries values' })).toBeAttached();
});
