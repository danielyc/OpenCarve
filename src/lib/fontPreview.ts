import { useEffect, useRef, useState } from 'react'
import { FONTS, getUploadedFont } from './fonts'

// Font picker previews: each row's name is drawn in its own font via the FontFace API (not opentype.js). Bundled
// fonts use their TTF, Fontsource fonts the small latin woff2, uploads the stored bytes. Faces load only for rows in
// view, a few at a time, under family names that can't clash with page fonts.

export const previewFamily = (id: string) => `oc-preview-${id.replace(/[^a-zA-Z0-9-]/g, '-')}`

// URL of the preview file, or null for uploads (read from IndexedDB).
export function previewUrl(id: string): string | null {
  if (id.startsWith('upload:')) return null
  if (id.startsWith('fs:')) return `https://cdn.jsdelivr.net/fontsource/fonts/${id.slice(3)}@latest/latin-400-normal.woff2`
  const f = FONTS.find((f) => f.id === id) ?? FONTS[0]
  return `${import.meta.env.BASE_URL}fonts/${f.file}`
}

// Runs at most `max` tasks at once. A queued task whose `wanted()` is false when its turn comes is skipped
// (resolves undefined) so rows scrolled past never download.
export function limiter(max: number) {
  let active = 0
  const queue: (() => void)[] = []
  const next = () => {
    if (active < max) queue.shift()?.()
  }
  return <T>(task: () => Promise<T>, wanted: () => boolean = () => true) =>
    new Promise<T | undefined>((resolve, reject) => {
      queue.push(() => {
        if (!wanted()) {
          resolve(undefined)
          return next()
        }
        active++
        task()
          .then(resolve, reject)
          .then(() => {
            active--
            next()
          })
      })
      next()
    })
}

const run = limiter(6)
const started = new Map<string, Promise<boolean>>()
const ready = new Set<string>()
const failed = new Set<string>()
const interest = new Map<string, number>()
let warned = false

// Marks a preview as wanted (its row is in view); returns the release.
function want(id: string) {
  interest.set(id, (interest.get(id) ?? 0) + 1)
  return () => interest.set(id, interest.get(id)! - 1)
}

// Resolves true once the face is in document.fonts, false if skipped (nobody wanted it any more). Failures are
// cached and silent: the row keeps the UI font.
function loadPreview(id: string): Promise<boolean> {
  let p = started.get(id)
  if (!p) {
    const url = previewUrl(id)
    p = run(
      async () => {
        const src = url ? `url("${url}")` : (await getUploadedFont(id))?.data
        if (!src) throw new Error('font not stored')
        const face = await new FontFace(previewFamily(id), src).load()
        document.fonts.add(face)
        ready.add(id)
        return true
      },
      () => (interest.get(id) ?? 0) > 0,
    ).then(
      (ok) => {
        if (!ok) started.delete(id)
        return !!ok
      },
      (e) => {
        failed.add(id)
        if (!warned) console.debug('Font preview failed', id, e)
        warned = true
        return false
      },
    )
    started.set(id, p)
  }
  return p
}

// Lets failed previews load again (the "Preview fonts" toggle switched on).
export function retryFailedPreviews() {
  for (const id of failed) started.delete(id)
  failed.clear()
}

// A removed uploaded font's preview face is unregistered too.
export function forgetPreview(id: string) {
  const fonts = globalThis.document?.fonts
  const family = previewFamily(id)
  if (fonts) for (const face of [...fonts]) if (face.family.replace(/"/g, '') === family) fonts.delete(face)
  started.delete(id)
  ready.delete(id)
  failed.delete(id)
}

// Ref + preview state for an element showing font `id`; loads while the element is in view and `enabled`.
export function useFontPreview<E extends Element>(id: string, enabled = true) {
  const ref = useRef<E>(null)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!enabled || !id || !el || ready.has(id)) return
    let release: (() => void) | undefined
    let alive = true
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !release) {
        release = want(id)
        void loadPreview(id).then((ok) => alive && ok && setLoadedId(id))
      } else if (!e.isIntersecting && release) {
        release()
        release = undefined
      }
    })
    io.observe(el)
    return () => {
      alive = false
      io.disconnect()
      release?.()
    }
  }, [id, enabled])
  const loaded = enabled && !!id && (loadedId === id || ready.has(id))
  return {
    ref,
    'data-preview': loaded ? 'loaded' : undefined,
    style: loaded ? { fontFamily: `"${previewFamily(id)}", var(--ui-font)` } : undefined,
  }
}
