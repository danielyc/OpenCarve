import { useRef, useState } from 'react'
import { OpenFileButton } from './Home'
import { downloadProject, goHome } from './lib/persist'
import { useAppStore } from './store'

export default function ProjectMenu() {
  const name = useAppStore((s) => s.project.name)
  const saving = useAppStore((s) => s.saving)
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)

  const commitName = () => {
    const next = draft?.trim()
    if (cancelled.current) cancelled.current = false
    else if (next && next !== name) useAppStore.getState().setProjectName(next)
    setDraft(null)
  }

  return (
    <div className="project-menu">
      <h1 className="brand">OpenCarve</h1>
      <button className="menu-button" onClick={() => void goHome()} title="All projects">
        Home
      </button>
      {draft === null ? (
        <button className="project-name" onClick={() => setDraft(name)} title="Rename project" aria-label={`Project name: ${name}`}>
          {name}
        </button>
      ) : (
        <input
          className="project-name"
          aria-label="Project name"
          value={draft}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName()
            if (e.key === 'Escape') {
              cancelled.current = true
              e.currentTarget.blur()
            }
          }}
        />
      )}
      <span className="save-status" aria-live="polite">
        {saving ? 'Saving…' : 'Saved'}
      </span>
      <details className="project-actions">
        <summary className="menu-button">File</summary>
        <div className="menu" onClick={(e) => e.currentTarget.parentElement?.removeAttribute('open')}>
          <button onClick={() => useAppStore.getState().newProject()}>New project</button>
          <OpenFileButton>Open file…</OpenFileButton>
          <button onClick={() => downloadProject(useAppStore.getState().project)}>Save as file</button>
        </div>
      </details>
    </div>
  )
}
