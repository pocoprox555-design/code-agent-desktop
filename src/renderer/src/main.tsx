import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './i18n' // i18next — يدعم العربية والإنجليزية
import './styles/tokens.css' // Design tokens — سمة داكنة/فاتحة
import './styles.css'
import '@xterm/xterm/css/xterm.css'
import 'allotment/dist/style.css'

// i18n يتولى RTL/LTR تلقائيًا بعد التهيئة
if (!document.documentElement.dir) document.documentElement.dir = 'rtl'
if (!document.documentElement.lang) document.documentElement.lang = 'ar'

// P3-03: كشف السمة مبكراً قبل تحميل React (يمنع وميض السمة)
const storedTheme = localStorage.getItem('code-agent-theme')
const systemDark = !window.matchMedia('(prefers-color-scheme: light)').matches
document.documentElement.setAttribute('data-theme', storedTheme === 'light' ? 'light' : storedTheme === 'dark' ? 'dark' : systemDark ? 'dark' : 'light')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
