import type { WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { AgentEvent, ApprovalRequest, Attachment, DevServerState, Message, ModelUsage, MutationReceipt, SessionRunState, SubagentEvent, ToolCallRecord } from '../shared/types'
import { AppDatabase, type StoredMessage } from './database'
import { ProviderStore } from './provider-store'
import { TavilyStore } from './tavily-store'
import { cancelProviderRequestSlots, ContextOverflowError, DeadlineExceededError, estimateModelRequestTokens, ProviderTimeoutError, requestModel, type ModelInput, type ModelToolCall, type ToolDefinition } from './provider'
import { commitAutoChanges, closeAllPersistentShells, closePersistentShell, executeTool, isToolMutating, runPowerShell, toolDefinitions, withAutoCommit, type ToolContext } from './tools'
import { McpManager } from './mcp'
import { calculateCost, GO_MODELS, modelSupportsModality } from '../shared/models'
import type { Session } from '../shared/types'
import { getProjectIndexer } from './code-intelligence'
import { ProjectMemory } from './memory'
import { ModelRouter, createModelRouter } from './model-router'
import { generateRepoMapString } from './repo-map'
import { CodeReviewer } from './review'
import { buildInjectedContext, getCostWarning, type CostWarning } from './agent-enhancements'
import { BUILD_TOOL_GROUPS, buildOutputTokenBudget, buildToolPolicy, MAIN_CHAT_PROFILE, toolGroupFor, type AgentProfile, type BuildToolGroup } from './agent-profile'
import { getWorkspaceCoordinator } from './workspace-coordinator'
import { planToolStages } from './tool-scheduler'

	const MAX_PARALLEL_READ_TOOLS = 6
	const SUBAGENT_MAX_STEPS = 30
	const SUBAGENT_MAX_RUNTIME_MS = 30 * 60_000
	const MAX_RUN_COST_USD = Math.max(0.1, Number(process.env.R_CODE_MAX_RUN_COST_USD ?? '') || 10)
	const PARALLEL_READ_TOOLS = new Set(['read_file', 'read_files', 'read_message', 'count_lines', 'list_directory', 'glob_files', 'search_files', 'search_symbols', 'get_file_info', 'tree', 'web_search', 'web_research'])
const BUILD_ONLY_TOOLS = new Set(['start_preview', 'stop_preview', 'preview_status', 'get_page_content', 'preview_screenshot', 'discover_tools', 'enable_tool_group'])
const SUBAGENT_TOOL_NAMES = new Set(['read_file', 'read_files', 'read_message', 'count_lines', 'list_directory', 'glob_files', 'search_files', 'search_symbols', 'get_file_info', 'tree', 'load_skill', 'web_fetch', 'web_search', 'web_research', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_show', 'write_file', 'edit_file', 'edit_files_bulk', 'edit_file_undo', 'patch_file'])
/** أدوات الوكيل الفرعي الافتراضي — قراءة/بحث فقط، تطابقًا مع برومبته (بدون قدرات تعديل) */
const DEFAULT_SUBAGENT_TOOLS = new Set(['read_file', 'read_files', 'read_message', 'count_lines', 'list_directory', 'glob_files', 'search_files', 'search_symbols', 'get_file_info', 'tree', 'load_skill', 'web_fetch', 'web_search', 'web_research', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_show', 'analyze_file', 'find_references', 'dependency_graph'])
/** أدوات قراءة الملف الواحد — تُتتبع لكشف الدوران (قراءة نفس الملف مرارًا) */
const FILE_REPEAT_TOOLS = new Set(['read_file', 'count_lines', 'get_file_info', 'analyze_file'])


/** بسيط LRU Cache: يحذف أقدم عنصر عند تجاوز الحد */
class LruCache<K, V> {
  private map = new Map<K, V>()
  constructor(private readonly max: number) {}
  get(key: K): V | undefined { const v = this.map.get(key); if (v !== undefined) { this.map.delete(key); this.map.set(key, v) } return v }
  set(key: K, value: V): void { if (this.map.has(key)) this.map.delete(key); else if (this.map.size >= this.max) { const first = this.map.keys().next().value; if (first !== undefined) this.map.delete(first) } this.map.set(key, value) }
  has(key: K): boolean { return this.map.has(key) }
  get size(): number { return this.map.size }
}

const projectInstructionsCache = new LruCache<string, { modifiedAt: number; content: string }>(50)

interface PendingApproval { sessionId: string; runId: string; request: ApprovalRequest; rememberKey?: string; abort: () => void; resolve(value: boolean): void; reject(error: Error): void }
interface ActiveRun { runId: string; controller: AbortController; startedAt: number; deadlineAt: number; status: string; error?: string; pendingMessages: StoredMessage[]; followUpQueued: boolean; childProcesses: Set<import('child_process').ChildProcess>; initializing: boolean; ready: Promise<void>; resolveReady: () => void; rejectReady: (error: Error) => void; repeatedSteps: Map<string, number>; fileReadCounts: Map<string, number>; toolFailures: number; outcome?: 'completed' | 'interrupted' | 'failed' | 'cancelled'; promise?: Promise<void>; accumulatedCostUsd: number; costCapped: boolean; lastCostWarningPercent: number; recentErrors: string[]; lastStepSignature?: string; consecutiveRepeats?: number; repeatEscalated?: boolean; lastErrorCategory?: ErrorCategory; consecutiveErrorCategories?: number; verificationFailures: number; compressionCount: number; cancelledExternally: boolean; filesModifiedInPreviousStep?: boolean; lastInjectedContext?: string; pendingVerificationFiles: string[]; pendingEditedFiles: string[]; baseContext?: { repoMap: string; memoryContext: string; instructions: string; commands: ProjectCommand[]; builtAtStep: number }; previewRevision?: number; toolUsage: Map<string, { calls: number; failures: number }>; peakErrorStreak: number; peakErrorSample?: string }

export class AgentRunner {
  private runs = new Map<string, ActiveRun>()
  private approvals = new Map<string, PendingApproval>()
  private approvalGrants = new Map<string, Set<string>>()
  private readonly profile: AgentProfile
  private undoStacks = new Map<string, Array<{ path: string; oldContent: string }>>()
  private memories = new Map<string, ProjectMemory>()
  private routers = new Map<string, ModelRouter>()
  private previewStates = new Map<string, DevServerState>()
  private checkpointCounters = new Map<string, number>()

  constructor(private db: AppDatabase, private providers: ProviderStore, private getWebContents: () => WebContents | null, private modelRequest: typeof requestModel = requestModel, private mcp = new McpManager(), private channel: string = MAIN_CHAT_PROFILE.eventChannel, private approvalChannel: string = MAIN_CHAT_PROFILE.approvalChannel, private startPreview?: (session: Session, signal?: AbortSignal) => Promise<DevServerState>, private stopPreview?: (session: Session) => Promise<DevServerState>, private previewStatus?: (session: Session) => DevServerState, private tavilyStore?: TavilyStore, profile: AgentProfile = MAIN_CHAT_PROFILE) { this.profile = profile; this.db.repairIncompleteToolCalls(); this.db.markRunningRunsInterrupted() }

  private getMemory(workspace: string): ProjectMemory {
    let memory = this.memories.get(workspace)
    if (!memory) {
      memory = new ProjectMemory(this.db.rawDb)
      memory.initTable()
      this.memories.set(workspace, memory)
    }
    return memory
  }

  private getRouter(sessionId: string, defaultModel: string): ModelRouter {
    let router = this.routers.get(sessionId)
    if (!router) {
      router = createModelRouter(defaultModel)
      this.routers.set(sessionId, router)
    }
    return router
  }

  /**
   * تعلّم تلقائي عند اكتمال التشغيل — يحفظ في الذاكرة طويلة المدى:
   * 1) ملخص الأدوات المستعملة ونتائجها (نجاح/فشل) والملفات المعدلة (فئة workflow).
   * 2) درس الخطأ→الحل إذا تعافى التشغيل بعد سلسلة فشل متكررة (فئة error_fix).
   * مفاتيح يومية مدمجة (upsert) — لا تضخم في الذاكرة، ولا تعطل الاكتمال أبدًا.
   */
  private autoRememberRun(session: ReturnType<AppDatabase['getSession']>, run: ActiveRun): void {
    try {
      const memory = this.getMemory(session.workspace)
      const date = new Date().toISOString().slice(0, 10)
      if (run.toolUsage.size) {
        const parts = [...run.toolUsage.entries()]
          .sort((a, b) => b[1].calls - a[1].calls)
          .slice(0, 8)
          .map(([name, usage]) => `${name} x${usage.calls}${usage.failures ? ` (${usage.failures} failed)` : ''}`)
        const edited = [...new Set(run.pendingEditedFiles)].slice(0, 6)
        const verification = run.verificationFailures > 0
          ? ` Verification had ${run.verificationFailures} failing round(s) before delivery.`
          : run.pendingVerificationFiles.length ? ' Final verification passed.' : ''
        const value = `Tools used: ${parts.join(', ')}.${edited.length ? ` Files edited: ${edited.join(', ')}.` : ''}${verification}`
        memory.save(session.workspace, 'workflow', `run-${date}`, value.slice(0, 480))
      }
      if (run.peakErrorStreak >= 3) {
        memory.save(session.workspace, 'error_fix', `recovered-streak-${date}`, `Recovered after ${run.peakErrorStreak} repeated failures — ${run.peakErrorSample ?? 'unknown error'}. Resolution: changed approach instead of retrying the identical call.`.slice(0, 480))
      }
    } catch { /* الذاكرة لا تعطل اكتمال التشغيل أبدًا */ }
  }

  states(): SessionRunState[] {
    return [...this.runs].map(([sessionId, run]) => ({ sessionId, runId: run.runId, state: run.cancelledExternally || run.controller.signal.aborted ? 'cancelling' : this.hasApproval(sessionId, run.runId) ? 'awaiting_approval' : 'running', status: run.status, error: run.error, pendingApprovals: [...this.approvals.values()].filter((item) => item.sessionId === sessionId && item.runId === run.runId).map((item) => item.request) }))
  }

  async send(sessionId: string, text: string, attachments?: Attachment[], modelOverride?: string): Promise<void> {
    attachments = await prepareAttachments(attachments)
    // ─── Checkpoint: لقطة كل 5 رسائل مستخدم ──────────────────────
    try {
      const counter = (this.checkpointCounters.get(sessionId) ?? 0) + 1
      this.checkpointCounters.set(sessionId, counter)
      if (counter % 5 === 0) {
        const messages = this.db.listMessages(sessionId)
        if (messages.length > 0) {
          const editedFiles = this.getEditedFilesFromMessages(messages)
          this.db.createCheckpoint(sessionId, `قبل: ${text.slice(0, 50)}`, messages, editedFiles)
        }
      }
    } catch { /* checkpoint failure should not block agent */ }

    const existing = this.runs.get(sessionId)
    if (existing) {
      if (existing.initializing) await existing.ready
      const current = this.runs.get(sessionId)
      if (current && current === existing) {
        if (current.controller.signal.aborted) {
          // مهلة أمان: لا يعلق إرسال جديد على تصريف تشغيل ملغى قد يكون عالقًا
          if (current.promise) await Promise.race([current.promise, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3_000))])
          if (this.runs.get(sessionId) === current) this.runs.delete(sessionId)
        } else {
          const message = this.db.addMessage({ sessionId, role: 'user', content: text, attachments })
          current.pendingMessages.push(message)
          this.db.addAudit({ sessionId, category: 'agent', action: 'queue', detail: text.slice(0, 1000), outcome: 'started' })
          this.emit({ sessionId, runId: current.runId, type: 'message', message })
          this.setStatus(sessionId, 'تصل رسالتك للوكيل في الجولة التالية...', current)
          return
        }
      }
    }

    let config = this.providers.get()
    if (modelOverride && modelOverride !== config.model) config = this.providers.getForModel(modelOverride)
    if (!config.apiKey) throw new Error('أضف مفتاح API من الإعدادات أولًا')
    if (attachments?.length) {
      const unsupported = attachments.find((attachment) => attachment.mimeType.startsWith('image/') ? !modelSupportsModality(config.model, 'image') : attachment.mimeType.startsWith('video/') ? !modelSupportsModality(config.model, 'video') : false)
      if (unsupported) throw new Error(`النموذج ${config.model} لا يدعم مرفقات من نوع ${unsupported.mimeType}. غيّر النموذج من الإعدادات أو أزل المرفق.`)
    }
    const session = this.db.getSession(sessionId)
    const previousRun = this.db.getAgentRun(sessionId)
    if (previousRun?.status === 'interrupted') {
      this.db.addAudit({ sessionId, category: 'agent', action: 'resume', detail: `استئناف السياق بعد التشغيل ${previousRun.runId} من الجولة ${previousRun.step}.`, outcome: 'started' })
    }
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const controller = new AbortController()
    const startedAt = Date.now()
    const run: ActiveRun = { runId: randomUUID(), controller, startedAt, deadlineAt: startedAt + this.profile.runtimeMs, status: 'يبدأ التنفيذ...', pendingMessages: [], followUpQueued: false, childProcesses: new Set(), initializing: true, ready, resolveReady, rejectReady, repeatedSteps: new Map(), fileReadCounts: new Map(), toolFailures: 0, accumulatedCostUsd: 0, costCapped: false, lastCostWarningPercent: 0, recentErrors: [], verificationFailures: 0, compressionCount: 0, cancelledExternally: false, pendingVerificationFiles: [], pendingEditedFiles: [], toolUsage: new Map(), peakErrorStreak: 0 }
    this.runs.set(sessionId, run)
    this.db.startAgentRun(sessionId, run.runId, startedAt)
    this.emit({ sessionId, runId: run.runId, type: 'run:start' })
    try {
      const workspace = await fs.realpath(session.workspace)
      if (!(await fs.stat(workspace)).isDirectory()) throw new Error()
      const userMessage = this.db.addMessage({ sessionId, role: 'user', content: text, attachments })
      this.db.addAudit({ sessionId, category: 'agent', action: 'run', detail: text.slice(0, 1000), outcome: 'started' })
      this.emit({ sessionId, runId: run.runId, type: 'message', message: userMessage })
      run.initializing = false
      run.resolveReady()
      run.promise = this.runLoop(session, config, run)
      void run.promise
    } catch (error) {
      run.initializing = false
      const message = error instanceof Error && error.message ? error.message : `مساحة عمل هذه الجلسة لم تعد موجودة: ${session.workspace}\nافتح مجلد المشروع الصحيح من زر "فتح مشروع" ثم أعد المحاولة.`
      run.rejectReady(new Error(message))
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId)
      throw new Error(message)
    }
  }

  async waitForRun(sessionId: string, runId: string): Promise<{ status: string; error?: string; outcome?: string }> {
    const run = this.runs.get(sessionId)
    if (run && run.runId === runId) {
      await run.promise
      const persisted = this.db.getAgentRun(sessionId)
      return { status: run.outcome ?? persisted?.status ?? 'completed', error: run.error, outcome: run.outcome }
    }
    const persisted = this.db.getAgentRun(sessionId)
    if (persisted && persisted.runId === runId) return { status: persisted.status, error: persisted.error, outcome: persisted.status }
    return { status: 'completed', outcome: 'completed' }
  }

  private async runLoop(session: ReturnType<AppDatabase['getSession']>, config: ReturnType<ProviderStore['get']>, run: ActiveRun): Promise<void> {
    const sessionId = session.id
    const controller = run.controller
    const coordinator = await getWorkspaceCoordinator(session.workspace)
    try {
      const discoveryStartedAt = Date.now()
      const enabledSubagents = this.db.listEnabledSubagents()
      const hasSubagents = enabledSubagents.length > 0
      // Subagent roster is constant for the whole run — build it once so the
      // per-round dynamic block stays stable (better prompt-cache hits).
      let subagentSection: string | undefined
      if (hasSubagents) {
        const subagentList = enabledSubagents.map(sa => {
          const toolsHint = sa.allowedTools === 'all' ? 'all tools (read + write + commands)' : sa.allowedTools === 'read' ? 'read and search only' : sa.allowedTools === 'edit' ? 'read and edit' : sa.allowedTools
          const modelName = GO_MODELS.find(m => m.id === sa.model)?.name ?? sa.model
          return `- **${sa.name}**: ${sa.description || 'specialist subagent'} | Model: ${modelName} | Permissions: ${toolsHint}`
        }).join('\n')
        subagentSection = `# Custom subagents
You supervise a team of specialist subagents. Delegate complex work to them:

${subagentList}

## Choosing a subagent
- Pass the right name in the \`subagentName\` field of the \`task\` tool.
- Read each subagent's description, specialty and permissions before delegating.
- Never delegate a task that requires permissions the subagent does not have.

## Delegation rules
- Use \`task_parallel\` to run up to 3 parallel subagents on independent tasks.
- Wait for all summaries before making your final decision.
- You are the supervisor: integrate the summaries and apply the best solution yourself.
- Do not redo a subagent's work — trust an accurate summary.`
      }
      let baseTools = session.agentMode === 'plan' ? toolDefinitions.filter((tool) => !isToolMutating(tool.function.name)) : toolDefinitions
      // أدوات Build لا تظهر في الشات الأساسي. اكتشاف المجموعات يبقى متاحًا في Build
      // حتى عندما لا يملك هذا الاختبار/المضيف مدير معاينة.
      if (!this.profile.dedicatedBuild) baseTools = baseTools.filter((tool) => !BUILD_ONLY_TOOLS.has(tool.function.name))
      else if (!this.startPreview) baseTools = baseTools.filter((tool) => !['start_preview', 'stop_preview', 'preview_status', 'get_page_content', 'preview_screenshot'].includes(tool.function.name))
      if (!hasSubagents) {
        baseTools = baseTools.filter((tool) => tool.function.name !== 'task' && tool.function.name !== 'task_parallel')
      }
      const latestPrompt = [...this.db.listStoredMessages(sessionId)].reverse().find((message) => message.role === 'user')?.content ?? ''
      const buildPolicy = buildToolPolicy(latestPrompt, { preview: Boolean(this.startPreview), subagents: hasSubagents })
      const enabledGroups = new Set<BuildToolGroup>(buildPolicy.groups)
      let mcpTools: ToolDefinition[] | undefined
      const loadMcpTools = async (): Promise<ToolDefinition[]> => {
        if (mcpTools) return mcpTools
        mcpTools = session.agentMode === 'plan' ? [] : await this.mcp.tools(session.workspace, controller.signal, (child) => { run.childProcesses.add(child); child.once('close', () => run.childProcesses.delete(child)) }, session.permissionMode === 'ask' ? (title, detail) => this.approve(sessionId, run, title, detail, true) : undefined)
        return mcpTools
      }
      if (!this.profile.dedicatedBuild || enabledGroups.has('mcp')) await loadMcpTools()
      const discoveryMs = Date.now() - discoveryStartedAt
      const maxSteps = this.profile.maxSteps
      let invalidToolInputRetries = 0
      for (let step = 0; step < maxSteps && Date.now() < run.deadlineAt; step++) {
        const stepStartedAt = Date.now()
        this.assertRunning(run)
        const localTools = this.profile.dedicatedBuild
          ? baseTools.filter((tool) => BUILD_ONLY_TOOLS.has(tool.function.name) || enabledGroups.has(toolGroupFor(tool.function.name) ?? 'core'))
          : baseTools
        const availableTools = [...localTools, ...(enabledGroups.has('mcp') || !this.profile.dedicatedBuild ? await loadMcpTools() : [])]
        this.db.updateAgentRun(sessionId, run.runId, step)
        this.drainPending(sessionId, run)
        this.setStatus(sessionId, step ? `يحلل نتيجة الخطوة ${step}...` : 'يحلل المشروع ويجهز السياق...', run)
        const prepared = await this.buildContext(session, config, availableTools, controller.signal, run.deadlineAt, run.runId, step, run.filesModifiedInPreviousStep, run.lastInjectedContext, subagentSection)
        // Fix 5: حفظ السياق المحقون للاستخدام في الجولة التالية
        if (prepared.injectedContext) run.lastInjectedContext = prepared.injectedContext
        const todos = this.db.getTodos(sessionId)
        const currentTodo = todos.find((todo) => todo.status === 'in_progress')
        const activeTodoId = currentTodo?.id ?? null
        const contextMs = Date.now() - stepStartedAt
        const estimatedTokens = prepared.estimatedTokens
        this.emit({ sessionId, runId: run.runId, type: 'context', context: { estimatedTokens, compacted: prepared.compacted, contextWindow: config.contextWindow } })
        const streamId = randomUUID()
        let streamed = false
        this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: streamId, delta: '', state: 'start' } })
        let reply: Awaited<ReturnType<typeof requestModel>>
        const modelStartedAt = Date.now()
        let firstDeltaAt = 0
        try {
          const markFirstDelta = (): void => { if (!firstDeltaAt) firstDeltaAt = Date.now() }
          const emitDelta = (delta: string): void => { markFirstDelta(); streamed = true; this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: streamId, delta, state: 'delta' } }) }
          const emitReasoningDelta = (delta: string): void => { markFirstDelta(); this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: streamId, delta, state: 'delta', reasoning: true } }) }
          // Tool call streaming: اجمع tool calls أثناء البث وأرسلها للواجهة
          const streamedToolCalls = new Map<string, { id: string; name: string; arguments: string }>()
          const emitToolCallStart = (id: string, name: string): void => {
            markFirstDelta()
            streamedToolCalls.set(id, { id, name, arguments: '' })
            this.emit({ sessionId, runId: run.runId, type: 'tool', tool: { id, name, input: {}, todoId: activeTodoId, status: 'running', startedAt: Date.now() } })
          }
          const emitToolCallDelta = (id: string, delta: string): void => {
            const existing = streamedToolCalls.get(id)
            if (existing) existing.arguments += delta
          }
          const emitToolCallDone = (id: string, _name: string, _args: string): void => {
            // completed in final processing below
          }
          try {
            reply = await this.modelRequest(config, prepared.messages, availableTools, { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 180_000, retries: 2, maxOutputTokens: prepared.maxOutputTokens, onTextDelta: emitDelta, onReasoningDelta: emitReasoningDelta, onToolCallStart: emitToolCallStart, onToolCallDelta: emitToolCallDelta, onToolCallDone: emitToolCallDone })
            this.recordUsage(sessionId, run, config, reply.usage, estimatedTokens, 'agent', streamId)
          } catch (error) {
            if (!(error instanceof ContextOverflowError)) throw error
            // محاولة استرداد: ضغط السياق وإعادة المحاولة حتى بعد بدء البث
            if (streamed) {
              this.setStatus(sessionId, 'تم بدء البث لكن السياق تجاوز الحد؛ يعيد ضغط السياق ويبتدي من جديد...', run)
              // إرسال حدث إنهاء البث السابق
              this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: streamId, delta: '', state: 'done' } })
              // إعادة تعيين علم البث للمحاولة الجديدة
              streamed = false
            } else {
              this.setStatus(sessionId, 'رفض المزود حجم السياق؛ يعيد بناء ذاكرة العمل ويحاول مرة واحدة...', run)
            }
            const recovered = forceCompactForOverflow(prepared.messages)
            // إنشاء stream جديد للمحاولة
            const newStreamId = randomUUID()
            this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: newStreamId, delta: '', state: 'start' } })
            try {
              reply = await this.modelRequest(config, recovered, availableTools, { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 180_000, retries: 0, maxOutputTokens: prepared.maxOutputTokens, onTextDelta: (delta) => { streamed = true; this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: newStreamId, delta, state: 'delta' } }) }, onReasoningDelta: (delta) => { this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: newStreamId, delta, state: 'delta', reasoning: true } }) } })
              this.recordUsage(sessionId, run, config, reply.usage, estimateModelRequestTokens(config, recovered, availableTools, prepared.maxOutputTokens), 'overflow-recovery', newStreamId)
            } finally {
              this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: newStreamId, delta: '', state: 'done' } })
            }
          }
          if (!reply.toolCalls.length && reply.finishReason === 'length') {
            let combinedText = reply.text
            let combinedUsage = reply.usage
            // ─── حل ذكي للاستمرار: حفظ السياق الكامل مع ضغط ذكي ───
            // 1. احتفظ بالسياق الكامل (prepared.messages) كأساس
            // 2. أضف الرد الحالي والتعليمات
            // 3. عند كل استمرار، اضغط الرسائل القديمة بدلاً من حذفها
            const continuationContext: ModelInput[] = [...prepared.messages, { role: 'assistant', content: reply.text, providerPayload: reply.providerPayload }]
            let continuationCount = 0
            while (reply.finishReason === 'length') {
              this.assertRunning(run)
              if (++continuationCount > 8) { reply = { ...reply, finishReason: 'stop', usage: combinedUsage }; break }
              this.setStatus(sessionId, 'يتابع الرد تلقائيًا بعد بلوغ حد إخراج المزود...', run)
              continuationContext.push({ role: 'user', content: 'تابع مباشرة من آخر موضع دون تكرار، وأكمل الرد حتى النهاية.' })
              // ضغط ذكي: قلل حجم الرسائل القديمة قبل كل طلب
              const estimatedTokens = estimateModelRequestTokens(config, continuationContext, [], prepared.maxOutputTokens)
              if (continuationCount > 3 || estimatedTokens > Math.floor(config.contextWindow * 0.75)) {
                // ضغط الرسائل القديمة: احتفظ semiclass الرؤوس فقط + آخر 3 رسائل كاملة
                const compressedContext = smartCompressForContinuation(continuationContext, config.contextWindow * 0.7)
                continuationContext.length = 0
                continuationContext.push(...compressedContext)
              }
              const continuationOutputTokens = Math.min(config.maxOutputTokens, Math.max(prepared.maxOutputTokens, Math.floor(config.contextWindow * 0.25)))
              const next = await this.modelRequest(config, continuationContext, [], { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 180_000, retries: 2, maxOutputTokens: continuationOutputTokens, onTextDelta: emitDelta })
              this.recordUsage(sessionId, run, config, next.usage, estimateModelRequestTokens(config, continuationContext, [], continuationOutputTokens), 'continuation', streamId)
              combinedUsage = mergeUsage(combinedUsage, next.usage)
              if (!next.text.trim() || next.text === reply.text || combinedText.endsWith(next.text)) { reply = { ...next, text: combinedText, finishReason: 'stop', providerPayload: undefined, usage: combinedUsage }; break }
              combinedText += next.text
              continuationContext.push({ role: 'assistant', content: next.text, providerPayload: next.providerPayload })
              reply = { ...next, text: combinedText, providerPayload: undefined, usage: combinedUsage }
            }
          }
        }
        finally { this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: streamId, delta: '', state: 'done' } }) }

        if (reply.toolCalls.length === 0) {
          // حماية حرجة: إذا أُلغي التشغيل أثناء حلّ promise المزود،
          // لا نُكمل مسار "الإكمال" — cancel() تولّى الإشعار والتسجيل.
          if (run.cancelledExternally || run.controller.signal.aborted) return
          if (reply.finishReason === 'length') reply.finishReason = 'stop'
          if (reply.finishReason === 'content_filter') throw new Error('أوقف المزود الرد بسبب سياسة المحتوى.')
          if (reply.finishReason !== 'stop') throw new Error(`انتهى النموذج بحالة غير مكتملة: ${reply.finishReason}`)
          // استجابة فارغة: محاولة واحدة إضافية مع تنبيه صريح بدل إفشال التشغيل
          if (!reply.text.trim()) {
            const retryMessages: ModelInput[] = [...prepared.messages, { role: 'user', content: 'Your previous reply was empty. Provide your complete answer now, without tool calls.' }]
            const retried = await this.modelRequest(config, retryMessages, [], { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 180_000, retries: 1, maxOutputTokens: prepared.maxOutputTokens })
            this.recordUsage(sessionId, run, config, retried.usage, estimateModelRequestTokens(config, retryMessages, [], prepared.maxOutputTokens), 'continuation', streamId)
            if (retried.text.trim()) reply = { ...retried, toolCalls: [] }
          }
          if (!reply.text.trim()) throw new Error('أعاد النموذج ردًا فارغًا دون تنفيذ أدوات.')

          // ─── P3-02: تحقق مؤجّل — يُشغَّل مرة عند التسليم لا بعد كل تعديل ───
          // يجمع الملفات المعدلة عبر الخطوات ويشغّل typecheck/lint/test مرة واحدة
          // قبل التسليم النهائي. إذا فشل، يُحقن الخطأ ويواصل الوكيل الإصلاح.
          if (run.pendingVerificationFiles.length && !controller.signal.aborted) {
            const uniqueFiles = [...new Set(run.pendingVerificationFiles)]
            run.pendingVerificationFiles = []
            const verificationResult = await this.runVerification(session.workspace, coordinator.revision, controller.signal, uniqueFiles, run.deadlineAt)
            if (verificationResult) {
              if (verificationResult.includes('❌')) {
                run.verificationFailures++
                const maxFixes = 3
                if (run.verificationFailures <= maxFixes) {
                  const fixInstruction = run.verificationFailures === 1
                    ? `\n⚠️ فشل التحقق بسبب تعديلاتك. هذه محاولة الإصلاح ${run.verificationFailures}/${maxFixes}. اقرأ الأخطاء أعلاه وأصلحها فورًا في الجولة القادمة. لا تنتظر موافقتي — أصلح واستمر.`
                    : run.verificationFailures < maxFixes
                      ? `\n⚠️ لا يزال التحقق يفشل! محاولة ${run.verificationFailures}/${maxFixes}. حلل الأخطاء بعمق وجرب أسلوبًا مختلفًا.`
                      : `\n🛑 هذه آخر محاولة إصلاح (${run.verificationFailures}/${maxFixes}). إذا لم تنجح، سأبلغ المستخدم بالمشكلة.`
                  this.db.addMessage({ sessionId, role: 'system', content: `نتيجة التحقق التلقائي بعد التعديل:\n${verificationResult}${fixInstruction}` })
                  this.setStatus(sessionId, 'فشل التحقق النهائي؛ يتابع الوكيل الإصلاح...', run)
                  continue
                }
                this.db.addMessage({ sessionId, role: 'system', content: `نتيجة التحقق التلقائي بعد التعديل:\n${verificationResult}\n⚠️ تم تجاوز حد محاولات الإصلاح التلقائي (${maxFixes}). أبلغ المستخدم بالمشكلة.` })
              } else {
                run.verificationFailures = 0
                this.db.addMessage({ sessionId, role: 'system', content: `نتيجة التحقق التلقائي بعد التعديل:\n${verificationResult}` })
              }
            }

            // مراجعة كود تلقائية مرة واحدة عند التسليم (قواعد regex محلية بلا تكلفة نموذج)
            if (uniqueFiles.length >= 3 && !controller.signal.aborted) {
              try {
                const reviewer = new CodeReviewer(session.workspace, controller.signal)
                const reviewResult = await reviewer.reviewFiles(uniqueFiles)
                if (reviewResult.issues.length > 0) {
                  const issuesSummary = reviewResult.issues.slice(0, 5).map((i) => `${i.severity === 'error' ? '🔴' : i.severity === 'warning' ? '🟡' : '🔵'} ${i.file}:${i.line} — ${i.message}`).join('\n')
                  this.db.addMessage({ sessionId, role: 'system', content: `📋 مراجعة كود تلقائية (${reviewResult.score}/100):\n${issuesSummary}${reviewResult.issues.length > 5 ? `\n... و${reviewResult.issues.length - 5} ملاحظات أخرى` : ''}` })
                }
              } catch { /* لا نتوقف بسبب فشل المراجعة */ }
            }
          }

          const message = this.db.addMessage({ id: streamId, sessionId, role: 'assistant', content: reply.text, reasoning: reply.reasoning, providerPayload: reply.providerPayload, usage: reply.usage })
          this.emit({ sessionId, runId: run.runId, type: 'message', message })
          this.recordStepTiming(sessionId, run.runId, step + 1, config.model, { discoveryMs: step === 0 ? discoveryMs : 0, contextMs, modelMs: Date.now() - modelStartedAt, firstTokenMs: firstDeltaAt ? firstDeltaAt - modelStartedAt : undefined, toolMs: 0, totalMs: Date.now() - stepStartedAt, tools: [], changedFiles: 0, compactionReason: prepared.compacted ? 'context-budget' : undefined })
           if (run.pendingMessages.length || run.followUpQueued) { run.followUpQueued = false; this.setStatus(sessionId, 'وصلت رسائل متابعة، يواصل الوكيل مع السياق المحدّث...', run); continue }
           if (this.profile.autoCompleteTodos) {
             const todos = this.db.getTodos(sessionId)
             if (todos.some((todo) => todo.status === 'pending' || todo.status === 'in_progress')) {
               const completedTodos = this.db.setTodos(sessionId, todos.map((todo) => ({ content: todo.content, status: todo.status === 'cancelled' ? 'cancelled' : 'completed', priority: todo.priority })))
               this.emit({ sessionId, runId: run.runId, type: 'todo', todos: completedTodos })
             }
           }
           // تعلّم تلقائي: احفظ الأدوات المستعملة ونتائجها وأهم الدروس في الذاكرة
           this.autoRememberRun(session, run)
           if (!run.cancelledExternally) run.outcome = 'completed'
           return
        }

        validateCallIds(reply.toolCalls)
        const requestedHiddenGroups = new Set<BuildToolGroup>()
        const validations = reply.toolCalls.map((call) => {
          const validation = validateToolCall(call, availableTools)
          if (validation.ok || !this.profile.dedicatedBuild) return validation
          const group = toolGroupFor(call.name)
          if (group && group !== 'core' && !enabledGroups.has(group)) requestedHiddenGroups.add(group)
          return validation
        })

        if (requestedHiddenGroups.size) {
          for (const group of requestedHiddenGroups) enabledGroups.add(group)
          if (requestedHiddenGroups.has('mcp')) await loadMcpTools()
          invalidToolInputRetries = 0
          this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: streamId, delta: '', state: 'discard' } })
          this.db.addMessage({ sessionId, role: 'system', content: `فعّل النظام تلقائيًا مجموعات الأدوات المطلوبة: ${[...requestedHiddenGroups].join(', ')}. أعد استدعاء الأدوات نفسها الآن في الجولة التالية.` })
          this.setStatus(sessionId, 'فعّل النظام مجموعة الأدوات المطلوبة تلقائيًا...', run)
          continue
        }

        const invalidCalls = validations.flatMap((validation, index) => validation.ok ? [] : [{ call: reply.toolCalls[index]!, error: validation.error }])
        if (this.profile.dedicatedBuild && invalidCalls.length) {
          invalidToolInputRetries++
          const correction = invalidCalls.map(({ call, error }) => {
            const definition = availableTools.find((tool) => tool.function.name === call.name)
            const requiredValue = definition?.function.parameters.required
            const required = Array.isArray(requiredValue) ? requiredValue.filter((value): value is string => typeof value === 'string') : []
            let sentFields = 'JSON غير صالح'
            try { const parsed = JSON.parse(call.arguments); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sentFields = Object.keys(parsed).join(', ') || 'لا توجد' } catch {}
            return `- ${call.name}: ${error}. الحقول المطلوبة: ${required.join(', ') || 'لا توجد'}. الحقول المرسلة: ${sentFields}`
          }).join('\n')
          this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: streamId, delta: '', state: 'discard' } })
          if (invalidToolInputRetries >= 3) throw new Error(`تعذر على النموذج تصحيح مدخلات الأدوات بعد 3 محاولات داخلية.\n${correction}`)
          this.db.addMessage({ sessionId, role: 'system', content: `رفض النظام استدعاءات أدوات ناقصة قبل تنفيذها:\n${correction}\n\nأعد استدعاء الأدوات الصحيحة مباشرة في الجولة التالية. لا تكتب اعتذارًا أو وعدًا بأنك سترسل المحتوى لاحقًا. بالنسبة إلى write_file وappend_file يجب أن يحتوي نفس الاستدعاء على content كنص فعلي كامل. contentReceipt بيانات عرض داخلية وليست مدخل أداة صالحًا؛ لا تنشئها ولا ترسلها. مثال البنية الصحيحة: {"path":"src/file.ts","content":"النص الفعلي الكامل"}. لا تكرر المدخل نفسه.` })
          this.setStatus(sessionId, 'صحح النظام مدخل أداة ناقص قبل التنفيذ...', run)
          continue
        }
        invalidToolInputRetries = 0

        // ─── Doom-loop detection (consecutive + cumulative) ──────────────
        const stepSignature = createStepSignature(reply.toolCalls, validations)
        const previousStepSignature = run.lastStepSignature
        run.lastStepSignature = stepSignature

        // كشف التكرار المتتالي (نفس الخطوة مرتين متتاليتين)
        const isConsecutiveRepeat = previousStepSignature === stepSignature
        if (isConsecutiveRepeat) {
          run.consecutiveRepeats = (run.consecutiveRepeats ?? 0) + 1
        } else {
          run.consecutiveRepeats = 0
        }

        // كشف التكرار المتراكم (نفس الخطوة 5 مرات على مدى الجلسة)
        const cumulativeRepeated = (run.repeatedSteps.get(stepSignature) ?? 0) + 1
        run.repeatedSteps.set(stepSignature, cumulativeRepeated)

        // توقف إذا: 3 متتاليات OR 5 متراكمة
        // التصعيد: أول كشف = رسالة توجيه صارمة وجولة إضافية (بدون خسارة
        // التشغيل)، الكشف الثاني = إيقاف. حماية التكلفة نفسها بلا قيود جديدة.
        if (run.consecutiveRepeats >= 3) {
          if (!run.repeatEscalated) {
            run.repeatEscalated = true
            run.consecutiveRepeats = 0
            run.lastStepSignature = undefined
            this.emit({ sessionId, runId: run.runId, type: 'stream', stream: { id: streamId, delta: '', state: 'discard' } })
            this.db.addMessage({ sessionId, role: 'system', content: `LOOP DETECTED: you issued the exact same tool calls 3 rounds in a row. Do not repeat them. Change your approach now: re-read the full error, try different inputs, use a different tool, or state what blocks you. The next identical repetition terminates this run.` })
            this.setStatus(sessionId, 'اكتشف تكرارًا؛ يوجّه الوكيل لمسار مختلف...', run)
            continue
          }
          throw new Error(`اكتشفت حلقة عالقة: كرر الوكيل نفس الإجراء رغم التنبيه.\n${recoveryNudge(ErrorCategory.Logic, reply.toolCalls[0]?.name ?? 'unknown', run.consecutiveRepeats)}`)
        }
        if (cumulativeRepeated >= 5) {
          throw new Error(`اكتشفت حلقة عالقة: كرر النموذج نفس استدعاءات الأدوات 5 مرات على مدى الجلسة.\n${recoveryNudge(ErrorCategory.Logic, reply.toolCalls[0]?.name ?? 'unknown', cumulativeRepeated)}`)
        }
        const records: ToolCallRecord[] = reply.toolCalls.map((call, index) => ({ id: call.id, name: call.name, input: validations[index]!.input, todoId: activeTodoId, status: 'running', step: step + 1, startedAt: Date.now() }))
        const thought = this.db.addMessage({ id: streamId, sessionId, role: 'assistant', content: reply.text, reasoning: reply.reasoning, toolCalls: records, providerPayload: reply.providerPayload, usage: reply.usage })
        this.emit({ sessionId, runId: run.runId, type: 'message', message: thought })

        const deferredCommits: Array<{ action: string; paths: string[] }> = []
        const toolContext: ToolContext = { session: this.db.getSession(sessionId), signal: controller.signal, deadlineAt: run.deadlineAt, maxOutputChars: Math.min(1_500_000, Math.max(120_000, Math.floor(config.contextWindow * 1.2))), mcp: this.mcp, trackProcess: (child) => { run.childProcesses.add(child); child.once('close', () => run.childProcesses.delete(child)) }, approve: (title, detail, critical, rememberKey) => this.approve(sessionId, run, title, detail, critical, rememberKey), readStoredMessage: (id) => Promise.resolve(this.db.getStoredMessage(sessionId, id)), loadSkill: (name) => loadSkillFromWorkspace(session.workspace, name), todos: { get: () => Promise.resolve(this.db.getTodos(sessionId)), set: (items) => { const todos = this.db.setTodos(sessionId, items); this.emit({ sessionId, runId: run.runId, type: 'todo', todos }); return Promise.resolve(todos) } }, runSubagent: (input, subSignal) => this.runSubagent(this.db.getSession(sessionId), config, run, input, subSignal), runSubagentBatch: (tasks, subSignal) => this.runSubagentBatch(this.db.getSession(sessionId), config, run, tasks, subSignal), runCommand: async (name, argumentsText) => { const commands = await loadProjectCommands(session.workspace); const command = commands.find((item) => item.name === name); if (!command) return { ok: false, error: `أمر غير معروف: ${name}` }; return { ok: true, output: renderCommandTemplate(command.template, argumentsText ?? '') } }, deferAutoCommit: (action, paths) => deferredCommits.push({ action, paths }), pushUndo: (entry) => { const stack = this.undoStacks.get(sessionId) ?? []; stack.push(entry); if (stack.length > 20) stack.shift(); this.undoStacks.set(sessionId, stack) }, popUndo: () => { const stack = this.undoStacks.get(sessionId); return stack?.pop() }, indexer: getProjectIndexer(session.workspace), memory: this.getMemory(session.workspace), fetchFileOnDemand: async (filePath) => { try { const abs = path.resolve(session.workspace, filePath); const content = await fs.readFile(abs, 'utf8'); return content.slice(0, 50_000) } catch { return null } }, ...(this.profile.dedicatedBuild ? { discoverTools: () => BUILD_TOOL_GROUPS, enableToolGroup: async (group: string) => { if (!(group in BUILD_TOOL_GROUPS) || group === 'core') throw new Error(`مجموعة غير صالحة: ${group}`); const typed = group as BuildToolGroup; enabledGroups.add(typed); const tools = typed === 'mcp' ? (await loadMcpTools()).map((tool) => tool.function.name) : [...BUILD_TOOL_GROUPS[typed]]; return { enabled: typed, tools } } } : {}) }
        toolContext.fullPowerShell = this.profile.fullPowerShellLanguage
        toolContext.tavilyApiKey = this.tavilyStore?.getKey() || undefined
        if (this.profile.dedicatedBuild && this.startPreview) {
          // Q2: نمرر signal الإلغاء إلى بدء المعاينة ليتوقف فورًا عند الإلغاء
          toolContext.startPreview = (signal) => this.startPreview!(this.db.getSession(sessionId), signal)
          toolContext.stopPreview = this.stopPreview ? () => this.stopPreview!(this.db.getSession(sessionId)) : undefined
          // Q7: الحالة الحية تأتي من مدير الخادم مباشرة (لا حالة مخزنة قديمة) عند توفره،
          // مع الاحتفاظ بعلم previewStarting من الحالة المخزنة لمعرفة البدء الجاري،
          // ويُصفَّر تلقائيًا عندما يكون الخادم يعمل فعلًا.
          toolContext.getPreviewState = () => {
            const cached = this.previewStates.get(sessionId)
            const live = this.previewStatus?.(this.db.getSession(sessionId))
            if (!live) return cached ?? { running: false }
            return { ...cached, ...live, previewStarting: cached?.previewStarting && !live?.running }
          }
          toolContext.onPreviewState = (preview) => { this.previewStates.set(sessionId, preview); this.emit({ sessionId, runId: run.runId, type: 'preview', preview }) }
          // عيون الوكيل: لقطة فعلية بعد JS + console من نافذة خفية (بلا اعتماديات خارجية)
          toolContext.capturePreview = async () => {
            const live = toolContext.getPreviewState?.()
            if (!live?.running || !live.url) return null
            const { capturePreviewPage } = await import('./preview-capture')
            const shotDir = path.join(os.tmpdir(), 'r-code-preview')
            await fs.mkdir(shotDir, { recursive: true })
            const shotPath = path.join(shotDir, `${sessionId}.jpg`)
            return capturePreviewPage(live.url, shotPath)
          }
        }
        const toolsStartedAt = Date.now()
        this.assertRunning(run) // تحقق إضافي قبل تنفيذ الأدوات
        const executeCall = async (index: number): Promise<void> => {
          const call = reply.toolCalls[index]!
          const validation = validations[index]!
          const record = records[index]!
          // تتبع استعمال الأدوات ونتائجها — يُحفظ تلقائيًا في الذاكرة عند اكتمال التشغيل
          const usageEntry = run.toolUsage.get(call.name) ?? { calls: 0, failures: 0 }
          usageEntry.calls++
          run.toolUsage.set(call.name, usageEntry)
          this.db.addAudit({ sessionId, category: 'tool', action: call.name, detail: JSON.stringify(projectToolInput(call.name, record.input)), outcome: 'started' })
          this.emit({ sessionId, runId: run.runId, type: 'tool', tool: record })
          let output: string
           if (!validation.ok) {
             output = JSON.stringify({ ok: false, error: { code: 'INVALID_TOOL_INPUT', message: validation.error } }, null, 2)
             record.status = 'error'
             run.toolFailures++
           } else if (controller.signal.aborted) {
             output = JSON.stringify({ ok: false, error: { code: 'ABORTED', message: 'تم الإلغاء قبل تنفيذ الأداة.' } }, null, 2)
             record.status = 'error'
             run.toolFailures++
           } else {
             try {
                const mutationReceipts: Array<Omit<MutationReceipt, 'workspaceRevision'>> = []
                const mutating = isToolMutating(call.name)
                const release = mutating ? await coordinator.acquireMutation(controller.signal) : undefined
                try {
                  output = await executeTool(call.name, validation.input, { ...toolContext, recordMutation: (receipt) => mutationReceipts.push(receipt) })
                   const succeeded = toolOutputSucceeded(output)
                   if (mutating && succeeded && mutationReceipts.length) {
                    const revision = coordinator.advanceRevision()
                    record.mutation = { ...mergeMutationReceipts(mutationReceipts), workspaceRevision: revision }
                    getProjectIndexer(session.workspace).invalidate(record.mutation)
                  }
                } finally {
                  release?.()
                }
               const outputErrorCode = toolOutputErrorCode(output)
               record.status = outputErrorCode ? outputErrorCode === 'APPROVAL_DENIED' || outputErrorCode === 'PLAN_MODE' || outputErrorCode === 'READ_ONLY' ? 'denied' : 'error' : 'completed'
               if (record.status === 'error') run.toolFailures++
              } catch (error) {
                output = JSON.stringify({ ok: false, error: { code: isAbortError(error) || controller.signal.aborted ? 'ABORTED' : 'TOOL_ERROR', message: isAbortError(error) ? 'تم الإلغاء قبل اكتمال الأداة.' : error instanceof Error ? error.message : String(error) } }, null, 2)
               record.status = 'error'
               run.toolFailures++
             }
           }
           if (run.toolFailures >= 15) throw new Error('توقّف الوكيل بعد 15 إخفاقات أدوات لتجنب حلقة فشل مكلفة.')

            const outputLimit = call.name === 'read_files' || call.name === 'tree' ? Math.min(80_000, Math.max(30_000, Math.floor(config.contextWindow * 0.08))) : call.name === 'read_file' ? Math.min(50_000, Math.max(20_000, Math.floor(config.contextWindow * 0.05))) : call.name === 'web_fetch' || call.name === 'web_research' ? Math.min(80_000, Math.max(40_000, Math.floor(config.contextWindow * 0.08))) : call.name === 'web_search' ? Math.min(50_000, Math.max(30_000, Math.floor(config.contextWindow * 0.05))) : 30_000
            record.output = boundToolOutput(output, outputLimit)
            record.completedAt = Date.now()

            // ─── كشف الدوران بالقراءة: نفس الملف 4+ مرات → توجيه بدل المنع ───
            // يكشف النمط الذي لا تلتقطه توقيع الخطوة (نفس الهدف بمدخلات مختلفة قليلًا)
            if (record.status === 'completed' && FILE_REPEAT_TOOLS.has(call.name)) {
              const filePath = typeof validation.input.path === 'string' ? validation.input.path : undefined
              if (filePath) {
                const reads = (run.fileReadCounts.get(filePath) ?? 0) + 1
                run.fileReadCounts.set(filePath, reads)
                if (reads >= 4) {
                  record.output = `${record.output ?? ''}\n[تنبيه دوران: قرأت ${filePath} ${reads} مرات في هذا التشغيل. محتواه لديك بالفعل — استخدم ما قرأته مباشرة، أو ابحث عن معلومة محددة داخله بـ search_files بدل إعادة القراءة الكاملة.]`
                }
              }
            }
            // تصنيف الخطأ وتتبع التكرار بعد حفظ الناتج الفعلي
             if (record.status === 'error') {
              usageEntry.failures++
              run.recentErrors.push(`${call.name}: ${(record.output ?? '').slice(0, 500)}`)
              if (run.recentErrors.length > 5) run.recentErrors.shift()
             const errorCategory = classifyError(record.output ?? '')
             const prevCategory = run.lastErrorCategory
             run.lastErrorCategory = errorCategory
             if (prevCategory === errorCategory) {
               run.consecutiveErrorCategories = (run.consecutiveErrorCategories ?? 0) + 1
             } else {
               run.consecutiveErrorCategories = 0
             }
             // سجل أسوأ سلسلة فشل متتالية — تُحفظ في الذاكرة كتعلم عند النجاح لاحقًا
             if ((run.consecutiveErrorCategories ?? 0) > run.peakErrorStreak) {
               run.peakErrorStreak = run.consecutiveErrorCategories ?? 0
               run.peakErrorSample = `${call.name}: ${(record.output ?? '').slice(0, 250)}`
             }
             // إذا فشل بنفس التصنيف 3 مرات متتالية، أضف recovery nudge
             if (run.consecutiveErrorCategories >= 3) {
               record.output = (record.output ?? '') + '\n' + recoveryNudge(errorCategory, call.name, run.consecutiveErrorCategories)
              }
            }
            // لا تحجب حالة الأداة السريعة خلف أبطأ أداة في مرحلة القراءة المتوازية.
            // تبقى رسائل نتائج الأدوات نفسها مؤجلة أدناه للحفاظ على ترتيب طلب النموذج.
            this.db.updateToolCalls(thought.id, records)
            this.emit({ sessionId, runId: run.runId, type: 'tool', tool: record })
         }
        const persistCall = (index: number): void => {
          const call = reply.toolCalls[index]!
          const record = records[index]!
          this.db.completeToolCall(thought.id, records, { sessionId, role: 'tool', content: record.output ?? '', toolCallId: call.id, toolName: call.name })
          this.db.addAudit({ sessionId, category: 'tool', action: call.name, detail: (record.output ?? '').slice(0, 4000), outcome: record.status === 'completed' ? 'completed' : record.status === 'denied' ? 'denied' : 'failed' })
        }
        for (const stage of planToolStages(reply.toolCalls.map((call, index) => ({ name: call.name, input: validations[index]!.input })))) {
          if (stage.parallel) await runWithConcurrency(stage.indexes.length, MAX_PARALLEL_READ_TOOLS, (offset) => executeCall(stage.indexes[offset]!))
          else for (const index of stage.indexes) await executeCall(index)
        }
        // النتائج تحفظ دائمًا بترتيب طلب النموذج، بصرف النظر عن ترتيب اكتمال القراءة.
        for (let index = 0; index < reply.toolCalls.length; index++) persistCall(index)
        // ─── عيون الوكيل: حقن لقطة المعاينة في السياق ليراها النموذج فعليًا ───
        // بعد preview_screenshot ناجح، تضاف الصورة كرسالة مستقلة إن كان النموذج
        // يدعم الصور — هكذا يتحقق من النتيجة المرئية بدل التخمين من HTML الخام.
        if (this.profile.dedicatedBuild) {
          for (const record of records) {
            if (record.name !== 'preview_screenshot' || record.status !== 'completed') continue
            try {
              const parsed = JSON.parse(record.output ?? '') as { data?: { screenshot?: { path?: string } } }
              const shotPath = parsed?.data?.screenshot?.path
              if (typeof shotPath !== 'string' || !modelSupportsModality(config.model, 'image')) break
              const shotBuffer = await fs.readFile(shotPath)
              if (shotBuffer.byteLength > 6_000_000) break
              const shotAttachment: Attachment = { name: 'preview-screenshot.jpg', mimeType: 'image/jpeg', data: shotBuffer.toString('base64'), size: shotBuffer.byteLength }
              const shotMessage = this.db.addMessage({ sessionId, role: 'user', content: '📸 لقطة المعاينة الفعلية بعد تنفيذ JavaScript (من preview_screenshot) — انظر إليها وتحقق من صحة الواجهة، وأصلح أي خلل مرئي أو أخطاء console ظهرت في نتيجة الأداة.', attachments: [shotAttachment] })
              this.emit({ sessionId, runId: run.runId, type: 'message', message: shotMessage })
            } catch { /* لقطة غير قابلة للحقن — النتيجة النصية كافية */ }
            break
          }
        }
        if (deferredCommits.length) {
          this.assertRunning(run) // لا تكمل auto-commit إن أُلغي التشغيل
          const paths = deferredCommits.flatMap((item) => item.paths)
          const actions = [...new Set(deferredCommits.map((item) => item.action))]
          const receipt = await commitAutoChanges(toolContext, session.workspace, actions.join('+'), paths)
          const deferredRecords = records.filter((item) => item.output?.includes('"deferred": true'))
          for (const record of deferredRecords) {
            record.output = withAutoCommit(record.output!, receipt)
            this.db.updateToolResult(sessionId, record.id, record.output)
          }
          this.db.updateToolCalls(thought.id, records)
          for (const record of deferredRecords) this.emit({ sessionId, runId: run.runId, type: 'tool', tool: record })
          this.db.addAudit({ sessionId, category: 'tool', action: 'git-auto-commit', detail: JSON.stringify(receipt), outcome: receipt?.committed ? 'completed' : 'failed' })
        }
        // ─── P3-02: تجميع الملفات المعدلة للتحقق المؤجل (لا تحقق فوري) ───
        const editedFiles = records.flatMap((record) => mutationReceiptPaths(record.mutation)).map((relative) => path.join(session.workspace, relative))
        run.filesModifiedInPreviousStep = editedFiles.length > 0
        if (editedFiles.length) {
          // تجميع الملفات — يُنفَّذ التحقق النوعي (typecheck/lint/test) ومراجعة الكود
          // مرة واحدة عند تسليم الوكيل للنتيجة النهائية، لا بعد كل خطوة تعديل.
          run.pendingVerificationFiles.push(...editedFiles)
          // ─── تجميع الملفات المعدلة على ActiveRun لتفادي rescan كل التاريخ ───
          // يُستخدم في buildContext لحقن git diff/snippets بدل مسح O(history).
          run.pendingEditedFiles.push(...editedFiles)
        }
        // تشغيل المعاينة تلقائيًا بعد كل جولة أدوات في وضع Build — يظهر الموقع فورًا في لوحة المعاينة داخل التطبيق
        // Q3/Q1: لا نعيد التشغيل إذا كان الخادم يعمل أو قيد التشغيل (يمنع حجب الجولات ودورات التثبيت المتكررة).
         const runtimeMutation = records.map((record) => record.mutation).filter((receipt): receipt is MutationReceipt => receipt !== undefined).filter(receiptAffectsRuntime).sort((a, b) => b.workspaceRevision - a.workspaceRevision)[0]
         if (this.profile.autoPreview && runtimeMutation && toolContext.startPreview && toolContext.onPreviewState && !controller.signal.aborted) {
           const existing = toolContext.getPreviewState?.()
           if (run.previewRevision !== runtimeMutation.workspaceRevision && !existing?.running && !existing?.previewStarting) {
             run.previewRevision = runtimeMutation.workspaceRevision
             toolContext.onPreviewState({ running: false, previewStarting: true })
             void toolContext.startPreview(controller.signal).then((preview) => { if (!controller.signal.aborted) toolContext.onPreviewState?.(preview) }).catch((error) => { if (!controller.signal.aborted) toolContext.onPreviewState?.({ running: false, error: error instanceof Error ? error.message : 'فشل' }) })
           }
        }
        this.recordStepTiming(sessionId, run.runId, step + 1, config.model, { discoveryMs: step === 0 ? discoveryMs : 0, contextMs, modelMs: toolsStartedAt - modelStartedAt, firstTokenMs: firstDeltaAt ? firstDeltaAt - modelStartedAt : undefined, toolMs: Date.now() - toolsStartedAt, totalMs: Date.now() - stepStartedAt, tools: reply.toolCalls.map((call) => call.name), changedFiles: editedFiles.length, compactionReason: prepared.compacted ? 'context-budget' : undefined })
        if (!prepared.compacted && run.compressionCount > 0) run.compressionCount = Math.max(0, run.compressionCount - 1)
      }
       run.outcome = 'interrupted'
       if (Date.now() >= run.deadlineAt) throw new DeadlineExceededError(`توقف التشغيل لانتهاء المهلة ${Math.round(this.profile.runtimeMs / 60_000)} دقيقة. استخدم استئناف لبدء ميزانية تشغيل جديدة.`)
       throw new Error(`توقف التشغيل عند حد ${maxSteps} جولة. استخدم استئناف لبدء ميزانية تشغيل جديدة.`)
    } catch (error) {
      if (run.costCapped) { const message = error instanceof Error ? error.message : String(error); this.db.addAudit({ sessionId, category: 'agent', action: 'run', detail: message, outcome: 'failed' }); run.error = message; run.outcome = 'failed'; const failure = this.db.addMessage({ sessionId, role: 'assistant', content: message }); this.emit({ sessionId, runId: run.runId, type: 'message', message: failure }); this.emit({ sessionId, runId: run.runId, type: 'error', text: message }) }
       else if (controller.signal.aborted) { run.outcome = 'cancelled'; this.db.addAudit({ sessionId, category: 'agent', action: 'run', detail: 'ألغى المستخدم التشغيل', outcome: 'cancelled' }); /* لا تبث شيئًا — cancel() تولى الإشعار */ }
       else if (run.outcome === 'interrupted' || error instanceof DeadlineExceededError || Date.now() >= run.deadlineAt) {
         const message = error instanceof Error && error.message.includes('حد')
           ? error.message
           : 'توقف التشغيل لانتهاء المهلة الزمنية. استخدم استئناف لبدء ميزانية تشغيل جديدة.'
         run.outcome = 'interrupted'
         run.error = message
         this.db.addAudit({ sessionId, category: 'agent', action: 'run-interrupted', detail: message, outcome: 'failed' })
         const interruption = this.db.addMessage({ sessionId, role: 'assistant', content: message, interrupted: true })
         this.emit({ sessionId, runId: run.runId, type: 'message', message: interruption })
         this.emit({ sessionId, runId: run.runId, type: 'error', text: message })
       }
       else if (isResumableNetworkError(error)) {
         // انقطاع عابر في اتصال المزود: يُحفظ التقدم ويُعلَّم التشغيل قابلًا
         // للاستئناف بدل تصنيفه فشلًا نهائيًا يخسر معه المستخدم كل السياق.
         const message = error instanceof Error && error.message ? error.message : String(error)
         run.outcome = 'interrupted'
         run.error = `انقطع اتصال المزود أثناء التشغيل: ${message.slice(0, 300)}`
         this.db.addAudit({ sessionId, category: 'agent', action: 'run-interrupted', detail: run.error, outcome: 'failed' })
         const interruption = this.db.addMessage({ sessionId, role: 'assistant', content: `انقطع اتصال المزود أثناء التشغيل. استخدم "استئناف" للمتابعة من السياق المحفوظ دون خسارة ما أُنجز. (${message.slice(0, 200)})`, interrupted: true })
         this.emit({ sessionId, runId: run.runId, type: 'message', message: interruption })
         this.emit({ sessionId, runId: run.runId, type: 'error', text: run.error })
       }
       else { const message = error instanceof Error ? error.message : String(error); this.db.addAudit({ sessionId, category: 'agent', action: 'run', detail: message, outcome: 'failed' }); run.error = message; const failure = this.db.addMessage({ sessionId, role: 'assistant', content: `فشل التنفيذ: ${message}` }); this.emit({ sessionId, runId: run.runId, type: 'message', message: failure }); this.emit({ sessionId, runId: run.runId, type: 'error', text: message }) }
    } finally {
      this.db.finishAgentRun(sessionId, run.runId, run.outcome ?? 'failed', run.error)
      this.cancelApprovals(sessionId, run.runId)
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId)
      // لا تبث الحالة الأخيرة إن كان المستخدم قد ألغى التشغيل (cancel تولى الإشعار)
      if (!run.cancelledExternally) {
        this.emit({ sessionId, runId: run.runId, type: 'status', text: controller.signal.aborted ? 'تم إيقاف التنفيذ.' : '' })
      }
    }
  }

  cancel(sessionId: string): void {
    const run = this.runs.get(sessionId)
    if (!run) return
    // 1. اقتل كل العمليات الفرعية فورًا
    for (const child of run.childProcesses) { try { child.kill() } catch {} }
    run.childProcesses.clear()
    // 2. أسقط أي رسائل معلقة في الطابور حتى لا تُعالج في جولات متأخرة
    run.pendingMessages.length = 0
    // 3. أغلق shell الدائم لهذه الجلسة
    closePersistentShell(sessionId)
    // 4. ألغِ AbortController الرئيسي (يوقف runLoop وكل الأدوات والوكلاء الفرعيين)
    run.controller.abort()
    // 5. ألغِ كل طلبات الموافقة المعلقة
    this.cancelApprovals(sessionId, run.runId)
    // 6. نظف طلبات المزود المعلقة لهذه الجلسة
    cancelProviderRequestSlots(`session:${sessionId}`)
    cancelProviderRequestSlots(`subagent:${sessionId}`)
    // 7. ابث حالة الإيقاف مرة واحدة (قبل تعليم العلم لمنع الكتم)
    this.setStatus(sessionId, 'تم إيقاف التنفيذ.', run)
    // 8. علّم run كملغى خارجيًا — يمنع finally وsetStatus من بث أحداث إضافية
    run.cancelledExternally = true
    run.outcome = 'cancelled'
    // 9. Q5: أوقف خادم المعاينة لهذه الجلسة إن وُجد — يمنع بقاء خادم يتيم خارج سيطرة الوكيل
    if (this.stopPreview) {
      try { void this.stopPreview(this.db.getSession(sessionId)).catch(() => {}) } catch { /* الجلسة قد تكون محذوفة */ }
    }
  }

  async waitForIdle(sessionId: string): Promise<void> {
    const run = this.runs.get(sessionId)
    if (!run) return
    if (run.initializing) {
      try { await run.ready } catch { /* initialization failure is already persisted by send */ }
    }
    const current = this.runs.get(sessionId)
    if (current?.promise) await current.promise
  }

  answerApproval(id: string, allowed: boolean, remember = false): void {
    const pending = this.approvals.get(id)
    if (!pending) throw new Error('طلب الموافقة منتهي أو غير موجود')
    this.approvals.delete(id)
    if (allowed && remember && pending.rememberKey) this.approvalGrantsFor(pending.sessionId).add(pending.rememberKey)
    this.db.addAudit({ sessionId: pending.sessionId, category: 'approval', action: id, detail: allowed ? remember && pending.rememberKey ? 'سمح المستخدم وحفظ القرار لبقية الجلسة' : 'سمح المستخدم' : 'رفض المستخدم', outcome: allowed ? 'allowed' : 'denied' }); pending.resolve(allowed)
  }

  async shutdown(closeMcp = true): Promise<void> {
    const runs = [...this.runs.values()]
    for (const run of runs) { for (const child of run.childProcesses) { try { child.kill() } catch {} }; run.controller.abort(); this.cancelApprovalsForRun(run, new DOMException('يتم إغلاق التطبيق', 'AbortError')) }
    await Promise.allSettled(runs.map((run) => run.promise).filter((promise): promise is Promise<void> => Boolean(promise)))
    if (closeMcp) await this.mcp.close()
    closeAllPersistentShells()
  }

  forgetSession(sessionId: string): void {
    this.approvalGrants.delete(sessionId)
    this.cancelApprovals(sessionId)
    closePersistentShell(sessionId)
    // Q8: تنظيف حالة المعاينة المخزنة مع الجلسة
    this.previewStates.delete(sessionId)
  }

  private async buildContext(session: ReturnType<AppDatabase['getSession']>, config: ReturnType<ProviderStore['get']>, definitions: ToolDefinition[], signal: AbortSignal, deadlineAt: number, runId: string, step: number, filesModifiedInPreviousStep?: boolean, lastInjectedContext?: string, subagentSection?: string): Promise<{ messages: ModelInput[]; maxOutputTokens: number; compacted: boolean; estimatedTokens: number; injectedContext?: string }> {
    const safetyTokens = Math.max(8_000, Math.floor(config.contextWindow * 0.05))
    const configuredOutput = Math.min(config.maxOutputTokens, Math.max(2_048, config.contextWindow - safetyTokens))
    const maxOutputTokens = buildOutputTokenBudget(configuredOutput, config.contextWindow, this.profile.adaptiveOutputBudget)
    const hardLimit = config.contextWindow - maxOutputTokens - safetyTokens
    let history = this.db.listStoredMessages(session.id)
    let summary = this.db.getSummary(session.id)
    let compacted = false
    const activeRun = this.runs.get(session.id)

    // ─── P3-01: كاش السياق الأساسي — تجنّب إعادة بناء الأجزاء الثابتة كل جولة ───
    // تُعاد قراءة AGENTS.md وخريطة المشروع والذاكرة فقط في أول جولة أو بعد تعديل
    // ملفات أو كل 7 جولات (لالتقاط تغييرات خارجية). هذا يلغي أغلب كلفة بناء السياق
    // ويزيد استفادة prompt caching لدى المزود (البادئة الثابتة أكبر وأطول عمرًا).
    const base = activeRun?.baseContext
    const shouldRebuildBase = !base || filesModifiedInPreviousStep || (step - base.builtAtStep) >= 7
    let instructions: string
    let commands: ProjectCommand[]
    let repoMapString: string
    let memoryContext: string

    if (shouldRebuildBase || !base) {
      instructions = await projectInstructions(session.workspace)
      commands = await loadProjectCommands(session.workspace)

      // بناء خريطة المشروع (Repo Map) — بـ timeout لتجنب البطء
      repoMapString = ''
      try {
        const indexer = getProjectIndexer(session.workspace)
        const index = await Promise.race([
          indexer.getIndex(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 500)),
        ])
        const focusFiles = extractPromptPaths([...history].reverse().find((message) => message.role === 'user')?.content ?? '')
        repoMapString = generateRepoMapString(index, focusFiles)
      } catch { /* fallback: لا خريطة */ }

      // ذاكرة طويلة المدى — تُستعلم دائمًا (شات أساسي وBuild) حتى يتذكر
      // الوكيل الأدوات المستعملة سابقًا ونتائجها وقرارات المشروع.
      memoryContext = ''
      try {
        const memoryQuery = buildMemoryQuery(history, activeRun?.recentErrors ?? [])
        memoryContext = this.getMemory(session.workspace).buildContextString(session.workspace, memoryQuery)
      } catch { /* fallback */ }

      if (activeRun) activeRun.baseContext = { repoMap: repoMapString, memoryContext, instructions, commands, builtAtStep: step }
    } else {
      instructions = base.instructions
      commands = base.commands
      repoMapString = base.repoMap
      memoryContext = base.memoryContext
    }

    let messages = makeContext(session, instructions, summary.text, history.filter((message) => message.sequence > summary.throughSequence), commands, repoMapString)
    // ─── Prompt caching order ───
    // Stable system content first (combined core prompt, long-term memory,
    // summary), one volatile dynamic block last, then history. cacheAnchor
    // marks the end of the stable prefix so the provider keeps it cache-warm
    // even when the dynamic block changes every round.
    if (memoryContext) messages.splice(1, 0, { role: 'system', content: memoryContext })
    let anchorIndex = 0
    for (let i = 0; i < messages.length && messages[i]!.role === 'system'; i++) anchorIndex = i
    messages[anchorIndex]!.cacheAnchor = true

    // ─── P2-03: Smart Context Injection ───────────────────────────
    // حقن git diff + ملفات معدلة + أخطاء سابقة تلقائيا
    // إذا لم تتغير الملفات وكان لدينا injectedContext سابق، أعد استخدامه
    let injectedContext: string | undefined
    try {
      if (!filesModifiedInPreviousStep && lastInjectedContext) {
        injectedContext = lastInjectedContext
      } else {
        // ─── تحسين: استخدم ملفات معدلة مجمّعة على ActiveRun بدل rescan كل التاريخ ───
        // activeRun.pendingEditedFiles يتم تجميعها بعد كل خطوة تعديل.
        // هذا يلغي O(history) scan في كل جولة ويصبح O(1).
        const modifiedFiles = activeRun?.pendingEditedFiles?.length ? [...new Set(activeRun.pendingEditedFiles)] : this.getEditedFilesFromMessages(history)
        const injected = await buildInjectedContext(session.workspace, modifiedFiles, activeRun?.recentErrors ?? [])
        if (injected) {
          injectedContext = injected
        }
      }
    } catch { /* non-blocking */ }

    // ─── Single volatile dynamic block ───
    // Task profile + workspace state + subagent roster + active todo, in one
    // system block appended at the end of the system array. Keeping all
    // per-round volatile content in one trailing block leaves everything
    // above it (the expensive prefix) stable and cache-readable.
    const dynamicTodos = this.db.getTodos(session.id)
    const dynamicTodo = dynamicTodos.find((todo) => todo.status === 'in_progress')
    const dynamicParts: string[] = []
    if (this.profile.dedicatedBuild) dynamicParts.push(buildTaskProfile(history))
    if (injectedContext) dynamicParts.push(injectedContext.trim())
    if (subagentSection) dynamicParts.push(subagentSection)
    dynamicParts.push(dynamicTodo
      ? `Current todo phase (todoId: ${dynamicTodo.id}): ${dynamicTodo.content}\nIts status: ${dynamicTodo.status}. todo_write updates are saved this round but only take effect from the next one. Do not change what the step number means.`
      : 'No active todo phase (todoId: null). todo_write updates only take effect from the next round. Do not change what the step number means.')
    const dynamicStart = messages.findIndex((m) => m.role !== 'system')
    messages.splice(dynamicStart === -1 ? messages.length : dynamicStart, 0, { role: 'system', content: dynamicParts.join('\n\n') })

    let estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens)

    if (estimatedTokens > hardLimit) {
      const turns = userTurns(history.filter((message) => message.sequence > summary.throughSequence))
      const candidates = turns.slice(0, Math.max(0, turns.length - 2))
      if (candidates.length) {
        // بناء المحتوى تدريجيًا مع تحديد cut بناءً على ما تم تضمينه فعلياً
        let content = ''
        let cut = 0
        for (const message of candidates.flat()) {
          const line = summaryLine(message)
          if (content.length + line.length > 100_000) break
          content += line + '\n'
          cut = message.sequence
        }
        if (cut) {
        try {
          // استخدام نموذج اقتصادي للضغط (بدلاً من النموذج الرئيسي)
          const router = this.getRouter(session.id, config.model)
          const compactRoute = router.route('compact', config.model)
          const compactConfig = { ...config, model: compactRoute.modelId, apiStyle: compactRoute.apiStyle, contextWindow: compactRoute.contextWindow }
          const compactReply = await this.modelRequest(compactConfig, [
            { role: 'system', content: 'لخص سجل وكيل برمجي بدقة ككائن JSON صالح بهذه المفاتيح حصرًا: goal, constraints, decisions, evidence, filesModified, verification, commands, openRisks, nextStep. استخدم نصًا للهدف والخطوة التالية ومصفوفات نصّية لبقية المفاتيح. **احفظ دائمًا**: مسارات الملفات كاملة (مثل src/file.ts:42)، أسماء الدوال والأصناف، أرقام الأسطر المرجعية، الأوامر المنفذة بنتائجها، ورسائل الأخطاء بحرفيتها. استبقِ الأدلة الواقعية والمسارات فقط، ولا تخترع معلومات. اكتب بالعربية.' },
            { role: 'user', content: `${summary.text ? `الملخص السابق:\n${summary.text}\n\n` : ''}السجل الجديد:\n${content}` }
          ], [], { signal, deadlineAt, concurrencyKey: `session:${session.id}`, timeoutMs: 60_000, retries: 0, maxOutputTokens: 4096 })
          const activeRun = this.runs.get(session.id)
          if (activeRun?.runId === runId) this.recordUsage(session.id, activeRun, compactConfig, compactReply.usage, estimateModelRequestTokens(compactConfig, [{ role: 'user', content }], [], 4096), 'compaction')
          if (compactReply.finishReason === 'stop' && compactReply.text.trim() && this.db.setSummaryAndArchive(session.id, compactReply.text, cut, summary.throughSequence)) {
            summary = { text: compactReply.text, throughSequence: cut }
            compacted = true
          }
        } catch (error) {
          if (signal.aborted) throw error
          this.db.addAudit({ sessionId: session.id, category: 'agent', action: 'context-compaction', detail: error instanceof Error ? error.message : String(error), outcome: 'failed' })
        }
        } // end if (cut)
        history = this.db.listStoredMessages(session.id)
        messages = makeContext(session, instructions, summary.text, history.filter((message) => message.sequence > summary.throughSequence), commands, repoMapString)
         estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens)
      }
    }

    // Auto-compact: ضغط تلقائي عند 80% من السياق (قبل الوصول للـ overflow)
    if (shouldAutoCompact(estimatedTokens, config.contextWindow, maxOutputTokens)) {
      // ─── Thrashing Detector: إيقاف عند الضغط المتكرر ────────────────
      const run = this.runs.get(session.id)
      if (run) {
        run.compressionCount++
         if (run.compressionCount >= 3) {
          throw new Error('تم ضغط السياق 3 مرات متتالية — قد تكون هناك مشكلة في بنية المحادثة. حاول إعادة صياغة طلبك.')
        }
      }
      compactContextMessages(messages, 2_000, 2)
      estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens)
      compacted = true
    }

    if (estimatedTokens > hardLimit) {
      compactContextMessages(messages, 800, 1)
      estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens)
    }

    if (estimatedTokens > hardLimit) throw new Error(`السياق تجاوز حد النموذج (${config.contextWindow.toLocaleString('en')} رمز). السجل الكامل محفوظ. ابدأ جلسة جديدة.`)
    return { messages, maxOutputTokens, compacted, estimatedTokens, injectedContext }
  }

  private approve(sessionId: string, run: ActiveRun, title: string, detail: string, critical: boolean, rememberKey?: string): Promise<boolean> {
    if (run.controller.signal.aborted) return Promise.reject(new DOMException('تم الإلغاء', 'AbortError'))
    if (this.profile.bypassApprovals) {
      this.db.addAudit({ sessionId, category: 'approval', action: title, detail: 'تم السماح تلقائيًا لشات Build ذي الصلاحيات الكاملة', outcome: 'allowed' })
      return Promise.resolve(true)
    }
    if (rememberKey && this.approvalGrantsFor(sessionId).has(rememberKey)) { this.db.addAudit({ sessionId, category: 'approval', action: title, detail: 'موافقة محفوظة لبقية الجلسة', outcome: 'allowed' }); return Promise.resolve(true) }
    const id = randomUUID()
    const request: ApprovalRequest = { id, sessionId, runId: run.runId, title, detail, risk: critical ? 'critical' : 'normal', canRemember: Boolean(rememberKey) }
    this.db.addAudit({ sessionId, category: 'approval', action: title, detail, outcome: 'started' })
    this.setStatus(sessionId, 'متوقف مؤقتًا بانتظار السماح أو الرفض منك.', run)
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = (): void => { settled = true; clearTimeout(timer); this.approvals.delete(id); run.controller.signal.removeEventListener('abort', onAbort) }
      const onAbort = (): void => { if (settled) return; cleanup(); reject(new DOMException('تم الإلغاء', 'AbortError')) }
      // موعد نهائي تلقائي: الموافقة تنتهي عند انتهاء وقت التشغيل
      const timer = setTimeout(() => {
        if (settled) return
        cleanup()
        this.db.addAudit({ sessionId, category: 'approval', action: title, detail: 'انتهت المهلة تلقائيًا', outcome: 'denied' })
        resolve(false) // رفض تلقائي عند انتهاء المهلة
      }, Math.max(1_000, run.deadlineAt - Date.now()))
      this.approvals.set(id, { sessionId, runId: run.runId, request, rememberKey, abort: () => { if (!settled) { cleanup(); reject(new DOMException('تم الإلغاء', 'AbortError')) } }, resolve: (v) => { if (!settled) { cleanup(); resolve(v) } }, reject: (e) => { if (!settled) { cleanup(); reject(e) } } })
      run.controller.signal.addEventListener('abort', onAbort, { once: true })
      this.sendApproval(request)
    })
  }

  private sendApproval(request: ApprovalRequest): void { const contents = this.getWebContents(); if (!contents || contents.isDestroyed()) return; try { contents.send(this.approvalChannel, request) } catch {} }
  private cancelApprovals(sessionId: string, runId?: string): void { for (const [id, pending] of this.approvals) if (pending.sessionId === sessionId && (!runId || pending.runId === runId)) { this.approvals.delete(id); pending.abort(); pending.reject(new DOMException('تم الإلغاء', 'AbortError')) } }
  private cancelApprovalsForRun(run: ActiveRun, error: Error): void { for (const [id, pending] of this.approvals) if (pending.runId === run.runId) { this.approvals.delete(id); pending.abort(); pending.reject(error) } }
  private hasApproval(sessionId: string, runId?: string): boolean { return [...this.approvals.values()].some((item) => item.sessionId === sessionId && (!runId || item.runId === runId)) }
  private approvalGrantsFor(sessionId: string): Set<string> { const grants = this.approvalGrants.get(sessionId) ?? new Set<string>(); this.approvalGrants.set(sessionId, grants); return grants }
  private drainPending(sessionId: string, run: ActiveRun): void { if (run.pendingMessages.length) run.followUpQueued = true; while (run.pendingMessages.length) { const message = run.pendingMessages.shift()!; this.db.addAudit({ sessionId, category: 'agent', action: 'inject', detail: message.content.slice(0, 1000), outcome: 'started' }) } }
  private recordUsage(sessionId: string, run: ActiveRun, config: ReturnType<ProviderStore['get']>, usage: ModelUsage | undefined, estimatedInputTokens: number, purpose: 'agent' | 'continuation' | 'compaction' | 'overflow-recovery' | 'subagent', messageId?: string): void { this.db.recordUsage({ sessionId, runId: run.runId, requestId: randomUUID(), messageId, purpose, model: config.model, apiStyle: config.apiStyle, usage, estimatedInputTokens }); const total = this.db.getUsageSummary(sessionId); this.emit({ sessionId, runId: run.runId, type: 'status', usage: { delta: usage ?? { input: estimatedInputTokens, output: 0, total: estimatedInputTokens }, estimated: !usage, total }, text: run.status });     if (usage && !run.costCapped) { const delta = calculateCost(config.model, usage); if (delta === undefined) { console.warn(`[cost] No price defined for model ${config.model} — cost tracking disabled for this request`) } else if (delta > 0) { run.accumulatedCostUsd += delta;
    // ─── P2-05: Progressive Cost Disclosure ─────────────────
     const costWarning = getCostWarning(run.accumulatedCostUsd, MAX_RUN_COST_USD, run.lastCostWarningPercent)
     if (costWarning) {
       run.lastCostWarningPercent = costWarning.percentUsed
      // تحديث status مع التحذير (بأقل تدخل — لا نوقف التنفيذ)
      this.setStatus(sessionId, costWarning.message, run)
    }
     if (run.accumulatedCostUsd > MAX_RUN_COST_USD) { run.costCapped = true; run.controller.abort(); this.db.addAudit({ sessionId, category: 'agent', action: 'cost-cap', detail: `تجاوز ${run.accumulatedCostUsd.toFixed(4)}$ حد ${MAX_RUN_COST_USD}$`, outcome: 'failed' }); throw new Error(`بلغ هذا التشغيل حد التكلفة القصوى (${MAX_RUN_COST_USD}$) وقد توقف. التكلفة المتراكمة الآن: ${run.accumulatedCostUsd.toFixed(2)}$. يمكنك المتابعة بإرسال رسالة جديدة في جلسة لاحقة أو رفع الحد عبر متغير البيئة R_CODE_MAX_RUN_COST_USD.`) } } } }
  private assertRunning(run: ActiveRun): void { if (run.controller.signal.aborted) throw new DOMException('تم الإلغاء', 'AbortError'); if (Date.now() >= run.deadlineAt) throw new DeadlineExceededError(`وصل الوكيل إلى الحد الزمني الأقصى وهو ${Math.round(this.profile.runtimeMs / 60_000)} دقيقة. استخدم استئناف لبدء ميزانية جديدة.`) }
  private setStatus(sessionId: string, status: string, run?: ActiveRun): void { const current = this.runs.get(sessionId); if (run && current !== run) return; if (current?.cancelledExternally) return; if (current) current.status = status; this.emit({ sessionId, runId: run?.runId ?? current?.runId, type: 'status', text: status }) }
  private recordStepTiming(sessionId: string, runId: string, step: number, model: string, timing: { discoveryMs: number; contextMs: number; modelMs: number; firstTokenMs?: number; toolMs: number; totalMs: number; tools: string[]; changedFiles: number; compactionReason?: string }): void { this.db.recordStepMetric({ sessionId, runId, step, model, ...timing }) }
  private emit(event: AgentEvent): void { const contents = this.getWebContents(); if (!contents || contents.isDestroyed()) return; try { if (event.message) { const { providerPayload: _, ...message } = event.message as StoredMessage; contents.send(this.channel, { ...event, message: { ...message, toolCalls: message.toolCalls?.map((call) => ({ ...call, input: projectToolInput(call.name, call.input) })) } }); return } if (event.tool) { contents.send(this.channel, { ...event, tool: { ...event.tool, input: projectToolInput(event.tool.name, event.tool.input) } }); return } contents.send(this.channel, event) } catch {} }

  /** استخراج الملفات المعدلة من tool calls في مصفوفة رسائل (يمكن تمريرها مسبقاً للتحميل) */
  private getEditedFilesFromMessages(messages: Message[]): string[] {
    const files = new Set<string>()
    for (const msg of messages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) for (const file of mutationReceiptPaths(tc.mutation)) files.add(file)
      }
    }
    return [...files]
  }

  /** استخراج الملفات المعدلة من الجلسة (غلاف للمتصلين خارج المسار الساخن) */
  private getEditedFiles(sessionId: string): string[] {
    const messages = this.db.listMessages(sessionId)
    return this.getEditedFilesFromMessages(messages)
  }

  // ─── Verification Cache ──────────────────────────────────────────────
  private verificationCache = new Map<string, { result: string; timestamp: number }>()
  private static readonly VERIFICATION_CACHE_TTL = 60_000 // 60 ثانية

  /** Auto-detect and run verification commands after file edits */
  private async runVerification(workspace: string, revision: number, signal: AbortSignal, editedFiles?: string[], deadlineAt?: number): Promise<string | null> {
    try {
      const results: string[] = []
      const verificationDeadline = Math.min(deadlineAt ?? Date.now() + 300_000, Date.now() + 300_000)

      // Detect verification commands from project structure
      const checks: Array<{ label: string; command: string; file: string }> = []

      // ─── JavaScript/TypeScript ───────────────────────────────────────
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'))
        if (pkg.scripts?.typecheck) checks.push({ label: 'typecheck', command: 'npm run typecheck', file: 'package.json' })
        else if (pkg.devDependencies?.typescript) checks.push({ label: 'typecheck', command: 'npx tsc --noEmit', file: 'package.json' })
        if (pkg.scripts?.lint) checks.push({ label: 'lint', command: 'npm run lint', file: 'package.json' })
        if (pkg.scripts?.test && !pkg.scripts?.test.includes('test:watch')) checks.push({ label: 'test', command: 'npm test', file: 'package.json' })
      } catch { /* no package.json */ }

      try { await fs.access(path.join(workspace, 'tsconfig.json')); if (!checks.some((c) => c.label === 'typecheck')) checks.push({ label: 'typecheck', command: 'npx tsc --noEmit', file: 'tsconfig.json' }) } catch { /* no tsconfig */ }

      // ─── Python ──────────────────────────────────────────────────────
      if (!checks.length) {
        try {
          await fs.access(path.join(workspace, 'pyproject.toml'))
          checks.push({ label: 'typecheck', command: 'python -m pyright', file: 'pyproject.toml' })
          checks.push({ label: 'test', command: 'python -m pytest --tb=short -q', file: 'pyproject.toml' })
        } catch { /* no pyproject.toml */ }
        try {
          await fs.access(path.join(workspace, 'setup.py'))
          if (!checks.length) checks.push({ label: 'test', command: 'python -m pytest --tb=short -q', file: 'setup.py' })
        } catch { /* no setup.py */ }
      }

      // ─── Rust ────────────────────────────────────────────────────────
      if (!checks.length) {
        try {
          await fs.access(path.join(workspace, 'Cargo.toml'))
          checks.push({ label: 'typecheck', command: 'cargo check', file: 'Cargo.toml' })
          checks.push({ label: 'test', command: 'cargo test', file: 'Cargo.toml' })
        } catch { /* no Cargo.toml */ }
      }

      if (!checks.length) return null

      // ─── مسار Build السريع: typecheck/lint فقط افتراضيًا ───
      // تشغيل suite الاختبارات كاملًا عند كل تسليم كان أكبر سبب لتوقفات الدقائق.
      // الاختبارات تعمل فقط إذا مُسّت ملفات اختبار فعلًا في هذه الجولة.
      let activeChecks = checks
      if (this.profile.dedicatedBuild) {
        const touchedTests = (editedFiles ?? []).some((file) => /\.(?:test|spec)\.[a-z]+$|\b__tests__\b/i.test(file))
        activeChecks = checks.filter((check) => check.label !== 'test' || touchedTests)
        if (!activeChecks.length) return null
      }

      const coordinator = await getWorkspaceCoordinator(workspace)
      const plan = activeChecks.slice(0, 3).map((check) => check.command).join('\u0000')
      const cacheKey = `${coordinator.key}\u0000${revision}\u0000${plan}`
      const cached = this.verificationCache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < AgentRunner.VERIFICATION_CACHE_TTL) return cached.result

      // Run checks sequentially with timeout — now up to 3 checks
      for (const check of activeChecks.slice(0, 3)) {
        if (signal.aborted) break
        try {
          const remaining = verificationDeadline - Date.now()
          if (remaining <= 0) { results.push(`⚠️ ${check.label}: انتهت مهلة التحقق المشتركة`); break }
          const result = await runPowerShell(check.command, workspace, workspace, signal, remaining)
          const status = result.exitCode === 0 ? '✅' : '❌'
          results.push(`${status} ${check.label}: ${result.output.slice(0, 1000).trim()}`)
        } catch (error) {
          results.push(`⚠️ ${check.label}: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`)
        }
      }

      const finalResult = results.length ? results.join('\n') : null
      // حفظ في الكاش (بسقف صغير — النتائج تختلف مع كل revision للمساحة)
      if (finalResult) {
        if (this.verificationCache.size >= 20) this.verificationCache.delete(this.verificationCache.keys().next().value!)
        this.verificationCache.set(cacheKey, { result: finalResult, timestamp: Date.now() })
      }
      return finalResult
    } catch { return null }
  }

  private async runSubagent(session: ReturnType<AppDatabase['getSession']>, config: ReturnType<ProviderStore['get']>, parentRun: ActiveRun, input: { prompt: string; description: string; subagentName?: string }, signal: AbortSignal): Promise<{ ok: boolean; summary: string; error?: string; steps: number }> {
    const sessionId = session.id
    const startedAt = Date.now()
    const deadlineAt = Math.min(parentRun.deadlineAt, startedAt + SUBAGENT_MAX_RUNTIME_MS)
    const subRunId = randomUUID()
    const allSubTools = toolDefinitions.filter((tool) => SUBAGENT_TOOL_NAMES.has(tool.function.name))

    // استخدام نموذج مخصص إذا حدد اسم وكيل، وإلا اقتصادي
	    let subagentSystem = subagentSystemPrompt(session, input.prompt)
	    let subagentModelConfig = (() => {
	      const router = this.getRouter(sessionId, config.model)
	      const subagentRoute = router.route('subagent', config.model)
	      return { ...config, model: subagentRoute.modelId, apiStyle: subagentRoute.apiStyle, contextWindow: subagentRoute.contextWindow }
	    })()
	    // الوكيل الافتراضي قراءة/بحث فقط (يفرض برومبته فعليًا بدل الاكتفاء بالنص).
	    // الوكلاء المخصصون تُضبط صلاحياتهم أدناه حسب allowedTools.
	    let subTools = input.subagentName ? allSubTools : allSubTools.filter((tool) => DEFAULT_SUBAGENT_TOOLS.has(tool.function.name))
	    if (input.subagentName) {
	      const custom = this.db.getSubagentByName(input.subagentName)
	      if (custom) {
	        // دمج البرومبت المخصص مع المهمة بدلاً من استبدالها بالكامل
	        if (custom.systemPrompt) {
	          subagentSystem = `${custom.systemPrompt}\n\n---\n\n## المهمة الحالية\n${input.prompt}\n\nمساحة العمل: ${session.workspace}\n\nقواعد:\n- افحص الملفات والبنية الفعلية قبل أي استنتاج.\n- استخدم المسارات النسبية إلى جذر مساحة العمل.\n- أعد خلاصة نهائية منظمة بنفس لغة المهمة.`
	        }
	        if (custom.model) {
	          subagentModelConfig = { ...subagentModelConfig, model: custom.model, apiStyle: GO_MODELS.find(m => m.id === custom.model)?.apiStyle ?? subagentModelConfig.apiStyle, contextWindow: GO_MODELS.find(m => m.id === custom.model)?.contextWindow ?? subagentModelConfig.contextWindow }
	        }
	        // تصفية الأدوات حسب ما يسمح به الوكيل
	        if (custom.allowedTools && custom.allowedTools !== 'all') {
	          const READ_TOOLS = new Set(['read_file', 'read_files', 'read_message', 'count_lines', 'list_directory', 'glob_files', 'search_files', 'search_symbols', 'get_file_info', 'tree', 'load_skill', 'web_fetch', 'web_search', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_show'])
	          const EDIT_TOOLS = new Set([...READ_TOOLS, 'write_file', 'edit_file', 'edit_file_undo', 'patch_file'])
	          const allowed = custom.allowedTools === 'read' ? READ_TOOLS : custom.allowedTools === 'edit' ? EDIT_TOOLS : SUBAGENT_TOOL_NAMES
	          subTools = allSubTools.filter((tool) => allowed.has(tool.function.name))
	        }
	      }
	    }
    const subagentConfig = subagentModelConfig
    const messages: ModelInput[] = [{ role: 'system', content: subagentSystem }]
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })

    const contextBudget = Math.floor(subagentConfig.contextWindow * 0.55)
    let steps = 0
    const emitSubagent = (state: SubagentEvent['state'], step: number, extra: { tool?: string; summary?: string; error?: string } = {}): void => {
      const event: SubagentEvent = { id: subRunId, runId: parentRun.runId, description: input.description || 'وكيل فرعي', state, step, ...extra }
      this.db.saveSubagentEvent(sessionId, parentRun.runId, event)
      this.emit({ sessionId, runId: parentRun.runId, type: 'subagent', subagent: event })
    }
    emitSubagent('running', 0)
    try {
      for (let step = 0; step < SUBAGENT_MAX_STEPS; step++) {
        steps = step + 1
        if (signal.aborted) throw new DOMException('أُلغي الوكيل الفرعي', 'AbortError')
        if (Date.now() >= deadlineAt) throw new Error('وصل الوكيل الفرعي إلى الحد الزمني المسموح')
        const isFinalStep = step === SUBAGENT_MAX_STEPS - 1
        this.setStatus(sessionId, input.description ? `${input.description} — جولة ${step + 1}...` : `وكيل فرعي — جولة ${step + 1}...`, parentRun)
        const reply = await this.modelRequest(subagentConfig, messages, isFinalStep ? [] : subTools, { signal: controller.signal, deadlineAt, concurrencyKey: `subagent:${sessionId}:${subRunId}`, timeoutMs: 300_000, retries: 1, maxOutputTokens: 8192 })
         if (reply.usage) this.recordUsage(sessionId, parentRun, subagentConfig, reply.usage, 0, 'subagent')
        if (!reply.toolCalls.length) {
          const summary = reply.text.trim()
          if (summary) { emitSubagent('completed', steps, { summary }); return { ok: true, summary, steps } }
          const forced = await this.requestSubagentSummary(subagentConfig, messages, sessionId, parentRun, subRunId, controller.signal, deadlineAt, emitSubagent, steps)
          if (forced.ok) return forced
           const error = 'انتهت محاولات استخراج الخلاصة دون نص'; emitSubagent('failed', steps, { error }); return { ok: false, summary: '', error, steps }
        }
        validateCallIds(reply.toolCalls)
        const validations = reply.toolCalls.map((call) => validateToolCall(call, subTools))
        messages.push({ role: 'assistant', content: reply.text, tool_calls: reply.toolCalls.map((call, index) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(validations[index]!.input) } })) })
        for (let index = 0; index < reply.toolCalls.length; index++) {
          const call = reply.toolCalls[index]!
          const validation = validations[index]!
          let output: string
          if (!validation.ok) {
            output = JSON.stringify({ ok: false, error: { code: 'INVALID_TOOL_INPUT', message: validation.error } }, null, 2)
          } else {
            try {
              emitSubagent('running', steps, { tool: call.name })
              const coordinator = await getWorkspaceCoordinator(session.workspace)
              const mutating = isToolMutating(call.name)
              const release = mutating ? await coordinator.acquireMutation(controller.signal) : undefined
              const receipts: Array<Omit<MutationReceipt, 'workspaceRevision'>> = []
              try {
                output = await executeTool(call.name, validation.input, {
                  session, signal: controller.signal, deadlineAt, maxOutputChars: 80_000,
                  mcp: this.mcp,
                  trackProcess: (child) => { parentRun.childProcesses.add(child); child.once('close', () => parentRun.childProcesses.delete(child)) },
                  approve: (title, detail, critical, rememberKey) => this.approve(sessionId, parentRun, title, detail, critical, rememberKey),
                  loadSkill: (name) => loadSkillFromWorkspace(session.workspace, name),
                  runSubagent: undefined,
                  indexer: getProjectIndexer(session.workspace),
                  memory: this.getMemory(session.workspace),
                  recordMutation: (receipt) => receipts.push(receipt),
                  tavilyApiKey: this.tavilyStore?.getKey() || undefined,
                })
                 if (mutating && toolOutputSucceeded(output) && receipts.length) {
                  const receipt: MutationReceipt = { ...mergeMutationReceipts(receipts), workspaceRevision: coordinator.advanceRevision() }
                  getProjectIndexer(session.workspace).invalidate(receipt)
                }
              } finally {
                release?.()
              }
            } catch (error) {
              output = JSON.stringify({ ok: false, error: { code: isAbortError(error) || signal.aborted || controller.signal.aborted ? 'ABORTED' : 'TOOL_ERROR', message: isAbortError(error) ? 'تم الإلغاء قبل اكتمال الأداة.' : error instanceof Error ? error.message : String(error) } }, null, 2)
            }
          }
          this.db.addAudit({ sessionId, category: 'tool', action: call.name, detail: `[وكيل فرعي] ${JSON.stringify(input.description ?? '').slice(0, 200)}`, outcome: toolOutputSucceeded(output) ? 'completed' : 'failed' })
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: boundToolOutput(output, 60_000) })
          this.setStatus(sessionId, input.description ? `${input.description} — ${call.name}` : `وكيل فرعي — ${call.name}`, parentRun)
        }
        const estimated = estimateModelRequestTokens(config, messages, subTools, 8192)
        if (estimated > contextBudget) compactSubagentMessages(messages)
      }
       const forced = await this.requestSubagentSummary(config, messages, sessionId, parentRun, subRunId, controller.signal, deadlineAt, emitSubagent, steps)
       if (!forced.ok) emitSubagent('failed', steps, { error: 'انتهت جولات الوكيل الفرعي دون خلاصة.' })
       return forced
    } catch (error) {
      // ─── عند الإلغاء: أرسل حدث فشل للواجهة قبل إعادة رمي الخطأ ───
      // بدون هذا، الواجهة لا تعرف أن الوكيل الفرعي توقف ويبقى شريط التحميل ظاهرًا.
      if (signal.aborted || controller.signal.aborted) {
        emitSubagent('failed', steps, { error: 'تم إلغاء الوكيل الفرعي' })
        return { ok: false, summary: '', error: 'تم إلغاء الوكيل الفرعي', steps }
      }
      emitSubagent('failed', steps, { error: error instanceof Error ? error.message : String(error) })
      return { ok: false, summary: '', error: error instanceof Error ? error.message : String(error), steps }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async requestSubagentSummary(config: ReturnType<ProviderStore['get']>, messages: ModelInput[], sessionId: string, parentRun: ActiveRun, subRunId: string, signal: AbortSignal, deadlineAt: number, emitSubagent: (state: SubagentEvent['state'], step: number, extra?: { tool?: string; summary?: string; error?: string }) => void, steps: number): Promise<{ ok: boolean; summary: string; steps: number }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new DOMException('أُلغي الوكيل الفرعي', 'AbortError')
      try {
        const instruction = attempt === 0 ? 'أعد الآن خلاصتك النهائية المنظمة بالعربية لكل ما وجدته، بالتفصيل وبأرقام الأسطر المرجعية. لا تستخدم أي أدوات.' : 'أعد الخلاصة النهائية الآن. ابدأ فورًا بكتابة النص دون أي مقدمات أو أدوات.'
        const reply = await this.modelRequest(config, [...messages, { role: 'user', content: instruction }], [], { signal, deadlineAt, concurrencyKey: `subagent:${sessionId}:${subRunId}`, timeoutMs: 120_000, retries: 0, maxOutputTokens: 8192 })
        if (reply.usage) this.recordUsage(sessionId, parentRun, config, reply.usage, 0, 'subagent')
        const summary = reply.text.trim()
        if (summary) { emitSubagent('completed', steps, { summary }); return { ok: true, summary, steps } }
      } catch (error) {
        if (signal.aborted) throw error
      }
    }
    return { ok: false, summary: '', steps }
  }

  private async runSubagentBatch(session: ReturnType<AppDatabase['getSession']>, config: ReturnType<ProviderStore['get']>, parentRun: ActiveRun, tasks: Array<{ prompt: string; description: string; subagentName?: string }>, signal: AbortSignal): Promise<Array<{ ok: boolean; description: string; summary: string; error?: string; steps: number }>> {
    const MAX_PARALLEL_SUBAGENTS = 3
    const limited = tasks.slice(0, MAX_PARALLEL_SUBAGENTS)
    const results = new Array<{ ok: boolean; description: string; summary: string; error?: string; steps: number }>(limited.length)
    const concurrency = Math.min(MAX_PARALLEL_SUBAGENTS, limited.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < limited.length) {
        const index = next++
        const task = limited[index]!
        try {
          const result = await this.runSubagent(session, config, parentRun, task, signal)
          results[index] = { ok: result.ok, description: task.description, summary: result.summary, error: result.error, steps: result.steps }
        } catch (error) {
          if (signal.aborted) throw error
          results[index] = { ok: false, description: task.description, summary: '', error: error instanceof Error ? error.message : String(error), steps: 0 }
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return results
  }
}

function mergeMutationReceipts(receipts: Array<Omit<MutationReceipt, 'workspaceRevision'>>): Omit<MutationReceipt, 'workspaceRevision'> {
  return { effects: receipts.flatMap((receipt) => receipt.effects), partial: receipts.some((receipt) => receipt.partial) || undefined }
}

function mutationReceiptPaths(receipt: MutationReceipt | undefined): string[] {
  return receipt?.effects.flatMap((effect) => effect.kind === 'move' ? [effect.from, effect.path] : [effect.path]).filter((item): item is string => Boolean(item)) ?? []
}

function receiptAffectsRuntime(receipt: MutationReceipt): boolean {
  return receipt.effects.some((effect) => {
    const file = effect.path.toLowerCase()
    return /(^|\/)(package\.json|vite\.config\.[^/]+|next\.config\.[^/]+|src\/.*\.(?:js|jsx|ts|tsx|css|html)|index\.html)$/.test(file)
  })
}

function makeContext(session: ReturnType<AppDatabase['getSession']>, instructions: string, summary: string, history: StoredMessage[], commands: ProjectCommand[] = [], repoMap?: string): ModelInput[] {
  // تحسين: دمج الرسائل الثابتة في رسالة system واحدة لتفعيل prompt caching
  // بدل رسالتين system منفصلتين، ندمج它们 في رسالة واحدة أكبر
  const combinedSystemContent = `${CORE_SYSTEM_PROMPT}\n\n${sessionContextBlock(session, instructions, commands, repoMap)}`
  const result: ModelInput[] = [
    { role: 'system', content: combinedSystemContent },
  ]
  if (summary) result.push({ role: 'system', content: `ذاكرة مضغوطة للتاريخ السابق:\n${summary}` })
  for (const message of history) result.push(toModelMessage(message))
  return result
}

// ─── Core System Prompt (stable, cache-friendly) ───────────────────────
const CORE_SYSTEM_PROMPT = `You are Code Agent, a world-class software engineer working locally on the user's Windows machine. You do not follow requests blindly — you understand the project, analyze it, and protect it from regressions.

# Language rule
Always reply in exactly the same language as the user's latest message (Arabic in → Arabic out, English in → English out). Code, identifiers, and file content follow the project's own conventions.

# Core working method
- Read files fully before editing them: read_file (up to 5000 lines) for one file, read_files for several files in a single call.
- Batch independent reads and searches into one turn — they execute in parallel.
- Explore structure first (tree / glob_files / list_directory). Never guess file names — discover them.
- Edit with the smallest safe scope: edit_file with a precise, unique old_string; patch_file for several ranges in one file; edit_files_bulk for 2+ ready, independent edits across different files.
- Tool inputs must be complete before calling: write_file and append_file require the full actual content in the same call. Never promise content "later".
- Verify your changes: run typecheck/lint/tests when available and fix reported errors yourself. One verification pass after all edits beats one per file.
- Prefer shell over run_powershell for consecutive commands — it keeps cwd and environment between calls.
- Search with glob_files / search_files / search_symbols instead of browsing randomly.
- Large projects: build a map first (tree + repo map), then delegate independent parts to task / task_parallel subagents and integrate their summaries yourself.
- For fresh or precise information use web_research (searches, opens the best pages, returns clean text); fallback: web_search then web_fetch. Search technical topics in English too.
- Plan with todo_write for tasks of 3+ steps.
- Use analyze_file / find_references / dependency_graph for deep understanding before refactors or signature changes.
- Persist important decisions, conventions, and error fixes with remember_project; retrieve them with recall_project.
- Read PDF files with read_pdf.

# Discipline
- Use paths relative to the workspace root; never scan parent directories or drive roots.
- If a tool fails: read the full error, fix the input once — never repeat the exact same failing call.
- If a file is not found: verify the path or use glob_files; do not retry blindly.
- Never claim work you did not perform. Never reveal secrets.
- search_files accepts either a file or a directory in path.
- End with a clear summary of what you changed and what you verified.

Current date: ${new Date().toISOString().slice(0, 10)}`

// ─── Session Context (per-session, appended after the stable core) ─────
function sessionContextBlock(session: ReturnType<AppDatabase['getSession']>, instructions: string, commands: ProjectCommand[] = [], repoMap?: string): string {
  const modeText = session.agentMode === 'build' ? 'Build — execute the task with tools until it is complete' : 'Plan — analyze and read only; make no modifications'
  const permText = session.permissionMode === 'full'
    ? 'Full access — skips approval popups only; sandbox, path and command checks still apply'
    : 'Ask mode — mutating and sensitive operations require user approval'
  const permRule = session.permissionMode === 'full'
    ? 'Run allowed tools without asking for approval; never bypass the sandbox or the path/command checks.'
    : 'Ask for approval before every mutating or sensitive operation.'

  const parts: string[] = [
    `Workspace: ${session.workspace}`,
    `Mode: ${modeText}`,
    `Permission: ${permText}`,
    `Permission rule: ${permRule}`,
  ]

  if (repoMap) parts.push(`\n## Project map\n${repoMap}`)

  parts.push(`\n# Detailed operating rules
- Use paths relative to the workspace root. Do not scan the parent directory or drive roots.
- Do not claim work you did not do. Do not reveal secrets.
- When a tool fails: analyze the error and correct the input once. Never repeat the same failing approach.
- Automatic verification is enabled: after your edits the system runs typecheck/lint/test automatically. If it fails, fix the reported errors.
- Explore the project structure first (tree / list_directory / glob_files) before reading or editing specific files. Never assume file names — discover them.
- If a tool fails with "file not found", do not retry the same call — verify the path or use glob_files to locate the right file.`)

  if (session.gitTracked) {
    parts.push('- Automatic Git tracking is enabled: every edit is saved as an auto commit. Use git_revert / git_revert_step to roll back.')
  }

  if (commands.length) {
    const cmds = commands.map((c) => `- /${c.name}${c.description ? `: ${c.description}` : ''}`).join('\n')
    parts.push(`\n## Known commands\n${cmds}`)
  }

  if (session.systemPrompt) {
    parts.push(`\n## User custom instructions\n${session.systemPrompt}`)
  }

  if (instructions) {
    parts.push(`\n## Project instructions\n${instructions}`)
  }

  return parts.join('\n')
}

function subagentSystemPrompt(session: ReturnType<AppDatabase['getSession']>, task: string): string {
  return `You are an independent specialist subagent of Code Agent, running in a context fully isolated from the main conversation. You are responsible for a precise, evidence-based summary that decisions will rely on.

Your task (execute it exactly and literally — you own the quality of the result):
${task}

Workspace: ${session.workspace}

Language: write your final summary in the same language the task is written in.

Rules:
- You are an analysis/research agent only: read, search, read-only Git and web tools are allowed. Do not modify any file, run terminal commands, write to Git, call MCP tools, or use todos.
- Inspect the actual files and structure before any conclusion. Never guess or claim what you have not read; state explicitly what you did not find.
- Use paths relative to the workspace root, batch independent reads/searches into one tool call, and follow read_files cursors until complete=true when needed.
- Stop reading as soon as you have what you need: on the first turn that requires no new tools, produce the final summary immediately. Never re-read the same large file.

When done, return one structured final summary that the supervisor can fully rely on:
- Precise answers to the task questions, with evidence (file path and line numbers when possible).
- The structure and relationships between the files you discovered.
- Any risks or parts you did not inspect.
Do not paste file contents; be focused, complete and precise.`
}

async function projectInstructions(workspace: string): Promise<string> {  for (const name of ['AGENTS.md', 'CLAUDE.md']) { try { const target = path.join(workspace, name); const stat = await fs.stat(target); const cached = projectInstructionsCache.get(target); if (cached?.modifiedAt === stat.mtimeMs) return cached.content; let content = await fs.readFile(target, 'utf8'); if (content.length > 40_000) content = `${content.slice(0, 40_000)}\n\n[مقصوص: تجاوز ملف التعليمات 40,000 حرف، عُرضت البداية فقط]`; projectInstructionsCache.set(target, { modifiedAt: stat.mtimeMs, content }); return content } catch {} }
  return ''
}

const SKILL_DIRS = ['.skills', '.opencode/skills', 'skills', '.claude/skills']
const skillCache = new LruCache<string, { name: string; description: string; content: string }>(50)

interface ProjectCommand { name: string; description?: string; template: string; agent?: string; model?: string; subtask?: boolean }
const commandCache = new LruCache<string, { modifiedAt: number; commands: ProjectCommand[] }>(50)

async function loadProjectCommands(workspace: string): Promise<ProjectCommand[]> {
  const target = path.join(workspace, 'commands.json')
  try {
    const stat = await fs.stat(target)
    const cached = commandCache.get(target)
    if (cached?.modifiedAt === stat.mtimeMs) return cached.commands
    const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as { command?: Record<string, { description?: string; template: string; agent?: string; model?: string; subtask?: boolean }> }
    const commands = Object.entries(parsed?.command ?? {}).filter(([, value]) => value && typeof value.template === 'string').map(([name, value]) => ({ name, description: value?.description, template: value.template, agent: value?.agent, model: value?.model, subtask: value?.subtask }))
    commandCache.set(target, { modifiedAt: stat.mtimeMs, commands })
    return commands
  } catch { return [] }
}

function renderCommandTemplate(template: string, argumentsText: string): string {
  const args = argumentsText.trim()
  return template.replace(/\$ARGUMENTS/g, args).replace(/\$1/g, args)
}

async function loadSkillFromWorkspace(workspace: string, name: string): Promise<{ name: string; description: string; content: string } | undefined> {
  const safeName = name.replace(/[\\/]/g, '')
  if (!safeName || safeName === '..' || safeName === '.') return undefined
  const cacheKey = `${workspace}:${safeName}`
  const cached = skillCache.get(cacheKey)
  if (cached) return cached
  const canonicalWorkspace = path.resolve(workspace).toLowerCase()
  for (const dir of SKILL_DIRS) {
    const base = path.join(workspace, dir)
    for (const candidate of [path.join(base, safeName), path.join(base, safeName, 'SKILL.md')]) {
      try {
        // فحص realpath لمنع symlink traversal
        const real = await fs.realpath(candidate)
        if (!real.toLowerCase().startsWith(canonicalWorkspace)) continue
        const stat = await fs.stat(candidate)
        if (!stat.isFile()) continue
        let content = await fs.readFile(candidate, 'utf8')
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
        let description = ''
        if (frontmatter) {
          const desc = /description\s*:\s*(?:"([^"]*)"|'([^']*)'|>?\s*([^\n]+))/.exec(frontmatter[1] ?? '')
          if (desc) description = (desc[1] ?? desc[2] ?? desc[3] ?? '').trim()
          content = content.slice(frontmatter[0].length)
        }
        const skill = { name: safeName, description: description.slice(0, 500), content: content.trim() }
        skillCache.set(cacheKey, skill)
        return skill
      } catch { /* continue */ }
    }
  }
  return undefined
}

