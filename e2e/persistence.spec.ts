import { expect, test, type Page } from '@playwright/test'

async function drawRect(page: Page) {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()
}

async function rename(page: Page, name: string) {
  await page.getByRole('button', { name: /^Project name/ }).click()
  await page.getByLabel('Project name', { exact: true }).fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: `Project name: ${name}` })).toBeVisible()
}

test('autosaves, reopens after reload, and deletes from home', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('No saved projects yet.')).toBeVisible()
  await page.getByRole('button', { name: 'New project' }).click()
  await drawRect(page)
  await rename(page, 'Test')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: 'Project name: Test' })).toBeVisible()
  await expect(page.locator('[data-id]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Home' }).click()
  const list = page.getByRole('list', { name: 'Projects' })
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('Test')
  await expect(list).toContainText('300 × 200 × 12 mm')

  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Delete Test' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('No saved projects yet.')).toBeVisible()
})

test('saves as a .oc file', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New project' }).click()
  await drawRect(page)
  await rename(page, 'Test')
  await page.getByText('File', { exact: true }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save as file' }).click()])
  expect(download.suggestedFilename()).toBe('Test.oc')
  const json = JSON.parse(Buffer.concat(await (await download.createReadStream()).toArray()).toString())
  expect(json).toMatchObject({ format: 'opencarve', version: 2, project: { name: 'Test', shapes: [{ type: 'rect' }] } })
})

test('opens a .oc file with text and plans its toolpaths', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Open project file').setInputFiles('e2e/fixtures/sample.oc')
  await expect(page.getByRole('button', { name: 'Project name: Sample sign' })).toBeVisible()
  await expect(page.locator('[data-id]')).toHaveCount(2)
  // The text's glyph outlines (several contours, not the placeholder box) render once its font loads lazily.
  await expect(page.locator('[data-id=label] path.hit')).toHaveAttribute('d', /(Z.*){3}/)
  await page.getByRole('button', { name: /^Simulate/ }).click()
  await expect(page.locator('.toolpath-rough')).toHaveAttribute('d', /M/)

  await page.getByRole('button', { name: 'Home' }).click()
  await expect(page.getByRole('list', { name: 'Projects' })).toContainText('Sample sign')
})
