import { expect, test, type Download, type Page } from '@playwright/test'

const text = async (download: Download) => Buffer.concat(await (await download.createReadStream()).toArray()).toString()

// Selects a shape through its Simulate row (canvas hit-testing on glyphs is fiddly), then returns to Design.
async function selectViaSimulate(page: Page, name: string) {
  await page.getByRole('button', { name: /^Simulate/ }).click()
  await page.locator('.op-list').getByRole('button', { name: new RegExp(`^${name}`) }).first().click()
  await page.getByRole('button', { name: 'Design', exact: true }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name)
}

test('designs, simulates, exports and reopens a two-bit sign', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'New project' }).click()

  await page.getByRole('button', { name: /^Project name/ }).click()
  await page.getByLabel('Project name', { exact: true }).fill('Sign')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Project name: Sign' })).toBeVisible()
  await expect(page).toHaveTitle('Sign – OpenCarve')

  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await page.mouse.move(cx - 150, cy - 100)
  await page.mouse.down()
  await page.mouse.move(cx + 150, cy + 100, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('[data-id]')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await page.keyboard.press('t') // tool shortcut
  await expect(page.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.click(cx, cy)
  await expect(page.locator('[data-id]')).toHaveCount(2)
  const content = page.getByLabel('Text', { exact: true })
  await content.fill('Hi')
  await content.press('Escape')
  const size = page.getByLabel('Size', { exact: true })
  await size.fill('40')
  await size.press('Enter')
  await page.getByRole('radio', { name: 'Pocket' }).click()
  const depth = page.getByLabel('Depth value', { exact: true })
  await depth.fill('3')
  await depth.press('Enter')
  await expect(depth).toHaveValue('3.00')

  await selectViaSimulate(page, 'Rectangle')
  await page.getByRole('radio', { name: 'Outline' }).click()
  await page.getByRole('radio', { name: 'Outside' }).click()
  await expect(page.getByRole('slider', { name: 'Depth' })).toHaveAttribute('aria-valuetext', 'Through')
  const tabs = page.getByRole('checkbox', { name: 'Tabs' })
  await tabs.check()

  await page.mouse.click(box.x + 10, box.y + 10) // empty canvas: deselect to show the project settings
  await page.getByLabel('Detail bit').selectOption('60-vbit')
  await selectViaSimulate(page, 'Text')
  await page.getByRole('radio', { name: 'V-carve' }).click()
  await expect(page.locator('[data-cut=vcarve]')).toHaveCount(1)

  await page.getByRole('button', { name: /^Simulate/ }).click()
  const rows = page.locator('.op-list').getByRole('button')
  await expect(rows.filter({ hasText: /^Rectangle.*Outline outside · Rough bit/ })).toHaveCount(1)
  await expect(rows.filter({ hasText: /^Text.*V-carve · Detail bit/ })).toHaveCount(1)
  await expect(rows.filter({ hasText: /^Text.*V-carve clearing/ })).not.toHaveCount(0)
  await expect(page.getByText(/^about \d+:\d\d$/)).toBeVisible()
  // Expected: the 1/8" endmill doesn't fit the narrow V-carve floor of 40 mm text, so the V-bit clears it.
  const warnings = await page.getByRole('list', { name: 'Warnings' }).getByRole('listitem').allTextContents()
  expect(warnings.filter((w) => !w.includes('The endmill is too large for the floor of Text'))).toEqual([])

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const download = async (role: string) => {
    const button = page.getByRole('button', { name: `Download ${role} G-code` })
    await expect(button).toBeEnabled()
    return (await Promise.all([page.waitForEvent('download'), button.click()]))[0]
  }
  const rough = await download('rough')
  expect(rough.suggestedFilename()).toBe('Sign-1_8_ (3.175 mm) endmill.nc')
  expect(await text(rough)).toContain('G21 G90 G17 G94')
  const detail = await download('detail')
  expect(detail.suggestedFilename()).toBe('Sign-60° V-bit, 1_2_ (12.7 mm).nc')
  expect(await text(detail)).toMatch(/^G1 .*X-?[\d.]+ Y-?[\d.]+ Z-?[\d.]+/m)

  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Project name: Sign' })).toBeVisible()
  await expect(page.locator('[data-id]')).toHaveCount(2)
})

// In this file so it runs after the flow test rather than alongside it: headless WebGL is software-rendered, and every
// animation frame redraws the 1.2 M-cell surface, which starves tests running in parallel.
test('plays and scrubs the toolpath animation', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'New project' }).click()
  const box = (await page.getByLabel('Design canvas').boundingBox())!
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.getByRole('button', { name: 'Rectangle' }).click()
  await page.mouse.move(cx - 80, cy - 50)
  await page.mouse.down()
  await page.mouse.move(cx + 80, cy + 50, { steps: 4 })
  await page.mouse.up()
  await page.getByRole('radio', { name: 'Outline' }).click()

  await page.getByRole('button', { name: /^Simulate/ }).click()
  const bar = page.getByRole('group', { name: 'Toolpath animation' })
  await expect(bar).toBeVisible({ timeout: 15_000 })
  const current = bar.locator('.playback-current')
  const total = await bar.locator('.playback-total').textContent()
  await expect(current).toHaveText(total!) // starts at the end, showing the finished job

  await bar.getByRole('button', { name: 'Play animation' }).click()
  await expect(bar.getByRole('button', { name: 'Pause animation' })).toBeVisible()
  await page.waitForTimeout(1000)
  await expect(current).not.toHaveText('0:00', { timeout: 20_000 })
  expect(parseFloat((await bar.getAttribute('data-anim-t'))!)).toBeGreaterThan(0)
  expect(await page.evaluate(() => !!document.querySelector('[data-tool-visible=true]'))).toBe(true)
  await bar.getByRole('button', { name: 'Pause animation' }).click()

  const slider = bar.getByRole('slider', { name: 'Animation time' })
  await slider.focus()
  await page.keyboard.press('End')
  await expect(current).toHaveText(total!)
})