function toModelMessage(message: StoredMessage): ModelInput {
  if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId, name: message.toolName, messageId: message.id }
  const attachments = message.attachments
  let content: string | Array<Record<string, unknown>> = message.content
  if (attachments?.length) {
    const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: message.content }]
    for (const attachment of attachments) {
      if (attachment.mimeType.startsWith('image/')) blocks.push({ type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data } })
      else if (attachment.mimeType.startsWith('video/')) blocks.push({ type: 'video', source: { type: 'base64', media_type: attachment.mimeType, data: attachment.data } })
      else if (isTextAttachment(attachment.mimeType)) blocks.push({ type: 'text', text: `محتوى المرفق ${attachment.name}:\n${decodeAttachmentText(attachment.data, attachment.size)}` })
    }
    content = blocks
  }
  // سياق النموذج يجب أن يحتفظ ببنية الاستدعاء الحقيقية. contentReceipt مخصص للواجهة
  // والتدقيق فقط؛ إرساله كتاريخ أداة يجعل النموذج يقلده كأنه مدخل صالح.
  const toolCalls = message.toolCalls?.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.input) } }))
  return { role: message.role as 'user' | 'assistant' | 'system', content, providerPayload: modelProviderPayload(message.providerPayload, new Set(toolCalls?.map((call) => call.id) ?? [])), tool_calls: toolCalls }
}

