import { expect, type Page, test } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

function rowheader(page: Page, name: string) {
  return page.locator('.source-table').getByRole('rowheader', { name, exact: true });
}

test('shows the source tabs, chart, and referrers table', async ({ page }) => {
  await signIn(page);

  await expect(page.getByRole('tab', { name: 'Referrers' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.source-chart canvas')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Top Referrers by visitors' })).toBeAttached();
  await expect(rowheader(page, 'google.com')).toBeVisible();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
});

test('switches dimension tabs', async ({ page }) => {
  await signIn(page);
  await expect(rowheader(page, 'google.com')).toBeVisible();

  await page.getByRole('tab', { name: 'Pages' }).click();

  await expect(page).toHaveURL(/tab=pages/);
  await expect(page.getByRole('tab', { name: 'Pages' })).toHaveAttribute('aria-selected', 'true');
  await expect(rowheader(page, '/pricing')).toBeVisible();
  await expect(rowheader(page, 'google.com')).toHaveCount(0);
});

test('paginates the source table', async ({ page }) => {
  await signIn(page);
  await page.getByRole('tab', { name: 'Pages' }).click();
  await expect(rowheader(page, '/pricing')).toBeVisible();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();

  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect(rowheader(page, '/pricing')).toHaveCount(0);
  await expect(rowheader(page, '/templates')).toBeVisible();
});

test('filters pages by path', async ({ page }) => {
  await signIn(page);
  await page.getByRole('tab', { name: 'Pages' }).click();
  await expect(rowheader(page, '/pricing')).toBeVisible();

  await page.getByLabel('Filter by path').fill('/blog');

  await expect(page).toHaveURL(/path=%2Fblog/);
  await expect(rowheader(page, '/blog')).toBeVisible();
  await expect(rowheader(page, '/blog/analytics-guide')).toBeVisible();
  await expect(rowheader(page, '/pricing')).toHaveCount(0);
  await expect(page.getByText('Page 1 of 1')).toBeVisible();
});

test('sorts the loaded page by a column', async ({ page }) => {
  await signIn(page);
  await expect(rowheader(page, 'google.com')).toBeVisible();

  const pageviewsHeader = page
    .locator('.source-table')
    .getByRole('columnheader', { name: 'Pageviews' });
  await pageviewsHeader.getByRole('button').click();
  await expect(pageviewsHeader).toHaveAttribute('aria-sort', 'descending');

  await pageviewsHeader.getByRole('button').click();
  await expect(pageviewsHeader).toHaveAttribute('aria-sort', 'ascending');
});

test('switches websites and persists the selection', async ({ page }) => {
  await signIn(page);

  await page.getByLabel('Website').selectOption('site_2');

  await expect(page).toHaveURL(/site=site_2/);
  await expect(page.getByLabel('Website')).toHaveValue('site_2');
  await expect(page.getByRole('option', { name: 'acme.test' })).toBeAttached();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('datagoat.site')))
    .toBe('site_2');
});
