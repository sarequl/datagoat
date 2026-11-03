import { expect, type Page, test } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

function funnelRow(page: Page, name: string) {
  return page.locator('tr', {
    has: page.getByRole('rowheader', { name, exact: true }),
  });
}

async function createFunnelViaApi(page: Page, name: string) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post(`${origin}/api/v1/admin/sites/site_1/funnels`, {
    data: {
      name,
      steps: [
        { type: 'page', path: '/', name: 'Landing' },
        { type: 'goal', goal: 'signup', name: 'Signup' },
      ],
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { data: { id: string; name: string } };
  return body.data;
}

test('shows the saved funnels list', async ({ page }) => {
  await signIn(page);
  await page.goto('/funnels');

  await expect(page.getByRole('rowheader', { name: 'Checkout', exact: true })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'Signup', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New funnel' })).toBeVisible();
});

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

test('creates a funnel from the builder', async ({ page }) => {
  await signIn(page);
  await page.goto('/funnels');
  await page.getByRole('button', { name: 'New funnel' }).click();

  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Trial Funnel');
  await page
    .locator('.funnel-step-editor')
    .nth(0)
    .getByRole('textbox', { name: 'path', exact: true })
    .fill('/pricing');
  await page
    .locator('.funnel-step-editor')
    .nth(1)
    .getByRole('textbox', { name: 'goal', exact: true })
    .fill('signup');
  await page.getByRole('button', { name: 'Create funnel' }).click();

  await expect(page).toHaveURL(/funnel=fun_\d+/);
  await expect(page.getByRole('heading', { name: 'E2E Trial Funnel' })).toBeVisible();
});

test('edits a saved funnel', async ({ page }) => {
  await signIn(page);
  await createFunnelViaApi(page, 'E2E Edit Funnel');
  await page.goto('/funnels');

  const row = funnelRow(page, 'E2E Edit Funnel');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit' }).click();

  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'E2E Edit Funnel',
  );
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Edit Funnel v2');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page).toHaveURL(/funnel=fun_\d+/);
  await expect(page.getByRole('heading', { name: 'E2E Edit Funnel v2' })).toBeVisible();
});

test('deletes a saved funnel after confirmation', async ({ page }) => {
  await signIn(page);
  await createFunnelViaApi(page, 'E2E Delete Funnel');
  await page.goto('/funnels');

  const row = funnelRow(page, 'E2E Delete Funnel');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Delete' }).click();
  await row.getByRole('button', { name: 'Confirm' }).click();

  await expect(row).toHaveCount(0);
});

test('shows an error for an unknown funnel', async ({ page }) => {
  await signIn(page);
  await page.goto('/funnels?funnel=fun_missing');

  await expect(page.getByText('Cannot load funnel')).toBeVisible();
});
