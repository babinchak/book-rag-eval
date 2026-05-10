import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import RootErrorBoundary from './components/RootErrorBoundary'
import { installGlobalErrorReporters } from './lib/log'
import { applyThemeToDOM } from './lib/theme'

// Apply saved theme before first render to prevent flash
applyThemeToDOM((localStorage.getItem('theme-mode') as 'light' | 'dark' | 'system') ?? 'system')

installGlobalErrorReporters()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>
)
