import { expect, type Locator, type Page } from '@playwright/test'

// Toolpath planning is debounced and runs in a worker (seconds for a V-carve under load); the Simulate and Export
// panels flag it with data-cam-busy.
export const waitForCam = (page: Page) =>
  expect(page.locator('[data-cam-busy]')).toHaveAttribute('data-cam-busy', 'false', { timeout: 30_000 })

// An element's width once it is unchanged across two reads 200 ms apart (a step change may animate it).
export async function settledWidth(el: Locator) {
  let last = -1
  await expect
    .poll(
      async () => {
        const w = (await el.boundingBox())!.width
        const same = w === last
        last = w
        return same
      },
      { intervals: [200], timeout: 15_000 },
    )
    .toBe(true)
  return last
}