function isTextAttachment(mimeType: string): boolean { return mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mimeType) }
function decodeAttachmentText(data: string, size: number): string { try { return Buffer.from(data, 'base64').subarray(0, Math.min(size, 500_000)).toString('utf8') } catch { return '[تعذر قراءة محتوى المرفق]' } }

async function prepareAttachments(attachments?: Attachment[]): Promise<Attachment[] | undefined> {
  if (!attachments?.length) return attachments
  const prepared: Attachment[] = []
  for (const attachment of attachments) {
    if (attachment.mimeType !== 'application/pdf') { prepared.push(attachment); continue }
    const buffer = Buffer.from(attachment.data, 'base64')
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error(`المرفق ${attachment.name} ليس ملف PDF صالحا.`)
    if (buffer.byteLength > 25_000_000) throw new Error(`ملف PDF ${attachment.name} أكبر من الحد الآمن (25 MB).`)
    const pdfParse = (await import('pdf-parse')).default
    const parsed = await pdfParse(buffer)
    const artifact = `PDF: ${attachment.name}\nPages: ${parsed.numpages}\n\n${parsed.text.slice(0, 500_000)}`
    prepared.push({ ...attachment, name: `${attachment.name}.txt`, mimeType: 'text/plain', data: Buffer.from(artifact, 'utf8').toString('base64'), size: Buffer.byteLength(artifact) })
  }
  return prepared
}

