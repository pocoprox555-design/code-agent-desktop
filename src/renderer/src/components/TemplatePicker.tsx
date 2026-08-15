/**
 * TemplatePicker — شاشة اختيار القالب عند بدء مشروع جديد
 */
import { memo, useState } from 'react'
import type { TemplateInfo } from '../../../shared/types'
import { Layout, Braces, Globe, ArrowLeft, LoaderCircle } from 'lucide-react'

interface Props {
  templates: TemplateInfo[]
  onSelect(templateId: string, projectName: string): void
  onBack(): void
  isCreating: boolean
}

export const TemplatePicker = memo(function TemplatePicker({ templates, onSelect, onBack, isCreating }: Props) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  function handleCreate() {
    if (!selected || !name.trim()) return
    onSelect(selected, name.trim())
  }

  return (
    <div className="template-picker">
      <div className="template-picker-head">
        <button className="template-back" onClick={onBack}>
          <ArrowLeft size={14} /> رجوع
        </button>
        <h2>أنشئ مشروعًا جديدًا</h2>
        <p>اختر قالبًا وأدخل اسم المشروع للبدء</p>
      </div>

      <div className="template-grid">
        {templates.map((tpl) => (
          <button
            key={tpl.id}
            className={`template-card ${selected === tpl.id ? 'selected' : ''}`}
            onClick={() => setSelected(tpl.id)}
          >
            <span className="template-icon">{tpl.icon}</span>
            <div className="template-info">
              <strong>{tpl.name}</strong>
              <small>{tpl.description}</small>
            </div>
            <div className="template-tags">
              {tpl.tags.map((tag) => (
                <span key={tag} className="template-tag">{tag}</span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="template-create-form">
          <label className="template-label">
            اسم المشروع
            <input
              className="template-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-awesome-site"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
            />
          </label>
          <button
            className="template-create-btn"
            onClick={handleCreate}
            disabled={!name.trim() || isCreating}
          >
            {isCreating ? <><LoaderCircle size={14} className="spin" /> جارٍ الإنشاء...</> : <><Layout size={14} /> إنشاء المشروع</>}
          </button>
        </div>
      )}
    </div>
  )
})
