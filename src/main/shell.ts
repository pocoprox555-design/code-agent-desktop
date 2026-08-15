/**
 * Cross-Platform Shell Detection (P2-01)
 * يكتشف المنصة ويعيد أوامر shell المناسبة:
 * - Windows: PowerShell (ConstrainedLanguage)
 * - macOS/Linux: bash ثم zsh
 */
import path from 'node:path'

export type ShellType = 'powershell' | 'bash' | 'zsh'

export interface PlatformShell {
  executable: string
  args: string[]
  type: ShellType
  /** نمط الهروب للسلسلة النصية داخل الأمر */
  escapeLiteral(value: string): string
  /** أمر تغيير المجلد */
  cdCommand(dir: string): string
  /** تغليف الأمر في وضع آمن (PowerShell: ConstrainedLanguage) */
  wrapCommand(command: string, cwd: string): string
}

function powershellShell(): PlatformShell {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const exe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return {
    executable: exe,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
    type: 'powershell',
    escapeLiteral: (value: string) => value.replaceAll("'", "''"),
    cdCommand: (dir: string) => `Set-Location -LiteralPath '${dir.replaceAll("'", "''")}'`,
    wrapCommand: (command: string, cwd: string) =>
      `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}'; & { ${command} }`,
  }
}

function bashShell(): PlatformShell {
  const exe = process.env.SHELL || '/bin/bash'
  return {
    executable: exe,
    args: ['--norc', '--noprofile'],
    type: 'bash',
    escapeLiteral: (value: string) => `'${value.replaceAll("'", "'\\''")}'`,
    cdCommand: (dir: string) => `cd ${dir.replaceAll("'", "'\\''")}`,
    wrapCommand: (command: string, cwd: string) =>
      `cd '${cwd.replaceAll("'", "'\\''")}' && { ${command} ; }`,
  }
}

function zshShell(): PlatformShell {
  const exe = process.env.SHELL || '/bin/zsh'
  return {
    executable: exe,
    args: ['--no-rcs'],
    type: 'zsh',
    escapeLiteral: (value: string) => `'${value.replaceAll("'", "'\\''")}'`,
    cdCommand: (dir: string) => `cd ${dir.replaceAll("'", "'\\''")}`,
    wrapCommand: (command: string, cwd: string) =>
      `cd '${cwd.replaceAll("'", "'\\''")}' && { ${command} ; }`,
  }
}

let cachedShell: PlatformShell | null = null

/** يعيد غلاف المنصة الحالية مع كاش */
export function getPlatformShell(): PlatformShell {
  if (cachedShell) return cachedShell

  if (process.platform === 'win32') {
    cachedShell = powershellShell()
  } else {
    // على Unix، نفضل bash ثم zsh
    try {
      const shell = process.env.SHELL || ''
      if (shell.includes('zsh')) {
        cachedShell = zshShell()
      } else {
        cachedShell = bashShell()
      }
    } catch {
      cachedShell = bashShell()
    }
  }

  return cachedShell
}

/** هل المنصة الحالية هي Windows؟ */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/** هل المنصة الحالية هي macOS؟ */
export function isMacOS(): boolean {
  return process.platform === 'darwin'
}

/** هل المنصة الحالية هي Linux؟ */
export function isLinux(): boolean {
  return process.platform === 'linux'
}

/** يعيد اسم المنصة للعرض */
export function platformLabel(): string {
  if (isWindows()) return 'Windows'
  if (isMacOS()) return 'macOS'
  if (isLinux()) return 'Linux'
  return process.platform
}
