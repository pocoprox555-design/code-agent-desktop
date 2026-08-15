/**
 * FileSidebar — قائمة ملفات جانبية ضيقة قابلة للفتح/الغلق
 * عند فتحها: تعرض الملفات مع أيقونات وأسطر
 * عند غلقها: أيقونة 📁 فقط
 */
import { memo, useState } from 'react'
import { Files, ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { ProjectFile } from '../../../shared/types'

interface Props {
  files: ProjectFile[]
  activeFile: string | null
  onSelectFile(path: string): void
}

function fileIcon(lang: string): string {
  const m: Record<string, string> = { html: '🌐', css: '🎨', tsx: '⚛️', jsx: '⚛️', typescript: '📜', javascript: '📜', json: '📋', markdown: '📝', svg: '🖼' }
  return m[lang] ?? '📄'
}

export const FileSidebar = memo(function FileSidebar({ files, activeFile, onSelectFile }: Props) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <div className="filesidebar filesidebar-closed">
        <button className="filesidebar-toggle" onClick={() => setOpen(true)} title="إظهار الملفات">
          <Files size={18} />
          <span className="filesidebar-count">{files.length}</span>
        </button>
      </div>
    )
  }

  return (
    <div className="filesidebar filesidebar-open">
      <div className="filesidebar-head">
        <span className="filesidebar-title">الملفات</span>
        <span className="filesidebar-count-badge">{files.length}</span>
        <button className="filesidebar-close" onClick={() => setOpen(false)} title="إخفاء">
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="filesidebar-list">
        {files.map((f) => (
          <button key={f.relativePath} type="button" className={`filesidebar-item ${activeFile === f.relativePath ? 'active' : ''}`} title={`${f.relativePath}\n${f.lines.toLocaleString('ar')} سطر`} onClick={() => onSelectFile(f.relativePath)}>
            <span className="filesidebar-item-icon">{fileIcon(f.language)}</span>
            <span className="filesidebar-item-name">{f.name}</span>
            <span className="filesidebar-item-lines">{f.lines}</span>
          </button>
        ))}
      </div>
    </div>
  )
})
