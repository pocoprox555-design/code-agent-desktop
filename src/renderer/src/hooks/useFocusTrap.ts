import { useEffect, type RefObject } from 'react'

/** حبس التركيز داخل عنصر (focus trap) — للنوافذ المنبثقة */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return
    const root = ref.current
    const focusable = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const first = root.querySelector<HTMLElement>(focusable)
    first?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const items = root.querySelectorAll<HTMLElement>(focusable)
      if (!items.length) return
      const first = items[0]!
      const last = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [active])
}
