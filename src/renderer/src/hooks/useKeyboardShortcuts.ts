/**
 * Keyboard Shortcuts Hook (P3-02)
 * اختصارات لوحة مفاتيح على مستوى التطبيق
 */
import { useEffect } from 'react'

export interface ShortcutHandlers {
  /** ⌘K — فتح لوحة الأوامر */
  onCommandPalette?: () => void
  /** ⌘L — مسح الدردشة */
  onClearChat?: () => void
  /** ⌘/ — تبديل الشريط الجانبي */
  onToggleSidebar?: () => void
  /** ⌘⇧N — جلسة جديدة */
  onNewSession?: () => void
  /** ⌘⇧R — استئناف */
  onResume?: () => void
  /** ⌘. — إلغاء */
  onCancel?: () => void
  /** ⌘⇧P — تبديل Plan/Build */
  onTogglePlanMode?: () => void
  /** Escape — إغلاق الحوارات */
  onEscape?: () => void
}

/** اكتشاف مفتاح Meta (⌘ على Mac، Ctrl على Windows/Linux) */
function isModKey(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // لا نعترض الاختصارات داخل الحقول النصية
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      // ⌘K / Ctrl+K — Command Palette (يعمل حتى داخل الحقول)
      if (isModKey(e) && e.key === 'k' && !e.shiftKey) {
        e.preventDefault()
        handlers.onCommandPalette?.()
        return
      }

      // لا نعترض باقي الاختصارات داخل الحقول
      if (isInput) return

      // ⌘L — مسح الدردشة
      if (isModKey(e) && e.key === 'l' && !e.shiftKey) {
        e.preventDefault()
        handlers.onClearChat?.()
        return
      }

      // ⌘/ — تبديل الشريط الجانبي
      if (isModKey(e) && e.key === '/') {
        e.preventDefault()
        handlers.onToggleSidebar?.()
        return
      }

      // ⌘⇧N — جلسة جديدة
      if (isModKey(e) && e.shiftKey && e.key === 'N') {
        e.preventDefault()
        handlers.onNewSession?.()
        return
      }

      // ⌘⇧R — استئناف
      if (isModKey(e) && e.shiftKey && e.key === 'R') {
        e.preventDefault()
        handlers.onResume?.()
        return
      }

      // ⌘. — إلغاء
      if (isModKey(e) && e.key === '.') {
        e.preventDefault()
        handlers.onCancel?.()
        return
      }

      // ⌘⇧P — تبديل Plan/Build
      if (isModKey(e) && e.shiftKey && e.key === 'P') {
        e.preventDefault()
        handlers.onTogglePlanMode?.()
        return
      }

      // Escape — إغلاق الحوارات
      if (e.key === 'Escape') {
        handlers.onEscape?.()
        return
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [handlers])
}
