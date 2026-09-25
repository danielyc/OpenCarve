import { expect, test } from 'vitest'
import { limiter, previewFamily, previewUrl } from './fontPreview'

test('preview family names and URLs', () => {
  expect(previewFamily('lora')).toBe('oc-preview-lora')
  expect(previewFamily('fs:lora')).toBe('oc-preview-fs-lora')
  expect(previewFamily('upload:1b2c-3d')).toBe('oc-preview-upload-1b2c-3d')
  expect(previewUrl('lora')).toBe('/fonts/Lora-Regular.ttf')
  expect(previewUrl('fs:open-sans')).toBe('https://cdn.jsdelivr.net/fontsource/fonts/open-sans@latest/latin-400-normal.woff2')
  expect(previewUrl('upload:x')).toBeNull()
})

test('the limiter caps concurrency and skips tasks no longer wanted', async () => {
  const run = limiter(2)
  const resolvers: (() => void)[] = []
  let active = 0
  let peak = 0
  const task = (v: number) => () =>
    new Promise<number>((resolve) => {
      peak = Math.max(peak, ++active)
      resolvers.push(() => {
        active--
        resolve(v)
      })
    })
  const wanted = [true, true, false, true]
  const results = [1, 2, 3, 4].map((v, i) => run(task(v), () => wanted[i]))
  expect(resolvers).toHaveLength(2)
  resolvers[0]()
  await results[0]
  await Promise.resolve()
  expect(resolvers).toHaveLength(3) // task 3 was skipped, task 4 started
  resolvers[1]()
  resolvers[2]()
  expect(await Promise.all(results)).toEqual([1, 2, undefined, 4])
  expect(peak).toBe(2)

  const failing = await run(() => Promise.reject(new Error('x'))).catch((e: Error) => e.message)
  expect(failing).toBe('x')
  expect(await run(async () => 'next')).toBe('next') // a failure frees its slot
})
