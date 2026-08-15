/**
 * DevServerManager — runs the project's declared dev script with an owned process tree.
 *
 * المبادئ:
 *  - أداة واحدة فقط (start_preview / devserver:start) هي المسؤولة عن تشغيل المعاينة.
 *  - إذا كان هناك خادم تطوير يعمل بالفعل لنفس المشروع (سواء شغّلناه نحن أو شغّله
 *    المستخدم يدويًا) فنعيد استخدامه بدل تشغيل نسخة ثانية أو قتل العملية.
 *  - لا نقتل أبدًا خادمًا خارجيًا لا نملكه؛ نشغّل المشروع الجديد على منفذ حر.
 *  - عند تبديل المشروع نوقف خادم المشروع السابق الذي نملكه فقط، ولا نتبنّى خادم
 *    مشروع آخر (حتى لا تظهر "مشاريع قديمة").
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import type { DevServerState } from '../shared/types'

let instance: DevServerManager | null = null
export function getDevServerManager(): DevServerManager { if (!instance) instance = new DevServerManager(); return instance }

export class DevServerManager {
  private state: DevServerState = { running: false }
  private child: ChildProcess | null = null
  private installChild: ChildProcess | null = null
  private generation = 0
  /** أجيال أُعيد تشغيلها تلقائيًا بعد انهيار — مرة واحدة لكل جيل فقط */
  private restartedGenerations = new Set<number>()
  private readonly starts = new Map<string, Promise<DevServerState>>()
  private lifecycle: Promise<void> = Promise.resolve()

  async start(projectId: string, projectPath: string, signal?: AbortSignal): Promise<DevServerState> {
    return this.enqueueStart(projectId, projectPath, () => this.withAbort(projectId, projectPath, signal, () => this.startInternal(projectId, projectPath)))
  }

  private async startInternal(projectId: string, projectPath: string): Promise<DevServerState> {
    // إن كان لدينا خادم نملكه لمشروع مختلف، أوقفه أولًا لتحرير المنفذ.
    if ((this.child && !sameProject(this.state.projectPath ?? '', projectPath)) || (this.state.running && this.state.projectPath && !sameProject(this.state.projectPath, projectPath))) {
      await this.stopInternal()
    }
    const generation = ++this.generation
    try {
      const packageJson = await readPackageJson(projectPath)
      if (!packageJson) return this.fail(projectId, projectPath, 'لا يوجد package.json صالح في المشروع.')
      if (!packageJson.scripts || typeof packageJson.scripts.dev !== 'string' || !packageJson.scripts.dev.trim()) return this.fail(projectId, projectPath, 'المشروع لا يحتوي script باسم dev في package.json.')
      // P14: لا نكتفي بوجود node_modules — نتحقق أن أداة التشغيل الفعلية (vite/next/...) مثبتة،
      // وإلا فـ npm run dev يفشل على stderr بلا رابط وننتظر 45 ثانية مهلة عقيمة.
      if (!(await devToolAvailable(projectPath, packageJson))) {
        this.state = { running: false, projectId, projectPath, requiresInstall: true }
        return { ...this.state }
      }
      const manager = await detectPackageManager(projectPath)
      const vite = /\bvite\b/i.test(String(packageJson.scripts.dev))
      const expectedPort = await readDevPort(projectPath, vite)
      // إعادة الاستخدام محصورة بالعملية التي يملكها هذا المدير، لا بأي منفذ مستجيب.
      if (this.state.running && sameProject(this.state.projectPath ?? '', projectPath) && this.child && this.child.exitCode === null) return { ...this.state }
      this.state = { running: false, projectId, projectPath }
      if (generation !== this.generation) return { running: false, projectId, projectPath }
      let lastError = 'توقف خادم التطوير دون رابط.'
      for (let attempt = 0; attempt < 4; attempt++) {
        if (generation !== this.generation) return { running: false, projectId, projectPath }
        // المحاولة الأولى على المنفذ المتوقع؛ إن كان مشغولًا (خادم خارجي/آخر) ننتقل لمنفذ حر.
        const port = attempt === 0 ? expectedPort : await findAvailablePort(expectedPort + attempt)
        const result = await this.spawnDev(projectId, projectPath, manager, port, generation, vite)
        if (result.running) return result
        lastError = result.error ?? lastError
        const isPortConflict = /address already in use|eaddrinuse|المنفذ|port/i.test(lastError)
        const isStartTimeout = /انتهت مهلة تشغيل الخادم/i.test(lastError)
        // Q14: تعارض المنفذ يعيد المحاولة دائمًا؛ مهلة البدء تعيد المحاولة مرة واحدة فقط (قد تكون عطلًا عابرًا)
        if (!isPortConflict && !(isStartTimeout && attempt === 0)) break
        // P7: اقتل عملية المحاولة السابقة إن بقيت حية (شجرة cmd.exe لم تخرج بعد) قبل المحاولة التالية.
        if (this.child && this.child.exitCode === null) await killProcessTree(this.child)
      }
      return this.fail(projectId, projectPath, lastError)
    } catch (error) {
      return this.fail(projectId, projectPath, error instanceof Error ? error.message : String(error))
    }
  }

  async startWithInstall(projectId: string, projectPath: string, signal?: AbortSignal): Promise<DevServerState> {
    return this.enqueueStart(projectId, projectPath, () => this.withAbort(projectId, projectPath, signal, async () => {
      let state = await this.startInternal(projectId, projectPath)
      if (!state.requiresInstall) return state
      const installed = await this.installDeps(projectId, projectPath)
      if (!installed.ok) return { ...state, error: installed.output || 'فشل تثبيت اعتماديات المشروع.' }
      return this.startInternal(projectId, projectPath)
    }))
  }

  /**
   * Q2: يستمع لإشارة الإلغاء (AbortSignal) ويوقف العمليات فورًا عند الإلغاء —
   * بدل انتظار انتهاء تثبيت الاعتماديات أو مهلة البدء.
   */
  private async withAbort(projectId: string, projectPath: string, signal: AbortSignal | undefined, operation: () => Promise<DevServerState>): Promise<DevServerState> {
    if (signal?.aborted) return { running: false, projectId, projectPath, error: 'أُلغي تشغيل المعاينة.' }
    const onAbort = (): void => { void this.stopInternal() }
    signal?.addEventListener('abort', onAbort, { once: true })
    try { return await operation() } finally { signal?.removeEventListener('abort', onAbort) }
  }

  private enqueueStart(projectId: string, projectPath: string, operation: () => Promise<DevServerState>): Promise<DevServerState> {
    const key = `${projectId}:${resolve(projectPath)}`
    const existing = this.starts.get(key)
    if (existing) return existing
    const queued = this.lifecycle.then(operation, operation)
    this.lifecycle = queued.then(() => undefined, () => undefined)
    this.starts.set(key, queued)
    void queued.finally(() => { if (this.starts.get(key) === queued) this.starts.delete(key) })
    return queued
  }

  async stop(projectId: string): Promise<DevServerState> {
    if (this.state.projectId && this.state.projectId !== projectId) {
      // خادم مشروع آخر لا يجب أن نمسّه.
      return { running: false, projectId }
    }
    // أوقف العمليات فورًا دون انتظار عمليات البدء المعلقة (قد تكون تثبيت اعتماديات يستغرق دقائق)
    this.generation++
    const child = this.child
    const installChild = this.installChild
    this.child = null
    this.installChild = null
    this.state = { running: false, projectId }
    if (child && child.exitCode === null) void killProcessTree(child)
    if (installChild && installChild.exitCode === null) void killProcessTree(installChild)
    await this.lifecycle
    return { ...this.state, projectId }
  }

  status(projectId: string): DevServerState {
    if (this.state.projectId && this.state.projectId !== projectId) return { running: false, projectId }
    // حارس: لا نعرض "يعمل" لخادم ماتت عمليته فعليًا (انقلاب نادر قبل close handler).
    if (this.state.running && this.child && this.child.exitCode !== null) {
      this.state = { running: false, projectId: this.state.projectId, projectPath: this.state.projectPath, error: 'توقف خادم المعاينة.' }
    }
    return { ...this.state, projectId }
  }

  async installDeps(projectId: string, projectPath: string): Promise<{ ok: boolean; output: string; requiresInstall?: boolean }> {
    const packageJson = await readPackageJson(projectPath)
    if (!packageJson) return { ok: false, output: 'لا يوجد package.json صالح في المشروع.' }
    const manager = await detectPackageManager(projectPath)
    const result = await runProcess(manager.command, [...manager.args, 'install', '--no-audit', '--no-fund'], projectPath, 300_000, (child) => { this.installChild = child })
    if (this.installChild && this.installChild.exitCode !== null) this.installChild = null
    if (this.state.projectId === projectId && result.ok) this.state = { ...this.state, requiresInstall: false, error: undefined }
    return { ...result, requiresInstall: !result.ok }
  }

  async shutdown(): Promise<void> { await this.lifecycle; if (this.state.projectId || this.child) await this.stopInternal() }

  private async spawnDev(projectId: string, projectPath: string, manager: PackageManager, port: number, generation: number, vite: boolean): Promise<DevServerState> {
    // مشاريع Vite تحصل على وسائط host/port/strictPort؛ المشاريع العامة (Node/Express...) تُشغَّل كما هي
    const args = vite
      ? [...manager.args, 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
      : [...manager.args, 'run', 'dev']
    return new Promise((resolveResult) => {
      const child = spawnPackageCommand(manager.command, args, { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', PORT: String(port) } })
      this.child = child
      let output = ''
      let settled = false
      let terminating = false
      const startedAt = Date.now()
      const finish = (state: DevServerState): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout?.removeListener('data', onOutput)
        child.stderr?.removeListener('data', onOutput)
        resolveResult(state)
      }
      const onOutput = (chunk: Buffer): void => {
        output = `${output}${chunk.toString('utf8')}`.slice(-8_000)
        // حرج: vite يطبع الرابط بأكواد ANSI ملونة تقطع النص (مثل Local<ESC>[22m: و 127.0.0.1:<ESC>[1m5177)
        // فلا يطابق regex أبدًا رغم أن الخادم جاهز — نجرد أكواد ANSI قبل المطابقة.
        const clean = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        const match = vite
          ? clean.match(/(?:Local|Network):\s+(https?:\/\/[^\s]+)/i) ?? clean.match(/(https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?)/i)
          : detectGenericUrl(clean)
        if (match && generation === this.generation && !settled) {
          const url = match[1]!.replace(/[),]+$/, '')
          const port = urlPort(url)
          // P2: فحص TCP حيوي — لا نعلن "يعمل" إلا إذا كان المنفذ يستقبل اتصالات فعلًا،
          // حتى لا يظهر رابط لخادم طبع الرابط ثم انهار فورًا.
          void probePort(port).then((alive) => {
            if (!alive || settled || generation !== this.generation) return
            this.state = { running: true, projectId, projectPath, url, port, startedAt }
            finish({ ...this.state })
          })
        }
      }
      child.stdout?.on('data', onOutput); child.stderr?.on('data', onOutput)
      child.once('error', (error) => finish({ running: false, projectId, projectPath, error: error.message }))
      child.once('close', (code) => {
        if (this.child === child) this.child = null
        if (!settled && !terminating) finish({ running: false, projectId, projectPath, error: code === 0 ? 'توقف خادم التطوير دون رابط.' : `توقف الخادم برمز ${code}:\n${output.slice(-1200)}` })
        else if (this.state.projectId === projectId && generation === this.generation) {
          const wasRunning = this.state.running
          this.state = { running: false, projectId, projectPath, error: code === 0 ? undefined : output.slice(-1200) }
          // إعادة تشغيل تلقائية (مرة واحدة لكل جيل) إذا انهار خادم كان يعمل
          // فعلًا — عطل عابر لا يجب أن يظهر للمستخدم كموت للخادم.
          if (wasRunning && code !== 0 && !this.restartedGenerations.has(generation)) {
            this.restartedGenerations.add(generation)
            void this.spawnDev(projectId, projectPath, manager, port, generation, vite).then((restarted) => {
              if (generation === this.generation) this.state = restarted
            })
          }
        }
      })
      const timer = setTimeout(async () => {
        if (settled || generation !== this.generation) return
        terminating = true
        void killProcessTree(child).then(() => finish({ running: false, projectId, projectPath, error: `انتهت مهلة تشغيل الخادم:\n${output.slice(-1200)}` }))
      }, 45_000)
    })
  }

  private async stopInternal(): Promise<void> {
    this.generation++
    const child = this.child
    const installChild = this.installChild
    this.child = null
    this.installChild = null
    if (child) await killProcessTree(child)
    if (installChild) await killProcessTree(installChild)
    this.state = { running: false }
  }

  private fail(projectId: string, projectPath: string, error: string): DevServerState {
    this.state = { running: false, projectId, projectPath, error }
    return { ...this.state }
  }
}

