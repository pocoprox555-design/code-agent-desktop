/**
 * CodeViewer — عارض أكواد احترافي مع CodeMirror 6
 * يعرض ملفات المشروع مع syntax highlighting وإحصائيات
 */
import { memo, useMemo, useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import type { BuildStats, ProjectFile } from '../../../shared/types'
import { FileText, Hash } from 'lucide-react'

interface Props {
  files: ProjectFile[]
  activeFilePath: string | null
  activeContent: string
  onSelectFile(path: string): void
  stats: BuildStats
}

function getLanguage(ext: string) {
  switch (ext) {
    case 'html': return html()
    case 'css': return css()
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return javascript({ typescript: ext === 'ts' || ext === 'tsx', jsx: ext === 'jsx' || ext === 'tsx' })
    default: return javascript()
  }
}

export const CodeViewer = memo(function CodeViewer({ files, activeFilePath, activeContent, onSelectFile, stats }: Props) {
  return (
    <div className="code-viewer">
      <div className="code-viewer-sidebar">
        <div className="code-viewer-stats">
          <span title="عدد الملفات"><FileText size={11} /> {files.length.toLocaleString('ar')} ملف</span>
          <span title="عدد الأسطر"><Hash size={11} /> {stats.lines.toLocaleString('ar')} سطر</span>
          <span title="الحجم">{formatSize(stats.size)}</span>
          {stats.truncated && <span title="تم الوصول إلى حد الفحص">محدود</span>}
        </div>
        <div className="code-viewer-files">
          {files.map((file) => (
            <button
              key={file.relativePath}
              className={`code-file-tab ${activeFilePath === file.relativePath ? 'active' : ''}`}
              onClick={() => onSelectFile(file.relativePath)}
              title={`${file.relativePath} (${file.lines.toLocaleString('ar')} سطر)`}
            >
              <span className="file-icon">{fileIcon(file.language)}</span>
              <span className="file-name">{file.name}</span>
              <span className="file-lines">{file.lines}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="code-viewer-editor">
        {activeFilePath ? (
          <CodeMirrorEditor content={activeContent} language={files.find(f => f.relativePath === activeFilePath)?.language ?? 'text'} />
        ) : (
          <div className="code-viewer-empty">
            <FileText size={32} />
            <p>اختر ملفًا من القائمة لعرض الكود</p>
          </div>
        )}
      </div>
    </div>
  )
})

function CodeMirrorEditor({ content, language }: { content: string; language: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  const ext = language === 'tsx' ? 'tsx' : language === 'jsx' ? 'jsx' : language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language

  useEffect(() => {
    if (!containerRef.current) return
    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        getLanguage(ext),
        oneDark,
        keymap.of([]),
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
      ],
    })

    const view = new EditorView({
      state,
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [content, ext])

  return <div ref={containerRef} className="codemirror-container" />
}

function fileIcon(language: string): string {
  switch (language) {
    case 'html': return '🌐'
    case 'css': return '🎨'
    case 'tsx': case 'jsx': return '⚛️'
    case 'typescript': case 'javascript': return '📜'
    case 'json': return '📋'
    case 'markdown': return '📝'
    case 'svg': return '🖼'
    default: return '📄'
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
