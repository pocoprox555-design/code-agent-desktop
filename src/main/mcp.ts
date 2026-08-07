import { promises as fs } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ToolDefinition } from './provider'
import { isBlockedHost } from './tools'

interface McpLocalConfig { command: string; args: string[]; env: Record<string, string> }
interface McpRemoteConfig { url: string; headers?: Record<string, string> }
type McpServerConfig = McpLocalConfig | McpRemoteConfig
interface McpConfig { mcpServers?: Record<string, Record<string, unknown>> }
interface McpToolRecord { name: string; description?: string; inputSchema?: Record<string, unknown> }
interface McpConnectionLike {
  isAlive(): boolean
  start(signal: AbortSignal): Promise<void>
  listTools(signal: AbortSignal): Promise<McpToolRecord[]>
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string>
  close(): Promise<void>
  readonly child?: ChildProcessWithoutNullStreams
}
interface McpBinding { server: string; originalName: string; connection: McpConnectionLike }
interface ManagedConnection { fingerprint: string; connection: McpConnectionLike; tools?: McpToolRecord[] }

const MCP_PROTOCOL_VERSION = '2025-06-18'
const MCP_REQUEST_TIMEOUT_MS = 60_000

export interface McpToolExecutor { call(name: string, input: Record<string, unknown>, signal: AbortSignal, workspace?: string): Promise<string> }

export class McpManager implements McpToolExecutor {
  private connections = new Map<string, Map<string, ManagedConnection>>()
  private bindings = new Map<string, McpBinding>()

  constructor(private globalConfigPath?: string) {}

  async tools(workspace: string, signal: AbortSignal, trackProcess?: (child: ChildProcessWithoutNullStreams) => void, approve?: (title: string, detail: string) => Promise<boolean>): Promise<ToolDefinition[]> {
    const config = await mergeConfigs(this.globalConfigPath, path.join(workspace, '.mcp.json'))
    const key = path.resolve(workspace)
    const existing = this.connections.get(key) ?? new Map<string, ManagedConnection>()
    this.connections.set(key, existing)
    const configured = new Set(Object.entries(config?.mcpServers ?? {}).filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[1] && (typeof entry[1].command === 'string' && entry[1].command.trim() || typeof entry[1].url === 'string' && entry[1].url.trim()))).map(([name]) => name))
    for (const [serverName, managed] of existing) if (!configured.has(serverName)) { existing.delete(serverName); this.removeBindings(key, serverName); await managed.connection.close() }
    if (!config) { if (!existing.size) this.connections.delete(key); return [] }
    const definitions: ToolDefinition[] = []
    for (const [serverName, raw] of Object.entries(config.mcpServers ?? {})) {
      const isRemote = Boolean(raw && typeof raw.url === 'string' && raw.url.trim().length > 0)
      if (!isRemote && (!raw || typeof raw.command !== 'string' || !raw.command.trim())) continue
      const normalized: McpServerConfig = isRemote ? { url: String(raw.url), headers: objectStrings(raw.headers) } : { command: String(raw.command), args: Array.isArray(raw.args) ? raw.args.filter((item): item is string => typeof item === 'string') : [], env: objectStrings(raw.env) }
      const fingerprint = configFingerprint(normalized)
      let managed = existing.get(serverName)
      if (managed && (managed.fingerprint !== fingerprint || !managed.connection.isAlive())) { existing.delete(serverName); this.removeBindings(key, serverName); await managed.connection.close(); managed = undefined }
      if (!managed) {
        const preview = isRemote ? { server: serverName, url: (normalized as McpRemoteConfig).url } : { server: serverName, command: redactMcpText((normalized as McpLocalConfig).command), args: (normalized as McpLocalConfig).args.map(redactMcpText), envNames: Object.keys((normalized as McpLocalConfig).env).sort() }
        if (approve && !await approve(`السماح بتشغيل خادم MCP ${serverName}؟`, JSON.stringify(preview, null, 2))) continue
        const connection: McpConnectionLike = isRemote ? new RemoteMcpConnection(normalized as McpRemoteConfig) : new McpConnection(normalized as McpLocalConfig, workspace)
        managed = { fingerprint, connection }
        existing.set(serverName, managed)
        try { await connection.start(signal); if (connection.child) trackProcess?.(connection.child) }
        catch (error) { existing.delete(serverName); this.removeBindings(key, serverName); await connection.close(); console.error(`[MCP] تعذر تشغيل خادم ${serverName} وسيُتخطى: ${error instanceof Error ? error.message : String(error)}`); continue }
      }
      const connection = managed.connection
      this.removeBindings(key, serverName)
      let listed: McpToolRecord[]
      try {
        listed = managed.tools ?? await connection.listTools(signal)
        managed.tools = listed
      }
      catch (error) { existing.delete(serverName); this.removeBindings(key, serverName); await connection.close(); console.error(`[MCP] فشل سرد أدوات خادم ${serverName} وسيُتخطى: ${error instanceof Error ? error.message : String(error)}`); continue }
      for (const tool of listed) {
        if (!tool.name || !/^[\w.-]+$/.test(tool.name)) continue
        const name = exposedName(serverName, tool.name)
        const definition: ToolDefinition = { type: 'function', function: { name, description: `[MCP ${serverName}] ${tool.description ?? tool.name}`, parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {}, additionalProperties: true } } }
        this.bindings.set(`${key}:${name}`, { server: serverName, originalName: tool.name, connection })
        definitions.push(definition)
      }
    }
    return definitions
  }

  private removeBindings(workspace: string, server: string): void { for (const [key, binding] of this.bindings) if (key.startsWith(`${workspace}:`) && binding.server === server) this.bindings.delete(key) }

  async call(name: string, input: Record<string, unknown>, signal: AbortSignal, workspace?: string): Promise<string> {
    const binding = workspace ? this.bindings.get(`${path.resolve(workspace)}:${name}`) : [...this.bindings.entries()].find(([key]) => key.endsWith(`:${name}`))?.[1]
    if (!binding) throw new Error(`أداة MCP غير موجودة أو انتهت جلسة الخادم: ${name}`)
    return binding.connection.callTool(binding.originalName, input, signal)
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()].flatMap((items) => [...items.values()].map((item) => item.connection))
    this.connections.clear(); this.bindings.clear()
    await Promise.allSettled(connections.map((connection) => connection.close()))
  }
}