interface PackageManager { command: string; args: string[] }

async function readPackageJson(projectPath: string): Promise<{ scripts?: Record<string, unknown> } | null> {
  try { return JSON.parse(await fs.readFile(join(projectPath, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> } } catch { return null }
}

async function detectPackageManager(projectPath: string): Promise<PackageManager> {
  // P13: فحص ملفات القفل بالتوازي بدل تسلسلي.
  const [pnpm, yarn, bun] = await Promise.all([
    exists(join(projectPath, 'pnpm-lock.yaml')),
    exists(join(projectPath, 'yarn.lock')),
    exists(join(projectPath, 'bun.lockb')).then((locked) => locked || exists(join(projectPath, 'bun.lock'))),
  ])
  if (pnpm) return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] }
  if (yarn) return { command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn', args: [] }
  if (bun) return { command: process.platform === 'win32' ? 'bun.exe' : 'bun', args: [] }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] }
}

async function exists(value: string): Promise<boolean> { try { await fs.lstat(value); return true } catch { return false } }

/**
 * P14: يتحقق أن أداة التشغيل الفعلية (vite/next/react-scripts/...) مثبتة في المشروع،
 * وليس فقط أن node_modules موجودة. يمنع انتظار 45 ثانية عقيمة عندما يفشل npm run dev
 * على stderr بلا رابط لأن الأداة غير موجودة.
 */
