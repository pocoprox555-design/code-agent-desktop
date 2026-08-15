/**
 * Theme Hook — تبديل السمة (P3-03)
 * يكتشف تفضيل النظام ويسمح بالتبديل بين داكن وفاتح
 */
import { useState, useEffect, useCallback } from 'react'

export type Theme = 'dark' | 'light'

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function getStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem('code-agent-theme')
    if (stored === 'dark' || stored === 'light') return stored
  } catch {}
  return null
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme() ?? getSystemTheme())

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('code-agent-theme', theme) } catch {}
  }, [theme])

  // استمع لتغير تفضيل النظام
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = (e: MediaQueryListEvent) => {
      // فقط إذا لم يختر المستخدم يدوياً
      if (!getStoredTheme()) {
        setThemeState(e.matches ? 'light' : 'dark')
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => prev === 'dark' ? 'light' : 'dark')
  }, [])

  const isDark = theme === 'dark'

  return { theme, isDark, toggleTheme, setTheme: setThemeState }
}