function validateCallIds(calls: ModelToolCall[]): void { const ids = new Set<string>(); for (const call of calls) { if (!call.id || !call.name) throw new Error('أعاد المزود استدعاء أداة بلا id أو name'); if (ids.has(call.id)) throw new Error(`كرر المزود tool call id: ${call.id}`); ids.add(call.id) } }

// ─── Error Classification ──────────────────────────────────────────────
enum ErrorCategory { Syntax = 'syntax', Runtime = 'runtime', Permission = 'permission', Logic = 'logic', Network = 'network', Unknown = 'unknown' }

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && (error.name === 'AbortError' || /(?:cancel|abort|إلغاء|أُلغي)/i.test(error.message))
}

/** خطأ شبكة عابر يستحق استئنافًا بدل فشل نهائي (مهلة مزود/انقطاع اتصال/DNS) */
function isResumableNetworkError(error: unknown): boolean {
  if (error instanceof ProviderTimeoutError || error instanceof TypeError) return true
  const message = error instanceof Error ? error.message : String(error)
  return /(?:terminated|socket hang up|connection.*closed|other side closed|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|انقطع اتصال المزود قبل اكتمال الرد)/i.test(message)
}

function classifyError(errorMessage: string): ErrorCategory {
  const lower = errorMessage.toLowerCase()
  if (lower.includes('syntax') || lower.includes('parse') || lower.includes('unexpected token') || lower.includes('invalid json')) return ErrorCategory.Syntax
  if (lower.includes('permission') || lower.includes('access denied') || lower.includes('eacces') || lower.includes('eperm') || lower.includes('plan_mode') || lower.includes('approval')) return ErrorCategory.Permission
  if (lower.includes('timeout') || lower.includes('enotfound') || lower.includes('econnrefused') || lower.includes('network') || lower.includes('fetch')) return ErrorCategory.Network
  if (lower.includes('enoent') || lower.includes('type') || lower.includes('reference') || lower.includes('undefined') || lower.includes('cannot find') || lower.includes('is not a function')) return ErrorCategory.Runtime
  return ErrorCategory.Logic
}