async function devToolAvailable(projectPath: string, packageJson: { scripts?: Record<string, unknown> }): Promise<boolean> {
  if (!(await exists(join(projectPath, 'node_modules')))) return false
  const dev = String(packageJson.scripts?.dev ?? '').trim()
  const first = dev.split(/\s+/)[0] ?? ''
  if (!first) return false
  if (first === 'node') return true
  // أمر نسبي داخل المشروع مثل ./server.js أو scripts/dev.mjs
  if (first.startsWith('.') || first.includes('/') || first.includes('\\')) return await exists(join(projectPath, first))
  return await binExists(projectPath, first)
}

async function binExists(projectPath: string, name: string): Promise<boolean> {
  const binDir = join(projectPath, 'node_modules', '.bin')
  for (const candidate of [name, `${name}.cmd`, `${name}.exe`, `${name}.ps1`, `${name}.bat`]) {
    if (await exists(join(binDir, candidate))) return true
  }
  // بعض الحزم (مثل vite) تعرّف bin في package.json بدل مجلد .bin المباشر
  try {
    const pkg = JSON.parse(await fs.readFile(join(projectPath, 'node_modules', name, 'package.json'), 'utf8')) as { bin?: unknown }
    return pkg.bin !== undefined
  } catch { return false }
}

/**
 * P2: فحص TCP حيوي — هل المنفذ يستقبل اتصالات فعلًا؟
 * يحمي من إعلان "يعمل" لخادم طبع الرابط ثم انهار قبل فتح المنفذ.
 */
