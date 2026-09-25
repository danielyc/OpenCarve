import { expect, test } from '@playwright/test'

// Each test gets a fresh browser context (empty IndexedDB), so the app opens on the home screen.
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New project' }).click()
})

test('loads the app shell', async ({ page }) => {
  await expect(page).toHaveTitle('Untitled – OpenCarve')
  for (const name of ['Design', 'Simulate', 'Export']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  }
})

test('draws a rectangle and undoes it', async ({ page }) => {
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
  await expect(page.getByLabel('3D carve preview')).toBeVisible()
  await expect(page.getByText('Simulating…')).toBeHidden({ timeout: 10_000 })

  await page.keyboard.press('ControlOrMeta+z')
  await expect(shapes).toHaveCount(0)
})

test('draws a path with the pen tool', async ({ page }) => {
  await page.getByRole('button', { name: 'Pen' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  for (const [dx, dy] of [[-50, 0], [50, 0], [0, 60]]) await page.mouse.click(cx + dx, cy + dy)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-id]')).toHaveCount(1)
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Path')
})

test('places a text shape with the text tool', async ({ page }) => {
  await page.getByRole('button', { name: 'Text' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('[data-id]')).toHaveCount(1)
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue('Text')
  await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true')
})

test('imports an SVG file', async ({ page }) => {
  await page.locator('input[accept*=svg]').setInputFiles('e2e/fixtures/shapes.svg')
  await expect(page.locator('[data-id]')).toHaveCount(3)
  await expect(page.getByRole('heading', { name: '3 shapes' })).toBeVisible()
})

test('sets a rectangle to a pocket cut', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()

  const shape = page.locator('[data-id]')
  await expect(shape).toHaveAttribute('data-cut', 'outline')
  await expect(page.getByRole('heading', { name: 'Cut' })).toBeVisible()
  await page.getByRole('radio', { name: 'Pocket' }).click()
  await expect(shape).toHaveAttribute('data-cut', 'pocket')
  const depth = page.getByLabel('Depth value', { exact: true })
  await expect(depth).toHaveValue('3.00') // a through depth becomes a pocket-sized default
  await depth.fill('3')
  await depth.press('Enter')
  await expect(depth).toHaveValue('3.00')
  await expect(page.getByRole('slider', { name: 'Depth' })).toHaveValue('3')
  await expect(page.getByLabel('Tabs')).toHaveCount(0)
})

test('exports G-code for a rectangle', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const button = page.getByRole('button', { name: 'Download rough G-code' })
  await expect(button).toBeEnabled()
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  expect(download.suggestedFilename()).toMatch(/^Untitled-.*\.nc$/)
  const gcode = await (await download.createReadStream()).toArray()
  expect(Buffer.concat(gcode).toString()).toContain('G21 G90 G17')
})

test('exports a V-carve with a V-bit as the detail bit', async ({ page }) => {
  await page.getByLabel('Detail bit').selectOption('90-vbit')
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()

  await page.getByRole('radio', { name: 'V-carve' }).click()
  await expect(page.locator('[data-id]')).toHaveAttribute('data-cut', 'vcarve')
  await expect(page.getByRole('slider', { name: 'Max depth' })).toBeVisible()
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download detail G-code' })).toBeEnabled()
})

test('simulate lists ops and selects the shape', async ({ page }) => {
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-id].selected')).toHaveCount(0)

  await page.getByRole('button', { name: /^Simulate/ }).click()
  const rows = page.locator('.op-list').getByRole('button')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Outline outside')
  await expect(page.getByText(/^about \d+:\d\d$/)).toBeVisible()
  await rows.first().click()
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-id].selected')).toHaveCount(1)
  await expect(page.locator('.toolpaths.highlight')).toHaveCount(1)
  await expect(page.locator('.selection-frame polygon')).toHaveCount(1)
  await expect(page.locator('.handle')).toHaveCount(0) // no scale/rotate handles outside Design

  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Rectangle')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download rough G-code' })).toBeEnabled()
})

test('badges the Simulate step when a shape is partly outside the stock', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Simulate', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Rectangle' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  await page.mouse.move(box.x + 5, box.y + 5)
  await page.mouse.down()
  await page.mouse.move(box.x + 120, box.y + 100, { steps: 4 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Simulate 1 warning' })).toBeVisible()
  await page.getByRole('button', { name: /^Simulate/ }).click()
  await expect(page.getByRole('list', { name: 'Warnings' })).toContainText('partly outside the stock')
})
