import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { join, relative, resolve, isAbsolute, extname } from 'node:path'
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { AppDatabase } from './database'
import { ProviderStore } from './provider-store'
import { CustomProviderStore } from './custom-provider-store'
import { TavilyStore } from './tavily-store'
import { AgentRunner } from './agent'
import { ensureGitRepository, isBlockedHost } from './tools'
import { McpManager } from './mcp'
import { requestModel, requestOnce } from './provider'
import { GO_MODELS, apiPathFor } from '../shared/models'
import type { Attachment, TreeEntry, ApiStyle, CustomProviderUpdate, ProviderConfig } from '../shared/types'
import { isTrustedRendererUrl } from './ipc-security'
import { createRuntimeMarker, type RuntimeMarker } from './runtime-marker'
import { autoUpdater } from 'electron-updater'
import { initSentry, captureException } from './sentry'
import { listTemplates, createProject } from './scaffold'
import { getDevServerManager } from './dev-server'
import { getDeployManager } from './deploy'
import { BuildDomain, cleanupLegacyBuildSessions } from './build-domain'
import { getBuildStats, readBuildFileContent, readBuildFiles } from './build-files'
import { MAIN_CHAT_PROFILE } from './agent-profile'

let mainWindow: BrowserWindow | null = null
let trustedRendererUrl = ''
let database: AppDatabase | null = null
let agentRunner: AgentRunner | null = null
let buildDomain: BuildDomain | null = null
let mcpManager: McpManager | null = null
let quitting = false
let runtimeMarker: RuntimeMarker

process.on('uncaughtException', (error) => {
  captureException(error, { type: 'uncaughtException' })
  try { database?.addAudit({ category: 'security', action: 'uncaught-exception', detail: `${error?.message ?? String(error)}`.slice(0, 4000), outcome: 'failed' }) } catch { console.error('uncaughtException', error) }
  console.error('uncaughtException', error)
})
process.on('unhandledRejection', (reason) => {
  captureException(reason instanceof Error ? reason : new Error(String(reason)), { type: 'unhandledRejection' })
  try { database?.addAudit({ category: 'security', action: 'unhandled-rejection', detail: `${reason instanceof Error ? reason.message : String(reason)}`.slice(0, 4000), outcome: 'failed' }) } catch { console.error('unhandledRejection', reason) }
  console.error('unhandledRejection', reason)
})

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (!mainWindow) return; if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() })
   void app.whenReady().then(() => {
     initSentry() // P2-06: مراقبة أخطاء (تفعّل فقط مع SENTRY_DSN)
     runtimeMarker = createRuntimeMarker({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), mainDir: __dirname })
     console.info(`[runtime-marker] ${runtimeMarker.marker}`)
     const db = new AppDatabase(join(app.getPath('userData'), 'r-code-agent.db'))
    database = db
    const providers = new ProviderStore(join(app.getPath('userData'), 'provider.json'))
    const customProviders = new CustomProviderStore(join(app.getPath('userData'), 'custom-providers.json'))
    const tavilyStore = new TavilyStore(join(app.getPath('userData'), 'tavily.json'))
    const mcp = new McpManager(join(app.getPath('userData'), 'mcp.json'))
    mcpManager = mcp
    const agent = new AgentRunner(db, providers, () => mainWindow?.isDestroyed() ? null : mainWindow?.webContents ?? null, undefined, mcp, MAIN_CHAT_PROFILE.eventChannel, MAIN_CHAT_PROFILE.approvalChannel, undefined, undefined, undefined, tavilyStore, MAIN_CHAT_PROFILE, customProviders)
    agentRunner = agent
     buildDomain = new BuildDomain({ userData: app.getPath('userData'), providers, mcp, getWebContents: () => mainWindow?.isDestroyed() ? null : mainWindow?.webContents ?? null, startPreview: (projectId, projectPath, signal) => getDevServerManager().startWithInstall(projectId, projectPath, signal), stopPreview: (projectId) => getDevServerManager().stop(projectId), previewStatus: (projectId) => getDevServerManager().status(projectId), tavilyStore, customProviders })
    registerIpc(db, providers, customProviders, agent, tavilyStore)
    registerBuildIpc(buildDomain)
    try { cleanupLegacyBuildSessions(db, agent) } catch { /* تنظيف قديم — لا يعطل الإقلاع */ }
    createWindow()
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', (event) => {
    if (quitting) { database?.close(); database = null; agentRunner = null; return }
    event.preventDefault(); quitting = true
    void Promise.allSettled([agentRunner?.shutdown(false), buildDomain?.shutdown(), getDevServerManager().shutdown()]).then(() => mcpManager?.close()).finally(() => app.quit())
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}