// ─── Recovery Nudges ───────────────────────────────────────────────────
function recoveryNudge(category: ErrorCategory, toolName: string, attemptCount: number): string {
  const base = `\n[تنبيه: الأداة ${toolName} فشلت ${attemptCount} مرة متتالية]`
  switch (category) {
    case ErrorCategory.Syntax: return `${base} — لا تحاول نفس التعديل. أعد قراءة الملف بالكامل واكتب التعديل من الصفر.`
    case ErrorCategory.Permission: return `${base} — لا يمكنك تنفيذ هذا الإجراء. اطلب إذن المستخدم أو غيّر الطريقة.`
    case ErrorCategory.Network: return `${base} — لا تعاود المحاولة الآن. أكمل بالمهام الأخرى أو اطلب من المستخدم التحقق من الاتصال.`
    case ErrorCategory.Runtime: return `${base} — تحقق من المسارات والنوعيات. اقرأ الملف المطلوب أولاً قبل التعديل.`
    case ErrorCategory.Logic: return `${base} — جرب طريقة مختلفة تمامًا. لا تكرر نفس الاستدعاء.`
    case ErrorCategory.Unknown: return `${base} — جرّب أسلوبًا مختلفًا تمامًا.`
  }
}

// ─── Step Signature (improved) ────────────────────────────────────────
function createStepSignature(calls: ModelToolCall[], validations: Array<{ ok: boolean; input: Record<string, unknown> }>, outputs?: string[]): string {
  return JSON.stringify(calls.map((call, index) => ({
    name: call.name,
    input: validations[index]?.input ?? {},
    // hash مختصر للـ output للكشف عن التكرار حتى مع مدخلات مختلفة
    outputHash: outputs?.[index] ? simpleHash(outputs[index]!.slice(0, 500)) : undefined
  })))
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash.toString(36)
}

