/**
 * ModelSelector Component — اختيار النموذج من القائمة
 * يدعم النماذج الافتراضية + المزودات المخصصة
 */
import { useState, useEffect, useRef, useId, memo, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ProviderSettings, CustomProviderSettings } from '../../../shared/types'
import { GO_MODELS } from '../../../shared/models'

interface ModelSelectProps {
  provider: ProviderSettings
  change(id: string): void
  small?: boolean
}

// Custom model ID format: "custom:{providerId}:{modelId}"
export function isCustomModelId(id: string): boolean {
  return id.startsWith('custom:')
}

export function parseCustomModelId(id: string): { providerId: string; modelId: string } | null {
  const parts = id.split(':')
  if (parts.length !== 3 || parts[0] !== 'custom' || !parts[1] || !parts[2]) return null
  return { providerId: parts[1], modelId: parts[2] }
}

export function buildCustomModelId(providerId: string, modelId: string): string {
  return `custom:${providerId}:${modelId}`
}

const MemoModelSelect = memo(function ModelSelect({ provider, change, small = false }: ModelSelectProps) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const [customProviders, setCustomProviders] = useState<CustomProviderSettings[]>([])
  const menuId = useId()
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.rCode.customProviders.list().then(setCustomProviders).catch(() => {})
  }, [])

  // إعادة جلب المزودات المخصصة عند كل فتح للقائمة (لأنها قد تتغير من الإعدادات)
  const toggleOpen = useCallback(() => {
    if (!open) {
      void window.rCode.customProviders.list().then(setCustomProviders).catch(() => {})
    }
    setOpen((prev) => !prev)
  }, [open])

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

  const getSelectedName = useCallback(() => {
    if (isCustomModelId(provider.model)) {
      const parsed = parseCustomModelId(provider.model)
      if (parsed) {
        const cp = customProviders.find((p) => p.id === parsed.providerId)
        const cm = cp?.models.find((m) => m.id === parsed.modelId)
        if (cp && cm) return `${cp.name} / ${cm.modelId}`
      }
    }
    return GO_MODELS.find((m) => m.id === provider.model)?.name ?? provider.model
  }, [provider.model, customProviders])

  const hasCustomModels = customProviders.some((p) => p.models.length > 0)

  return (
    <div className={`model-select ${small ? 'small' : ''}`}>
      <button ref={btnRef} className="model-select-btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={toggleOpen} type="button">
        <span className="model-dot" />
        <span>{getSelectedName()}</span>
        <ChevronDown size={12} className={`chev ${open ? 'rot' : ''}`} />
      </button>
      {open && menuPos && (
        <div id={menuId} ref={menuRef} className="model-select-menu" role="listbox" style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width, maxHeight: menuPos.maxHeight }}>
          {/* OpenCode Go Models */}
          {GO_MODELS.map((model) => (
            <button key={model.id} role="option" aria-selected={model.id === provider.model} className={`model-select-item ${model.id === provider.model ? 'active' : ''}`} onClick={() => { change(model.id); setOpen(false) }} type="button">
              <span className="model-select-name">{model.name}</span>
              <span className="model-select-meta">{model.apiStyle === 'chat' ? 'Chat' : model.apiStyle === 'responses' ? 'Responses' : 'Anthropic'} · {(model.contextWindow / 1_000_000).toFixed(0)}M</span>
            </button>
          ))}

          {/* Custom Provider Models */}
          {hasCustomModels && (
            <>
              <div className="model-select-divider">المزودات المخصصة</div>
              {customProviders.map((cp) =>
                cp.models.map((cm) => {
                  const customId = buildCustomModelId(cp.id, cm.id)
                  return (
                    <button key={customId} role="option" aria-selected={customId === provider.model} className={`model-select-item ${customId === provider.model ? 'active' : ''}`} onClick={() => { change(customId); setOpen(false) }} type="button">
                      <span className="model-select-name">{cm.modelId}</span>
                      <span className="model-select-meta">{cp.name} · {cp.apiStyle === 'chat' ? 'Chat' : cp.apiStyle === 'anthropic' ? 'Anthropic' : 'Responses'} · {(cm.contextWindow / 1_000_000).toFixed(0)}M</span>
                    </button>
                  )
                })
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})

export default MemoModelSelect
