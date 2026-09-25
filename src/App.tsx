import Canvas from './canvas/Canvas'
import { icons } from './icons'
import Inspector from './Inspector'
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
]

export default function App() {
  const step = useAppStore((s) => s.step)
  const setStep = useAppStore((s) => s.setStep)
  const tool = useAppStore((s) => s.tool)
  const setTool = useAppStore((s) => s.setTool)

  return (
    <div className="app">
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
        <button disabled>
          {icons.text}
          Text
        </button>
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
