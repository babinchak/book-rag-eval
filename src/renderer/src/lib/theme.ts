import { useEffect, useMemo, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

export const cv = {
  bg: 'var(--c-bg)',
  surface: 'var(--c-surface)',
  surface2: 'var(--c-surface-2)',
  border: 'var(--c-border)',
  border2: 'var(--c-border-2)',
  border3: 'var(--c-border-3)',
  text1: 'var(--c-text-1)',
  text2: 'var(--c-text-2)',
  text3: 'var(--c-text-3)',
  text4: 'var(--c-text-4)',
  text5: 'var(--c-text-5)',
  accent: 'var(--c-accent)',
  accentText: 'var(--c-accent-text)',
  danger: 'var(--c-danger)',
  dangerBorder: 'var(--c-danger-border)',
  successBg: 'var(--c-success-bg)',
  successBorder: 'var(--c-success-border)',
  successText: 'var(--c-success-text)',
  successStrong: 'var(--c-success-strong)',
  warningBg: 'var(--c-warning-bg)',
  warningBorder: 'var(--c-warning-border)',
  warningText: 'var(--c-warning-text)',
  errorBg: 'var(--c-error-bg)',
  errorBorder: 'var(--c-error-border)',
  errorText: 'var(--c-error-text)',
  selectedBg: 'var(--c-selected-bg)',
  selectedBorder: 'var(--c-selected-border)',
  goldBg: 'var(--c-gold-bg)',
  goldBorder: 'var(--c-gold-border)',
  overlay: 'var(--c-overlay)',
  hit1: 'var(--c-hit-1)',
  hit3: 'var(--c-hit-3)',
  hitK: 'var(--c-hit-k)',
  miss: 'var(--c-miss)',
} as const

function getEffective(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyThemeToDOM(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', getEffective(mode))
}

export function useTheme(): { mode: ThemeMode; setMode: (m: ThemeMode) => void; isDark: boolean } {
  const [mode, setModeState] = useState<ThemeMode>(
    () => (localStorage.getItem('theme-mode') as ThemeMode) ?? 'system'
  )

  const isDark = useMemo(() => getEffective(mode) === 'dark', [mode])

  useEffect(() => {
    applyThemeToDOM(mode)
    localStorage.setItem('theme-mode', mode)
    if (mode !== 'system') return undefined
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => applyThemeToDOM('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [mode])

  return { mode, setMode: setModeState, isDark }
}
