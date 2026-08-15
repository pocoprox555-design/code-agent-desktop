/**
 * Repo Map — خريطة المشروع الذكية
 *
 * تبني ملخصًا مختصرًا للمشروع يُحقن في system prompt:
 * - هيكل المجلدات
 * - أهم الرموز في كل ملف
 * - اعتماديات الملفات
 *
 * مبنية على فكرة Aider's repo map مع page-rank على الرموز.
 */

import type { ProjectIndex, SymbolInfo, FileAnalysis } from './code-intelligence'

// ─── Types ───────────────────────────────────────────────────────────

export interface RepoMapEntry {
  file: string
  symbols: Array<{ name: string; kind: string; importance: number }>
  imports: string[]
  exportedBy: string[]
}

export interface RepoMap {
  entries: RepoMapEntry[]
  generatedAt: number
  totalFiles: number
  totalSymbols: number
}

// ─── Constants ───────────────────────────────────────────────────────

const REPO_MAP_MAX_CHARS = 4_000
const MAX_SYMBOLS_PER_FILE = 10
const MAX_FILES_IN_MAP = 200

// ─── Importance Scoring ──────────────────────────────────────────────

/** أهمية نوع الرمز (classes و functions أهم من variables) */
const SYMBOL_KIND_WEIGHT: Record<string, number> = {
  class: 1.0,
  function: 0.9,
  interface: 0.85,
  type: 0.8,
  enum: 0.7,
  method: 0.6,
  property: 0.5,
  variable: 0.4,
  import: 0.3,
  export: 0.3,
  parameter: 0.2,
}

/** هل الملف مصدري رئيسي (index, main, app)؟ */
function isEntryFile(file: string): boolean {
  const lower = file.toLowerCase()
  return /(?:index|main|app|server|client)\.(?:ts|tsx|js|jsx)$/.test(lower)
}

/** هل الملف يحتوي على تعريفات types مهمة؟ */
function hasTypeDefinitions(analysis: FileAnalysis): boolean {
  return analysis.interfaces.length > 0 || analysis.classes.some((c) => c.properties.length > 3)
}

// ─── Symbol Importance ───────────────────────────────────────────────

/**
 * حساب أهمية الرمز بناءً على:
 * - نوع الرمز (class > function > interface)
 * - عدد الملفات التي تستورد الرمز
 * - هل الرمز مصدراً (exported)
 * - هل الرمز في ملف رئيسي
 */
function calculateSymbolImportance(
  symbol: SymbolInfo,
  importedByCount: number,
  isEntry: boolean
): number {
  let importance = SYMBOL_KIND_WEIGHT[symbol.kind] ?? 0.5

  // زيادة الأهمية إذا كان مصدراً
  if (symbol.isExported) importance *= 1.3

  // زيادة الأهمية حسب عدد الملفات التي تستورده
  importance += Math.min(0.5, importedByCount * 0.1)

  // زيادة الأهمية إذا كان في ملف رئيسي
  if (isEntry) importance *= 1.2

  // زيادة الأهمية إذا كان فيه documentation
  if (symbol.documentation) importance *= 1.1

  return Math.min(1.0, importance)
}

// ─── Repo Map Builder ────────────────────────────────────────────────

/**
 * بناء خريطة المشروع من الفهرس
 */
export function buildRepoMap(index: ProjectIndex): RepoMap {
  const entries: RepoMapEntry[] = []

  for (const [file, analysis] of index.files) {
    const isEntry = isEntryFile(file)
    const fileImportance = isEntry ? 1.0 : hasTypeDefinitions(analysis) ? 0.8 : 0.5

    // جمع الرموز مع حساب الأهمية
    const symbolsWithImportance = analysis.symbols
      .filter((sym) => sym.kind !== 'import' && sym.kind !== 'export')
      .map((sym) => {
        // حساب عدد الملفات التي تستورد هذا الرمز
        const importedByCount = [...index.dependencyGraph.values()]
          .filter((dep) => dep.importedBy.some((ib) => ib.symbols.includes(sym.name)))
          .length

        return {
          name: sym.name,
          kind: sym.kind,
          importance: calculateSymbolImportance(sym, importedByCount, isEntry) * fileImportance,
        }
      })
      .sort((a, b) => b.importance - a.importance)
      .slice(0, MAX_SYMBOLS_PER_FILE)

    // الاعتماديات
    const depInfo = index.dependencyGraph.get(file)
    const imports = depInfo?.imports.map((imp) => imp.moduleSpecifier).slice(0, 5) ?? []
    const exportedBy = depInfo?.exportedBy.map((eb) => eb.from).slice(0, 3) ?? []

    entries.push({ file, symbols: symbolsWithImportance, imports, exportedBy })
  }

  // ترتيب الملفات: الملفات المدخلة أولاً، ثم حسب عدد الرموز
  entries.sort((a, b) => {
    const aEntry = isEntryFile(a.file) ? 1 : 0
    const bEntry = isEntryFile(b.file) ? 1 : 0
    if (aEntry !== bEntry) return bEntry - aEntry
    return b.symbols.length - a.symbols.length
  })

  return {
    entries: entries.slice(0, MAX_FILES_IN_MAP),
    generatedAt: Date.now(),
    totalFiles: index.files.size,
    totalSymbols: [...index.symbols.values()].flat().length,
  }
}

/**
 * تحويل خريطة المشروع إلى نص مختصر يُحقن في system prompt
 */
export function repoMapToString(repoMap: RepoMap, focusFiles: string[] = []): string {
  if (!repoMap.entries.length) return ''

  const lines: string[] = [
    `# Project map (${repoMap.totalFiles} files, ${repoMap.totalSymbols} symbols)`,
    '',
  ]

  const normalizedFocus = focusFiles.map((file) => file.replaceAll('\\', '/').toLowerCase())
  const entries = [...repoMap.entries].sort((first, second) => Number(isFocused(second.file, normalizedFocus)) - Number(isFocused(first.file, normalizedFocus)))
  for (const entry of entries) {
    // سطر الملف
    const fileLabel = isEntryFile(entry.file) ? '⭐' : '📄'
    lines.push(`${fileLabel} ${entry.file}`)

    // الرموز المهمة
    if (entry.symbols.length) {
      const symbolsStr = entry.symbols
        .map((s) => `${s.name}(${s.kind})`)
        .join(', ')
      lines.push(`  symbols: ${symbolsStr}`)
    }

    // الاعتماديات (مختصرة)
    if (entry.imports.length) {
      const importsStr = entry.imports.slice(0, 3).join(', ')
      lines.push(`  imports: ${importsStr}`)
    }

    lines.push('')
    if (lines.join('\n').length >= REPO_MAP_MAX_CHARS) break
  }

  const output: string[] = []
  let chars = 0
  for (const line of lines) {
    if (chars + line.length + 1 > REPO_MAP_MAX_CHARS) break
    output.push(line)
    chars += line.length + 1
  }
  if (output.length < lines.length || entries.length < repoMap.entries.length) output.push('[map truncated]')
  return output.join('\n')
}

/**
 * بناء خريطة المشروع وتحويلها إلى نص جاهز للحقن
 */
export function generateRepoMapString(index: ProjectIndex, focusFiles: string[] = []): string {
  const repoMap = buildRepoMap(index)
  return repoMapToString(repoMap, focusFiles)
}

function isFocused(file: string, focusFiles: string[]): boolean {
  const normalized = file.replaceAll('\\', '/').toLowerCase()
  return focusFiles.some((focus) => normalized === focus || normalized.endsWith(`/${focus}`) || normalized.includes(focus))
}
