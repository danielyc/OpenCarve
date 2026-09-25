import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CATEGORIES, FONTS, fontsourceIndex, fontSource, listUploadedFonts, missingGlyphs, uploadFont, type FontEntry, type FsFont } from './lib/fonts'
import { retryFailedPreviews, useFontPreview } from './lib/fontPreview'
import { fontUsers, removeFont } from './lib/persist'
import { useAppStore } from './store'

const LIMIT = 200
const setStatus = (status: string) => useAppStore.setState({ status })
const PREVIEW_KEY = 'opencarve:fontPreviews'
const storedPreview = () => {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== 'off'
  } catch {
    return true
  }
}

interface Row {
  id: string
  name: string
  meta: string
  category?: string
}

// Font picker: Bundled / Your fonts / Google Fonts (the Fontsource index, fetched once "Browse Google Fonts" is on).
// Rows are plain buttons; arrow keys move between them, Escape closes and returns focus to the trigger.
// `text` is the selected text, checked for characters the font can't draw.
export function FontPicker({ value, text, onChange }: { value: string; text: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [uploads, setUploads] = useState<FontEntry[]>([])
  const [google, setGoogle] = useState<FsFont[] | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [previewGoogle, setPreviewGoogle] = useState(storedPreview)
  const previews = (id: string) => previewGoogle || !id.startsWith('fs:')
  const trigger = useRef<HTMLButtonElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)

  const refreshUploads = () => listUploadedFonts().then(setUploads, console.error)
  useEffect(() => void refreshUploads(), [])
  useEffect(() => {
    if (!browsing || google) return
    fontsourceIndex().then(setGoogle, (e: Error) => {
      setBrowsing(false)
      setStatus(`Could not load the Google Fonts list (${e.message})`)
    })
  }, [browsing, google])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => !wrapper.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useAppStore((s) => s.fontsVersion) // re-check glyphs once the font arrives
  const missing = value ? missingGlyphs(value, text) : []

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  const choose = (id: string) => {
    onChange(id)
    close()
  }

  const q = query.trim().toLowerCase()
  const match = (r: Row) => r.name.toLowerCase().includes(q) && (!category || r.category === category)
  const groups: [string, Row[]][] = [
    ['Bundled', FONTS.map((f) => ({ id: f.id, name: f.name, meta: `${f.category} · OFL-1.1`, category: f.category })).filter(match)],
    ['Your fonts', uploads.map((f) => ({ id: f.id, name: f.name, meta: 'uploaded' })).filter((r) => !category && match(r))],
  ]
  let more = 0
  if (browsing && google) {
    const rows = google.map((f) => ({ id: `fs:${f.id}`, name: f.family, meta: `${f.category} · ${f.license}`, category: f.category })).filter(match)
    more = rows.length - LIMIT
    groups.push(['Google Fonts', rows.slice(0, LIMIT)])
  }

  const remove = async (f: FontEntry) => {
    const blocked = (names: string[]) => setStatus(`"${f.name}" is still used by: ${names.join(', ')}. Change the font there first.`)
    const users = await fontUsers(f.id, useAppStore.getState().project.id)
    if (users.length) return blocked(users)
    if (!confirm(`Remove the font "${f.name}" from this browser?`)) return
    const { blockedBy, fellBack } = await removeFont(f.id)
    if (blockedBy.length) return blocked(blockedBy)
    await refreshUploads()
    if (fellBack) setStatus(`Removed "${f.name}"; its text now uses ${FONTS[0].name}.`)
  }

  const upload = async (f: File | undefined) => {
    if (!f) return
    try {
      await uploadFont(f)
      await refreshUploads()
    } catch (e) {
      setStatus(`Could not add ${f.name}: ${(e as Error).message}`)
    }
  }

  // Plain keys stay in the picker (trigger included) so canvas shortcuts (arrows nudge, Delete deletes, letters
  // pick tools) don't fire; Ctrl/Cmd shortcuts like undo still reach the app, as does Escape on the closed trigger.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || (e.key === 'Escape' && !open)) return
    e.stopPropagation()
    if (e.key === 'Escape') return close()
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    if (!open) return setOpen(e.key === 'ArrowDown')
    const rows = [...panel.current!.querySelectorAll<HTMLElement>('[data-font]')]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : i - 1
    if (next < 0) panel.current!.querySelector('input')?.focus()
    else rows[next]?.focus()
  }

  const togglePreview = (on: boolean) => {
    if (on) retryFailedPreviews()
    setPreviewGoogle(on)
    try {
      localStorage.setItem(PREVIEW_KEY, on ? 'on' : 'off')
    } catch {
      /* not remembered */
    }
  }

  const label = value ? fontSource(value).label : 'Mixed'
  return (
    <div ref={wrapper} className="field wide font-picker" onKeyDown={onKeyDown}>
      <span>Font</span>
      <button ref={trigger} className="font-trigger" aria-label={`Font: ${label}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {missing.length > 0 && (
        <small className="font-missing" role="status">
          {label} has no glyph for {missing.map((c) => `'${c}'`).join(' ')}
        </small>
      )}
      {open && (
        <div ref={panel} className="font-panel" role="group" aria-label="Choose a font">
          <input autoFocus type="search" placeholder="Search fonts" aria-label="Search fonts" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="font-chips">
            {CATEGORIES.map((c) => (
              <button key={c} aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
                {c}
              </button>
            ))}
          </div>
          <div className="font-list">
            {groups.map(([title, rows]) => (
              <section key={title} aria-label={title}>
                <h3>{title}</h3>
                {title === 'Google Fonts' && (
                  <label className="font-preview-toggle">
                    <input type="checkbox" checked={previewGoogle} onChange={(e) => togglePreview(e.target.checked)} /> Preview fonts
                  </label>
                )}
                {rows.map((r) => (
                  <FontRow key={r.id} row={r} selected={r.id === value} preview={previews(r.id)} onChoose={choose} onRemove={remove} />
                ))}
                {!rows.length && <p className="hint">{title === 'Your fonts' && !uploads.length ? 'No uploaded fonts yet.' : 'No matches.'}</p>}
                {title === 'Google Fonts' && more > 0 && <p className="hint">{more} more — type to narrow.</p>}
              </section>
            ))}
            {browsing && !google && <p className="hint">Loading Google Fonts…</p>}
          </div>
          <div className="font-actions">
            <button onClick={() => file.current?.click()}>Upload font…</button>
            <input ref={file} hidden type="file" accept=".ttf,.otf" aria-label="Upload font file" onChange={(e) => void upload(e.target.files?.[0]).then(() => (e.target.value = ''))} />
            <button aria-pressed={browsing} onClick={() => setBrowsing(!browsing)}>
              Browse Google Fonts
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function FontRow({ row: r, selected, preview, onChoose, onRemove }: { row: Row; selected: boolean; preview: boolean; onChoose: (id: string) => void; onRemove: (f: FontEntry) => void }) {
  const sample = useFontPreview<HTMLSpanElement>(r.id, preview)
  return (
    <div className="font-row">
      <button data-font aria-pressed={selected} onClick={() => onChoose(r.id)}>
        {/* The name stays in the UI font: symbol and barcode fonts would draw it as glyphs. */}
        {r.name}{' '}
        <span {...sample} className="font-sample" aria-hidden>
          Abc 123
        </span>{' '}
        <small>{r.meta}</small>
      </button>
      {r.id.startsWith('upload:') && (
        <button className="font-remove" aria-label={`Remove ${r.name}`} onClick={() => void onRemove({ id: r.id, name: r.name })}>
          ×
        </button>
      )}
    </div>
  )
}