function createWindow(): void {
  const rendererFile = join(__dirname, '../renderer/index.html')
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  trustedRendererUrl = developmentUrl ? new URL(developmentUrl).href : pathToFileURL(rendererFile).href
  const window = new BrowserWindow({
    width: 1480, height: 940, minWidth: 760, minHeight: 560, show: false,
    backgroundColor: '#0d1017', title: 'Code Agent',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false }
  })
  mainWindow = window
  const electronSession = window.webContents.session
  electronSession.setPermissionCheckHandler(() => false)
  electronSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  electronSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
  window.on('closed', () => { if (mainWindow === window) mainWindow = null })
  window.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => { if (!isTrustedUrl(url)) { event.preventDefault(); void openExternal(url) } })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(rendererFile)

  // ─── P3-04: Auto-Update (electron-updater) ─────────────────────────
  if (app.isPackaged) {
    try {
      autoUpdater.autoDownload = false // لا نحمل تلقائياً — ننتظر موافقة المستخدم
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.on('update-available', () => {
        if (!window.isDestroyed()) {
          window.webContents.send('agent:event', {
            sessionId: '', type: 'status',
            text: 'يتوفر تحديث جديد! سيُثبَّت عند إغلاق التطبيق.',
          })
        }
      })
      autoUpdater.checkForUpdates().catch(() => { /* فشل صامت — يمكن الفحص يدويًا */ })
    } catch { /* electron-updater غير متاح في وضع dev */ }
  }
}

const id = z.string().uuid()
const filePath = z.string().min(1).max(32_767)
const providerUpdate = z.object({ model: z.enum(GO_MODELS.map((model) => model.id) as [string, ...string[]]), apiKey: z.string().max(8192).optional(), contextWindow: z.number().int().min(32_000).max(2_000_000).optional() }).strict()
const sessionPatch = z.object({ title: z.string().trim().min(1).max(200).optional(), permissionMode: z.enum(['ask', 'full', 'read-only']).optional(), agentMode: z.enum(['build', 'plan']).optional() }).strict()
const sessionCreate = z.object({ workspace: filePath, title: z.string().trim().min(1).max(200).optional(), initGit: z.boolean().optional() }).strict()
const attachmentInput = z.object({ name: z.string().min(1).max(255), mimeType: z.string().min(1).max(128), data: z.string().max(28_000_000), size: z.number().int().nonnegative().max(20_000_000) }).strict()
const attachmentsInput = z.array(attachmentInput).max(10).refine((items) => items.reduce((total, item) => total + item.size, 0) <= 40_000_000, 'إجمالي المرفقات أكبر من 40 ميغابايت').refine((items) => items.every((item) => /^[A-Za-z0-9+/]*={0,2}$/.test(item.data)), 'بيانات مرفق غير صالحة')

