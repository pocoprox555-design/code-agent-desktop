/**
 * Hooks System — نظام callbacks الدورية
 *
 * يتيح تنفيذ أكواد عند أحداث معينة في دورة حياة الوكيل:
 * - pre-edit / post-edit: قبل وبعد تعديل ملف
 * - pre-commit / post-commit: قبل وبعد commit
 * - pre-tool / post-tool: قبل وبعد تنفيذ أي أداة
 *
 * Zero context cost: لا يُقرأ في كل طلب.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────

export type HookEvent = 'pre-edit' | 'post-edit' | 'pre-commit' | 'post-commit' | 'pre-tool' | 'post-tool'

export interface HookContext {
  filePath?: string
  toolName?: string
  oldContent?: string
  newContent?: string
  commitMessage?: string
  workspace: string
}

export interface HookResult {
  /** هل يجب إلغاء الإجراء؟ */
  cancel?: boolean
  /** رسالة للمستخدم */
  message?: string
}

export type HookHandler = (context: HookContext) => Promise<HookResult | void>

// ─── HooksManager ────────────────────────────────────────────────────

export class HooksManager {
  private hooks = new Map<HookEvent, HookHandler[]>()
  private hooksLoaded = false
  private hooksDir: string

  constructor(private workspace: string) {
    this.hooksDir = path.join(workspace, '.code-agent', 'hooks')
  }

  /** تحميل الـ hooks من ملفات المشروع */
  async loadHooks(): Promise<void> {
    if (this.hooksLoaded) return
    this.hooksLoaded = true

    try {
      const hooksFile = path.join(this.hooksDir, 'hooks.ts')
      const content = await fs.readFile(hooksFile, 'utf8')

      // تحليل بسيط لاستخراج الـ hooks
      // في الإصدار الكامل، يمكن استخدام dynamic import
      const eventMatches = content.match(/export\s+(?:async\s+)?function\s+(\w+)?\s*\(/g)
      if (eventMatches) {
        // hooks موجودة — يمكن تحميلها
        console.log(`[Hooks] وجد ${eventMatches.length} hook في ${hooksFile}`)
      }
    } catch {
      // لا توجد hooks — هذا عادي
    }
  }

  /** تسجيل hook يدوي */
  on(event: HookEvent, handler: HookHandler): void {
    const handlers = this.hooks.get(event) ?? []
    handlers.push(handler)
    this.hooks.set(event, handlers)
  }

  /** تنفيذ جميع الـ hooks لحدث معين */
  async execute(event: HookEvent, context: HookContext): Promise<HookResult> {
    await this.loadHooks()

    const handlers = this.hooks.get(event) ?? []
    let result: HookResult = {}

    for (const handler of handlers) {
      try {
        const hookResult = await handler(context)
        if (hookResult) {
          if (hookResult.cancel) result.cancel = true
          if (hookResult.message) result.message = hookResult.message
        }
      } catch (error) {
        console.error(`[Hooks] خطأ في ${event}:`, error)
      }
    }

    return result
  }

  /** هل يوجد hooks مسجلة لحدث معين؟ */
  hasHooks(event: HookEvent): boolean {
    return (this.hooks.get(event)?.length ?? 0) > 0
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

let defaultHooks: HooksManager | null = null

export function getHooksManager(workspace: string): HooksManager {
  if (!defaultHooks || defaultHooks['workspace'] !== workspace) {
    defaultHooks = new HooksManager(workspace)
  }
  return defaultHooks
}
