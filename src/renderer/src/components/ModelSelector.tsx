/**
 * ModelSelector Component — اختيار النموذج من 18 نموذجاً
 * مستخرج من App.tsx (P1-01)
 */
import { useState, useEffect, useRef, useId, memo } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ProviderSettings } from '../../../shared/types'
import { GO_MODELS } from '../../../shared/models'

interface ModelSelectProps {
  provider: ProviderSettings
  change(id: string): void
  small?: boolean
}

const MemoModelSelect = memo(function ModelSelect({ provider, change, small = false }: ModelSelectProps) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const menuId = useId()
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const btn = btnRef.current
      if (!btn) return
      const rect = btn.getBoundingClientRect()
      const margin = 8; const gap = 8; const preferredHeight = 360
      const width = Math.min(Math.max(300, rect.width), window.innerWidth - margin * 2)
      const above = rect.top - margin - gap; const below = window.innerHeight - rect.bottom - margin - gap
      const openAbove = above >= preferredHeight || above > below
      const maxHeight = Math.max(120, Math.min(preferredHeight, openAbove ? above : below))
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin)
      setMenuPos({ top: openAbove ? Math.max(margin, rect.top - gap - maxHeight) : rect.bottom + gap, left, width, maxHeight })
    }
    updatePosition()
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    const keyHandler = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); btnRef.current?.focus() } }
    document.addEventListener('keydown', keyHandler)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  const selected = GO_MODELS.find((m) => m.id === provider.model)

  return (
    <div className={`model-select ${small ? 'small' : ''}`}>
      <button ref={btnRef} className="model-select-btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)} type="button">
        <span className="model-dot" />
        <span>{selected?.name ?? provider.model}</span>
        <ChevronDown size={12} className={`chev ${open ? 'rot' : ''}`} />
      </button>
      {open && menuPos && (
        <div id={menuId} ref={menuRef} className="model-select-menu" role="listbox" style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width, maxHeight: menuPos.maxHeight }}>
          {GO_MODELS.map((model) => (
            <button key={model.id} role="option" aria-selected={model.id === provider.model} className={`model-select-item ${model.id === provider.model ? 'active' : ''}`} onClick={() => { change(model.id); setOpen(false) }} type="button">
              <span className="model-select-name">{model.name}</span>
              <span className="model-select-meta">{model.apiStyle === 'chat' ? 'Chat' : model.apiStyle === 'responses' ? 'Responses' : 'Anthropic'} · {(model.contextWindow / 1_000_000).toFixed(0)}M</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

export default MemoModelSelect
