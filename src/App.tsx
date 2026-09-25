import { useAppStore, type Step } from './store'

const STEPS: { id: Step; label: string }[] = [
  { id: 'design', label: 'Design' },
  { id: 'simulate', label: 'Simulate' },
  { id: 'export', label: 'Export' },
]

const TOOLS = ['Select', 'Rectangle', 'Ellipse', 'Polygon', 'Pen', 'Text']

export default function App() {
  const step = useAppStore((s) => s.step)
  const setStep = useAppStore((s) => s.setStep)

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">OpenCarve</span>
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
          <button key={t} title={t}>
            {t}
          </button>
        ))}
      </aside>
      <main className="workspace">
        <section className="canvas2d">2D canvas</section>
        <section className="preview3d">3D preview</section>
      </main>
      <aside className="panel">
        <h2>Cut settings</h2>
      </aside>
    </div>
  )
}
