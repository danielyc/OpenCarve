import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CATEGORIES, FONTS, fontsourceIndex, fontSource, listUploadedFonts, loadFont, removeUploadedFont, uploadFont, type FontEntry, type FsFont } from './lib/fonts'
import { fitText } from './lib/geometry'
import { useAppStore } from './store'

const LIMIT = 200
const setStatus = (status: string) => useAppStore.setState({ status })

interface Row {
  id: string
  name: string
  meta: string
  category?: string
}

// Font picker: Bundled / Your fonts / Google Fonts (the Fontsource index, fetched once "Browse Google Fonts" is on).
// Rows are plain buttons; arrow keys move between them, Escape closes and returns focus to the trigger.
export function FontPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [uploads, setUploads] = useState<FontEntry[]>([])
  const [google, setGoogle] = useState<FsFont[] | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
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
    if (!confirm(`Remove the font "${f.name}" from this browser?`)) return
    await removeUploadedFont(f.id)
    await refreshUploads()
    const st = useAppStore.getState()
    const ids = st.project.shapes.filter((s) => s.type === 'text' && s.font === f.id).map((s) => s.id)
    if (!ids.length) return
    await loadFont(FONTS[0].id)
    st.updateShapes(ids, (s) => (s.type === 'text' ? fitText({ ...s, font: FONTS[0].id }) : s))
    setStatus(`Removed "${f.name}"; its text now uses ${FONTS[0].name}.`)
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

  // Keys stay in the panel so the canvas shortcuts (arrows nudge, Escape deselects, letters pick tools) don't fire.
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [...panel.current!.querySelectorAll<HTMLElement>('[data-font]')]
    const i = rows.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : i - 1
    e.preventDefault()
    if (next < 0) panel.current!.querySelector('input')?.focus()
    else rows[next]?.focus()
  }

  const label = value ? fontSource(value).label : 'Mixed'
  return (
    <div className="field wide font-picker">
      <span>Font</span>
      <button ref={trigger} className="font-trigger" aria-label={`Font: ${label}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div ref={panel} className="font-panel" role="group" aria-label="Choose a font" onKeyDown={onKeyDown}>
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
                {rows.map((r) => (
                  <div key={r.id} className="font-row">
                    <button data-font aria-pressed={r.id === value} onClick={() => choose(r.id)}>
                      {r.name} <small>{r.meta}</small>
                    </button>
                    {r.id.startsWith('upload:') && (
                      <button className="font-remove" aria-label={`Remove ${r.name}`} onClick={() => void remove({ id: r.id, name: r.name })}>
                        ×
                      </button>
                    )}
                  </div>
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
