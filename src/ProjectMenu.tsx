import { useEffect, useRef, useState } from 'react'
import { OpenFileButton } from './Home'
import { createProject, downloadProject, goHome } from './lib/persist'
import { useAppStore } from './store'

export default function ProjectMenu() {
  const name = useAppStore((s) => s.project.name)
  const saveState = useAppStore((s) => s.saveState)
  const menu = useRef<HTMLDetailsElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)

  // <details> menus (File, shortcuts help) don't close on their own on Escape or an outside click.
  useEffect(() => {
    const close = (e: Event) => {
      for (const d of document.querySelectorAll<HTMLDetailsElement>('details.project-actions[open]'))
        if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) d.open = false
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [])

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
      <span className="save-status">{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : ''}</span>
      <span className="save-status save-failed" aria-live="polite">
        {saveState === 'failed' ? 'Not saved — retrying' : ''}
      </span>
      <details className="project-actions" ref={menu}>
        <summary className="menu-button">File</summary>
        <div className="menu" onClick={() => menu.current?.removeAttribute('open')}>
          <button onClick={() => void createProject()}>New project</button>
          <OpenFileButton>Open file…</OpenFileButton>
          <button onClick={() => downloadProject(useAppStore.getState().project)}>Save as file</button>
        </div>
      </details>
    </div>
  )
}