function registerIpc(db: AppDatabase, providers: ProviderStore, customProviders: CustomProviderStore, agent: AgentRunner, tavilyStore: TavilyStore): void {
  handle('diagnostics:runtimeMarker', z.tuple([]), () => runtimeMarker)
  handle('app:update:check', z.tuple([]), async () => {
    if (!app.isPackaged) return { status: 'dev' as const, message: 'التحديثات متاحة بعد بناء نسخة التثبيت.' }
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result?.updateInfo || result.updateInfo.version === app.getVersion()) return { status: 'none' as const, message: 'أنت تستخدم أحدث إصدار.' }
      return { status: 'available' as const, version: result.updateInfo.version, message: `يتوفر الإصدار ${result.updateInfo.version}.` }
    } catch (error) {
      return { status: 'error' as const, message: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('app:update:install', z.tuple([]), async () => {
    if (!app.isPackaged) throw new Error('التحديثات متاحة بعد بناء نسخة التثبيت.')
    await autoUpdater.downloadUpdate()
    autoUpdater.quitAndInstall()
  })
  handle('sessions:create', z.tuple([sessionCreate]), async (input) => { const workspace = await fs.realpath(input.workspace); if (!(await fs.stat(workspace)).isDirectory()) throw new Error('مساحة العمل ليست مجلدًا'); if (input.initGit) await ensureGitRepository(workspace); return db.createSession(workspace, input.title, Boolean(input.initGit)) })
  handle('sessions:list', z.tuple([]), () => db.listSessions())
  handle('sessions:update', z.tuple([id, sessionPatch]), (sessionId, patch) => db.updateSession(sessionId, patch))
  handle('sessions:remove', z.tuple([id]), (sessionId) => { agent.cancel(sessionId); agent.forgetSession(sessionId); db.deleteSession(sessionId) })
  handle('sessions:clearAll', z.tuple([]), () => { const running = agent.states(); for (const state of running) { agent.cancel(state.sessionId); agent.forgetSession(state.sessionId) }; return db.deleteAllSessions() })
  handle('sessions:setPrompt', z.tuple([id, z.string().max(50_000)]), (sessionId, prompt) => db.setSystemPrompt(sessionId, prompt))
  handle('sessions:approvePlan', z.tuple([id]), (sessionId) => db.approvePlan(sessionId))
  handle('sessions:setTodos', z.tuple([id, z.array(z.object({ content: z.string().trim().min(1).max(500), status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(), priority: z.enum(['high', 'medium', 'low']).optional() }).strict()).max(100)]), (sessionId, items) => db.setTodos(sessionId, items))
  handle('sessions:run', z.tuple([id]), (sessionId) => db.getAgentRun(sessionId))
  handle('sessions:messages', z.tuple([id]), (sessionId) => db.listMessages(sessionId))
  handle('sessions:usage', z.tuple([id]), (sessionId) => db.getUsageSummary(sessionId))
  handle('sessions:subagents', z.tuple([id]), (sessionId) => db.listSubagentEvents(sessionId))
  handle('sessions:checkpoints', z.tuple([id]), (sessionId) => db.listCheckpoints(sessionId))
  handle('sessions:restoreCheckpoint', z.tuple([id, id, z.enum(['all', 'chat', 'code'])]), async (sessionId, checkpointId, mode) => {
    const cp = db.getCheckpoint(checkpointId)
    if (!cp) throw new Error('نقطة التفتيش غير موجودة')
    if (mode === 'all' || mode === 'chat') {
      const messages = db.restoreCheckpointMessages(checkpointId)
      db.clearMessages(sessionId)
      for (const m of messages) {
        db.addMessage({ sessionId, role: m.role as 'user' | 'assistant' | 'system' | 'tool', content: m.content })
      }
    }
    if (mode === 'code') {
      // استرجاع الملفات المعدلة عبر git
      const files = cp.filesChanged
      if (files.length) {
        try { const { execFileSync } = await import('node:child_process'); execFileSync('git', ['checkout', 'HEAD', '--', ...files], { cwd: db.getSession(sessionId).workspace, windowsHide: true, timeout: 30_000 }) } catch { /* git not available or files missing */ }
      }
    }
  })
  ipcMain.handle('agent:send', (event, ...raw: unknown[]) => { assertTrustedSender(event); const [sessionId, text, attachments] = z.tuple([id, z.string().trim().min(1).max(200_000), attachmentsInput.optional()]).parse(raw); return agent.send(sessionId, text, attachments as Attachment[] | undefined) })
  handle('agent:cancel', z.tuple([id]), (sessionId) => agent.cancel(sessionId))
  handle('agent:resume', z.tuple([id]), (sessionId) => agent.send(sessionId, 'تابع التنفيذ من السياق المحفوظ دون إعادة ما تم إنجازه.'))
  handle('agent:states', z.tuple([]), () => agent.states())
  handle('approval:answer', z.tuple([id, z.boolean(), z.boolean().optional()]), (approvalId, allowed, remember = false) => agent.answerApproval(approvalId, allowed, remember))
  handle('audit:list', z.tuple([z.union([z.number().int().min(1).max(1000), z.undefined()])]), (limit) => db.listAudit(limit))
  handle('clipboard:writeText', z.tuple([z.string().max(1_000_000)]), (text) => clipboard.writeText(text))
  handle('provider:get', z.tuple([]), () => providers.getSettings())
  handle('provider:save', z.tuple([providerUpdate]), (update) => providers.save(update))
  handle('provider:clear', z.tuple([]), () => providers.clear())
  handle('provider:test', z.tuple([providerUpdate]), async (update) => { const config = providers.resolve(update); if (!config.apiKey) throw new Error('أضف مفتاح API أولًا'); const reply = await requestModel(config, [{ role: 'user', content: 'أجب بكلمة: متصل' }], [], { timeoutMs: 30_000, retries: 1 }); return reply.text })

  // ─── Custom Providers ─────────────────────────────────────────────
  const customProviderUpdateSchema = z.object({
    name: z.string().min(1).max(200),
    baseUrl: z.string().url(),
    apiKey: z.string().max(8192).optional(),
    apiStyle: z.enum(['chat', 'responses', 'anthropic']),
    models: z.array(z.object({
      modelId: z.string().min(1).max(200),
      contextWindow: z.number().int().min(32_000).max(2_000_000),
      maxOutputTokens: z.number().int().min(256).max(1_000_000),
    })).min(1).max(20),
    id: z.string().uuid().optional(),
  }).strict()

  handle('customProviders:list', z.tuple([]), () => customProviders.list())
  handle('customProviders:save', z.tuple([customProviderUpdateSchema]), (input) => customProviders.save(input))
  handle('customProviders:remove', z.tuple([z.string().uuid()]), (providerId) => customProviders.remove(providerId))
  handle('customProviders:getModelConfig', z.tuple([z.string().uuid(), z.string().uuid()]), (providerId, modelId) => customProviders.getConfig(providerId, modelId))
  handle('customProviders:testNewModel', z.tuple([z.object({
    baseUrl: z.string().url(),
    apiKey: z.string().max(8192).optional(),
    apiStyle: z.enum(['chat', 'responses', 'anthropic']),
    modelId: z.string().min(1).max(200),
  }).strict()]), async (input) => {
    const startTime = Date.now()
    try {
      const config: ProviderConfig = {
        name: 'test',
        baseUrl: input.baseUrl.replace(/\/+$/, ''),
        apiPath: apiPathFor(input.apiStyle),
        apiStyle: input.apiStyle,
        model: input.modelId,
        contextWindow: 128_000,
        maxOutputTokens: 4096,
        apiKey: input.apiKey ?? '',
      }
      await requestOnce(config, [{ role: 'user', content: 'Hi' }], [], { timeoutMs: 30_000, retries: 0 })
      return { success: true, modelId: input.modelId, latency: Date.now() - startTime }
    } catch (error) {
      return { success: false, modelId: input.modelId, error: error instanceof Error ? error.message : String(error), latency: Date.now() - startTime }
    }
  })
  handle('customProviders:testModel', z.tuple([z.string().uuid(), z.string().uuid()]), async (providerId, modelId) => {
    const config = customProviders.getConfig(providerId, modelId)
    if (!config) return { success: false, modelId, error: 'المزود أو النموذج غير موجود' }
    const startTime = Date.now()
    try {
      const providerConfig: ProviderConfig = {
        name: 'test',
        baseUrl: config.baseUrl,
        apiPath: apiPathFor(config.apiStyle),
        apiStyle: config.apiStyle,
        model: config.model,
        contextWindow: config.contextWindow,
        maxOutputTokens: config.maxOutputTokens,
        apiKey: config.apiKey,
      }
      await requestOnce(providerConfig, [{ role: 'user', content: 'Hi' }], [], { timeoutMs: 30_000, retries: 0 })
      return { success: true, modelId, latency: Date.now() - startTime }
    } catch (error) {
      return { success: false, modelId, error: error instanceof Error ? error.message : String(error), latency: Date.now() - startTime }
    }
  })

  handle('tavily:get', z.tuple([]), () => ({ hasApiKey: Boolean(tavilyStore.getKey()) }))
  handle('tavily:save', z.tuple([z.object({ apiKey: z.string().max(8192) })]), (input) => { tavilyStore.saveKey(input.apiKey); return { hasApiKey: Boolean(input.apiKey.trim()) } })
  handle('tavily:clear', z.tuple([]), () => { tavilyStore.clearKey(); return { hasApiKey: false } })
  handle('files:chooseFolder', z.tuple([]), async () => (await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] ?? null)
  handle('files:list', z.tuple([id, z.union([filePath, z.undefined()])]), async (sessionId, requested): Promise<TreeEntry[]> => {
    const target = await trustedSessionPath(db, sessionId, requested ?? '.')
    const entries = await fs.readdir(target, { withFileTypes: true })
    return entries.filter((entry) => !entry.isSymbolicLink() && !isIgnoredWorkspaceEntry(entry.name)).slice(0, 500).map((entry) => ({ name: entry.name, path: join(target, entry.name), directory: entry.isDirectory(), size: 0 }))
  })
  handle('files:read', z.tuple([id, filePath]), async (sessionId, requested) => {
    const target = await trustedSessionPath(db, sessionId, requested)
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > 500_000) throw new Error('الملف غير نصي أو أكبر من حد العرض')
    return fs.readFile(target, 'utf8')
  })
  handle('files:readAsBase64', z.tuple([id, filePath]), async (sessionId, requested): Promise<Attachment> => {
    const target = await trustedSessionPath(db, sessionId, requested)
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > 20_000_000) throw new Error('الملف فارغ أو أكبر من 20 ميغابايت')
    const data = await fs.readFile(target)
    const mime = mimeForExt(extname(target).toLowerCase())
    return { name: target.split(/[\\/]/).pop() ?? 'file', mimeType: mime, data: data.toString('base64'), size: stat.size }
  })
  handle('prompts:list', z.tuple([]), () => db.listCustomPrompts())
  handle('prompts:add', z.tuple([z.string().min(1).max(200), z.string().min(1).max(100_000)]), (title, content) => db.addCustomPrompt(title, content))
  handle('prompts:remove', z.tuple([z.string().uuid()]), (promptId) => { db.removeCustomPrompt(promptId) })
  handle('subagents:list', z.tuple([]), () => db.listSubagents())
  handle('subagents:create', z.tuple([z.object({ name: z.string().min(1).max(200), description: z.string().max(2000), color: z.string().max(20), model: z.string().max(200), systemPrompt: z.string().max(50_000), allowedTools: z.string().max(5000), enabled: z.boolean() })]), (input) => db.createSubagent(input))
  handle('subagents:update', z.tuple([z.string().uuid(), z.object({ name: z.string().min(1).max(200).optional(), description: z.string().max(2000).optional(), color: z.string().max(20).optional(), model: z.string().max(200).optional(), systemPrompt: z.string().max(50_000).optional(), allowedTools: z.string().max(5000).optional(), enabled: z.boolean().optional() }).strict()]), (subagentId, input) => db.updateSubagent(subagentId, input))
	  handle('subagents:remove', z.tuple([z.string().uuid()]), (subagentId) => { db.removeSubagent(subagentId) })

	  // ─── Build → Preview → Share ──────────────────────────────────
	  handle('scaffold:templates', z.tuple([]), () => listTemplates())
	  handle('scaffold:create', z.tuple([z.object({ template: z.string().min(1).max(100), projectName: z.string().min(1).max(200), targetDir: filePath, description: z.string().max(500).optional() }).strict()]), (input) => createProject(input.template, input.projectName, input.targetDir, input.description))
	  const devServer = getDevServerManager()
	  const deploy = getDeployManager()
	  const buildProjectId = z.string().uuid()
	  const relativeBuildPath = z.string().trim().min(1).max(1000).refine((value) => !value.includes('\0') && !isAbsolute(value), 'مسار ملف Build غير صالح')
	  handle('devserver:start', z.tuple([buildProjectId]), (projectId) => { if (!buildDomain) throw new Error('Build غير جاهز'); const resolved = buildDomain.resolveProject(projectId); return devServer.startWithInstall(projectId, resolved.path) })
	  handle('devserver:stop', z.tuple([buildProjectId]), (projectId) => devServer.stop(projectId))
	  handle('devserver:status', z.tuple([buildProjectId]), (projectId) => devServer.status(projectId))
	  handle('devserver:installDeps', z.tuple([buildProjectId]), (projectId) => { if (!buildDomain) throw new Error('Build غير جاهز'); const resolved = buildDomain.resolveProject(projectId); return devServer.installDeps(projectId, resolved.path) })

	  handle('deploy:githubPages', z.tuple([z.object({ projectId: buildProjectId, token: z.string().min(1).max(500), repoUrl: z.string().min(1).max(500), branch: z.string().max(100).optional() }).strict()]), (input) => { if (!buildDomain) throw new Error('Build غير جاهز'); const resolved = buildDomain.resolveProject(input.projectId); return deploy.deploy({ ...input, projectPath: resolved.path }) })
	  handle('deploy:status', z.tuple([buildProjectId]), (projectId) => deploy.status(projectId))

  const buildSchema = z.tuple([buildProjectId])
  handle('build:readFiles', buildSchema, (projectId) => { if (!buildDomain) throw new Error('Build غير جاهز'); return readBuildFiles(buildDomain.resolveProject(projectId).path) })
  handle('build:readFileContent', z.tuple([buildProjectId, relativeBuildPath]), (projectId, filePath) => { if (!buildDomain) throw new Error('Build غير جاهز'); return readBuildFileContent(buildDomain.resolveProject(projectId).path, filePath) })
  handle('build:getStats', buildSchema, (projectId) => { if (!buildDomain) throw new Error('Build غير جاهز'); return getBuildStats(buildDomain.resolveProject(projectId).path) })
}