interface ToolInputSchema {
  type?: string
  properties?: Record<string, ToolInputSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: ToolInputSchema
  anyOf?: ToolInputSchema[]
  enum?: unknown[]
  minimum?: number
  maximum?: number
  minLength?: number
  minItems?: number
  maxItems?: number
}

function validateToolCall(call: ModelToolCall, definitions: ToolDefinition[] = toolDefinitions): { ok: true; input: Record<string, unknown> } | { ok: false; input: Record<string, unknown>; error: string } {
  const definition = definitions.find((item) => item.function.name === call.name)
  if (!definition) return { ok: false, input: {}, error: `الأداة غير معروفة: ${call.name}` }
  let input: Record<string, unknown>
  try { const parsed = JSON.parse(call.arguments); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('يجب أن تكون المدخلات object'); input = parsed as Record<string, unknown> } catch (error) { return { ok: false, input: {}, error: `JSON غير صالح: ${error instanceof Error ? error.message : String(error)}` } }
  const schema = definition.function.parameters as ToolInputSchema
  normalizeSchemaInput(schema, input)
  const error = validateSchemaValue(schema, input, '')
  if (error) return { ok: false, input, error }
  return { ok: true, input }
}

function validateSchemaValue(schema: ToolInputSchema, value: unknown, path: string): string | undefined {
  if (schema.anyOf?.length) {
    if (schema.anyOf.some((candidate) => !validateSchemaValue(candidate, structuredClone(value), path))) return undefined
    return `نوع الحقل ${path || 'المدخل'} غير صحيح`
  }
  const label = path || 'المدخل'
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `نوع الحقل ${label} غير صحيح؛ المتوقع object`
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in record)) return `الحقل المطلوب مفقود: ${path ? `${path}.${key}` : key}`
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!schema.properties?.[key]) delete record[key]
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!(key in record)) continue
      if (child.type === 'array' && !Array.isArray(record[key])) {
        const parsed = parseArrayLike(record[key])
        if (parsed !== undefined) record[key] = parsed
      }
      if (child.type === 'boolean' && typeof record[key] === 'string' && /^(?:true|false)$/i.test(record[key])) record[key] = record[key].toLowerCase() === 'true'
      if ((child.type === 'number' || child.type === 'integer') && typeof record[key] === 'string' && /^-?\d+(?:\.\d+)?$/.test(record[key])) record[key] = Number(record[key])
      const error = validateSchemaValue(child, record[key], path ? `${path}.${key}` : key)
      if (error) return error
    }
    return undefined
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `نوع الحقل ${label} غير صحيح؛ المتوقع array`
    if (schema.minItems !== undefined && value.length < schema.minItems) return `الحقل ${label} يتطلب ${schema.minItems} عنصرًا على الأقل`
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `الحقل ${label} يقبل ${schema.maxItems} عنصرًا كحد أقصى`
    for (let index = 0; index < value.length; index++) { const error = validateSchemaValue(schema.items ?? {}, value[index], `${label}[${index}]`); if (error) return error }
    return undefined
  }
  if (schema.type === 'string' && typeof value !== 'string') return `نوع الحقل ${label} غير صحيح؛ المتوقع string`
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `نوع الحقل ${label} غير صحيح؛ المتوقع boolean`
  if ((schema.type === 'number' || schema.type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value))) return `نوع الحقل ${label} غير صحيح؛ المتوقع ${schema.type}`
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) return `الحقل ${label} لا يمكن أن يكون فارغًا`
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return `قيمة الحقل ${label} خارج النطاق`
  if (schema.enum && !schema.enum.includes(value)) return `قيمة الحقل ${label} غير صالحة؛ المتاح: ${schema.enum.join(', ')}`
  return undefined
}

