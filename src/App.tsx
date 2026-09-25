import { useEffect, useRef, useState } from 'react'
import { useCam } from './cam/useCam'
import Canvas from './canvas/Canvas'
import ExportPanel from './ExportPanel'
import { icons } from './icons'
import Inspector from './Inspector'
import { importSvg } from './lib/svgImport'
import Preview3D from './preview/Preview3D'
import ProjectMenu from './ProjectMenu'
import SimulatePanel from './SimulatePanel'
import { TOOL_KEYS, useAppStore, type Step, type Tool } from './store'

const STEPS: { id: Step; label: string }[] = [
  { id: 'design', label: 'Design' },
  { id: 'simulate', label: 'Simulate' },
  { id: 'export', label: 'Export' },
]

const TOOLS: { id: Tool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'pen', label: 'Pen' },
  { id: 'text', label: 'Text' },
]

const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const SHORTCUTS: [string, string][] = [
  ...TOOLS.map((t): [string, string] => [TOOL_KEYS[t.id], `${t.label} tool`]),
  ['Delete', 'Delete selection'],
  [`${mod}+Z`, 'Undo'],
  [`${mod}+⇧Z`, 'Redo'],
  [`${mod}+D`, 'Duplicate'],
  ['Arrows', 'Nudge 1 mm (⇧ 10 mm)'],
  ['Esc', 'Deselect / cancel'],
  ['Space+drag', 'Pan'],
  [`${mod}+wheel`, 'Zoom'],
]

async function importFile(file: File | undefined) {
  if (!file) return
  try {
    const { shapes, skipped } = importSvg(await file.text())
    if (shapes.length) useAppStore.getState().addShapes(shapes)
    const found = shapes.length ? `Imported ${shapes.length} shape(s) from ${file.name}.` : `No shapes found in ${file.name}.`
    if (!shapes.length || skipped) alert(skipped ? `${found} Skipped ${skipped} text/<use> element(s); convert text to paths first.` : found)
  } catch (e) {
    alert(`Could not import ${file.name}: ${(e as Error).message}`)
  }
}

export default function App() {
  const step = useAppStore((s) => s.step)
  const setStep = useAppStore((s) => s.setStep)
  const tool = useAppStore((s) => s.tool)
  const setTool = useAppStore((s) => s.setTool)
  const warnings = useAppStore((s) => s.cam?.warnings.length ?? 0)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dropping, setDropping] = useState(false)
  const name = useAppStore((s) => s.project.name)
  useCam()
  useEffect(() => {
    document.title = `${name} – OpenCarve`
    return () => void (document.title = 'OpenCarve')
  }, [name])

  return (
    <div
      className={dropping ? 'app dropping' : 'app'}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        void importFile(e.dataTransfer.files[0])
      }}
    >
      <header className="topbar">
        <ProjectMenu />
        <nav className="steps" aria-label="Workflow step">
          {STEPS.map((s) => (
            <button key={s.id} aria-pressed={step === s.id} onClick={() => setStep(s.id)}>
              {s.label}
              {s.id === 'simulate' && warnings > 0 && (
                <span className="step-badge" role="img" aria-label={`${warnings} warning${warnings > 1 ? 's' : ''}`}>
                  {warnings}
                </span>
              )}
            </button>
          ))}
        </nav>
        <details className="project-actions help">
          <summary className="menu-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
            ?
          </summary>
          <dl className="menu shortcuts">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k}>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      </header>
      <aside className="tools" aria-label="Tools">
        {TOOLS.map((t) => (
          <button key={t.id} aria-pressed={tool === t.id} title={`${t.label} (${TOOL_KEYS[t.id]})`} onClick={() => setTool(t.id)}>
            {icons[t.id]}
            {t.label}
          </button>
        ))}
        <button aria-label="Import SVG" title="Import SVG" onClick={() => fileRef.current?.click()}>
          {icons.import}
          Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".svg,image/svg+xml"
          hidden
          onChange={(e) => {
            void importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </aside>
      <main className="workspace">
        <Canvas />
        <Preview3D />
      </main>
      <aside className="panel">
        {step === 'export' ? <ExportPanel /> : step === 'simulate' ? <SimulatePanel /> : <Inspector />}
      </aside>
    </div>
  )
}
