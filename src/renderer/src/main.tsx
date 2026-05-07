import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyThemeToDOM } from './lib/theme'

// Apply saved theme before first render to prevent flash
applyThemeToDOM((localStorage.getItem('theme-mode') as 'light' | 'dark' | 'system') ?? 'system')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