class McpConnection {
  child!: ChildProcessWithoutNullStreams
  private reader: Interface | null = null
  private nextId = 1
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout; abort: () => void }>()
  private closed: Promise<Error> | null = null
  private stderrTail = ''

  constructor(private config: McpLocalConfig, private cwd: string) {}

  isAlive(): boolean { return Boolean(this.child && !this.child.killed && this.child.exitCode === null) }

  async start(signal: AbortSignal): Promise<void> {
    if (this.child) return
    const command = process.platform === 'win32' && ['npx', 'npm', 'pnpm', 'yarn'].includes(this.config.command.toLowerCase()) ? `${this.config.command}.cmd` : this.config.command
    const commandLine = [command, ...this.config.args].map(commandArgument).join(' ')
    const executable = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command) ? (process.env.ComSpec ?? 'cmd.exe') : command
    const args = executable === (process.env.ComSpec ?? 'cmd.exe') ? ['/d', '/s', '/c', commandLine] : this.config.args
    this.child = spawn(executable, args, { cwd: this.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: safeEnvironment(this.config.env) })
    this.reader = createInterface({ input: this.child.stdout })
    this.reader.on('line', (line) => this.receive(line))
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-65_536) })
    const closed = new Promise<Error>((resolve) => { this.child.once('error', (error) => { this.rejectPending(error instanceof Error ? error : new Error(String(error))); resolve(error instanceof Error ? error : new Error(String(error))) }); this.child.once('close', (code) => { const error = new Error(`أغلق خادم MCP الاتصال (${code ?? -1})`); this.rejectPending(error); resolve(error) }) })
    this.closed = closed
    const response = await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Rahma Code Agent', version: '0.5.0' } }, signal)
    if (!response) throw new Error('استجابة تهيئة MCP فارغة')
    this.notify('notifications/initialized', {})
  }

  async listTools(signal: AbortSignal): Promise<McpToolRecord[]> { const result = await this.request('tools/list', {}, signal); return Array.isArray(result?.tools) ? result.tools as McpToolRecord[] : [] }

  async callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: input }, signal)
    const content = Array.isArray(result?.content) ? result.content.map((part: any) => part?.type === 'text' ? String(part.text ?? '') : JSON.stringify(part)).join('\n') : result?.structuredContent ? JSON.stringify(result.structuredContent) : ''
    return JSON.stringify({ ok: !result?.isError, data: { content: content.slice(0, 500_000), isError: Boolean(result?.isError) } }, null, 2)
  }

  async close(): Promise<void> {
    this.rejectPending(new Error('أغلق خادم MCP')); this.reader?.close(); this.reader = null
    if (this.child && !this.child.killed) this.child.kill()
    if (this.closed) await Promise.race([this.closed, new Promise<void>((resolve) => setTimeout(resolve, 1000))])
  }

  private request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    if (!this.child || this.child.killed) return Promise.reject(new Error('خادم MCP غير متصل'))
    if (signal.aborted) return Promise.reject(new DOMException('تم إلغاء طلب MCP', 'AbortError'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (error: Error | null, value?: any): void => { if (settled) return; settled = true; clearTimeout(timer); this.pending.delete(id); signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(value) }
       const timer = setTimeout(() => settle(new Error(`انتهت مهلة MCP للطلب ${method}`)), MCP_REQUEST_TIMEOUT_MS)
      const abort = (): void => settle(new DOMException('تم إلغاء طلب MCP', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve: (value) => settle(null, value), reject: (error) => settle(error), timer, abort })
      try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) } catch (error) { settle(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private notify(method: string, params: Record<string, unknown>): void { try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`) } catch {} }
  private rejectPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }; this.pending.clear() }
  private receive(line: string): void { try { const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }; if (message.id === undefined) return; const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); clearTimeout(pending.timer); if (message.error) pending.reject(new Error(message.error.message ?? 'خطأ MCP غير معروف')); else pending.resolve(message.result) } catch {} }
}

class RemoteMcpConnection implements McpConnectionLike {
  private nextId = 1
  private alive = false
  private sessionId = ''

  constructor(private config: McpRemoteConfig) {}

  child?: ChildProcessWithoutNullStreams
  isAlive(): boolean { return this.alive }

  async start(signal: AbortSignal): Promise<void> {
    const url = new URL(this.config.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('يسمح فقط بروابط MCP عن بُعد HTTP/HTTPS')
    if (isBlockedHost(url.hostname)) throw new Error('لا يسمح بوصول خادم MCP عن بُعد إلى شبكة محلية أو عنوان خاص')
    const response = await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Rahma Code Agent', version: '0.5.0' } }, signal)
    if (!response) throw new Error('استجابة تهيئة MCP عن بُعد فارغة')
    this.alive = true
    try { await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, signal) } catch { /* اختياري */ }
  }

  async listTools(signal: AbortSignal): Promise<McpToolRecord[]> { const result = await this.request('tools/list', {}, signal); return Array.isArray(result?.tools) ? result.tools as McpToolRecord[] : [] }

  async callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    let result: any
    try { result = await this.request('tools/call', { name, arguments: input }, signal) }
    catch (error) {
      if (signal.aborted) throw error
      this.alive = false
      this.sessionId = ''
      await this.start(signal)
      result = await this.request('tools/call', { name, arguments: input }, signal)
    }
    const content = Array.isArray(result?.content) ? result.content.map((part: any) => part?.type === 'text' ? String(part.text ?? '') : JSON.stringify(part)).join('\n') : result?.structuredContent ? JSON.stringify(result.structuredContent) : ''
    return JSON.stringify({ ok: !result?.isError, data: { content: content.slice(0, 500_000), isError: Boolean(result?.isError) } }, null, 2)
  }

  async close(): Promise<void> { this.alive = false }

  private async request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    if (signal.aborted) throw new DOMException('تم إلغاء طلب MCP', 'AbortError')
    const id = this.nextId++
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal)
    return response
  }

  private async post(payload: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    const url = new URL(this.config.url)
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('انتهت مهلة طلب MCP عن بُعد')), MCP_REQUEST_TIMEOUT_MS)
    try {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}), ...this.config.headers }, body: JSON.stringify(payload), signal: controller.signal })
        if (!response.ok) throw new Error(`فشل خادم MCP عن بُعد (${response.status}): ${(await readBoundedResponse(response, 1_000_000)).slice(0, 1000)}`)
        const sessionId = response.headers.get('mcp-session-id')
        if (sessionId) this.sessionId = sessionId
       const contentType = String(response.headers.get('content-type') ?? '')
       if (/text\/event-stream/i.test(contentType)) return readSseResult(response, payload.id, 5_000_000)
       const text = await readBoundedResponse(response, 5_000_000)
       if (/\bjson\b/i.test(contentType)) { const parsed = JSON.parse(text); if (parsed?.error) throw new Error(parsed.error.message ?? 'خطأ MCP غير معروف'); return parsed?.result ?? parsed }
      const parsed = JSON.parse(text)
      if (parsed?.error) throw new Error(parsed.error.message ?? 'خطأ MCP غير معروف')
      return parsed?.result ?? parsed
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}

async function readSseResult(response: Response, requestId: unknown, maxBytes: number): Promise<any> {
  if (!response.body) throw new Error('استجابة SSE بلا body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) throw new Error(`بث MCP أكبر من الحد (${maxBytes} بايت)`)
      buffer += decoder.decode(part.value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (!data || data === '[DONE]') continue
        const parsed = JSON.parse(data)
        if (parsed?.error) throw new Error(parsed.error.message ?? 'خطأ MCP غير معروف')
        if (parsed?.id === requestId) return parsed.result ?? parsed
      }
    }
    throw new Error('لم يستجب خادم MCP عن بُعد بحل متطابق')
  } finally { try { await reader.cancel() } catch {}; reader.releaseLock() }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) throw new Error(`استجابة MCP أكبر من الحد (${maxBytes} بايت)`)
      chunks.push(part.value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
  } finally {
    try { await reader.cancel() } catch {}
    reader.releaseLock()
  }
}

async function mergeConfigs(globalPath: string | undefined, workspacePath: string): Promise<McpConfig | null> {
  const [global, workspace] = await Promise.all([readConfigFile(globalPath, 'إعداد MCP العام'), readConfigFile(workspacePath, 'ملف .mcp.json')])
  if (!global && !workspace) return null
  return { mcpServers: { ...(global?.mcpServers ?? {}), ...(workspace?.mcpServers ?? {}) } }
}

async function readConfigFile(filePath: string | undefined, label: string): Promise<McpConfig | null> {
  if (!filePath) return null
  try { const text = await fs.readFile(filePath, 'utf8'); if (Buffer.byteLength(text) > 1_000_000) throw new Error('ملف MCP أكبر من الحد'); const parsed = JSON.parse(text) as McpConfig; return parsed && typeof parsed === 'object' ? parsed : null } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error(`${label} غير صالح: ${error instanceof Error ? error.message : String(error)}`) }
}

function objectStrings(value: unknown): Record<string, string> { if (!value || typeof value !== 'object' || Array.isArray(value)) return {}; return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')) }
function safeEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv { return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, ...extra } }
function exposedName(server: string, tool: string): string { const normalized = tool.replaceAll('-', '_'); return server === 'tavily' ? normalized.startsWith('tavily_') ? normalized : `tavily_${normalized}` : `mcp_${server.replaceAll(/[^a-zA-Z0-9_]/g, '_')}_${normalized}` }
function commandArgument(value: string): string { return /[\s"&|<>^]/.test(value) ? `"${value.replace(/["^]/g, (character) => `^${character}`)}"` : value }
function redactMcpText(value: string): string { return value.replace(/((?:tavily)?api[_-]?key=)[^&\s]+/gi, '$1[محجوب]').replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s&]+/gi, '$1[محجوب]') }
function configFingerprint(config: McpServerConfig): string { return createHash('sha256').update(JSON.stringify(config)).digest('hex') }
