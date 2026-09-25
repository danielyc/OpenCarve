import { expect, test } from '@playwright/test'

test('loads the app shell', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('OpenCarve')
  for (const name of ['Design', 'Simulate', 'Export']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  }
})
