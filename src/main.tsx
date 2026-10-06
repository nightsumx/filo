import { configure } from 'mobx'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initTheme } from './lib/theme'
import { appStore } from './store/app'
import './styles/index.css'

// Async store methods mutate state after awaits; those writes are wrapped where they matter.
configure({ enforceActions: 'never' })
initTheme()

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
)

void appStore.init()

// Handle for inspecting state from DevTools (dev builds) and for end-to-end scripts (PI_GUI_TEST).
if (import.meta.env.DEV || new URLSearchParams(location.search).has('test'))
    (window as any).__app = appStore