function registerBuildIpc(domain: BuildDomain): void {
  const buildProjectSave = z.object({ name: z.string().trim().min(1).max(200), path: filePath, template: z.string().max(100), filesCount: z.number().int().nonnegative(), totalLines: z.number().int().nonnegative() }).strict()
  handle('build:projects:list', z.tuple([]), () => domain.projects.list())
  handle('build:projects:save', z.tuple([buildProjectSave]), (input) => domain.projects.save(input))
  handle('build:projects:open', z.tuple([z.string().uuid()]), (id) => domain.projects.open(id))
  handle('build:projects:remove', z.tuple([z.string().uuid()]), (id) => domain.projects.remove(id))
  handle('build:projects:clearChat', z.tuple([z.string().uuid()]), (projectId) => domain.projects.clearChat(projectId))
  ipcMain.handle('build:agent:send', (event, ...raw: unknown[]) => { assertTrustedSender(event); const [projectId, text, attachments, modelOverride] = z.tuple([z.string().uuid(), z.string().trim().min(1).max(200_000), attachmentsInput.optional(), z.string().max(100).optional()]).parse(raw); const resolved = domain.resolveProject(projectId); return domain.runner.send(resolved.session.id, text, attachments as Attachment[] | undefined, modelOverride).then(() => ({ queued: true })) })
  handle('build:agent:cancel', z.tuple([z.string().uuid()]), async (projectId) => {
    // الإلغاء لا يعتمد على وجود مجلد المشروع (resolveProject يرمي لو نُقل المجلد أو حُذف
    // وكان يترك الوكيل يعمل في الخلفية ويستهلك رصيدًا بلا أي طريقة لإيقافه).
    const sessionId = domain.sessionIdFor(projectId)
    if (!sessionId) return
    domain.runner.cancel(sessionId)
    // مهلة أمان: لا يعلّق زر الإيقاف إلى الأبد لو تأخر خروج حلقة الوكيل —
    // الإلغاء نفسه فوري، والانتظار فقط لتنظيف الحالة في قاعدة البيانات.
    await Promise.race([domain.runner.waitForIdle(sessionId), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000))])
  })
  handle('build:agent:resume', z.tuple([z.string().uuid()]), (projectId) => { const resolved = domain.resolveProject(projectId); return domain.runner.send(resolved.session.id, 'تابع التنفيذ من السياق المحفوظ دون إعادة ما تم إنجازه.') })
  handle('build:agent:states', z.tuple([]), () => domain.runner.states())
  handle('build:approval:answer', z.tuple([id, z.boolean(), z.boolean().optional()]), (approvalId, allowed, remember = false) => domain.runner.answerApproval(approvalId, allowed, remember))
}

