/**
 * Command Palette — Cmd+K (P3-01)
 * لوحة أوامر سريعة بتقنية fuzzy search
 * تفتح بـ ⌘K أو Ctrl+K
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Bot, Code2, FolderOpen, KeyRound, ListChecks, Play, Search, Settings, Shield, Square, Terminal, Trash2, X } from 'lucide-react'
import { GO_MODELS } from '../../../shared/models'
import type { Session, ProviderSettings } from '../../../shared/types'

export interface CommandAction {
  id: string
  label: string
  description?: string
  icon: React.ReactNode
  keywords?: string[]
  action: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  actions: CommandAction[]
  /** إجراءات إضافية للبحث عن الملفات */
  onSearchFiles?: (query: string) => Promise<Array<{ path: string; action: () => void }>>
}

export function CommandPalette({ open, onClose, actions, onSearchFiles }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [fileResults, setFileResults] = useState<Array<{ path: string; action: () => void }>>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter actions by fuzzy search
  const filtered = query.trim()
    ? actions.filter((a) => {
        const lower = query.toLowerCase()
        return (
          a.label.toLowerCase().includes(lower) ||
          a.description?.toLowerCase().includes(lower) ||
          a.keywords?.some((k) => k.toLowerCase().includes(lower))
        )
      })
    : actions

  const allItems = [...filtered, ...fileResults.map((f) => ({
    id: `file:${f.path}`,
    label: f.path,
    description: 'فتح ملف',
    icon: <Code2 size={14} />,
    action: f.action,
  } as CommandAction))]

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setFileResults([])
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Keyboard navigation
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, allItems.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && allItems[selectedIndex]) {
        e.preventDefault()
        allItems[selectedIndex]!.action()
        onClose()
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, selectedIndex, allItems, onClose])

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // File search debounce
  useEffect(() => {
    if (!onSearchFiles || query.length < 2) {
      setFileResults([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        const results = await onSearchFiles(query)
        setFileResults(results.slice(0, 5))
      } catch { setFileResults([]) }
    }, 300)
    return () => clearTimeout(timer)
  }, [query, onSearchFiles])

  if (!open) return null

  return (
    <div className="cmd-backdrop" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-input-wrap">
          <Search size={16} className="cmd-search-icon" />
          <input
            ref={inputRef}
            className="cmd-input"
            placeholder="اكتب أمرًا... (بحث عن إجراء، نموذج، ملف)"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
          />
          <kbd className="cmd-kbd">esc</kbd>
        </div>
        <div ref={listRef} className="cmd-list">
          {allItems.length === 0 && (
            <div className="cmd-empty">لا توجد نتائج</div>
          )}
          {allItems.map((item, index) => (
            <button
              key={item.id}
              className={`cmd-item ${index === selectedIndex ? 'selected' : ''}`}
              onClick={() => { item.action(); onClose() }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="cmd-item-icon">{item.icon}</span>
              <span className="cmd-item-label">{item.label}</span>
              {item.description && (
                <span className="cmd-item-desc">{item.description}</span>
              )}
            </button>
          ))}
        </div>
        <div className="cmd-footer">
          <span><kbd>↑↓</kbd> تنقل</span>
          <span><kbd>↵</kbd> تنفيذ</span>
          <span><kbd>esc</kbd> إغلاق</span>
        </div>
      </div>
    </div>
  )
}

/**
 * إنشاء قائمة الإجراءات الافتراضية للوحة الأوامر
 */
export function createDefaultActions(
  active: Session | null,
  provider: ProviderSettings,
  callbacks: {
    newSession: () => void
    openSettings: () => void
    togglePlanMode: () => void
    toggleFullAccess: () => void
    cancel: () => void
    resume: () => void
    clearAll: () => void
    changeModel: (id: string) => void
  },
): CommandAction[] {
  const actions: CommandAction[] = [
    {
      id: 'new-session',
      label: 'جلسة جديدة',
      description: 'افتح مشروعًا جديدًا وابدأ محادثة',
      icon: <FolderOpen size={14} />,
      keywords: ['new', 'session', 'project', 'open', 'جديد', 'مشروع', 'جلسة', 'فتح'],
      action: callbacks.newSession,
    },
    {
      id: 'settings',
      label: 'الإعدادات',
      description: 'تغيير النموذج أو مفتاح API',
      icon: <Settings size={14} />,
      keywords: ['settings', 'config', 'api', 'key', 'model', 'إعدادات', 'نموذج', 'مفتاح'],
      action: callbacks.openSettings,
    },
  ]

  if (active) {
    actions.push(
      {
        id: 'toggle-plan',
        label: active.agentMode === 'plan' ? 'تبديل إلى Build' : 'تبديل إلى Plan',
        description: active.agentMode === 'plan' ? 'السماح بالتعديل والتنفيذ' : 'التحليل والقراءة فقط',
        icon: <ListChecks size={14} />,
        keywords: ['plan', 'build', 'mode', 'تخطيط', 'بناء', 'وضع'],
        action: callbacks.togglePlanMode,
      },
      {
        id: 'toggle-access',
        label: active.permissionMode === 'full' ? 'تبديل إلى وضع اسألني' : 'تبديل إلى وصول كامل',
        description: active.permissionMode === 'full' ? 'طلب الموافقة قبل كل عملية' : 'تنفيذ مباشر دون موافقة',
        icon: <Shield size={14} />,
        keywords: ['access', 'permission', 'full', 'ask', 'وصول', 'صلاحية', 'موافقة'],
        action: callbacks.toggleFullAccess,
      },
      {
        id: 'cancel',
        label: 'إيقاف التنفيذ',
        description: 'إلغاء تشغيل الوكيل الحالي',
        icon: <Square size={14} />,
        keywords: ['cancel', 'stop', 'abort', 'إيقاف', 'إلغاء'],
        action: callbacks.cancel,
      },
      {
        id: 'resume',
        label: 'استئناف التنفيذ',
        description: 'متابعة التشغيل من السياق المحفوظ',
        icon: <Play size={14} />,
        keywords: ['resume', 'continue', 'استئناف', 'متابعة'],
        action: callbacks.resume,
      },
      {
        id: 'clear',
        label: 'مسح جميع المحادثات',
        description: 'حذف كل الجلسات نهائيًا',
        icon: <Trash2 size={14} />,
        keywords: ['clear', 'delete', 'all', 'مسح', 'حذف', 'كل'],
        action: callbacks.clearAll,
      },
    )

    // نموذج سريع لكل نموذج
    for (const model of GO_MODELS.slice(0, 8)) {
      actions.push({
        id: `model:${model.id}`,
        label: `النموذج: ${model.name}`,
        description: `${model.apiStyle} · ${(model.contextWindow / 1_000_000).toFixed(0)}M سياق`,
        icon: <Bot size={14} />,
        keywords: [model.id, model.name, 'model', 'نموذج'],
        action: () => callbacks.changeModel(model.id),
      })
    }
  }

  return actions
}
