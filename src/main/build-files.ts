import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { BuildFileScanResult, BuildStats, ProjectFile } from '../shared/types'

export const BUILD_MAX_FILES = 200
export const BUILD_MAX_FILE_BYTES = 500_000
export const BUILD_MAX_TOTAL_BYTES = 10_000_000
export const BUILD_SCAN_TIMEOUT_MS = 5_000

const BUILD_EXTENSIONS = new Set(['.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt', '.svg', '.xml', '.yml', '.yaml', '.toml', '.mjs', '.cjs'])
const IGNORED_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'coverage', '.next', '.cache', '.vite'])

export async function readBuildFiles(projectPath: string): Promise<BuildFileScanResult> {
  const root = await canonicalProject(projectPath)
  const ignored = await gitignorePatterns(root)
  const files: ProjectFile[] = []
  let totalBytes = 0
  let truncated = false
  const deadline = Date.now() + BUILD_SCAN_TIMEOUT_MS

  const walk = async (directory: string): Promise<void> => {
    if (Date.now() >= deadline || files.length >= BUILD_MAX_FILES) { truncated = true; return }
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (Date.now() >= deadline || files.length >= BUILD_MAX_FILES) { truncated = true; return }
      if (entry.isSymbolicLink()) {
        if (entry.isDirectory() || isIgnoredDirectory(entry.name)) continue
        throw new Error(`المشروع يحتوي رابطًا رمزيًا غير مسموح: ${entry.name}`)
      }
      const fullPath = join(directory, entry.name)
      const relativePath = relative(root, fullPath).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (!isIgnoredDirectory(entry.name) && !isGitignored(relativePath, ignored)) await walk(fullPath)
        continue
      }
      if (!entry.isFile() || isSecretPath(relativePath) || isGitignored(relativePath, ignored) || !isAllowedFile(entry.name)) continue
      const stat = await fs.lstat(fullPath)
      if (stat.size > BUILD_MAX_FILE_BYTES || totalBytes + stat.size > BUILD_MAX_TOTAL_BYTES) { truncated = true; continue }
      const language = languageFor(entry.name)
      let lines = 0
      if (language !== 'binary') {
        const content = await fs.readFile(fullPath, 'utf8')
        lines = lineCount(content)
      }
      totalBytes += stat.size
      files.push({ name: basename(relativePath), path: relativePath, relativePath, size: stat.size, lines, language })
    }
  }

  await walk(root)
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return { files, totalBytes, truncated }
}

export async function readBuildFileContent(projectPath: string, relativePath: string): Promise<string> {
  const root = await canonicalProject(projectPath)
  const normalized = relativePath.replace(/\\/g, '/')
  if (!normalized || normalized.includes('\0') || isAbsolute(relativePath) || normalized.split('/').some((part) => part === '..')) throw new Error('المسار خارج المشروع')
  if (isSecretPath(normalized) || !isAllowedFile(basename(normalized))) throw new Error('نوع الملف غير مسموح للعرض')
  const target = resolve(root, normalized)
  if (!isContained(root, target)) throw new Error('المسار خارج المشروع')
  await assertNoSymlinkComponents(root, target)
  const ignored = await gitignorePatterns(root)
  if (isGitignored(normalized, ignored)) throw new Error('الملف مستثنى من فحص المشروع')
  const stat = await fs.lstat(target)
  if (!stat.isFile() || stat.size > BUILD_MAX_FILE_BYTES) throw new Error('الملف غير نصي أو أكبر من حد العرض')
  return fs.readFile(target, 'utf8')
}

export async function getBuildStats(projectPath: string): Promise<BuildStats> {
  const scan = await readBuildFiles(projectPath)
  return { files: scan.files.length, lines: scan.files.reduce((total, file) => total + file.lines, 0), size: scan.totalBytes, truncated: scan.truncated }
}

export async function canonicalProject(projectPath: string): Promise<string> {
  const root = await fs.realpath(resolve(projectPath))
  const stat = await fs.lstat(root)
  if (!stat.isDirectory()) throw new Error('مجلد المشروع غير صالح')
  return root
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  if (!isContained(root, target)) throw new Error('المسار خارج المشروع')
  const parts = relative(root, target).split(/[\\/]/).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error('لا يسمح بعبور رابط رمزي داخل المشروع')
  }
}

function isContained(root: string, target: string): boolean {
  const difference = relative(root, target)
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))
}

function isIgnoredDirectory(name: string): boolean {
  const lower = name.toLowerCase()
  return IGNORED_DIRS.has(lower) || lower.startsWith('release-') || lower.startsWith('dist-v') || lower.startsWith('win-unpacked') || lower.endsWith('.tmp')
}

function isAllowedFile(name: string): boolean {
  return name.toLowerCase() === '.gitignore' || BUILD_EXTENSIONS.has(extname(name).toLowerCase())
}

function isSecretPath(value: string): boolean {
  const parts = value.replace(/\\/g, '/').toLowerCase().split('/')
  return parts.some((part) => part === '.env' || part.startsWith('.env.') || part === '.npmrc' || part === '.netrc' || part === '.git-credentials' || part === 'credentials' || part === 'provider.json' || part === 'auth.json' || part === 'id_rsa' || part === 'id_ed25519' || part.endsWith('.pem') || part.endsWith('.key') || part.endsWith('.p12') || part.endsWith('.pfx') || part === 'secrets.json')
}

function languageFor(name: string): string {
  const ext = extname(name).toLowerCase()
  if (ext === '.html') return 'html'
  if (ext === '.css') return 'css'
  if (ext === '.tsx') return 'tsx'
  if (ext === '.jsx') return 'jsx'
  if (ext === '.ts') return 'typescript'
  if (['.js', '.mjs', '.cjs'].includes(ext)) return 'javascript'
  if (ext === '.json') return 'json'
  if (ext === '.md') return 'markdown'
  if (ext === '.svg') return 'svg'
  return 'text'
}

function lineCount(value: string): number { return value.length === 0 ? 0 : value.split(/\r?\n/).length }

async function gitignorePatterns(root: string): Promise<string[]> {
  try {
    const value = await fs.readFile(join(root, '.gitignore'), 'utf8')
    return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
  } catch { return [] }
}

function isGitignored(value: string, patterns: string[]): boolean {
  const normalized = value.replace(/\\/g, '/')
  return patterns.some((pattern) => {
    const clean = pattern.replace(/^\/+/, '')
    const matcher = globRegex(clean.endsWith('/') ? `${clean}**` : clean)
    return matcher.test(normalized) || (!clean.includes('/') && matcher.test(basename(normalized)))
  })
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`, 'i')
}