function handle<A extends unknown[], R>(channel: string, schema: z.ZodType<A>, listener: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (event, ...raw: unknown[]) => { assertTrustedSender(event); return listener(...schema.parse(raw)) })
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('مصدر IPC غير موثوق')
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isTrustedUrl(frame.url)) throw new Error('مصدر IPC غير موثوق')
}

function isTrustedUrl(value: string): boolean {
  return isTrustedRendererUrl(value, trustedRendererUrl)
}

async function trustedSessionPath(db: AppDatabase, sessionId: string, requested: string): Promise<string> {
  const root = await fs.realpath(db.getSession(sessionId).workspace)
  const lexical = resolve(root, requested)
  const lexicalDifference = relative(root, lexical)
  if (lexicalDifference.startsWith('..') || isAbsolute(lexicalDifference)) throw new Error('المسار خارج مساحة العمل')
  await rejectSymlinkComponents(root, lexical)
  const target = await fs.realpath(lexical)
  const difference = relative(root, target)
  if (difference.startsWith('..') || isAbsolute(difference)) throw new Error('المسار خارج مساحة العمل')
  return target
}

async function rejectSymlinkComponents(root: string, target: string): Promise<void> {
  const parts = relative(root, target).split(/[\\/]/).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('لا يسمح بعبور رابط رمزي داخل مساحة العمل')
  }
}

function isIgnoredWorkspaceEntry(name: string): boolean {
  const lower = name.toLowerCase()
  return ['node_modules', '.git', 'out', 'dist', 'build', 'coverage', '.next', '.cache', '.vite'].includes(lower) || lower.startsWith('release-') || lower.startsWith('dist-v') || lower.startsWith('win-unpacked') || lower.endsWith('.tmp')
}

async function openExternal(value: string): Promise<void> {
  try {
    const url = new URL(value)
    if (!isAllowedExternalUrl(url)) return
    await shell.openExternal(url.toString())
  } catch {}
}

export function isAllowedExternalUrl(url: URL): boolean {
  if (url.username || url.password || url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65_535)) return false
  if (url.protocol === 'https:') return !isBlockedHost(url.hostname)
  if (url.protocol !== 'http:') return false
  return (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && Boolean(url.port)
}

function mimeForExt(ext: string): string {
  const map: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.xml': 'text/xml', '.html': 'text/html', '.md': 'text/markdown' }
  return map[ext] ?? 'application/octet-stream'
}

