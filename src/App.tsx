import { useRef, useState } from 'react'
import Canvas from './canvas/Canvas'
import { icons } from './icons'
import Inspector from './Inspector'
import { importSvg } from './lib/svgImport'
import { useAppStore, type Step, type Tool } from './store'

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

async function importFile(file: File | undefined) {
  if (!file) return
  try {
    const shapes = importSvg(await file.text())
    if (shapes.length) useAppStore.getState().addShapes(shapes)
    else alert(`No shapes found in ${file.name}`)
  } catch (e) {
    alert(`Could not import ${file.name}: ${(e as Error).message}`)
  }
}

export default function App() {
  const step = useAppStore((s) => s.step)
  const setStep = useAppStore((s) => s.setStep)
  const tool = useAppStore((s) => s.tool)
  const setTool = useAppStore((s) => s.setTool)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dropping, setDropping] = useState(false)

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
        <h1 className="brand">OpenCarve</h1>
        <nav className="steps" aria-label="Workflow step">
          {STEPS.map((s) => (
            <button key={s.id} aria-pressed={step === s.id} onClick={() => setStep(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <span />
      </header>
      <aside className="tools" aria-label="Tools">
        {TOOLS.map((t) => (
          <button key={t.id} aria-pressed={tool === t.id} onClick={() => setTool(t.id)}>
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
        <section className="preview3d">3D preview</section>
      </main>
      <aside className="panel">
        <Inspector />
      </aside>
    </div>
  )
}
