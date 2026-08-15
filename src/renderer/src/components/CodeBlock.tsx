/**
 * CodeBlock — Syntax Highlighting with Shiki (P1-04)
 * يستبدل CodeBlock الحالي في App.tsx مع تظليل نحوي كامل
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface CodeBlockProps {
  language: string
  code: string
}

// Lazy load Shiki — يحمّل فقط عند الحاجة
let highlighterPromise: Promise<{ codeToHtml(code: string, options: { lang: string; theme: string }): Promise<string> }> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(async ({ codeToHtml }) => {
      // Shiki v3+ has built-in themes and langs — pre-warm with common langs
      return { codeToHtml }
    })
  }
  return highlighterPromise
}

// Fallback: تظليل CSS خفيف عندما لا يكون Shiki محمّلاً بعد
function plainCodeBlock(language: string, code: string): string {
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return `<pre><code class="language-${language}">${escaped}</code></pre>`
}

const MemoCodeBlock = memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const cacheKey = `${language}:${code.slice(0, 200)}:${code.length}`

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setLoadError(false)

    if (!code.trim()) {
      setHtml('')
      return
    }

    // تجربة Shiki أولاً
    getHighlighter()
      .then(async (hl) => {
        if (cancelled) return
        try {
          const result = await hl.codeToHtml(code, {
            lang: language || 'text',
            theme: 'dark-plus', // matches dark theme
          })
          if (!cancelled) setHtml(result)
        } catch {
          // فشل Shiki، استخدم fallback
          if (!cancelled) {
            setHtml(plainCodeBlock(language, code))
            setLoadError(true)
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHtml(plainCodeBlock(language, code))
          setLoadError(true)
        }
      })

    return () => { cancelled = true }
  }, [cacheKey])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // fallback copy via IPC
      try {
        await (window as any).rCode?.clipboard?.writeText(code)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } catch { /* لا يمكن النسخ */ }
    }
  }

  return (
    <div className="code-block" dir="ltr">
      <div className="code-head">
        <span>
          <span className="code-lang-dot" />
          {language}
          {loadError && <span className="code-fallback-badge" title="تظليل خفيف — حمّل Shiki"> ⚡</span>}
        </span>
        <button aria-label={copied ? t('message.copied') : t('message.copy')} onClick={() => void copy()}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {' '}
          {copied ? t('message.copied') : t('message.copy')}
        </button>
      </div>
      {html ? (
        <div
          className="shiki-wrapper"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre><code>{code}</code></pre>
      )}
    </div>
  )
})

export default MemoCodeBlock
export { MemoCodeBlock as CodeBlock }
