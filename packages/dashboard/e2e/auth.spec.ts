import { expect, test } from '@playwright/test';

test('an unauthenticated visitor is redirected to /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to DataGoat' })).toBeVisible();
});

test('the mock password opens the dashboard shell', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('a wrong password shows an error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toHaveText('Incorrect password.');
  await expect(page).toHaveURL(/\/login$/);
});

test('signing out returns to /login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.locator('.account-menu summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page).toHaveURL(/\/login$/);
});