function normalizeSchemaInput(schema: ToolInputSchema, value: unknown): void {
  if (schema.anyOf?.length) { for (const candidate of schema.anyOf) normalizeSchemaInput(candidate, value); return }
  if (schema.type === 'array' && Array.isArray(value)) { for (const item of value) normalizeSchemaInput(schema.items ?? {}, item); return }
  if (schema.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  const properties = schema.properties ?? {}
  for (const key of Object.keys(record)) {
    if (properties[key]) continue
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    if (snake !== key && properties[snake] && !(snake in record)) { record[snake] = record[key]; delete record[key] }
  }
  for (const [key, child] of Object.entries(properties)) if (key in record) normalizeSchemaInput(child, record[key])
}

function parseArrayLike(value: unknown): unknown[] | undefined {
  if (value && typeof value === 'object') return [value]
  if (typeof value !== 'string') return undefined
  try {
    let parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'string') try { parsed = JSON.parse(parsed) } catch {}
    return Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : undefined
  } catch { return undefined }
}

function parseToolOutput(output: string): { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } } | undefined {
  try {
    const parsed = JSON.parse(output)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } } : undefined
  } catch { return undefined }
}

function toolOutputSucceeded(output: string): boolean {
  return parseToolOutput(output)?.ok === true
}

function toolOutputErrorCode(output: string): string | undefined {
  const parsed = parseToolOutput(output)
  if (parsed?.ok !== false) return undefined
  return typeof parsed.error?.code === 'string' ? parsed.error.code : 'TOOL_REPORTED_FAILURE'
}

function boundToolOutput(output: string, limit: number): string {
  if (output.length <= limit) return output
  const parsed = parseToolOutput(output)
  if (!parsed) return JSON.stringify({ ok: false, error: { code: 'INVALID_TOOL_OUTPUT', message: 'أعادت الأداة خرجًا غير صالح وتجاوز حد التخزين.', originalChars: output.length } }, null, 2)
  if (parsed.ok === false) {
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : 'TOOL_REPORTED_FAILURE'
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : 'أبلغت الأداة عن فشل دون رسالة.'
    return JSON.stringify({ ok: false, error: { code, message: message.slice(0, Math.max(1_000, limit - 500)), truncated: message.length > limit - 500 } }, null, 2)
  }
  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data as Record<string, unknown> : {}
  const metadata = Object.fromEntries(Object.entries(data).filter(([key, value]) => !['content', 'output', 'text', 'diff', 'lines', 'files', 'entries', 'matches', 'symbols', 'results'].includes(key) && (value === null || ['string', 'number', 'boolean'].includes(typeof value))))
  return JSON.stringify({ ok: true, data: { ...metadata, truncated: true, originalChars: output.length, preview: output.slice(0, Math.max(1_000, limit - 1_000)), note: 'تم اقتصار خرج الأداة في سياق المحادثة؛ أعد استدعاء أداة القراءة بنطاق أضيق عند الحاجة.' } }, null, 2)
}

function userTurns(messages: StoredMessage[]): StoredMessage[][] { const turns: StoredMessage[][] = []; for (const message of messages) { if (message.role === 'user' || !turns.length) turns.push([]); turns.at(-1)!.push(message) } return turns }
function summaryLine(message: StoredMessage): string { const tools = message.toolCalls?.map((call) => `${call.name}(${toolInputSummary(call.name, call.input)}): ${call.output?.slice(0, 1500) ?? call.status}`).join('\n') ?? ''; return `[seq ${message.sequence}] ${message.role}: ${message.content.slice(0, 4000)}${tools ? `\n${tools}` : ''}` }
// ─── Enhanced Compaction Pipeline ──────────────────────────────────────

