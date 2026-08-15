/**
 * DeployManager - GitHub Pages deployment via gh-pages.
 * Token passed through GH_TOKEN env var (safe, no shell).
 */
import { join, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { fork, spawn, type ChildProcess } from 'node:child_process'
import type { DeployState } from '../shared/types'

let instance: DeployManager | null = null
export function getDeployManager(): DeployManager {
  if (!instance) instance = new DeployManager()
  return instance
}

export class DeployManager {
  private state: DeployState = { status: 'idle' }
  private readonly publisher: PublishArtifact

  constructor(options: { publisher?: PublishArtifact } = {}) {
    this.publisher = options.publisher ?? publishArtifact
  }

  async deploy(args: {
    projectId: string; projectPath: string; token: string; repoUrl: string; branch?: string
  }): Promise<DeployState> {
    if (this.state.status === 'deploying' || this.state.status === 'building') return { ...this.state, error: 'عملية نشر جارية.' }
    const parsed = parseGitHubRepo(args.repoUrl)
    const branch = args.branch ?? 'gh-pages'
    if (!parsed || !isSafeGitRef(branch)) return this.fail(args.projectId, 'رابط GitHub أو اسم الفرع غير صالح.')
    const startedAt = Date.now()
    this.state = { status: 'building', projectId: args.projectId, startedAt, pagesStatus: 'unknown' }

    try {
      const packageJson = await readPackageJson(args.projectPath)
      if (!packageJson?.scripts || typeof packageJson.scripts.build !== 'string' || !packageJson.scripts.build.trim()) return this.fail(args.projectId, 'المشروع لا يحتوي script باسم build في package.json.')
      const manager = await detectPackageManager(args.projectPath)
      const buildEnvironment: NodeJS.ProcessEnv = { ...process.env, GITHUB_PAGES_BASE: pagesBasePath(parsed.owner, parsed.repo), FORCE_COLOR: '0' }
      delete buildEnvironment.GH_TOKEN
      const build = await runProcess(manager.command, [...manager.args, 'run', 'build'], args.projectPath, 600_000, buildEnvironment)
      if (!build.ok) return this.fail(args.projectId, `فشل build قبل النشر:\n${sanitize(build.output, args.token)}`, false)
      this.state = { ...this.state, status: 'deploying', buildSucceeded: true }
      const artifactDir = await findArtifact(args.projectPath)
      if (!artifactDir) return this.fail(args.projectId, 'نجح build لكن لم يوجد artifact dist أو build للنشر.', true)
      this.state = { ...this.state, artifactDir }
      await this.publisher(artifactDir, args.repoUrl, branch, args.token)
      this.state = { status: 'success', projectId: args.projectId, buildSucceeded: true, pushSucceeded: true, pagesStatus: 'pending', artifactDir, url: extractPagesUrl(parsed), startedAt }
      return { ...this.state }
    } catch (e) {
      return this.fail(args.projectId, sanitize(e instanceof Error ? e.message : String(e), args.token), this.state.buildSucceeded)
    }
  }

  status(projectId: string): DeployState { return this.state.projectId && this.state.projectId !== projectId ? { status: 'idle' } : { ...this.state, projectId } }
  private fail(projectId: string, error: string, buildSucceeded = false): DeployState { this.state = { status: 'failed', projectId, buildSucceeded, pushSucceeded: false, pagesStatus: 'failed', error, startedAt: this.state.startedAt }; return { ...this.state } }
}

interface GitHubRepo { owner: string; repo: string }
interface PackageJson { scripts?: Record<string, unknown> }
interface PackageManager { command: string; args: string[] }
export type PublishArtifact = (artifactDir: string, repoUrl: string, branch: string, token: string) => Promise<void>

export function parseGitHubRepo(value: string): GitHubRepo | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length !== 2 || parts.some((part) => part === '.' || part === '..') || !/^[A-Za-z0-9_.-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(parts[1]!)) return null
    return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/i, '') }
  } catch { return null }
}

export function isSafeGitRef(value: string): boolean {
  const parts = value.split('/')
  return value.length > 0 && value.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..') && !value.includes('//') && !value.includes('@{') && !value.endsWith('/') && parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.startsWith('.') && !part.endsWith('.'))
}

