import { expect, type Page, test } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

function goalRow(page: Page, name: string) {
  return page.locator('.goal-table').getByRole('rowheader', { name, exact: true });
}

test('shows goal rows and completion totals', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Goals' }).click();

  await expect(page).toHaveURL(/\/goals/);
  await expect(goalRow(page, 'signup')).toBeVisible();
  await expect(goalRow(page, 'payment')).toBeVisible();
  await expect(page.getByText('482')).toBeVisible();
  await expect(page.getByText('$5,311')).toBeVisible();
});

test('paginates the goals table', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Goals' }).click();
  await expect(goalRow(page, 'signup')).toBeVisible();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();

  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect(goalRow(page, 'signup')).toHaveCount(0);
  await expect(goalRow(page, 'goal_25')).toBeVisible();
});