/** ضغط نتيجة أداة مع استخراج metadata غني */
function compactToolResult(message: ModelInput, previewChars: number): string {
  const contentStr = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  let metadata: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(contentStr)
    const data = parsed?.data
    metadata = {
      ok: parsed?.ok,
      path: data?.path,
      totalLines: data?.totalLines,
      range: data?.range,
      count: data?.count,
      truncated: data?.truncated,
      bytes: data?.bytes,
      // metadata إضافي حسب نوع الأداة
      ...(data?.diff && { diffLines: String(data.diff).split('\n').length }),
      ...(data?.symbols && { symbolsCount: Array.isArray(data.symbols) ? data.symbols.length : undefined }),
      ...(data?.files && { filesCount: Array.isArray(data.files) ? data.files.length : undefined }),
      ...(data?.url && { url: data.url }),
      ...(data?.exitCode !== undefined && { exitCode: data.exitCode }),
    }
  } catch {}
  const retrieveHint = message.messageId ? `\n[استرجع النص الكامل عبر read_message بمعرّف ${message.messageId}]` : ''
  const metaStr = Object.keys(metadata).length ? JSON.stringify(metadata) + '\n' : ''
  return `${metaStr}${contentStr.slice(0, previewChars)}\n[تم ضغط هذه النتيجة؛ أعد قراءة الملف عند الحاجة.]${retrieveHint}`
}

/** Microcompact: حذف الرسائل القديمة غير المؤثرة */
function microcompact(messages: ModelInput[]): void {
  // حذف system messages المتكررة (المحفوظة مسبقاً في السياق)
  // تحسين: مقارنة المحتوى الكامل بدلاً من أول 200 حرف لمنع حذف رسائل مختلفة بالخطأ
  const seenSystemContent = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === 'system') {
      const content = typeof msg.content === 'string' ? msg.content : ''
      if (seenSystemContent.has(content)) {
        messages.splice(i, 1) // حذف system message مكرر
      } else {
        seenSystemContent.add(content)
      }
    }
  }
}

/** Auto-compact: ضغط تلقائي عند 80% من السياق */
function shouldAutoCompact(estimatedTokens: number, contextWindow: number, maxOutputTokens: number): boolean {
  const usedRatio = estimatedTokens / (contextWindow - maxOutputTokens)
  return usedRatio > 0.8
}

function compactContextMessages(messages: ModelInput[], previewChars: number, keepUserTurns: number): void {
  // أولاً: microcompact لحذف الرسائل المتكررة
  microcompact(messages)

  const userIndexes = messages.flatMap((message, index) => message.role === 'user' ? [index] : [])
  const keepFrom = userIndexes[Math.max(0, userIndexes.length - keepUserTurns)] ?? messages.length
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (index >= keepFrom || message.role === 'system') continue
    if (message.role === 'tool') {
      message.content = compactToolResult(message, previewChars)
      continue
    }
    if (typeof message.content === 'string') {
      if (message.content.length > previewChars) message.content = `${message.content.slice(0, previewChars)}\n[تم ضغط الرسالة القديمة؛ أعد قراءة الملفات عند الحاجة.]`
    } else {
      message.content = message.content.filter((block) => block.type === 'text').map((block) => ({ type: 'text', text: String(block.text ?? '').slice(0, previewChars) }))
    }
  }
}

function compactSubagentMessages(messages: ModelInput[]): void {
  const keptToolMessages = 2
  let toolCount = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === 'tool') {
      toolCount++
      if (toolCount > keptToolMessages && typeof message.content === 'string' && message.content.length > 2_000) {
        message.content = compactToolResult(message, 500)
      }
    }
  }
}

/**
 * ضغط ذكي لسياق الاستمرار (Continuation):
 * - يحتفظ بجميع الرسائل system (التعليمات الأساسية)
 * - يحتفظ بآخر 3 تبادلات user/assistant كاملة
 * - يضغط الرسائل القديمة مع الحفاظ على القرارات الرئيسية ونتائج الأدوات المهمة
 * - لا يحذف أي معلومة بالكامل بل يلخصها
 */
export function smartCompressForContinuation(messages: ModelInput[], targetTokens: number): ModelInput[] {
  const result: ModelInput[] = []

  // 1. احتفظ بجميع الرسائل system (التعليمات والمعلومات الأساسية)
  const systemMessages: ModelInput[] = []
  const nonSystemMessages: ModelInput[] = []
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push(msg)
    } else {
      nonSystemMessages.push(msg)
    }
  }
  result.push(...systemMessages)

  // 2. حدد عدد التبادلات الأخيرة بناءً على الحجم المستهدف
  //    كلما كان المحتوى أكبر مقارنة بالهدف، قلل التبادلات المحتفظ بها
  const estimatedInput = JSON.stringify(messages).length / 2.5
  const keepExchanges = estimatedInput > targetTokens * 1.5 ? 2 : estimatedInput > targetTokens ? 3 : 4
  const keepCount = keepExchanges * 2 // user + assistant لكل تبادل
  const lastExchanges = nonSystemMessages.slice(-keepCount)
  const olderMessages = nonSystemMessages.slice(0, -keepCount)

  // 3. اضغط الرسائل القديمة: احتفظ بالملخصات ونتائج الأدوات المهمة
  for (const msg of olderMessages) {
    if (msg.role === 'tool') {
      // لنتائج الأدوات: احتفظ بالنتيجة المختصرة مع الحفاظ على المعلومة
      if (typeof msg.content === 'string') {
        if (msg.content.length > 1000) {
          // استخراج المعلومات المهمة من نتائج الأدوات
          const compressed = compressToolResultSmart(msg.content)
          result.push({ ...msg, content: compressed })
        } else {
          result.push(msg)
        }
      } else {
        result.push(msg)
      }
    } else if (msg.role === 'assistant') {
      // لرسائل المساعد: احتفظ بالنص والقرارات الرئيسية
      if (typeof msg.content === 'string' && msg.content.length > 1500) {
        const compressed = compressAssistantMessageSmart(msg.content)
        result.push({ ...msg, content: compressed })
      } else {
        result.push(msg)
      }
    } else if (msg.role === 'user') {
      // لرسائل المستخدم: احتفظ بالأوامر الرئيسية فقط
      if (typeof msg.content === 'string' && msg.content.length > 500) {
        result.push({ ...msg, content: msg.content.slice(0, 500) + '\n[تم ضغط الرسالة القديمة]' })
      } else {
        result.push(msg)
      }
    } else {
      result.push(msg)
    }
  }

  // 4. أضف آخر التبادلات كاملة (مهمة للحفاظ على السياق الأخير)
  result.push(...lastExchanges)

  return result
}

/**
 * ضغط ذكي لنتيجة الأداة: يحتفظ بالأسماء والمسارات والأرقام المرجعية
 * (مستوحى من Aider — حفظ identifiers بدل المحتوى الكامل)
 */
function compressToolResultSmart(content: string): string {
  const lines = content.split('\n')
  const importantLines: string[] = []
  // استخراج identifiers محفوظة دائمًا: مسارات الملفات وأرقام الأسطر
  const identifiers: string[] = []

  for (const line of lines) {
    // الأسطر المهمة دائمًا: أخطاء، نجاح، تحذيرات
    if (line.includes('❌') || line.includes('✅') || line.includes('⚠️') || line.includes('error') || line.includes('Error')) {
      importantLines.push(line)
      continue
    }

    // استخراج مسارات الملفات وأرقام الأسطر (identifiers) — محفوظة دائمًا
    const fileMatches = line.matchAll(/([\w@.-]+(?:[\\/][\w@.-]+)+\.(?:ts|tsx|js|jsx|json|css|html|md|py|rs|go|java)):(\d+)/g)
    for (const m of fileMatches) {
      const id = `${m[1]}:${m[2]}`
      if (!identifiers.includes(id)) identifiers.push(id)
    }
    // مسارات بدون أرقام أسطر
    const pathMatches = line.matchAll(/([\w@.-]+(?:[\\/][\w@.-]+)+\.(?:ts|tsx|js|jsx|json|css|html|md|py|rs|go|java))/g)
    for (const m of pathMatches) {
      if (!identifiers.includes(m[1]!)) identifiers.push(m[1]!)
    }

    // نتائج البحث (أول5 نتائج فقط)
    if (line.match(/^\s*\d+\.\s/) && importantLines.length < 20) {
      importantLines.push(line)
      continue
    }

    // معلومات الملفات (path/file/line)
    if (line.includes('path:') || line.includes('file:') || line.includes('line:')) {
      if (importantLines.length < 30) {
        importantLines.push(line)
        continue
      }
    }
  }

  // ابدأ بالـ identifiers المستخرجة (أهم شيء للحفظ)
  const parts: string[] = []
  if (identifiers.length) {
    parts.push(`[ملفات مرجعية: ${identifiers.slice(0, 15).join('، ')}]`)
  }
  if (importantLines.length > 0) {
    parts.push(importantLines.join('\n'))
    parts.push('[تم ضغط نتائج الأداة القديمة - استخدم read_file عند الحاجة]')
    return parts.join('\n')
  }

  // إذا لم نجد أسطر مهمة، نحتفظ بالبداية والنهاية
  const preview = content.slice(0, 800)
  const ending = content.slice(-200)
  return `${preview}\n[...]\n${ending}\n[تم ضغط الرسالة القديمة]`
}

/**
 * ضغط ذكي لرسالة المساعد: يحتفظ بالقرارات والخطوات المهمة والمسارات المرجعية
 */
function compressAssistantMessageSmart(content: string): string {
  const lines = content.split('\n')
  const importantLines: string[] = []
  const referencedPaths: string[] = []

  for (const line of lines) {
    // استخراج مسارات الملفات المذكورة في الأسطر
    const pathMatches = line.matchAll(/([\w@.-]+(?:[\\/][\w@.-]+)+\.(?:ts|tsx|js|jsx|json|css|html|md|py|rs|go|java))/g)
    for (const m of pathMatches) {
      if (!referencedPaths.includes(m[1]!)) referencedPaths.push(m[1]!)
    }

    // القرارات والخطوات المهمة
    if (line.includes('#') || line.includes('•') || line.includes('-') || line.includes('أقرر') || line.includes('سأفعل')) {
      importantLines.push(line)
      continue
    }

    // الأكواد المهمة (توقيعات الدوال والأصناف)
    if (line.includes('```') || line.includes('function') || line.includes('const') || line.includes('class') || line.includes('interface') || line.includes('export')) {
      importantLines.push(line)
      continue
    }

    // التحذيرات والملاحظات
    if (line.includes('مهم') || line.includes('تنبيه') || line.includes('ملاحظة') || line.includes('تحقق') || line.includes('فشل')) {
      importantLines.push(line)
      continue
    }
  }

  const parts: string[] = []
  if (referencedPaths.length) {
    parts.push(`[ملفات ذُكرت: ${referencedPaths.slice(0, 10).join('، ')}]`)
  }
  if (importantLines.length > 0) {
    parts.push(importantLines.join('\n'))
    parts.push('[تم ضغط الرسالة القديمة - اقرأ السجل للتفاصيل]')
    return parts.join('\n')
  }

  // إذا لم نجد أسطر مهمة، نحتفظ بالبداية فقط
  return content.slice(0, 1000) + '\n[تم ضغط الرسالة القديمة]'
}
function mergeUsage(first: ModelUsage | undefined, second: ModelUsage | undefined): ModelUsage | undefined { if (!first) return second; if (!second) return first; return { input: first.input + second.input, output: first.output + second.output, total: (first.total ?? first.input + first.output) + (second.total ?? second.input + second.output), cacheRead: (first.cacheRead ?? 0) + (second.cacheRead ?? 0), cacheWrite: (first.cacheWrite ?? 0) + (second.cacheWrite ?? 0), reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) } }
async function runWithConcurrency(count: number, concurrency: number, execute: (index: number) => Promise<void>): Promise<void> { let next = 0; const worker = async (): Promise<void> => { while (next < count) { const index = next++; await execute(index) } }; await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker())) }
export function projectToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if ((name === 'write_file' || name === 'append_file') && typeof input.content === 'string') {
    const { content, ...rest } = input
    return { ...rest, operation: name, contentReceipt: contentReceipt(content, input.path) }
  }
  if (name === 'edit_file') {
    const result = { ...input }
    for (const field of ['old_string', 'new_string'] as const) if (typeof result[field] === 'string' && result[field].length > 2_000) { result[`${field}Receipt`] = contentReceipt(result[field], input.path); delete result[field] }
    return result
  }
  if (name === 'edit_files_bulk' && Array.isArray(input.edits)) return { operation: name, edits: input.edits.map((edit) => edit && typeof edit === 'object' ? projectToolInput('edit_file', edit as Record<string, unknown>) : edit) }
  if (name === 'patch_file' && Array.isArray(input.patches)) return { ...input, operation: name, patches: input.patches.map((patch, index) => {
    if (!patch || typeof patch !== 'object') return patch
    const projected: Record<string, unknown> = { ...(patch as Record<string, unknown>), reference: `patch:${index + 1}` }
    for (const field of ['new_lines', 'expected']) if (typeof projected[field] === 'string' && projected[field].length > 2_000) { projected[`${field}Receipt`] = contentReceipt(projected[field], input.path); delete projected[field] }
    return projected
  }) }
  if (name === 'edit_file_undo') return { action: 'undo_last_edit' }
  return input
}
function contentReceipt(content: string, pathValue: unknown): Record<string, unknown> { return { bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), persistedAtPath: pathValue, note: 'المحتوى الكامل محفوظ في سجل الجلسة والملف الناتج؛ استخدم read_file/read_files عند الحاجة إليه.' } }
function modelProviderPayload(payload: unknown[] | undefined, representedCallIds = new Set<string>()): unknown[] | undefined { if (!payload) return undefined; const projected = payload.filter((item) => { if (!item || typeof item !== 'object') return true; const value = item as Record<string, unknown>; return value.type !== 'function_call' || !representedCallIds.has(String(value.call_id ?? value.id ?? '')) }); return projected.length ? projected : undefined }
function toolInputSummary(name: string, input: Record<string, unknown>): string {
  const pathValue = typeof input.path === 'string' ? input.path : undefined
  if ((name === 'write_file' || name === 'append_file') && typeof input.content === 'string') return JSON.stringify({ path: pathValue, contentBytes: Buffer.byteLength(input.content) })
  if (name === 'edit_file') return JSON.stringify({ path: pathValue, oldBytes: typeof input.old_string === 'string' ? Buffer.byteLength(input.old_string) : undefined, newBytes: typeof input.new_string === 'string' ? Buffer.byteLength(input.new_string) : undefined })
  if (name === 'edit_files_bulk' && Array.isArray(input.edits)) return JSON.stringify({ edits: input.edits.length, paths: input.edits.flatMap((edit) => edit && typeof edit === 'object' && typeof edit.path === 'string' ? [edit.path] : []).slice(0, 20) })
  if (name === 'patch_file' && Array.isArray(input.patches)) return JSON.stringify({ path: pathValue, patches: input.patches.length })
  return JSON.stringify(input).slice(0, 500)
}

function buildMemoryQuery(history: StoredMessage[], errors: string[]): string | undefined {
  const latest = [...history].reverse().find((message) => message.role === 'user')?.content ?? ''
  const terms = `${latest} ${errors.join(' ')}`.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu)?.slice(0, 8)
  return terms?.join(' ')
}

function buildTaskProfile(history: StoredMessage[]): string {
  const prompt = [...history].reverse().find((message) => message.role === 'user')?.content.toLowerCase() ?? ''
  const readOnly = /(?:حلل|اشرح|راجع|افحص|analy[sz]e|explain|review|read.only)/i.test(prompt) && !/(?:عدل|اصلح|نفذ|أنشئ|edit|fix|implement|create)/i.test(prompt)
  return readOnly
    ? 'Build task profile: analysis/reading. Start with read and search tools; do not modify anything unless the user explicitly asks.'
    : 'Build task profile: implementation. Use reading, editing and terminal tools as needed, and verify changes before delivering.'
}

function extractPromptPaths(prompt: string): string[] { return prompt.match(/[\w@.-]+(?:[\\/][\w@.-]+)+/g)?.slice(0, 20) ?? [] }
export function forceCompactForOverflow(messages: ModelInput[]): ModelInput[] {
  const result = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
    tool_calls: message.tool_calls?.map((call) => ({ ...call, function: { ...call.function } })),
    providerPayload: message.providerPayload ? structuredClone(message.providerPayload) : undefined,
  }))
  let userSeen = 0
  let assistantCallsSeen = 0
  for (let index = result.length - 1; index >= 0; index--) {
    const message = result[index]!
    if (message.role === 'user') userSeen++
    if (message.role === 'assistant' && message.tool_calls) {
      assistantCallsSeen++
      if (assistantCallsSeen > 2) {
        message.tool_calls = message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: compactHistoricalToolArguments(call.function.name, call.function.arguments) } }))
      }
    }
    if (message.role === 'tool' && (userSeen >= 1 || message.content.length > 2_000)) message.content = compactToolResult(message, 500)
  }
  return result
}

function compactHistoricalToolArguments(name: string, argumentsText: string): string {
  if (argumentsText.length <= 2_000) return argumentsText
  try {
    const input = JSON.parse(argumentsText) as Record<string, unknown>
    if ((name === 'write_file' || name === 'append_file') && typeof input.path === 'string') return JSON.stringify({ path: input.path, content: '[محتوى تاريخي مقتطع من السياق؛ اقرأ الملف الحالي عند الحاجة]' })
    return JSON.stringify(input).slice(0, 2_000)
  } catch { return '{}' }
}
