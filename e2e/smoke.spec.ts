import { expect, test } from '@playwright/test'

test('loads the app shell', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('OpenCarve')
  for (const name of ['Design', 'Simulate', 'Export']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  }
})

test('draws a rectangle and undoes it', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await expect(page.getByRole('button', { name: 'Rectangle' })).toHaveAttribute('aria-pressed', 'true')
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx - 60, cy - 40)
  await page.mouse.down()
  await page.mouse.move(cx, cy, { steps: 4 })
  await page.mouse.move(cx + 60, cy + 40, { steps: 4 })
  await page.mouse.up()

  const shapes = page.locator('[data-id]')
  await expect(shapes).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true')
  const w = parseFloat(await page.getByLabel('W', { exact: true }).inputValue())
  const h = parseFloat(await page.getByLabel('H', { exact: true }).inputValue())
  expect(w).toBeGreaterThan(0)
  expect(w / h).toBeCloseTo(1.5, 1)

  await page.keyboard.press('ControlOrMeta+z')
  await expect(shapes).toHaveCount(0)
})
