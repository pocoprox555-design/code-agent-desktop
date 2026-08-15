/**
 * Code Review System — نظام مراجعة الكود
 *
 * يحلل التغييرات ويقدم ملاحظات:
 * - تحليل diff
 * - اكتشاف المشاكل الشائعة
 * - اقتراحات التحسين
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────

export interface ReviewIssue {
  file: string
  line: number
  severity: 'error' | 'warning' | 'info'
  category: string
  message: string
  suggestion?: string
}

export interface ReviewResult {
  filesReviewed: number
  issues: ReviewIssue[]
  summary: string
  score: number // 0-100
}

// ─── Rules ───────────────────────────────────────────────────────────

interface ReviewRule {
  name: string
  category: string
  severity: 'error' | 'warning' | 'info'
  check: (line: string, lineNum: number, file: string) => ReviewIssue | null
}

const REVIEW_RULES: ReviewRule[] = [
  // مشاكل أمنية
  {
    name: 'eval-usage',
    category: 'أمان',
    severity: 'error',
    check: (line, lineNum, file) => {
      if (/\beval\s*\(/.test(line)) {
        return { file, line: lineNum, severity: 'error', category: 'أمان', message: 'استخدام eval() خطير أمنيًا', suggestion: 'استخدم JSON.parse() أو طريقة آمنة أخرى' }
      }
      return null
    },
  },
  {
    name: 'console-log',
    category: 'جودة',
    severity: 'warning',
    check: (line, lineNum, file) => {
      if (/console\.(log|debug|info)\s*\(/.test(line)) {
        return { file, line: lineNum, severity: 'warning', category: 'جودة', message: 'console.log في كود الإنتاج', suggestion: 'استخدم logger أو احذفه' }
      }
      return null
    },
  },
  {
    name: 'todo-fixme',
    category: 'صيانة',
    severity: 'info',
    check: (line, lineNum, file) => {
      const match = line.match(/(?:TODO|FIXME|HACK|XXX)\s*[:：]?\s*(.*)/i)
      if (match) {
        return { file, line: lineNum, severity: 'info', category: 'صيانة', message: `ملاحظة معلقة: ${match[0].trim()}` }
      }
      return null
    },
  },
  {
    name: 'any-type',
    category: 'نوعية',
    severity: 'warning',
    check: (line, lineNum, file) => {
      if (file.endsWith('.ts') || file.endsWith('.tsx')) {
        if (/:\s*any\b/.test(line) && !line.includes('// @ts-ignore')) {
          return { file, line: lineNum, severity: 'warning', category: 'نوعية', message: 'استخدام نوع any', suggestion: 'حدد النوع بدلاً من any' }
        }
      }
      return null
    },
  },
  {
    name: 'empty-catch',
    category: 'جودة',
    severity: 'warning',
    check: (line, lineNum, file) => {
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
        return { file, line: lineNum, severity: 'warning', category: 'جودة', message: 'catch فارغ — الأخطاء تُبتلع بصمت', suggestion: 'أضف معالجة خطأ أو سجل الخطأ' }
      }
      return null
    },
  },
  {
    name: 'magic-number',
    category: 'صيانة',
    severity: 'info',
    check: (line, lineNum, file) => {
      if (/(?:if|while|for)\s*\(.*(?:===?|!==?|>=?|<=?)\s*(?:[2-9]\d{2,}|[1-9]\d{3,})\b/.test(line)) {
        return { file, line: lineNum, severity: 'info', category: 'صيانة', message: 'رقم سحري في شرط', suggestion: 'استخدم constant مع اسم وصفي' }
      }
      return null
    },
  },
  // قواعد إضافية
  {
    name: 'unused-import',
    category: 'صيانة',
    severity: 'warning',
    check: (line, lineNum, file) => {
      if ((file.endsWith('.ts') || file.endsWith('.tsx')) && /^import\s+.*\s+from\s+/.test(line.trim())) {
        const match = line.match(/import\s+\{([^}]+)\}\s+from/)
        if (match?.[1]) {
          const imports = match[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean)
          if (imports.length > 5) {
            return { file, line: lineNum, severity: 'warning', category: 'صيانة', message: `استيراد كبير (${imports.length} عناصر)`, suggestion: 'افصل الاستيرادات غير المستخدمة' }
          }
        }
      }
      return null
    },
  },
  {
    name: 'sync-fs',
    category: 'أداء',
    severity: 'warning',
    check: (line, lineNum, file) => {
      if (file.endsWith('.ts') && /require\(['"]node:fs['"]\)\.(statSync|readFileSync|writeFileSync|existsSync)/.test(line)) {
        return { file, line: lineNum, severity: 'warning', category: 'أداء', message: 'عملية ملف متزامنة', suggestion: 'استخدم fs.promises للعمليات غير المتزامنة' }
      }
      return null
    },
  },
  {
    name: 'hardcoded-secret',
    category: 'أمان',
    severity: 'error',
    check: (line, lineNum, file) => {
      if (/(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{20,}['"]/i.test(line)) {
        return { file, line: lineNum, severity: 'error', category: 'أمان', message: 'مفتاح أو سر مكتوب بالنص', suggestion: 'استخدم متغيرات البيئة أو نظام إدارة الأسرار' }
      }
      return null
    },
  },
  {
    name: 'deep-nesting',
    category: 'صيانة',
    severity: 'warning',
    check: (line, lineNum, file) => {
      const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
      if (indent >= 40) {
        return { file, line: lineNum, severity: 'warning', category: 'صيانة', message: 'تداخل عميق جدًا', suggestion: 'افصل الدالة أو استخدم early return' }
      }
      return null
    },
  },
]

// ─── Reviewer ────────────────────────────────────────────────────────

export class CodeReviewer {
  constructor(private workspace: string, private signal?: AbortSignal) {}

  /**
   * مراجعة ملف واحد
   */
  async reviewFile(filePath: string): Promise<ReviewIssue[]> {
    try {
      const content = await fs.readFile(filePath, 'utf8')
      const lines = content.split('\n')
      const issues: ReviewIssue[] = []

      for (let i = 0; i < lines.length; i++) {
        // فحص الإلغاء كل 100 سطر لتسريع الاستجابة
        if (i % 100 === 0 && this.signal?.aborted) break
        const line = lines[i]!
        for (const rule of REVIEW_RULES) {
          const issue = rule.check(line, i + 1, filePath)
          if (issue) issues.push(issue)
        }
      }

      return issues
    } catch {
      return []
    }
  }

  /**
   * مراجعة عدة ملفات
   */
  async reviewFiles(filePaths: string[]): Promise<ReviewResult> {
    const allIssues: ReviewIssue[] = []

    for (const filePath of filePaths) {
      // إيقاف فوري عند الإلغاء — لا نكمل مراجعة ملفات إضافية
      if (this.signal?.aborted) break
      const issues = await this.reviewFile(filePath)
      allIssues.push(...issues)
    }

    const errors = allIssues.filter((i) => i.severity === 'error').length
    const warnings = allIssues.filter((i) => i.severity === 'warning').length
    const infos = allIssues.filter((i) => i.severity === 'info').length

    // حساب النقاط (100 = مثالي)
    const score = Math.max(0, 100 - errors * 15 - warnings * 5 - infos * 1)

    const summary = [
      `تمت مراجعة ${filePaths.length} ملف`,
      `🔴 ${errors} أخطاء | 🟡 ${warnings} تحذيرات | 🔵 ${infos} ملاحظات`,
      `النقاط: ${score}/100`,
    ].join('\n')

    return { filesReviewed: filePaths.length, issues: allIssues, summary, score }
  }

  /**
   * مراجعة diff (لتغييرات git)
   */
  async reviewDiff(diffContent: string): Promise<ReviewResult> {
    const files = new Map<string, string[]>()
    let currentFile = ''

    for (const line of diffContent.split('\n')) {
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6)
        files.set(currentFile, [])
      } else if (currentFile && line.startsWith('+') && !line.startsWith('+++')) {
        files.get(currentFile)!.push(line.slice(1))
      }
    }

    const allIssues: ReviewIssue[] = []
    for (const [file, lines] of files) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        for (const rule of REVIEW_RULES) {
          const issue = rule.check(line, i + 1, file)
          if (issue) allIssues.push(issue)
        }
      }
    }

    const errors = allIssues.filter((i) => i.severity === 'error').length
    const warnings = allIssues.filter((i) => i.severity === 'warning').length
    const infos = allIssues.filter((i) => i.severity === 'info').length
    const score = Math.max(0, 100 - errors * 15 - warnings * 5 - infos * 1)

    return {
      filesReviewed: files.size,
      issues: allIssues,
      summary: `مراجعة Diff: ${files.size} ملف | 🔴 ${errors} | 🟡 ${warnings} | 🔵 ${infos} | النقاط: ${score}/100`,
      score,
    }
  }
}
