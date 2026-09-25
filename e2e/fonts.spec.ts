import { expect, test } from '@playwright/test'

// No live Google Fonts test: the Fontsource list and files come from the network.
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await page.getByRole('button', { name: 'Text' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByRole('button', { name: 'Font: Roboto' })).toBeVisible()
})

test('searches the font picker and picks a bundled font', async ({ page }) => {
  await page.getByRole('button', { name: 'Font: Roboto' }).click()
  await page.getByLabel('Search fonts').fill('Lora')
  const bundled = page.getByRole('region', { name: 'Bundled' })
  await expect(bundled.getByRole('button')).toHaveCount(1)
  await bundled.getByRole('button', { name: /^Lora/ }).click()
  await expect(page.getByRole('button', { name: 'Font: Lora' })).toBeFocused()
})

test('uploads a font and uses it', async ({ page }) => {
  await page.getByRole('button', { name: 'Font: Roboto' }).click()
  await page.getByLabel('Upload font file').setInputFiles('public/fonts/Roboto-Regular.ttf')
  const yours = page.getByRole('region', { name: 'Your fonts' })
  await expect(yours.getByRole('button', { name: /^Roboto/ })).toBeVisible()
  await yours.getByRole('button', { name: /^Roboto/ }).click()
  await page.getByRole('button', { name: 'Font: Roboto' }).click()
  await expect(yours.getByRole('button', { name: /^Roboto/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('region', { name: 'Bundled' }).getByRole('button', { name: /^Roboto/ })).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Search fonts')).toBeHidden()
})

test('keys on the font picker trigger never reach the canvas shortcuts', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Font: Roboto' })
  const x = await page.getByLabel('X', { exact: true }).inputValue()
  await trigger.focus()
  await page.keyboard.press('Delete')
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('[data-id]')).toHaveCount(1)
  await expect(page.getByLabel('X', { exact: true })).toHaveValue(x)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByLabel('Search fonts')).toBeFocused()
  await page.mouse.click(5, 300) // outside the picker
  await expect(page.getByLabel('Search fonts')).toBeHidden()
})

test('warns about characters the font cannot draw', async ({ page }) => {
  await page.getByRole('button', { name: 'Font: Roboto' }).click()
  await page.getByLabel('Search fonts').fill('Allerta')
  await page.getByRole('button', { name: /^Allerta Stencil/ }).click()
  await page.getByLabel('Text', { exact: true }).fill('Łódź ą')
  await expect(page.getByText("Allerta Stencil has no glyph for 'ź' 'ą'")).toBeVisible()
})
