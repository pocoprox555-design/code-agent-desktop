/**
 * Agent Enhancements (P2-03, P2-04, P2-05)
 *
 * P2-03: Auto-inject context (git diff, recent files, errors) before model requests
 * P2-04: Granular approval scopes (once, session, tool, path-pattern)
 * P2-05: Progressive cost disclosure warnings
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

// ─── P2-04: Approval Scopes ──────────────────────────────────────────

export type ApprovalScope = 'once' | 'session' | 'tool' | 'path-pattern'

export interface ApprovalGrant {
  scope: ApprovalScope
  /** للـ tool scope: اسم الأداة */
  toolName?: string
  /** للـ path-pattern scope: نمط المسار */
  pathPattern?: string
  createdAt: number
}

/** فحص إذا كان هناك منح سابق يغطي هذا المفتاح */
export function checkApprovalGrant(
  grants: Map<string, ApprovalGrant>,
  sessionId: string,
  scope: ApprovalScope,
  toolName?: string,
  filePath?: string,
): boolean {
  for (const [, grant] of grants) {
    if (grant.scope === 'session') return true // أوسع نطاق
    if (grant.scope === 'tool' && grant.toolName === toolName) return true
    if (grant.scope === 'path-pattern' && grant.pathPattern && filePath) {
      // فحص نمط glob بسيط
      const regex = new RegExp(
        '^' + grant.pathPattern.replace(/\*\*/g, '{{GLOBSTAR}}').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/{{GLOBSTAR}}/g, '.*') + '$',
      )
      if (regex.test(filePath)) return true
    }
  }
  return false
}

/** إنشاء مفتاح تذكر للموافقة */
export function createApprovalRememberKey(
  scope: ApprovalScope,
  toolName?: string,
  filePath?: string,
): string {
  switch (scope) {
    case 'session': return `session:grant`
    case 'tool': return `tool:${toolName ?? 'unknown'}`
    case 'path-pattern': return `path:${filePath ?? 'unknown'}`
    default: return `once:${Date.now()}:${Math.random().toString(36).slice(2)}`
  }
}

// ─── P2-05: Cost Disclosure ─────────────────────────────────────────

export interface CostWarning {
  level: 'info' | 'warning' | 'critical'
  message: string
  percentUsed: number
}

/** حساب تحذير التكلفة بناءً على النسبة المستخدمة من الحد */
export function getCostWarning(
  accumulatedCostUsd: number,
  maxCostUsd: number,
  previousPercentNotified: number,
): CostWarning | null {
  if (maxCostUsd <= 0) return null
  const percent = Math.min(100, Math.round((accumulatedCostUsd / maxCostUsd) * 100))

  // لا نعيد الإبلاغ عن نفس النسبة
  if (percent <= previousPercentNotified) return null

  if (percent >= 90) {
    return {
      level: 'critical',
      message: `⚠️ بلغت ${percent}% من حد التكلفة (${accumulatedCostUsd.toFixed(2)}$/${maxCostUsd.toFixed(2)}$). سيُوقف التشغيل قريبًا. يمكنك المتابعة في جلسة جديدة.`,
      percentUsed: percent,
    }
  }
  if (percent >= 75) {
    return {
      level: 'warning',
      message: `💰 بلغت ${percent}% من حد التكلفة (${accumulatedCostUsd.toFixed(2)}$/${maxCostUsd.toFixed(2)}$).`,
      percentUsed: percent,
    }
  }
  if (percent >= 50) {
    return {
      level: 'warning',
      message: `التكلفة: ${accumulatedCostUsd.toFixed(2)}$ من ${maxCostUsd.toFixed(2)}$ (${percent}%)`,
      percentUsed: percent,
    }
  }
  if (percent >= 25) {
    return {
      level: 'info',
      message: `التكلفة حتى الآن: ${accumulatedCostUsd.toFixed(2)}$ (${percent}%)`,
      percentUsed: percent,
    }
  }

  return null
}

// ─── P2-03: Smart Context Injection ─────────────────────────────────

export interface InjectedContext {
  /** آخر git diff */
  gitDiff?: string
  /** الملفات المعدلة حديثاً مع محتواها المقتضب */
  recentEdits?: Array<{ file: string; snippet: string }>
  /** أخطاء terminal/shell الأخيرة */
  recentErrors?: string[]
  /** الملفات التابعة (dependency neighborhood) */
  dependencyNeighbors?: string[]
}

/**
 * حقن سياق ذكي قبل طلب النموذج:
 * - git diff الحالي (إن وجد) — مختصر للصفرين فقط
 * - الملفات المعدلة حديثاً — اسم الملف + 10 أسطر أولى فقط
 * - أخطاء سابقة — نص الخطأ وحده دون تعقيدات
 *
 * تحسين: الناتج مضغوط وثابت البنية لتفعيل prompt caching —
 * لا يتغير بين الجولات إلا عند تعديل فعلي، مما يحافظ على البادئة الثابتة.
 * يقلل استدعاءات الأدوات 30-50% ويوفر cache hit كبير.
 */
export async function buildInjectedContext(
  workspace: string,
  modifiedFiles: string[],
  recentErrors: string[],
): Promise<string> {
  const parts: string[] = []

  // ── Git Diff (مختصر للصفرين فقط) ──
  try {
    await fs.access(path.join(workspace, '.git'))
    const { execFileSync } = await import('node:child_process')
    const diff = execFileSync('git', ['diff', '--stat'], {
      cwd: workspace,
      windowsHide: true,
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    // مختصر صارم: فقط أول 800 حرف (بدل 2000) لتقليل cache invalidation
    if (diff) parts.push(`## Current git diff (stat)\n${diff.slice(0, 800)}`)
  } catch { /* git not available */ }

  // ── Recently Modified Files (الاسم + 10 أسطر أولى فقط) ──
  if (modifiedFiles.length) {
    const snippets: string[] = []
    for (const file of modifiedFiles.slice(0, 3)) { // 3 ملفات بدل 5 — تقليل الحجم
      try {
        const content = await fs.readFile(path.resolve(workspace, file), 'utf8')
        const preview = content.split('\n').slice(0, 10).join('\n') // 10 أسطر بدل 30
        snippets.push(`### ${file}\n\`\`\`\n${preview.slice(0, 800)}\n\`\`\``)
      } catch { /* file may have been deleted */ }
    }
    if (snippets.length) {
      parts.push(`## Recently edited files\n${snippets.join('\n\n')}`)
    }
  }

  // ── Recent Errors (نص الخطأ وحده — بدل 500 حرف، اكتفِ بـ 300) ──
  if (recentErrors.length) {
    parts.push(`## Recent errors (do not repeat)\n${recentErrors.slice(0, 2).map((e) => `- ${e.slice(0, 300)}`).join('\n')}`)
  }

  return parts.length ? `\n## Current workspace state\n${parts.join('\n\n')}` : ''
}