async function probePort(port: number): Promise<boolean> {
  if (!port) return true
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await canConnectPort(port)) return true
    await sleep(150)
  }
  return false
}

function canConnectPort(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(700)
    socket.once('connect', () => { socket.destroy(); resolveConnect(true) })
    socket.once('error', () => resolveConnect(false))
    socket.once('timeout', () => { socket.destroy(); resolveConnect(false) })
  })
}

function sleep(ms: number): Promise<void> { return new Promise((done) => setTimeout(done, ms)) }

function detectGenericUrl(output: string): RegExpMatchArray | null {
  return output.match(/(https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[^\s,)\]]*)?)/i)
}

function urlPort(url: string): number {
  try { return Number(new URL(url).port) || 0 } catch { return 0 }
}

async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    if (await canBindPort(port)) return port
  }
  throw new Error('لم يتم العثور على منفذ متاح لتشغيل المعاينة.')
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)))
  })
}

/** يقرأ منفذ التطوير المتوقع من vite.config، وافتراضيًا 5173. */
async function readDevPort(projectPath: string, vite: boolean): Promise<number> {
  if (vite) {
    for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs']) {
      const configPath = join(projectPath, name)
      if (await exists(configPath)) {
        try {
          const raw = await fs.readFile(configPath, 'utf8')
          // P5: نزيل التعليقات قبل البحث — وإلا قد يلتقط regex منفذًا من سطر تعليق قديم.
          const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])[ \t]*\/\/.*$/gm, '$1')
          const match = text.match(/server\s*:\s*\{[^}]*port\s*:\s*(\d+)/s) ?? text.match(/port\s*:\s*(\d+)/)
          if (match) return Number(match[1])
        } catch { /* تجاهل واستخدم الافتراضي */ }
      }
    }
  }
  return 5173
}