function extractPagesUrl(repo: GitHubRepo): string {
  return repo.repo.toLowerCase() === `${repo.owner.toLowerCase()}.github.io` ? `https://${repo.owner}.github.io/` : `https://${repo.owner}.github.io/${repo.repo}/`
}

function pagesBasePath(owner: string, repo: string): string { return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? '/' : `/${repo}/` }

async function readPackageJson(projectPath: string): Promise<PackageJson | null> {
  try { return JSON.parse(await fs.readFile(join(projectPath, 'package.json'), 'utf8')) as PackageJson } catch { return null }
}

async function detectPackageManager(projectPath: string): Promise<PackageManager> {
  if (await exists(join(projectPath, 'pnpm-lock.yaml'))) return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] }
  if (await exists(join(projectPath, 'yarn.lock'))) return { command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn', args: [] }
  if (await exists(join(projectPath, 'bun.lockb')) || await exists(join(projectPath, 'bun.lock'))) return { command: process.platform === 'win32' ? 'bun.exe' : 'bun', args: [] }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] }
}

async function exists(value: string): Promise<boolean> { try { await fs.lstat(value); return true } catch { return false } }

async function findArtifact(projectPath: string): Promise<string | null> {
  for (const name of ['dist', 'build']) {
    const target = resolve(projectPath, name)
    try { if ((await fs.stat(target)).isDirectory()) return target } catch { /* try next known artifact */ }
  }
  return null
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveResult) => {
    const child = spawnPackageCommand(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    const chunks: string[] = []
    let settled = false
    let terminating = false
    const finish = (result: { ok: boolean; output: string }): void => { if (settled) return; settled = true; clearTimeout(timer); resolveResult(result) }
    const collect = (chunk: Buffer): void => { chunks.push(chunk.toString('utf8')); if (chunks.join('').length > 8_000) chunks.splice(0, Math.max(0, chunks.length - 20)) }
    child.stdout?.on('data', collect); child.stderr?.on('data', collect)
    child.once('error', (error) => finish({ ok: false, output: error.message }))
    child.once('close', (code) => { if (!terminating) finish({ ok: code === 0, output: chunks.join('').slice(-8_000) || (code === 0 ? 'تم' : `فشل ${code}`) }) })
    const timer = setTimeout(() => { terminating = true; void killProcessTree(child).then(() => finish({ ok: false, output: `انتهت مهلة build:\n${chunks.join('').slice(-4_000)}` })) }, timeoutMs)
  })
}

async function publishArtifact(artifactDir: string, repoUrl: string, branch: string, token: string): Promise<void> {
  const workerPath = join(__dirname, 'deploy-worker.js')
  if (!(await exists(workerPath))) throw new Error('عامل النشر غير موجود في نسخة التطبيق.')
  await new Promise<void>((resolveResult, reject) => {
    const child = fork(workerPath, [], { silent: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GH_TOKEN: token } })
    let settled = false
    let terminating = false
    const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolveResult() }
    child.on('message', (message: unknown) => { const result = message as { ok?: boolean; error?: string }; result.ok ? finish() : finish(new Error(result.error ?? 'فشل رفع artifact')) })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => { if (!settled && !terminating && code !== 0) finish(new Error(`فشل عامل النشر برمز ${code}`)) })
    child.send({ artifactDir, repoUrl, branch })
    const timer = setTimeout(() => { terminating = true; void killProcessTree(child).then(() => finish(new Error('انتهت مهلة النشر.'))) }, 600_000)
  })
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.killed || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>((done) => { const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('close', () => done()); killer.once('error', () => done()) })
  } else { try { child.kill('SIGTERM') } catch {} }
  if (child.exitCode === null) await new Promise<void>((done) => { const timer = setTimeout(done, 2_000); child.once('close', () => { clearTimeout(timer); done() }) })
}

function sanitize(value: string, token: string): string { return token ? value.split(token).join('[TOKEN]') : value }

function spawnPackageCommand(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args].map(commandArgument).join(' ')], options)
  }
  return spawn(command, args, options)
}

function commandArgument(value: string): string { return /[\s"&|<>^]/.test(value) ? `"${value.replace(/["^]/g, (character) => `^${character}`)}"` : value }
