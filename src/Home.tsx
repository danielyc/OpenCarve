import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createProject, deleteProject, duplicateProject, listProjects, openFile, readProject, type ProjectEntry } from './lib/persist'
import { formatLength } from './lib/units'
import { useAppStore } from './store'

export function OpenFileButton({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <button className={className} onClick={() => ref.current?.click()}>
        {children}
      </button>
      <input
        ref={ref}
        type="file"
        accept=".oc,application/json"
        aria-label="Open project file"
        hidden
        onChange={(e) => {
          void openFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </>
  )
}

const size = ({ stock, units }: ProjectEntry) =>
  `${[stock.w, stock.h, stock.thickness].map((v) => +formatLength(v, units)).join(' × ')} ${units}`

export default function Home() {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null)
  const refresh = () =>
    listProjects()
      .then(setProjects)
      .catch(() => setProjects([]))
  useEffect(() => void refresh(), [])

  const open = async (id: string) => {
    const p = await readProject(id).catch((e: Error) => alert(`Could not open project: ${e.message}`))
    if (p) useAppStore.getState().loadProject(p)
  }

  return (
    <div className="home">
      <header className="home-head">
        <h1 className="brand">OpenCarve</h1>
        <div className="home-actions">
          <OpenFileButton>Open file…</OpenFileButton>
          <button className="primary" onClick={() => void createProject()}>
            New project
          </button>
        </div>
      </header>
      <main className="home-main">
        <p className="home-intro">Design signs and parts, preview the carve in 3D and export G-code for your CNC router. Projects are saved in this browser.</p>
        <h2>Projects</h2>
        {projects && !projects.length && <p className="hint">No saved projects yet. Start a new one or open a .oc file.</p>}
        <ul className="project-list" aria-label="Projects">
          {projects?.map((p) => (
            <li key={p.id}>
              <div className="project-info" onDoubleClick={() => void open(p.id)}>
                <strong>{p.name || 'Untitled'}</strong>
                <span>
                  {size(p)} · Updated {new Date(p.updatedAt).toLocaleString()}
                </span>
              </div>
              <button className="primary" onClick={() => void open(p.id)} aria-label={`Open ${p.name || 'Untitled'}`}>
                Open
              </button>
              <button onClick={() => void duplicateProject(p.id).then(refresh)} aria-label={`Duplicate ${p.name || 'Untitled'}`}>
                Duplicate
              </button>
              <button
                onClick={() => window.confirm(`Delete “${p.name || 'Untitled'}”? This can't be undone.`) && void deleteProject(p.id).then(refresh)}
                aria-label={`Delete ${p.name || 'Untitled'}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
