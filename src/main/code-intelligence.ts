/**
 * Code Intelligence Engine — محرك فهم الكود
 *
 * يستخدم TypeScript Compiler API لبناء فهرس شامل للمشروع:
 * - رموز (Functions, Classes, Interfaces, Types, Enums, Variables)
 * - استيرادات وتصديرات
 * - خريطة اعتماديات على مستوى الرموز
 * - مراجع (References) لرمز معين
 *
 * Lazy loading: لا يُحمّل إلا عند أول استخدام.
 * Cache + invalidation: يتحقق من mtimes ويعيد البناء للملفات المتغيرة فقط.
 */

import ts from 'typescript'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { MutationReceipt } from '../shared/types'
import { normalizedWorkspaceKey } from './workspace-coordinator'

// استخراج نص التوثيق من JSDoc (الوصف الرئيسي + الوسوم)
function jsdocText(node: ts.Node): string {
  const parts: string[] = []
  // استخراج الوصف الرئيسي من عقد JSDoc
  const jsDocs = ts.getJSDocTags(node)
  for (const jsDoc of jsDocs) {
    if (jsDoc.comment) {
      const text = ts.getTextOfJSDocComment(jsDoc.comment)
      if (text) parts.push(text)
    }
  }
  // استخراج وصف العقد نفسه (السطر الأول من /** ... */)
  const fullText = node.getFullText()
  const jsDocMatch = fullText.match(/\/\*\*\s*\n?\s*(.+?)(?:\n\s*\*|\s*\*\/)/)
  if (jsDocMatch?.[1] && !parts.some((p) => p.includes(jsDocMatch[1]!))) {
    parts.unshift(jsDocMatch[1].trim())
  }
  return parts.join(' ').slice(0, 500)
}

// ─── Types ───────────────────────────────────────────────────────────

export interface SymbolInfo {
  name: string
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'method' | 'import' | 'export' | 'parameter' | 'property'
  file: string
  line: number
  endLine: number
  isExported: boolean
  isDefault: boolean
  documentation: string
  typeText?: string
}

export interface ImportInfo {
  moduleSpecifier: string
  namedBindings?: string[]
  defaultImport?: string
  namespaceImport?: string
  file: string
  line: number
}

export interface DependencyInfo {
  file: string
  imports: ImportInfo[]
  exportedBy: Array<{ from: string; symbols: string[] }>
  importedBy: Array<{ from: string; symbols: string[] }>
}

export interface FileAnalysis {
  path: string
  totalLines: number
  symbols: SymbolInfo[]
  imports: ImportInfo[]
  exports: string[]
  classes: Array<{ name: string; extends?: string; implements?: string[]; methods: string[]; properties: string[] }>
  functions: Array<{ name: string; parameters: string; returnType?: string; isAsync: boolean }>
  interfaces: Array<{ name: string; properties: string[]; methods: string[] }>
}

export interface ProjectIndex {
  workspace: string
  files: Map<string, FileAnalysis>
  symbols: Map<string, SymbolInfo[]>
  dependencyGraph: Map<string, DependencyInfo>
  builtAt: number
}

export interface ReferenceResult {
  symbol: string
  definition: SymbolInfo | undefined
  references: Array<{ file: string; line: number; column: number; context: string }>
}

// ─── Fallback regex-based extraction (used when TS compiler fails) ──

