/**
 * DiffViewer Component (P3-07)
 * عرض الفروقات مع تظليل نحوي وأزرار قبول/رفض
 * يستخدم Shiki للتظليل عند توفره، ويقع على plain text
 */
import { memo, useEffect, useState } from 'react'
import { Check, X, ChevronDown, ChevronRight } from 'lucide-react'

interface DiffHunk {
  startLine: number
  lines: Array<{ type: 'add' | 'remove' | 'context'; line: number; content: string }>
}

interface DiffViewerProps {
  diff: string
  language?: string
  /** وضع العرض: unified (الافتراضي) أو split */
  mode?: 'unified' | 'split'
  /** إمكانية قبول/رفض كل hunk */
  interactive?: boolean
  onAcceptHunk?: (hunkIndex: number) => void
  onRejectHunk?: (hunkIndex: number) => void
}

function parseDiff(diff: string): DiffHunk[] {
  const lines = diff.split(/\r?\n/)
  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null
  let lineCounter = 0

  for (const line of lines) {
    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line)
    if (hunkMatch) {
      if (currentHunk && currentHunk.lines.length) hunks.push(currentHunk)
      currentHunk = { startLine: Number(hunkMatch[2]), lines: [] }
      lineCounter = Number(hunkMatch[2]) - 1
      continue
    }

    if (!currentHunk) continue

    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineCounter++
      currentHunk.lines.push({ type: 'add', line: lineCounter, content: line.slice(1) })
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentHunk.lines.push({ type: 'remove', line: 0, content: line.slice(1) })
    } else {
      lineCounter++
      if (line.startsWith(' ')) {
        currentHunk.lines.push({ type: 'context', line: lineCounter, content: line.slice(1) })
      } else {
        currentHunk.lines.push({ type: 'context', line: lineCounter, content: line })
      }
    }
  }

  if (currentHunk && currentHunk.lines.length) hunks.push(currentHunk)
  return hunks
}

const MemoDiffViewer = memo(function DiffViewer({
  diff,
  language = 'text',
  mode = 'unified',
  interactive = false,
  onAcceptHunk,
  onRejectHunk,
}: DiffViewerProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const hunks = parseDiff(diff)

  if (!hunks.length) {
    return <pre className="diff-empty">لا توجد فروقات لعرضها</pre>
  }

  function toggleCollapse(hunkIndex: number) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(hunkIndex)) next.delete(hunkIndex)
      else next.add(hunkIndex)
      return next
    })
  }

  const addedCount = hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === 'add').length, 0)
  const removedCount = hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === 'remove').length, 0)

  return (
    <div className="diff-viewer" dir="ltr">
      <div className="diff-header">
        <span className="diff-stat" title="الأسطر المضافة">
          <span className="diff-added-count">+{addedCount}</span>
        </span>
        <span className="diff-stat" title="الأسطر المحذوفة">
          <span className="diff-removed-count">-{removedCount}</span>
        </span>
        <span className="diff-hunks-count">{hunks.length} كتلة</span>
      </div>
      <div className="diff-body">
        {hunks.map((hunk, hunkIndex) => {
          const isCollapsed = collapsed.has(hunkIndex)
          const firstContext = hunk.lines.find((l) => l.type === 'context')
          const preview = firstContext?.content.slice(0, 80) ?? `@@ السطر ${hunk.startLine}`

          return (
            <div key={hunkIndex} className={`diff-hunk ${isCollapsed ? 'collapsed' : ''}`}>
              <div className="diff-hunk-header">
                <button className="diff-hunk-toggle" onClick={() => toggleCollapse(hunkIndex)}>
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
                <span className="diff-hunk-preview">{preview}</span>
                <span className="diff-hunk-range">+{hunk.startLine}</span>
                {interactive && (
                  <div className="diff-hunk-actions">
                    <button
                      className="diff-accept-btn"
                      title="قبول هذا التعديل"
                      onClick={() => onAcceptHunk?.(hunkIndex)}
                    >
                      <Check size={12} /> قبول
                    </button>
                    <button
                      className="diff-reject-btn"
                      title="رفض هذا التعديل"
                      onClick={() => onRejectHunk?.(hunkIndex)}
                    >
                      <X size={12} /> رفض
                    </button>
                  </div>
                )}
              </div>
              {!isCollapsed && (
                <div className="diff-hunk-lines">
                  {hunk.lines.map((line, lineIndex) => (
                    <div
                      key={lineIndex}
                      className={`diff-line ${line.type}`}
                    >
                      <span className="diff-line-number">
                        {line.type === 'remove' ? ' ' : line.line}
                      </span>
                      <span className="diff-line-sign">
                        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                      </span>
                      <span className="diff-line-content">{line.content}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default MemoDiffViewer
export { MemoDiffViewer as DiffViewer }