function sameProject(first: string, second: string): boolean {
  const a = resolve(first).replace(/[\\/]$/, '')
  const b = resolve(second).replace(/[\\/]$/, '')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, onChild?: (child: ChildProcess) => void): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveResult) => {
    const child = spawnPackageCommand(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: { ...process.env, FORCE_COLOR: '0' } })
    onChild?.(child)
    const chunks: string[] = []
    let settled = false
    let terminating = false
    const finish = (result: { ok: boolean; output: string }): void => { if (settled) return; settled = true; clearTimeout(timer); resolveResult(result) }
    const collect = (chunk: Buffer): void => { chunks.push(chunk.toString('utf8')); if (chunks.join('').length > 8_000) chunks.splice(0, Math.max(0, chunks.length - 20)) }
    child.stdout?.on('data', collect); child.stderr?.on('data', collect)
    child.once('error', (error) => finish({ ok: false, output: error.message }))
    child.once('close', (code) => { if (!terminating) finish({ ok: code === 0, output: chunks.join('').slice(-8_000) || (code === 0 ? 'تم' : `فشل ${code}`) }) })
    const timer = setTimeout(() => { terminating = true; void killProcessTree(child).then(() => finish({ ok: false, output: `انتهت مهلة العملية:\n${chunks.join('').slice(-4_000)}` })) }, timeoutMs)
  })
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.killed || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('close', () => done()); killer.once('error', () => done())
    })
  } else {
    try { child.kill('SIGTERM') } catch {}
  }
  if (child.exitCode === null) await new Promise<void>((done) => { const timer = setTimeout(done, 2_000); child.once('close', () => { clearTimeout(timer); done() }) })
}

function spawnPackageCommand(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args].map(commandArgument).join(' ')], options)
  }
  return spawn(command, args, options)
}

function commandArgument(value: string): string { return /[\s"&|<>^]/.test(value) ? `"${value.replace(/["^]/g, (character) => `^${character}`)}"` : value }
