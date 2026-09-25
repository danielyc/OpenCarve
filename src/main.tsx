import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Home from './Home'
import { boot } from './lib/persist'
import { useAppStore } from './store'
import './styles.css'

// The editor remounts per project so its view refits and per-project UI state starts fresh.
function Root() {
  const screen = useAppStore((s) => s.screen)
  const id = useAppStore((s) => s.project.id)
  return screen === 'home' ? <Home /> : <App key={id} />
}

void boot().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  ),
)