const FALLBACK_SYMBOL_PATTERNS: Array<{ kind: SymbolInfo['kind']; pattern: RegExp }> = [
  { kind: 'function', pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
  { kind: 'class', pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
  { kind: 'interface', pattern: /^(?:export\s+)?interface\s+(\w+)/ },
  { kind: 'type', pattern: /^(?:export\s+)?(?:type|enum)\s+(\w+)/ },
  { kind: 'variable', pattern: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:function|\(|async|class)/ },
  { kind: 'import', pattern: /^import\s+(?:\{\s*([^}]+?)\s*\}|(\w+))\s+from/ },
]

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs'])
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs'])
const ALL_CODE_EXTENSIONS = new Set([...TS_EXTENSIONS, ...JS_EXTENSIONS])

// ─── ProjectIndexer ──────────────────────────────────────────────────

export class ProjectIndexer {
  private index: ProjectIndex | null = null
  private fileMtimes = new Map<string, number>()
  /** Cached import-specifier → resolved-relative-path results (null = unresolved). */
  private resolutionCache = new Map<string, string | null>()
  private tsconfigPath: string | undefined
  private tsconfigParsed: ts.ParsedCommandLine | undefined
  private languageService: ts.LanguageService | null = null
  private serviceHost: ts.LanguageServiceHost | null = null
  private fileCache = new Map<string, { version: string; content: string }>()
  private cachedFiles: string[] | null = null
  private lastFileScan = 0
  private lastDetectResult: boolean | null = null
  private lastDetectTime = 0
  private generation = 0
  private inFlightBuild: Promise<boolean> | null = null
  private static readonly FILE_SCAN_TTL = 5_000 // 5 ثوانٍ
  private static readonly DETECT_TTL = 3_000 // 3 ثوانٍ

  constructor(private workspace: string) {
    this.tsconfigPath = this.findTsConfig()
    // تحميل tsconfig فعليًا لاستخراج paths و compiler options
    if (this.tsconfigPath) {
      try {
        const configFile = ts.readConfigFile(this.tsconfigPath, ts.sys.readFile)
        if (!configFile.error) {
          const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(this.tsconfigPath))
          this.tsconfigParsed = parsed
        }
      } catch { /* fallback: لا نملك tsconfig parsed */ }
    }
  }

  /** Get or rebuild the project index (with cache invalidation) */
  async getIndex(): Promise<ProjectIndex> {
    while (!this.index || await this.detectChanges()) {
      const generation = this.generation
      const incremental = this.index !== null
      const build = this.inFlightBuild ?? this.buildIndex(generation, incremental)
      this.inFlightBuild = build
      try {
        await build
      } finally {
        if (this.inFlightBuild === build) this.inFlightBuild = null
      }
      if (generation === this.generation && this.index) break
    }
    return this.index!
  }

  /** Analyze a single file using TS compiler or regex fallback */
  async analyzeFile(filePath: string): Promise<FileAnalysis | null> {
    const relative = path.relative(this.workspace, filePath).replaceAll('\\', '/')
    const absolute = await this.resolvePath(filePath)
    if (!absolute) return null

    try {
      return await this.analyzeWithTsCompiler(absolute, relative)
    } catch {
      return await this.analyzeWithRegex(absolute, relative)
    }
  }

  /** Find all references to a symbol across the project */
  async findReferences(symbolName: string, startFile?: string): Promise<ReferenceResult> {
    const index = await this.getIndex()
    const definitions = index.symbols.get(symbolName) ?? []
    const definition = definitions[0]
    const references: ReferenceResult['references'] = []

    // Search through all files for the symbol name
    for (const [file, analysis] of index.files) {
      if (startFile && !file.includes(startFile) && !analysis.imports.some((imp) => imp.namedBindings?.includes(symbolName))) continue

      try {
        const absolute = path.resolve(this.workspace, file)
        const content = await fs.readFile(absolute, 'utf8')
        const lines = content.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          // Word-boundary match for the symbol
          const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, 'g')
          let match
          while ((match = regex.exec(line)) !== null) {
            // Skip if it's a comment or string literal (basic heuristic)
            const trimmed = line.trimStart()
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
            references.push({ file, line: i + 1, column: match.index + 1, context: line.trim().slice(0, 120) })
          }
        }
      } catch { /* skip unreadable files */ }
    }

    return { symbol: symbolName, definition, references }
  }

  /** Get dependency graph for a file */
  async getDependencies(filePath: string): Promise<DependencyInfo | null> {
    const index = await this.getIndex()
    const relative = (path.isAbsolute(filePath) ? path.relative(this.workspace, filePath) : filePath).replaceAll('\\', '/')
    return index.dependencyGraph.get(relative) ?? null
  }

  /** Get all symbols in the project (flattened) */
  async getAllSymbols(): Promise<SymbolInfo[]> {
    const index = await this.getIndex()
    const all: SymbolInfo[] = []
    for (const symbols of index.symbols.values()) all.push(...symbols)
    return all
  }

  /** إبطال ملف واحد في الفهرس (يُستدعى بعد تعديل الملف) */
  async invalidateFile(filePath: string): Promise<void> {
    this.invalidate({ workspaceRevision: this.generation + 1, effects: [{ kind: 'edit', path: filePath }] })
  }

  invalidate(receipt: MutationReceipt): void {
    this.generation = Math.max(this.generation + 1, receipt.workspaceRevision)
    this.cachedFiles = null
    this.lastFileScan = 0
    this.lastDetectResult = null
    this.lastDetectTime = 0
    // Mutations can add/remove files, so previously-unresolved specifiers may
    // resolve now (and vice versa). Drop cached resolutions for correctness.
    this.resolutionCache.clear()
    if (!this.index) return
    const affected = receipt.effects.flatMap((effect) => effect.kind === 'move' ? [effect.from, effect.path] : [effect.path])
    for (const filePath of affected) this.removeIndexedFile(filePath)
  }

  private removeIndexedFile(filePath: string): void {
    const index = this.index
    if (!index) return
    const relative = (path.isAbsolute(filePath) ? path.relative(this.workspace, filePath) : filePath).replaceAll('\\', '/')
    const analysis = index.files.get(relative)
    if (!analysis) {
      this.fileMtimes.delete(path.resolve(this.workspace, relative))
      return
    }
    // إزالة رموز هذا الملف من فهرس الرموز
    for (const sym of analysis.symbols) {
      const existing = index.symbols.get(sym.name)
      if (existing) {
        const filtered = existing.filter((s) => s.file !== relative)
        if (filtered.length) index.symbols.set(sym.name, filtered)
        else index.symbols.delete(sym.name)
      }
    }
    // إزالة الملف من خريطة الاعتماديات
    index.dependencyGraph.delete(relative)
    // إزالة الملف من قائمة الملفات
    index.files.delete(relative)
    // إزالة mtime ليجبر إعادة المسح
    const absPath = path.resolve(this.workspace, relative)
    this.fileMtimes.delete(absPath)
  }

  // ─── Private: Change detection ────────────────────────────────────

  private async detectChanges(): Promise<boolean> {
    // استرجاع من الكاش إذا كان حديثًا
    if (this.lastDetectResult !== null && Date.now() - this.lastDetectTime < ProjectIndexer.DETECT_TTL) {
      return this.lastDetectResult
    }
    const files = await this.collectCodeFiles()
    const currentMtimes = new Map<string, number>()

    for (const file of files) {
      try {
        const stat = await fs.stat(file)
        currentMtimes.set(file, stat.mtimeMs)
      } catch { /* skip */ }
    }

    // Check if any file was added, removed, or modified
    let changed = false
    if (currentMtimes.size !== this.fileMtimes.size) changed = true
    else {
      for (const [file, mtime] of currentMtimes) {
        if (this.fileMtimes.get(file) !== mtime) { changed = true; break }
      }
    }
    this.lastDetectResult = changed
    this.lastDetectTime = Date.now()
    return changed
  }

  // ─── Private: Build index ─────────────────────────────────────────

  private async buildIndex(generation: number, incremental = false): Promise<boolean> {
    const codeFiles = await this.collectCodeFiles()

    // Single stat pass for all current code files — used both for deciding
    // what to re-parse and as the new mtime baseline.
    const mtimes = new Map<string, number>()
    for (const file of codeFiles) {
      try { mtimes.set(file, (await fs.stat(file)).mtimeMs) } catch { /* skip */ }
    }

    let files: Map<string, FileAnalysis>
    let symbols: Map<string, SymbolInfo[]>

    if (incremental && this.index) {
      // ─── Incremental rebuild: re-parse only added/changed files ───
      // A full re-parse on every change kept large projects slow and made
      // the context builder's timeout drop the repo map. Reuse unchanged
      // analyses and re-parse only what actually changed.
      files = this.index.files
      symbols = this.index.symbols
      const currentSet = new Set(codeFiles)
      let setChanged = false
      for (const rel of [...files.keys()]) {
        if (!currentSet.has(path.resolve(this.workspace, rel))) { this.removeIndexedFile(rel); setChanged = true }
      }
      for (const file of codeFiles) {
        const relative = path.relative(this.workspace, file).replaceAll('\\', '/')
        const previousMtime = this.fileMtimes.get(file)
        if (previousMtime !== undefined && mtimes.get(file) === previousMtime && files.has(relative)) continue
        if (!files.has(relative)) setChanged = true
        this.removeIndexedFile(relative)
        const analysis = await this.analyzeOne(file, relative)
        if (generation !== this.generation) { this.cachedFiles = null; this.lastFileScan = 0; return false }
        if (analysis) {
          files.set(relative, analysis)
          for (const sym of analysis.symbols) {
            const existing = symbols.get(sym.name) ?? []
            existing.push(sym)
            symbols.set(sym.name, existing)
          }
        }
      }
      if (setChanged) this.resolutionCache.clear()
    } else {
      files = new Map<string, FileAnalysis>()
      symbols = new Map<string, SymbolInfo[]>()
      this.resolutionCache.clear()
      // Try TS compiler first, fall back to regex for each file
      for (const file of codeFiles) {
        const relative = path.relative(this.workspace, file).replaceAll('\\', '/')
        const analysis = await this.analyzeOne(file, relative)
        if (generation !== this.generation) { this.cachedFiles = null; this.lastFileScan = 0; return false }
        if (analysis) {
          files.set(relative, analysis)
          for (const sym of analysis.symbols) {
            const existing = symbols.get(sym.name) ?? []
            existing.push(sym)
            symbols.set(sym.name, existing)
          }
        }
      }
    }

    // Rebuild dependency graph from in-memory analyses
    const dependencyGraph = new Map<string, DependencyInfo>()
    for (const [file, analysis] of files) {
      const importedBy: DependencyInfo['importedBy'] = []
      const exportedBy: DependencyInfo['exportedBy'] = []
      for (const [otherFile, otherAnalysis] of files) {
        if (otherFile === file) continue
        const matchingImports: FileAnalysis['imports'][number][] = []
        for (const imp of otherAnalysis.imports) {
          const resolved = await this.resolveImportPath(imp.moduleSpecifier, otherFile)
          if (resolved === file) matchingImports.push(imp)
        }
        if (matchingImports.length) {
          importedBy.push({ from: otherFile, symbols: matchingImports.flatMap((imp) => imp.namedBindings ?? (imp.defaultImport ? [imp.defaultImport] : [])) })
        }
        // حساب exportedBy: إذا كان الملف الآخر يستورد رموزًا من هذا الملف
        const matchingExports: FileAnalysis['imports'][number][] = []
        for (const imp of analysis.imports) {
          const resolved = await this.resolveImportPath(imp.moduleSpecifier, file)
          if (resolved === otherFile) matchingExports.push(imp)
        }
        if (matchingExports.length) {
          exportedBy.push({ from: otherFile, symbols: matchingExports.flatMap((imp) => imp.namedBindings ?? (imp.defaultImport ? [imp.defaultImport] : [])) })
        }
      }
      dependencyGraph.set(file, { file, imports: analysis.imports, exportedBy, importedBy })
    }

    if (generation !== this.generation) {
      this.cachedFiles = null
      this.lastFileScan = 0
      return false
    }
    this.index = { workspace: this.workspace, files, symbols, dependencyGraph, builtAt: Date.now() }
    this.fileMtimes = mtimes
    this.lastDetectResult = false
    this.lastDetectTime = Date.now()
    return true
  }

  private async analyzeOne(file: string, relative: string): Promise<FileAnalysis | null> {
    try {
      return await this.analyzeWithTsCompiler(file, relative)
    } catch {
      try { return await this.analyzeWithRegex(file, relative) } catch { return null }
    }
  }

  // ─── Private: TypeScript Compiler analysis ────────────────────────

  private async analyzeWithTsCompiler(absolutePath: string, relativePath: string): Promise<FileAnalysis> {
    const content = await fs.readFile(absolutePath, 'utf8')
    const lines = content.split(/\r?\n/)
    const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, this.isJsFile(relativePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS)

    const symbols: SymbolInfo[] = []
    const imports: ImportInfo[] = []
    const exports: string[] = []
    const classes: FileAnalysis['classes'] = []
    const functions: FileAnalysis['functions'] = []
    const interfaces: FileAnalysis['interfaces'] = []

    const visit = (node: ts.Node) => {
      const kind = node.kind

      // Functions
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        const name = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ? node.name?.getText(sourceFile) ?? 'anonymous' : 'arrow'
        const isExported = ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        const isDefault = isExported && ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        const isAsync = ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
        const params = node.parameters.map((p) => p.getText(sourceFile)).join(', ')
        const retType = node.type?.getText(sourceFile)

        if (name !== 'anonymous' && name !== 'arrow') {
          symbols.push({ name, kind: 'function', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1, isExported, isDefault, documentation: jsdocText(node), typeText: retType })
          functions.push({ name, parameters: params, returnType: retType, isAsync })
          if (isExported) exports.push(name)
        }
      }

      // Classes
      if (ts.isClassDeclaration(node)) {
        const name = node.name?.getText(sourceFile) ?? 'anonymous'
        if (name === 'anonymous') { ts.forEachChild(node, visit); return }
        const isExported = ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        const isDefault = isExported && ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        const extendsClause = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.getText(sourceFile)
        const implementsClause = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)?.types.map((t) => t.getText(sourceFile))
        const methods: string[] = []
        const properties: string[] = []
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) || ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
            const memberName = member.name?.getText(sourceFile)
            if (memberName) {
              if (ts.isMethodDeclaration(member)) {
                methods.push(memberName)
                // إضافة method كـ symbol مستقل
                const memberExported = ts.canHaveModifiers(member) && Boolean(ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PublicKeyword))
                symbols.push({ name: `${name}.${memberName}`, kind: 'method', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(member.getEnd()).line + 1, isExported: memberExported, isDefault: false, documentation: jsdocText(member) })
              } else {
                properties.push(memberName)
                // إضافة property كـ symbol مستقل
                symbols.push({ name: `${name}.${memberName}`, kind: 'property', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(member.getEnd()).line + 1, isExported: false, isDefault: false, documentation: jsdocText(member) })
              }
            }
          }
        }
        symbols.push({ name, kind: 'class', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1, isExported, isDefault, documentation: jsdocText(node) })
        classes.push({ name, extends: extendsClause, implements: implementsClause, methods, properties })
        if (isExported) exports.push(name)
      }

      // Interfaces
      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.getText(sourceFile)
        const isExported = ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        const isDefault = false // interfaces لا يمكنها default export
        const members: string[] = []
        const memberMethods: string[] = []
        for (const member of node.members) {
          const memberName = member.name?.getText(sourceFile)
          if (memberName) {
            if (ts.isMethodSignature(member)) {
              memberMethods.push(memberName)
              // إضافة interface method كـ symbol
              symbols.push({ name: `${name}.${memberName}`, kind: 'method', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(member.getEnd()).line + 1, isExported: false, isDefault: false, documentation: jsdocText(member) })
            } else {
              members.push(memberName)
              // إضافة interface property كـ symbol
              symbols.push({ name: `${name}.${memberName}`, kind: 'property', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(member.getEnd()).line + 1, isExported: false, isDefault: false, documentation: jsdocText(member) })
            }
          }
        }
        symbols.push({ name, kind: 'interface', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1, isExported, isDefault, documentation: jsdocText(node) })
        interfaces.push({ name, properties: members, methods: memberMethods })
        if (isExported) exports.push(name)
      }

      // Type aliases
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.getText(sourceFile)
        const isExported = ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        const isDefault = isExported && ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        symbols.push({ name, kind: 'type', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1, isExported, isDefault, documentation: jsdocText(node), typeText: node.type.getText(sourceFile).slice(0, 200) })
        if (isExported) exports.push(name)
      }

      // Enums
      if (ts.isEnumDeclaration(node)) {
        const name = node.name.getText(sourceFile)
        const isExported = ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        const isDefault = isExported && ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        symbols.push({ name, kind: 'enum', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1, isExported, isDefault, documentation: jsdocText(node) })
        if (isExported) exports.push(name)
      }

      // Imports
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier.getText(sourceFile).replace(/^['"]|['"]$/g, '')
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        let namedBindings: string[] | undefined
        let defaultImport: string | undefined
        let namespaceImport: string | undefined

        if (node.importClause) {
          if (node.importClause.name) defaultImport = node.importClause.name.getText(sourceFile)
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              namedBindings = node.importClause.namedBindings.elements.map((el) => el.name.getText(sourceFile))
            } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              namespaceImport = node.importClause.namedBindings.name.getText(sourceFile)
            }
          }
        }
        imports.push({ moduleSpecifier, namedBindings, defaultImport, namespaceImport, file: relativePath, line })
      }

      // Variable statements (exported const/let/var assigned to function/class/arrow)
      if (ts.isVariableStatement(node)) {
        const isExported = ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const name = decl.name.getText(sourceFile)
            const isFunc = ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)
            const isClass = ts.isClassExpression(decl.initializer)
            if (isFunc || isClass) {
              symbols.push({ name, kind: isFunc ? 'function' : 'class', file: relativePath, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1, isExported, isDefault: false, documentation: '' })
              if (isExported) exports.push(name)
            }
          }
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)

    return { path: relativePath, totalLines: lines.length, symbols, imports, exports, classes, functions, interfaces }
  }

  // ─── Private: Regex fallback analysis ─────────────────────────────

  private async analyzeWithRegex(absolutePath: string, relativePath: string): Promise<FileAnalysis> {
    const content = await fs.readFile(absolutePath, 'utf8')
    const lines = content.split(/\r?\n/)
    const symbols: SymbolInfo[] = []
    const imports: ImportInfo[] = []
    const exports: string[] = []
    const classes: FileAnalysis['classes'] = []
    const functions: FileAnalysis['functions'] = []
    const interfaces: FileAnalysis['interfaces'] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

      // Imports
      const importMatch = /^import\s+(?:\{\s*([^}]+?)\s*\}|(\w+))\s+from\s+['"]([^'"]+)['"]/.exec(trimmed)
      if (importMatch) {
        imports.push({ moduleSpecifier: importMatch[3]!, namedBindings: importMatch[1]?.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean), defaultImport: importMatch[2], file: relativePath, line: i + 1 })
        continue
      }

      for (const { kind, pattern } of FALLBACK_SYMBOL_PATTERNS) {
        const match = pattern.exec(trimmed)
        if (match && match[1]) {
          const name = match[1].trim()
          const isExported = trimmed.startsWith('export ')
          symbols.push({ name, kind, file: relativePath, line: i + 1, endLine: i + 1, isExported, isDefault: false, documentation: '' })
          if (isExported) exports.push(name)
          break
        }
      }
    }

    return { path: relativePath, totalLines: lines.length, symbols, imports, exports, classes, functions, interfaces }
  }

  // ─── Private: Helpers ─────────────────────────────────────────────

  private findTsConfig(): string | undefined {
    const candidates = ['tsconfig.json', 'jsconfig.json']
    for (const name of candidates) {
      const p = path.join(this.workspace, name)
      try { require('node:fs').statSync(p); return p } catch { /* continue */ }
    }
    return undefined
  }

  private async collectCodeFiles(): Promise<string[]> {
    // استرجاع من الكاش إذا كان حديثًا
    if (this.cachedFiles && Date.now() - this.lastFileScan < ProjectIndexer.FILE_SCAN_TTL) {
      return this.cachedFiles
    }
    const files: string[] = []
    // مجلدات بناء واستثناءات شاملة
    const ignoreDirs = new Set([
      'node_modules', '.git', 'out', 'dist', 'build', '.next', '.nuxt',
      '.svelte-kit', 'coverage', '.angular', '.cache', '.temp', '.tmp',
      'release', 'vendor', '.venv', 'venv', '__pycache__', '.tox',
      'bin', 'obj', '.gradle', '.maven', 'target', 'dist-elec'
    ])

    const walk = async (dir: string): Promise<void> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            // تجاهل إذا كان الاسم يطابق أي من القائمة أو يبدأ بـ prefix معين
            if (!ignoreDirs.has(entry.name) &&
                !entry.name.startsWith('release-') &&
                !entry.name.startsWith('dist-v') &&
                !entry.name.startsWith('win-unpacked') &&
                !entry.name.startsWith('.') && // تجاهل كل المجلدات المخفية
                entry.name !== 'node_modules') {
              await walk(fullPath)
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (ALL_CODE_EXTENSIONS.has(ext)) {
              try {
                const stat = await fs.stat(fullPath)
                if (stat.size <= 5_000_000) files.push(fullPath)
              } catch { /* skip */ }
            }
          }
        }
      } catch { /* skip unreadable dirs */ }
    }

    await walk(this.workspace)
    this.cachedFiles = files
    this.lastFileScan = Date.now()
    return files
  }

  private isJsFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return JS_EXTENSIONS.has(ext)
  }

  private async resolvePath(input: string): Promise<string | null> {
    try {
      const resolved = path.resolve(this.workspace, input)
      await fs.access(resolved)
      return resolved
    } catch { return null }
  }

  private async resolveImportPath(moduleSpecifier: string, fromFile: string): Promise<string | null> {
    // Resolution results are cached: the dependency-graph rebuild performs
    // O(files × imports) lookups, and results only change when the file set
    // changes (cache is cleared on set changes and on mutation receipts).
    const key = `${fromFile}\u0000${moduleSpecifier}`
    const cached = this.resolutionCache.get(key)
    if (cached !== undefined) return cached
    let result: string | null = null
    if (moduleSpecifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(path.resolve(this.workspace, fromFile)), moduleSpecifier)
      // Try with extensions
      for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
        try { await fs.access(resolved + ext); result = path.relative(this.workspace, resolved + ext).replaceAll('\\', '/'); break } catch { /* continue */ }
      }
      if (result === null) {
        try { await fs.access(resolved); result = path.relative(this.workspace, resolved).replaceAll('\\', '/') } catch { /* unresolved */ }
      }
    }
    this.resolutionCache.set(key, result)
    return result
  }
}

