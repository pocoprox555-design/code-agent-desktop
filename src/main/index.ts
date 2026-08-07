import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { join, relative, resolve, isAbsolute, extname } from 'node:path'
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { AppDatabase } from './database'
import { ProviderStore } from './provider-store'
import { AgentRunner } from './agent'
import { ensureGitRepository, isBlockedHost } from './tools'
import { McpManager } from './mcp'
import { requestModel } from './provider'
import { GO_MODELS } from '../shared/models'
import type { Attachment, TreeEntry } from '../shared/types'
import { isTrustedRendererUrl } from './ipc-security'

let mainWindow: BrowserWindow | null = null
let trustedRendererUrl = ''
let database: AppDatabase | null = null
let agentRunner: AgentRunner | null = null
let quitting = false

process.on('uncaughtException', (error) => {
  try { database?.addAudit({ category: 'security', action: 'uncaught-exception', detail: `${error?.message ?? String(error)}`.slice(0, 4000), outcome: 'failed' }) } catch { console.error('uncaughtException', error) }
  console.error('uncaughtException', error)
})
process.on('unhandledRejection', (reason) => {
  try { database?.addAudit({ category: 'security', action: 'unhandled-rejection', detail: `${reason instanceof Error ? reason.message : String(reason)}`.slice(0, 4000), outcome: 'failed' }) } catch { console.error('unhandledRejection', reason) }
  console.error('unhandledRejection', reason)
})

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (!mainWindow) return; if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() })
  void app.whenReady().then(() => {
    const db = new AppDatabase(join(app.getPath('userData'), 'r-code-agent.db'))
    database = db
    const providers = new ProviderStore(join(app.getPath('userData'), 'provider.json'))
    const agent = new AgentRunner(db, providers, () => mainWindow?.isDestroyed() ? null : mainWindow?.webContents ?? null, undefined, new McpManager(join(app.getPath('userData'), 'mcp.json')))
    agentRunner = agent
    registerIpc(db, providers, agent)
    createWindow()
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', (event) => {
    if (quitting) { database?.close(); database = null; agentRunner = null; return }
    event.preventDefault(); quitting = true
    void agentRunner?.shutdown().finally(() => app.quit())
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}

function createWindow(): void {
  const rendererFile = join(__dirname, '../renderer/index.html')
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  trustedRendererUrl = developmentUrl ? new URL(developmentUrl).href : pathToFileURL(rendererFile).href
  const window = new BrowserWindow({
    width: 1480, height: 940, minWidth: 760, minHeight: 560, show: false,
    backgroundColor: '#0d1017', title: 'Rahma Code Agent',
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
}

const id = z.string().uuid()
const filePath = z.string().min(1).max(32_767)
const providerUpdate = z.object({ model: z.enum(GO_MODELS.map((model) => model.id) as [string, ...string[]]), apiKey: z.string().max(8192).optional(), contextWindow: z.number().int().min(32_000).max(2_000_000).optional() }).strict()
const sessionPatch = z.object({ title: z.string().trim().min(1).max(200).optional(), permissionMode: z.enum(['ask', 'full']).optional(), agentMode: z.enum(['build', 'plan']).optional() }).strict()
const sessionCreate = z.object({ workspace: filePath, title: z.string().trim().min(1).max(200).optional(), initGit: z.boolean().optional() }).strict()
const attachmentInput = z.object({ name: z.string().min(1).max(255), mimeType: z.string().min(1).max(128), data: z.string().max(28_000_000), size: z.number().int().nonnegative().max(20_000_000) }).strict()
const attachmentsInput = z.array(attachmentInput).max(10).refine((items) => items.reduce((total, item) => total + item.size, 0) <= 40_000_000, 'إجمالي المرفقات أكبر من 40 ميغابايت').refine((items) => items.every((item) => /^[A-Za-z0-9+/]*={0,2}$/.test(item.data)), 'بيانات مرفق غير صالحة')

function registerIpc(db: AppDatabase, providers: ProviderStore, agent: AgentRunner): void {
  handle('sessions:create', z.tuple([sessionCreate]), async (input) => { const workspace = await fs.realpath(input.workspace); if (!(await fs.stat(workspace)).isDirectory()) throw new Error('مساحة العمل ليست مجلدًا'); if (input.initGit) await ensureGitRepository(workspace); return db.createSession(workspace, input.title, Boolean(input.initGit)) })
  handle('sessions:list', z.tuple([]), () => db.listSessions())
  handle('sessions:update', z.tuple([id, sessionPatch]), (sessionId, patch) => db.updateSession(sessionId, patch))
  handle('sessions:remove', z.tuple([id]), (sessionId) => { agent.cancel(sessionId); agent.forgetSession(sessionId); db.deleteSession(sessionId) })
  handle('sessions:setPrompt', z.tuple([id, z.string().max(50_000)]), (sessionId, prompt) => db.setSystemPrompt(sessionId, prompt))
  handle('sessions:approvePlan', z.tuple([id]), (sessionId) => db.approvePlan(sessionId))
  handle('sessions:setTodos', z.tuple([id, z.array(z.object({ content: z.string().trim().min(1).max(500), status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(), priority: z.enum(['high', 'medium', 'low']).optional() }).strict()).max(100)]), (sessionId, items) => db.setTodos(sessionId, items))
  handle('sessions:run', z.tuple([id]), (sessionId) => db.getAgentRun(sessionId))
  handle('sessions:messages', z.tuple([id]), (sessionId) => db.listMessages(sessionId))
  handle('sessions:usage', z.tuple([id]), (sessionId) => db.getUsageSummary(sessionId))
  handle('sessions:subagents', z.tuple([id]), (sessionId) => db.listSubagentEvents(sessionId))
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
  handle('files:chooseFolder', z.tuple([]), async () => (await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] ?? null)
  handle('files:list', z.tuple([id, z.union([filePath, z.undefined()])]), async (sessionId, requested): Promise<TreeEntry[]> => {
    const target = await trustedSessionPath(db, sessionId, requested ?? '.')
    const entries = await fs.readdir(target, { withFileTypes: true })
    return entries.filter((entry) => !['node_modules', '.git'].includes(entry.name) && !entry.name.startsWith('release-') && !entry.name.startsWith('dist-v') && !entry.name.startsWith('win-unpacked') && !entry.name.endsWith('.tmp')).slice(0, 500).map((entry) => ({ name: entry.name, path: join(target, entry.name), directory: entry.isDirectory(), size: 0 }))
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
  const target = await fs.realpath(resolve(root, requested))
  const difference = relative(root, target)
  if (difference.startsWith('..') || isAbsolute(difference)) throw new Error('المسار خارج مساحة العمل')
  return target
}

async function openExternal(value: string): Promise<void> {
  try { const url = new URL(value);     if (url.protocol !== 'https:' || url.username || url.password || isBlockedHost(url.hostname)) return; await shell.openExternal(url.toString()) } catch {}
}

function mimeForExt(ext: string): string {
  const map: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.xml': 'text/xml', '.html': 'text/html', '.md': 'text/markdown' }
  return map[ext] ?? 'application/octet-stream'
}