/**
 * Fast syntax-only check for one file (parse diagnostics, no program/type
 * resolution). Used right after writes/edits so the model sees real syntax
 * errors in the same round instead of discovering them at final verification.
 */
export async function syntaxDiagnostics(absPath: string): Promise<{ ok: boolean; errors: string[] }> {
  try {
    const ext = path.extname(absPath).toLowerCase()
    if (!ALL_CODE_EXTENSIONS.has(ext)) return { ok: true, errors: [] }
    const content = await fs.readFile(absPath, 'utf8')
    if (content.includes('\0')) return { ok: true, errors: [] }
    const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.jsx' ? ts.ScriptKind.JSX : ext === '.ts' || ext === '.mts' ? ts.ScriptKind.TS : ts.ScriptKind.JS
    const sourceFile = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true, kind)
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: Array<{ start?: number; messageText: string | { messageText?: string } }> }).parseDiagnostics ?? []
    if (!diagnostics.length) return { ok: true, errors: [] }
    const errors = diagnostics.slice(0, 5).map((diagnostic) => {
      const position = sourceFile.getLineAndCharacterOfPosition(Math.max(0, diagnostic.start ?? 0))
      const text = typeof diagnostic.messageText === 'string' ? diagnostic.messageText : diagnostic.messageText?.messageText ?? 'syntax error'
      return `${path.basename(absPath)}:${position.line + 1} ${text}`
    })
    return { ok: false, errors }
  } catch { return { ok: true, errors: [] } }
}

// ─── Utility ──────────────────────────────────────────────────────────

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// ─── Singleton per workspace ──────────────────────────────────────────

const indexerCache = new Map<string, ProjectIndexer>()
const INDEXER_CACHE_MAX = 5

export function getProjectIndexer(workspace: string): ProjectIndexer {
  const key = normalizedWorkspaceKey(workspace)
  const existing = indexerCache.get(key)
  if (existing) { indexerCache.delete(key); indexerCache.set(key, existing); return existing }
  const indexer = new ProjectIndexer(path.resolve(workspace))
  indexerCache.set(key, indexer)
  // Bounded LRU: each indexer holds a full in-memory project index.
  while (indexerCache.size > INDEXER_CACHE_MAX) indexerCache.delete(indexerCache.keys().next().value!)
  return indexer
}
