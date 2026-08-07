import type { WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { AgentEvent, ApprovalRequest, Attachment, Message, ModelUsage, SessionRunState, SubagentEvent, ToolCallRecord } from '../shared/types'
import { AppDatabase, type StoredMessage } from './database'
import { ProviderStore } from './provider-store'
import { ContextOverflowError, DeadlineExceededError, estimateModelRequestTokens, requestModel, type ModelInput, type ModelToolCall, type ToolDefinition } from './provider'
import { commitAutoChanges, executeTool, toolDefinitions, withAutoCommit, type ToolContext } from './tools'
import { McpManager } from './mcp'
import { modelSupportsModality } from '../shared/models'

const MAX_STEPS = 200
const MAX_RUNTIME_MS = 30 * 60_000
const APPROVAL_TIMEOUT_MS = 5 * 60_000
const MAX_PARALLEL_READ_TOOLS = 6
const SUBAGENT_MAX_STEPS = 30
const SUBAGENT_MAX_RUNTIME_MS = 10 * 60_000
const PARALLEL_READ_TOOLS = new Set(['read_file', 'read_files', 'read_message', 'count_lines', 'list_directory', 'glob_files', 'search_files', 'search_symbols', 'get_file_info', 'tree'])
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'create_directory', 'run_powershell', 'git_commit', 'git_revert', 'git_revert_step', 'delete_file', 'move_file', 'append_file', 'git_add', 'git_restore', 'git_checkout', 'git_reset'])
const SUBAGENT_TOOL_NAMES = new Set(['read_file', 'read_files', 'read_message', 'count_lines', 'list_directory', 'glob_files', 'search_files', 'search_symbols', 'get_file_info', 'tree', 'load_skill', 'web_fetch', 'web_search', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_show', 'write_file', 'edit_file'])
const projectInstructionsCache = new Map<string, { modifiedAt: number; content: string }>()

interface PendingApproval { sessionId: string; runId: string; request: ApprovalRequest; rememberKey?: string; timer: NodeJS.Timeout; abort: () => void; resolve(value: boolean): void; reject(error: Error): void }
interface ActiveRun { runId: string; controller: AbortController; startedAt: number; deadlineAt: number; status: string; error?: string; pendingMessages: StoredMessage[]; followUpQueued: boolean; childProcesses: Set<import('child_process').ChildProcess>; initializing: boolean; ready: Promise<void>; resolveReady: () => void; rejectReady: (error: Error) => void; repeatedSteps: Map<string, number>; toolFailures: number; outcome?: 'completed' | 'interrupted' | 'failed' | 'cancelled'; promise?: Promise<void> }

export class AgentRunner {
  private runs = new Map<string, ActiveRun>()
  private approvals = new Map<string, PendingApproval>()
  private approvalGrants = new Map<string, Set<string>>()

  constructor(private db: AppDatabase, private providers: ProviderStore, private getWebContents: () => WebContents | null, private modelRequest: typeof requestModel = requestModel, private mcp = new McpManager()) { this.db.repairIncompleteToolCalls(); this.db.markRunningRunsInterrupted() }

  states(): SessionRunState[] {
    return [...this.runs].map(([sessionId, run]) => ({ sessionId, runId: run.runId, state: run.controller.signal.aborted ? 'cancelling' : this.hasApproval(sessionId, run.runId) ? 'awaiting_approval' : 'running', status: run.status, error: run.error, pendingApprovals: [...this.approvals.values()].filter((item) => item.sessionId === sessionId && item.runId === run.runId).map((item) => item.request) }))
  }

  async send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void> {
    const existing = this.runs.get(sessionId)
    if (existing) {
      if (existing.initializing) await existing.ready
      const current = this.runs.get(sessionId)
      if (!current || current !== existing) throw new Error('انتهى التشغيل قبل قبول الرسالة؛ أعد الإرسال.')
      if (current.controller.signal.aborted) throw new Error('ينهي الوكيل الإيقاف الحالي؛ أعد الإرسال بعد ظهوره متوقفًا.')
      const message = this.db.addMessage({ sessionId, role: 'user', content: text, attachments })
      current.pendingMessages.push(message)
      this.db.addAudit({ sessionId, category: 'agent', action: 'queue', detail: text.slice(0, 1000), outcome: 'started' })
      this.emit({ sessionId, runId: current.runId, type: 'message', message })
       this.setStatus(sessionId, 'تصل رسالتك للوكيل في الجولة التالية...', current)
       return
    }

    const config = this.providers.get()
    if (!config.apiKey) throw new Error('أضف مفتاح API من الإعدادات أولًا')
    if (attachments?.length) {
      const unsupportedDocument = attachments.find((attachment) => attachment.mimeType === 'application/pdf')
      if (unsupportedDocument) throw new Error(`لا يدعم الوكيل تحليل PDF مباشرةً حاليًا: ${unsupportedDocument.name}. أرفق نسخة نصية أو حوّل الملف إلى نص.`)
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
    const run: ActiveRun = { runId: randomUUID(), controller, startedAt, deadlineAt: startedAt + MAX_RUNTIME_MS, status: 'يبدأ التنفيذ...', pendingMessages: [], followUpQueued: false, childProcesses: new Set(), initializing: true, ready, resolveReady, rejectReady, repeatedSteps: new Map(), toolFailures: 0 }
    this.runs.set(sessionId, run)
    this.db.startAgentRun(sessionId, run.runId, startedAt)
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

  private async runLoop(session: ReturnType<AppDatabase['getSession']>, config: ReturnType<ProviderStore['get']>, run: ActiveRun): Promise<void> {
    const sessionId = session.id
    const controller = run.controller
    try {
      const discoveryStartedAt = Date.now()
      const baseTools = session.agentMode === 'plan' ? toolDefinitions.filter((tool) => !MUTATING_TOOLS.has(tool.function.name)) : toolDefinitions
      const mcpTools = session.agentMode === 'plan' ? [] : await this.mcp.tools(session.workspace, controller.signal, (child) => { run.childProcesses.add(child); child.once('close', () => run.childProcesses.delete(child)) }, session.permissionMode === 'ask' ? (title, detail) => this.approve(sessionId, run, title, detail, true) : undefined)
      const availableTools = [...baseTools, ...mcpTools]
      const discoveryMs = Date.now() - discoveryStartedAt
      for (let step = 0; step < MAX_STEPS || Date.now() < run.deadlineAt; step++) {
        const stepStartedAt = Date.now()
        this.assertRunning(run)
        if (step === MAX_STEPS) this.setStatus(sessionId, `اكتملت دفعة ${MAX_STEPS} جولة؛ يواصل الوكيل تلقائيًا ضمن الحد الزمني.`, run)
        this.db.updateAgentRun(sessionId, run.runId, step)
        this.drainPending(sessionId, run)
        this.setStatus(sessionId, step ? `يحلل نتيجة الخطوة ${step}...` : 'يحلل المشروع ويجهز السياق...', run)
        const prepared = await this.buildContext(session, config, availableTools, controller.signal, run.deadlineAt, run.runId)
        const todos = this.db.getTodos(sessionId)
        const currentTodo = todos.find((todo) => todo.status === 'in_progress')
        if (currentTodo) prepared.messages.push({ role: 'system', content: `الخطوة الحالية من خطة العمل التي تعمل عليها الآن: ${currentTodo.content}` })
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
          try {
            reply = await this.modelRequest(config, prepared.messages, availableTools, { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 180_000, retries: 2, maxOutputTokens: prepared.maxOutputTokens, onTextDelta: emitDelta, onReasoningDelta: emitReasoningDelta })
            this.recordUsage(sessionId, run, config, reply.usage, estimatedTokens, 'agent', streamId)
          } catch (error) {
            if (!(error instanceof ContextOverflowError) || streamed) throw error
            this.setStatus(sessionId, 'رفض المزود حجم السياق؛ يعيد بناء ذاكرة العمل ويحاول مرة واحدة...', run)
            const recovered = forceCompactForOverflow(prepared.messages)
            reply = await this.modelRequest(config, recovered, availableTools, { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 180_000, retries: 0, maxOutputTokens: prepared.maxOutputTokens, onTextDelta: emitDelta, onReasoningDelta: emitReasoningDelta })
            this.recordUsage(sessionId, run, config, reply.usage, estimateModelRequestTokens(config, recovered, availableTools, prepared.maxOutputTokens), 'overflow-recovery', streamId)
          }
          if (!reply.toolCalls.length && reply.finishReason === 'length') {
            let combinedText = reply.text
            let combinedUsage = reply.usage
            const continuationContext: ModelInput[] = [...prepared.messages, { role: 'assistant', content: reply.text, providerPayload: reply.providerPayload }]
            while (reply.finishReason === 'length') {
              this.assertRunning(run)
              this.setStatus(sessionId, 'يتابع الرد تلقائيًا بعد بلوغ حد إخراج المزود...', run)
              continuationContext.push({ role: 'user', content: 'تابع مباشرة من آخر موضع دون تكرار، وأكمل الرد حتى النهاية.' })
              const next = await this.modelRequest(config, continuationContext, [], { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 180_000, retries: 2, maxOutputTokens: prepared.maxOutputTokens, onTextDelta: emitDelta })
              this.recordUsage(sessionId, run, config, next.usage, estimateModelRequestTokens(config, continuationContext, [], prepared.maxOutputTokens), 'continuation', streamId)
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
          if (reply.finishReason === 'length') reply.finishReason = 'stop'
          if (reply.finishReason === 'content_filter') throw new Error('أوقف المزود الرد بسبب سياسة المحتوى.')
          if (reply.finishReason !== 'stop') throw new Error(`انتهى النموذج بحالة غير مكتملة: ${reply.finishReason}`)
          if (!reply.text.trim()) throw new Error('أعاد النموذج ردًا فارغًا دون تنفيذ أدوات.')
          const message = this.db.addMessage({ id: streamId, sessionId, role: 'assistant', content: reply.text, reasoning: reply.reasoning, providerPayload: reply.providerPayload, usage: reply.usage })
          this.emit({ sessionId, runId: run.runId, type: 'message', message })
          this.recordStepTiming(sessionId, step + 1, { discoveryMs: step === 0 ? discoveryMs : 0, contextMs, modelMs: Date.now() - modelStartedAt, firstTokenMs: firstDeltaAt ? firstDeltaAt - modelStartedAt : undefined, toolMs: 0, totalMs: Date.now() - stepStartedAt, tools: [] })
           if (run.pendingMessages.length || run.followUpQueued) { run.followUpQueued = false; this.setStatus(sessionId, 'وصلت رسائل متابعة، يواصل الوكيل مع السياق المحدّث...', run); continue }
           run.outcome = 'completed'
           return
        }

        validateCallIds(reply.toolCalls)
        const validations = reply.toolCalls.map((call) => validateToolCall(call, availableTools))
        const stepSignature = createStepSignature(reply.toolCalls, validations)
        const repeated = (run.repeatedSteps.get(stepSignature) ?? 0) + 1
        run.repeatedSteps.set(stepSignature, repeated)
        if (repeated >= 3) throw new Error('اكتشفت حلقة عالقة: كرر النموذج نفس استدعاءات الأدوات ثلاث مرات دون تقدم.')
        const records: ToolCallRecord[] = reply.toolCalls.map((call, index) => ({ id: call.id, name: call.name, input: validations[index]!.input, status: 'running', step: step + 1, startedAt: Date.now() }))
        const thought = this.db.addMessage({ id: streamId, sessionId, role: 'assistant', content: reply.text, reasoning: reply.reasoning, toolCalls: records, providerPayload: reply.providerPayload, usage: reply.usage })
        this.emit({ sessionId, runId: run.runId, type: 'message', message: thought })

        const deferredCommits: Array<{ action: string; paths: string[] }> = []
        const toolContext: ToolContext = { session: this.db.getSession(sessionId), signal: controller.signal, deadlineAt: run.deadlineAt, maxOutputChars: Math.min(1_500_000, Math.max(120_000, Math.floor(config.contextWindow * 1.2))), mcp: this.mcp, trackProcess: (child) => { run.childProcesses.add(child); child.once('close', () => run.childProcesses.delete(child)) }, approve: (title, detail, critical, rememberKey) => this.approve(sessionId, run, title, detail, critical, rememberKey), readStoredMessage: (id) => Promise.resolve(this.db.getStoredMessage(sessionId, id)), loadSkill: (name) => loadSkillFromWorkspace(session.workspace, name), todos: { get: () => Promise.resolve(this.db.getTodos(sessionId)), set: (items) => { const todos = this.db.setTodos(sessionId, items); this.emit({ sessionId, runId: run.runId, type: 'todo', todos }); return Promise.resolve(todos) } }, runSubagent: (input, subSignal) => this.runSubagent(this.db.getSession(sessionId), config, run, input, subSignal), runSubagentBatch: (tasks, subSignal) => this.runSubagentBatch(this.db.getSession(sessionId), config, run, tasks, subSignal), runCommand: async (name, argumentsText) => { const commands = await loadProjectCommands(session.workspace); const command = commands.find((item) => item.name === name); if (!command) return { ok: false, error: `أمر غير معروف: ${name}` }; return { ok: true, output: renderCommandTemplate(command.template, argumentsText ?? '') } }, deferAutoCommit: (action, paths) => deferredCommits.push({ action, paths }) }
        const toolsStartedAt = Date.now()
        const executeCall = async (index: number): Promise<void> => {
          const call = reply.toolCalls[index]!
          const validation = validations[index]!
          const record = records[index]!
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
               output = await executeTool(call.name, validation.input, toolContext)
               record.status = output.includes('"ok": false') ? output.includes('APPROVAL_DENIED') || output.includes('PLAN_MODE') ? 'denied' : 'error' : 'completed'
               if (record.status === 'error') run.toolFailures++
             } catch (error) {
               output = JSON.stringify({ ok: false, error: { code: controller.signal.aborted ? 'ABORTED' : 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }, null, 2)
               record.status = 'error'
               run.toolFailures++
             }
           }
           if (run.toolFailures >= 8) throw new Error('توقّف الوكيل بعد 8 إخفاقات أدوات لتجنب حلقة فشل مكلفة.')
          const outputLimit = call.name === 'read_files' || call.name === 'tree' ? Math.min(1_600_000, Math.max(150_000, Math.floor(config.contextWindow * 1.3))) : call.name === 'web_fetch' ? Math.min(600_000, Math.max(250_000, Math.floor(config.contextWindow * 0.4))) : 100_000
          record.output = output.slice(0, outputLimit)
          record.completedAt = Date.now()
        }
        const persistCall = (index: number): void => {
          const call = reply.toolCalls[index]!
          const record = records[index]!
          this.db.completeToolCall(thought.id, records, { sessionId, role: 'tool', content: record.output ?? '', toolCallId: call.id, toolName: call.name })
          this.db.addAudit({ sessionId, category: 'tool', action: call.name, detail: (record.output ?? '').slice(0, 4000), outcome: record.status === 'completed' ? 'completed' : record.status === 'denied' ? 'denied' : 'failed' })
          this.emit({ sessionId, runId: run.runId, type: 'tool', tool: record })
        }
        const parallel = reply.toolCalls.length > 1 && reply.toolCalls.every((call, index) => validations[index]!.ok && PARALLEL_READ_TOOLS.has(call.name))
        if (parallel) {
          this.setStatus(sessionId, `ينفذ ${reply.toolCalls.length} عمليات قراءة وبحث بالتوازي...`, run)
          await runWithConcurrency(reply.toolCalls.length, MAX_PARALLEL_READ_TOOLS, executeCall)
          for (let index = 0; index < reply.toolCalls.length; index++) persistCall(index)
        } else {
          for (let index = 0; index < reply.toolCalls.length; index++) { await executeCall(index); persistCall(index) }
        }
        if (deferredCommits.length) {
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
        this.recordStepTiming(sessionId, step + 1, { discoveryMs: step === 0 ? discoveryMs : 0, contextMs, modelMs: toolsStartedAt - modelStartedAt, firstTokenMs: firstDeltaAt ? firstDeltaAt - modelStartedAt : undefined, toolMs: Date.now() - toolsStartedAt, totalMs: Date.now() - stepStartedAt, tools: reply.toolCalls.map((call) => call.name) })
      }
       run.outcome = 'interrupted'
       throw new Error(`وصل الوكيل إلى حد ${MAX_STEPS} جولة. أرسل رسالة متابعة ليكمل من السياق المحفوظ.`)
    } catch (error) {
      if (controller.signal.aborted) { run.outcome = 'cancelled'; this.db.addAudit({ sessionId, category: 'agent', action: 'run', detail: 'ألغى المستخدم التشغيل', outcome: 'cancelled' }) }
      else { const message = error instanceof Error ? error.message : String(error); this.db.addAudit({ sessionId, category: 'agent', action: 'run', detail: message, outcome: 'failed' }); run.error = message; const failure = this.db.addMessage({ sessionId, role: 'assistant', content: `فشل التنفيذ: ${message}` }); this.emit({ sessionId, runId: run.runId, type: 'message', message: failure }); this.emit({ sessionId, runId: run.runId, type: 'error', text: message }) }
    } finally {
      this.db.finishAgentRun(sessionId, run.runId, run.outcome ?? 'failed', run.error)
      this.cancelApprovals(sessionId, run.runId)
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId)
      this.emit({ sessionId, runId: run.runId, type: 'status', text: controller.signal.aborted ? 'تم إيقاف التنفيذ.' : '' })
    }
  }

  cancel(sessionId: string): void {
    const run = this.runs.get(sessionId)
    if (!run) return
    for (const child of run.childProcesses) { try { child.kill() } catch {} }
    run.controller.abort()
    this.cancelApprovals(sessionId, run.runId)
    this.setStatus(sessionId, 'تم إيقاف التنفيذ.', run)
  }

  answerApproval(id: string, allowed: boolean, remember = false): void {
    const pending = this.approvals.get(id)
    if (!pending) throw new Error('طلب الموافقة منتهي أو غير موجود')
    this.approvals.delete(id); clearTimeout(pending.timer); pending.abort()
    if (allowed && remember && pending.rememberKey) this.approvalGrantsFor(pending.sessionId).add(pending.rememberKey)
    this.db.addAudit({ sessionId: pending.sessionId, category: 'approval', action: id, detail: allowed ? remember && pending.rememberKey ? 'سمح المستخدم وحفظ القرار لبقية الجلسة' : 'سمح المستخدم' : 'رفض المستخدم', outcome: allowed ? 'allowed' : 'denied' }); pending.resolve(allowed)
  }

  async shutdown(): Promise<void> {
    const runs = [...this.runs.values()]
    for (const run of runs) { for (const child of run.childProcesses) { try { child.kill() } catch {} }; run.controller.abort(); this.cancelApprovalsForRun(run, new DOMException('يتم إغلاق التطبيق', 'AbortError')) }
    await Promise.allSettled(runs.map((run) => run.promise).filter((promise): promise is Promise<void> => Boolean(promise)))
    await this.mcp.close()
  }

  forgetSession(sessionId: string): void {
    this.approvalGrants.delete(sessionId)
    this.cancelApprovals(sessionId)
  }

  private async buildContext(session: ReturnType<AppDatabase['getSession']>, config: ReturnType<ProviderStore['get']>, definitions: ToolDefinition[], signal: AbortSignal, deadlineAt: number, runId: string): Promise<{ messages: ModelInput[]; maxOutputTokens: number; compacted: boolean; estimatedTokens: number }> {
    const maxOutputTokens = Math.min(config.maxOutputTokens, Math.max(2_048, Math.floor(config.contextWindow * 0.25)))
    const safetyTokens = Math.max(8_000, Math.floor(config.contextWindow * 0.08))
    const hardLimit = config.contextWindow - maxOutputTokens - safetyTokens
    let history = this.db.listStoredMessages(session.id)
    let summary = this.db.getSummary(session.id)
    let compacted = false
    const instructions = await projectInstructions(session.workspace)
    const commands = await loadProjectCommands(session.workspace)

    let messages = makeContext(session, instructions, summary.text, history.filter((message) => message.sequence > summary.throughSequence), commands)
    let estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens)

    if (estimatedTokens > hardLimit) {
      const turns = userTurns(history.filter((message) => message.sequence > summary.throughSequence))
      const candidates = turns.slice(0, Math.max(0, turns.length - 2))
      if (candidates.length) {
        const cut = candidates.at(-1)!.at(-1)!.sequence
        const content = candidates.flat().map(summaryLine).join('\n').slice(0, 100_000)
        try {
          const compactReply = await this.modelRequest(config, [
            { role: 'system', content: 'لخص سجل وكيل برمجي بدقة شديدة كملخص JSON منظم. أعد:\n{\n  "goal": "الهدف الأساسي",\n  "decisions": ["قرار1", "قرار2"],\n  "filesModified": ["file1", "file2"],\n  "errors": ["خطأ1"],\n  "nextStep": "الخطوة التالية"\n}\nاحتفظ بالأدلة الواقعية فقط. لا تخترع معلومات. اكتب بالعربية.' },
            { role: 'user', content: `${summary.text ? `الملخص السابق:\n${summary.text}\n\n` : ''}السجل الجديد:\n${content}` }
          ], [], { signal, deadlineAt, concurrencyKey: `session:${session.id}`, timeoutMs: 60_000, retries: 0, maxOutputTokens: 4096 })
          const activeRun = this.runs.get(session.id)
          if (activeRun?.runId === runId) this.recordUsage(session.id, activeRun, config, compactReply.usage, estimateModelRequestTokens(config, [{ role: 'user', content }], [], 4096), 'compaction')
          if (compactReply.finishReason === 'stop' && compactReply.text.trim() && this.db.setSummary(session.id, compactReply.text, cut, summary.throughSequence)) { summary = { text: compactReply.text, throughSequence: cut }; compacted = true }
        } catch (error) {
          if (signal.aborted) throw error
          this.db.addAudit({ sessionId: session.id, category: 'agent', action: 'context-compaction', detail: error instanceof Error ? error.message : String(error), outcome: 'failed' })
        }
        history = this.db.listStoredMessages(session.id)
        messages = makeContext(session, instructions, summary.text, history.filter((message) => message.sequence > summary.throughSequence), commands)
        estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens)
      }
    }

    if (estimatedTokens > hardLimit) {
      compactContextMessages(messages, 2_000, 2)
      estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens)
    }

    if (estimatedTokens > hardLimit) {
      compactContextMessages(messages, 800, 1)
      estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens)
    }

    if (estimatedTokens > hardLimit) throw new Error(`السياق تجاوز حد النموذج (${config.contextWindow.toLocaleString('en')} رمز). السجل الكامل محفوظ. ابدأ جلسة جديدة.`)
    return { messages, maxOutputTokens, compacted, estimatedTokens }
  }

  private approve(sessionId: string, run: ActiveRun, title: string, detail: string, critical: boolean, rememberKey?: string): Promise<boolean> {
    if (run.controller.signal.aborted) return Promise.reject(new DOMException('تم الإلغاء', 'AbortError'))
    if (rememberKey && this.approvalGrantsFor(sessionId).has(rememberKey)) { this.db.addAudit({ sessionId, category: 'approval', action: title, detail: 'موافقة محفوظة لبقية الجلسة', outcome: 'allowed' }); return Promise.resolve(true) }
    const id = randomUUID()
    const request: ApprovalRequest = { id, sessionId, title, detail, risk: critical ? 'critical' : 'normal', canRemember: Boolean(rememberKey) }
    this.db.addAudit({ sessionId, category: 'approval', action: title, detail, outcome: 'started' })
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { const pending = this.approvals.get(id); if (!pending) return; this.approvals.delete(id); clearTimeout(pending.timer); reject(new DOMException('تم الإلغاء', 'AbortError')) }
      const timer = setTimeout(() => { const pending = this.approvals.get(id); if (!pending) return; this.approvals.delete(id); run.controller.signal.removeEventListener('abort', onAbort); reject(new Error('انتهت مهلة الموافقة وتم رفض العملية تلقائيًا')) }, APPROVAL_TIMEOUT_MS)
      this.approvals.set(id, { sessionId, runId: run.runId, request, rememberKey, timer, abort: () => run.controller.signal.removeEventListener('abort', onAbort), resolve, reject })
      run.controller.signal.addEventListener('abort', onAbort, { once: true })
      this.sendApproval(request)
    })
  }

  private sendApproval(request: ApprovalRequest): void { const contents = this.getWebContents(); if (!contents || contents.isDestroyed()) return; try { contents.send('approval:request', request) } catch {} }
  private cancelApprovals(sessionId: string, runId?: string): void { for (const [id, pending] of this.approvals) if (pending.sessionId === sessionId && (!runId || pending.runId === runId)) { this.approvals.delete(id); clearTimeout(pending.timer); pending.abort(); pending.reject(new DOMException('تم الإلغاء', 'AbortError')) } }
  private cancelApprovalsForRun(run: ActiveRun, error: Error): void { for (const [id, pending] of this.approvals) if (pending.runId === run.runId) { this.approvals.delete(id); clearTimeout(pending.timer); pending.abort(); pending.reject(error) } }
  private hasApproval(sessionId: string, runId?: string): boolean { return [...this.approvals.values()].some((item) => item.sessionId === sessionId && (!runId || item.runId === runId)) }
  private approvalGrantsFor(sessionId: string): Set<string> { const grants = this.approvalGrants.get(sessionId) ?? new Set<string>(); this.approvalGrants.set(sessionId, grants); return grants }
  private drainPending(sessionId: string, run: ActiveRun): void { if (run.pendingMessages.length) run.followUpQueued = true; while (run.pendingMessages.length) { const message = run.pendingMessages.shift()!; this.db.addAudit({ sessionId, category: 'agent', action: 'inject', detail: message.content.slice(0, 1000), outcome: 'started' }) } }
  private recordUsage(sessionId: string, run: ActiveRun, config: ReturnType<ProviderStore['get']>, usage: ModelUsage | undefined, estimatedInputTokens: number, purpose: 'agent' | 'continuation' | 'compaction' | 'overflow-recovery', messageId?: string): void { this.db.recordUsage({ sessionId, runId: run.runId, requestId: randomUUID(), messageId, purpose, model: config.model, apiStyle: config.apiStyle, usage, estimatedInputTokens }); const total = this.db.getUsageSummary(sessionId); this.emit({ sessionId, runId: run.runId, type: 'status', usage: { delta: usage ?? { input: estimatedInputTokens, output: 0, total: estimatedInputTokens }, estimated: !usage, total }, text: run.status }) }
  private assertRunning(run: ActiveRun): void { if (run.controller.signal.aborted) throw new DOMException('تم الإلغاء', 'AbortError'); if (Date.now() >= run.deadlineAt) throw new DeadlineExceededError('وصل الوكيل إلى الحد الزمني الأقصى وهو 30 دقيقة.') }
  private setStatus(sessionId: string, status: string, run?: ActiveRun): void { const current = this.runs.get(sessionId); if (run && current !== run) return; if (current) current.status = status; this.emit({ sessionId, runId: run?.runId ?? current?.runId, type: 'status', text: status }) }
  private recordStepTiming(sessionId: string, step: number, timing: { discoveryMs: number; contextMs: number; modelMs: number; firstTokenMs?: number; toolMs: number; totalMs: number; tools: string[] }): void { this.db.addAudit({ sessionId, category: 'agent', action: 'step-timing', detail: JSON.stringify({ step, ...timing }), outcome: 'completed' }) }
  private emit(event: AgentEvent): void { const contents = this.getWebContents(); if (!contents || contents.isDestroyed()) return; try { if (event.message) { const { providerPayload: _, ...message } = event.message as StoredMessage; contents.send('agent:event', { ...event, message: { ...message, toolCalls: message.toolCalls?.map((call) => ({ ...call, input: projectToolInput(call.name, call.input) })) } }); return } if (event.tool) { contents.send('agent:event', { ...event, tool: { ...event.tool, input: projectToolInput(event.tool.name, event.tool.input) } }); return } contents.send('agent:event', event) } catch {} }

  private async runSubagent(session: ReturnType<AppDatabase['getSession']>, config: ReturnType<ProviderStore['get']>, parentRun: ActiveRun, input: { prompt: string; description: string }, signal: AbortSignal): Promise<{ ok: boolean; summary: string; error?: string; steps: number }> {
    const sessionId = session.id
    const startedAt = Date.now()
    const deadlineAt = Math.min(parentRun.deadlineAt, startedAt + SUBAGENT_MAX_RUNTIME_MS)
    const subRunId = randomUUID()
    const subTools = toolDefinitions.filter((tool) => SUBAGENT_TOOL_NAMES.has(tool.function.name))
    const messages: ModelInput[] = [{ role: 'system', content: subagentSystemPrompt(session, input.prompt) }]
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const contextBudget = Math.floor(config.contextWindow * 0.55)
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
        const reply = await this.modelRequest(config, messages, isFinalStep ? [] : subTools, { signal: controller.signal, deadlineAt, concurrencyKey: `subagent:${sessionId}:${subRunId}`, timeoutMs: 300_000, retries: 1, maxOutputTokens: 8192 })
         if (reply.usage) { this.db.recordUsage({ sessionId, runId: parentRun.runId, requestId: randomUUID(), purpose: 'subagent', model: config.model, apiStyle: config.apiStyle, usage: reply.usage }); const total = this.db.getUsageSummary(sessionId); this.emit({ sessionId, runId: parentRun.runId, type: 'status', usage: { delta: reply.usage, estimated: false, total }, text: parentRun.status }) }
        if (!reply.toolCalls.length) {
          const summary = reply.text.trim()
          if (summary) { emitSubagent('completed', steps, { summary }); return { ok: true, summary, steps } }
          const forced = await this.requestSubagentSummary(config, messages, sessionId, parentRun, subRunId, controller.signal, deadlineAt, emitSubagent, steps)
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
              output = await executeTool(call.name, validation.input, { session, signal: controller.signal, deadlineAt, maxOutputChars: 80_000, mcp: this.mcp, trackProcess: (child) => { parentRun.childProcesses.add(child); child.once('close', () => parentRun.childProcesses.delete(child)) }, approve: (title, detail, critical, rememberKey) => this.approve(sessionId, parentRun, title, detail, critical, rememberKey), loadSkill: (name) => loadSkillFromWorkspace(session.workspace, name), runSubagent: undefined })
            } catch (error) {
              output = JSON.stringify({ ok: false, error: { code: controller.signal.aborted ? 'ABORTED' : 'TOOL_ERROR', message: error instanceof Error ? error.message : String(error) } }, null, 2)
            }
          }
          this.db.addAudit({ sessionId, category: 'tool', action: call.name, detail: `[وكيل فرعي] ${JSON.stringify(input.description ?? '').slice(0, 200)}`, outcome: output.includes('"ok": false') ? 'failed' : 'completed' })
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: output.slice(0, 60_000) })
          this.setStatus(sessionId, input.description ? `${input.description} — ${call.name}` : `وكيل فرعي — ${call.name}`, parentRun)
        }
        const estimated = estimateModelRequestTokens(config, messages, subTools, 8192)
        if (estimated > contextBudget) compactSubagentMessages(messages)
      }
       const forced = await this.requestSubagentSummary(config, messages, sessionId, parentRun, subRunId, controller.signal, deadlineAt, emitSubagent, steps)
       if (!forced.ok) emitSubagent('failed', steps, { error: 'انتهت جولات الوكيل الفرعي دون خلاصة.' })
       return forced
    } catch (error) {
      if (signal.aborted || controller.signal.aborted) throw error
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
        if (reply.usage) this.db.recordUsage({ sessionId, runId: parentRun.runId, requestId: randomUUID(), purpose: 'subagent', model: config.model, apiStyle: config.apiStyle, usage: reply.usage })
        const summary = reply.text.trim()
        if (summary) { emitSubagent('completed', steps, { summary }); return { ok: true, summary, steps } }
      } catch (error) {
        if (signal.aborted) throw error
      }
    }
    return { ok: false, summary: '', steps }
  }

  private async runSubagentBatch(session: ReturnType<AppDatabase['getSession']>, config: ReturnType<ProviderStore['get']>, parentRun: ActiveRun, tasks: Array<{ prompt: string; description: string }>, signal: AbortSignal): Promise<Array<{ ok: boolean; description: string; summary: string; error?: string; steps: number }>> {
    const limited = tasks.slice(0, 10)
    const results = new Array<{ ok: boolean; description: string; summary: string; error?: string; steps: number }>(limited.length)
    const concurrency = Math.min(4, limited.length)
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

function makeContext(session: ReturnType<AppDatabase['getSession']>, instructions: string, summary: string, history: StoredMessage[], commands: ProjectCommand[] = []): ModelInput[] {
  const result: ModelInput[] = [{ role: 'system', content: systemPrompt(session, instructions, commands) }]
  if (summary) result.push({ role: 'system', content: `ذاكرة مضغوطة للتاريخ السابق:\n${summary}` })
  for (const message of history) result.push(toModelMessage(message))
  return result
}

function systemPrompt(session: ReturnType<AppDatabase['getSession']>, instructions: string, commands: ProjectCommand[] = []): string {
  const permissionRule = session.permissionMode === 'full' ? '\n- قاعدة الصلاحية النهائية: وصول كامل مفعّل؛ نفّذ جميع الأدوات بما فيها الطرفية والويب وMCP دون طلب أي موافقة.' : '\n- قاعدة الصلاحية النهائية: وضع اسألني مفعّل؛ اطلب الموافقة قبل كل عملية معدّلة أو حساسة أو طرفية أو ويب أو MCP.'
  const efficiency = permissionRule + `# منهج العمل — على مستوى أدوات الهندسة العالمية (OpenCode، Claude Code، MiniMax Code)

## 1. افهم المشروع أولًا — الأدلة قبل التخمين
- للطلب الصغير المحدد بملف أو رمز واضح، اذهب مباشرة إلى الموضع المطلوب واقرأ أقل قدر لازم ثم نفّذ؛ لا تفحص الشجرة أو ملفات البيئة ولا تنشئ خطة أو وكيلًا فرعيًا بلا حاجة.
- عامل الأخطاء الإملائية البسيطة في أسماء الملفات والرموز كأسماء تقريبية: ابحث أولًا بـ glob مرن وغير حساس للحالة (مثل **/*MainActivity*)، وإذا وجدت نتيجة واضحة استخدمها مباشرة ولا تطلب من المستخدم تصحيح الاسم.
- إذا كان المطلوب فحص ملف معروف أو نتيجة glob وحيدة، اقرأ الملف مباشرة بحده الافتراضي الكامل. لا تستدعِ get_file_info قبله، ولا تقرأ manifest أو layout أو ملفات مرتبطة إلا إذا كان سؤال المستخدم يحتاجها فعلًا. تابع القراءة فقط عندما تعيد read_file truncated=true.
- للمهام الواسعة أو الغامضة فقط، حدد نوع المشروع من ملفات البيئة واقرأ أوامر البناء والاختبار وافحص البنية العامة قبل التعمق.
- لا تقل إن ملفًا أو رمزًا موجود إلا بعد أن تعيد الأداة ok=true. اقرأ أخطاء الأدوات حرفيًا ولا تخمّن نتيجة بديلة.
- استخدم glob_files للأسماء وsearch_files وsearch_symbols للمحتوى والتعريفات بدل التصفح العشوائي.

## 2. حُرّك بثقة واستقلالية
- أنت المسؤول عن تنظيم عملك: خطّط ونفّذ وتحقّق بنفسك دون انتظار توجيه في كل خطوة، ولا تقيّد نفسك بقوالب جامدة.
- اجمع عمليات القراءة والبحث المستقلة في استدعاء أدوات واحد (يُنفَّذ بالتوازي) لتقليل الجولات؛ ولا تضيّع جولة في التحقق من توفر الأدوات، استدعِ الأداة المناسبة مباشرة.

## 3. دقة التعديلات وسلامة المشروع
- اقرأ الملف بأرقام الأسطر أولًا ثم عدّل أصغر نطاق ممكن؛ وفي patch_file اضمّن expected بالمحتوى الحالي كما قرأته ليُتحقق قبل التطبيق ويمنع تعديل مواضع خاطئة.
- لا تعِد تنسيق ملفات لا تمسها، ولا تغيّر النمط خارج نطاق المهمة، ولا تغيّر سلوكًا قائمًا إلا عندما تطلبه المهمة صراحةً ثم اذكر ذلك في الملخص.
- طابق التحقق مع حجم وخطر التعديل؛ لا تشغّل فحوصًا واسعة لمهمة صغيرة إذا كان تحقق موجّه يكفي. اذكر نتيجة ما شغّلته. عند طلب عدد أسطر مجلد استخدم count_lines على المجلد مباشرة.

## 4. المشاريع الكبيرة
- ابنِ خريطة عامة للمشروع أولًا، ثم قسّم التحليل إلى مهام مستقلة (وحدات/مجلدات/أسئلة منفصلة) وأطلِقها عبر task_parallel حتى 5 ببرومبت دقيق يحدد ما يفحصه والملفات المستهدفة والأسئلة ومواصفات الخلاصة، أو عبر task للمهام المعزولة المتسلسلة، ثم ادمج الخلاصات واتخذ القرارات النهائية بنفسك ليظل سياقك نظيفًا.
- قبل دفعة read_files تالية اكتب في content خلاصة فنية مركزة (ذاكرة عمل للمهمة الطويلة)، وتابع بالـ cursor حتى complete=true، وإذا ضُغطت نتيجة استرجعها عبر read_message بمعرّفها.
- خطّط عبر todo_write فقط عندما تتطلب المهمة ثلاث خطوات مستقلة أو أكثر. استخدم load_skill عندما تطابق المهمة مهارة موثّقة فعلًا.

## 5. الحساسية للزمن
- للأسئلة المتعلقة بحالة حالية أو معلومات حديثة أو إصدارات، ابحث وتحقق عبر web_search ثم web_fetch واذكر الزمن في إجابتك.` + (session.gitTracked ? '\n- تتبع Git التلقائي مفعّل: كل أداة تعديل تحفظ مساراتها فورًا في commit وتعيد hash داخل gitAutoCommit، فقد يكون git status نظيفًا بعد النجاح. للتراجع استخدم git_revert مع hash المعاد ولا تستخدم git_restore.' : '')
  const commandsBlock = commands.length ? `\n\nأوامر معرفة (Slash Commands) متاحة في هذا المشروع — عند طلب المستخدم أمرًا منها نفّذه عبر run_command مع تمرير الاسم والوسائط:\n${commands.map((command) => `- /${command.name}${command.description ? `: ${command.description}` : ''}`).join('\n')}` : ''
  return `أنت Rahma Code Agent، مهندس برمجيات محترف من الطراز العالمي يعمل على Windows، ومسؤول بصفة مباشرة عن سلامة هذا المشروع وصحة كل تعديل فيه. أنت لا تنفّذ أوامر حرفيًا فحسب، بل تفهم المشروع وتحللّه وتحميه من الأخطاء وتدافع عن جودة كوده وسلامة سير عمله. رد بنفس لغة المستخدم التي يخاطبك بها — إن كتب بالعربية فبالعربية، وإن كتب بالإنجليزية فبالإنجليزية. أبق أسماء الكود والأوامر بلغتها الأصلية.
التاريخ الحالي: ${new Date().toISOString().slice(0, 10)}
مساحة العمل الوحيدة المسموحة: ${session.workspace}
الوضع: ${session.agentMode === 'build' ? 'Build: نفّذ المهمة واستخدم الأدوات حتى تكتمل' : 'Plan: حلل واقرأ فقط ولا تعدل'}
الصلاحية: ${session.permissionMode === 'full' ? 'وصول كامل: جميع الأدوات بما فيها الطرفية والويب وMCP تُنفَّذ دون طلب أي موافقة' : 'اسألني: كل عملية معدّلة أو حساسة أو طرفية أو ويب أو MCP تتطلب موافقتك'}
قواعد أساسية:
- استخدم المسارات النسبية إلى جذر مساحة العمل افتراضيًا، ولا تفحص المجلد الأب أو جذور الأقراص.${efficiency}
- لا تدّع تنفيذ شيء لم تنفذه، ولا تكشف الأسرار، ولا تطلب الوصول خارج مساحة العمل.
- عند فشل أداة، حلل الخطأ وصحّح المدخلات مرة واحدة؛ لا تجرب D:\\ أو مجلدات الأب.
- search_files يقبل ملفًا أو مجلدًا في path؛ عند البحث داخل ملف معروف مرّر مسار الملف مباشرة ولا تحوّله إلى بحث أوسع.
- أعطِ في النهاية ملخصًا واضحًا بما أنجزته والتحقق الذي أجريته.${commandsBlock}${session.systemPrompt ? `\n\nتعليمات المستخدم الخاصة (يلزم الالتزام بها طوال الجلسة):\n${session.systemPrompt}` : ''}${instructions ? `\n\nتعليمات المشروع:\n${instructions}` : ''}`
}

function subagentSystemPrompt(session: ReturnType<AppDatabase['getSession']>, task: string): string {
  return `أنت خبير تحليل مستقل تابع لـ Rahma Code Agent، تعمل في سياق منفصل تمامًا عن المحادثة الرئيسية، ومسؤول عن تقديم خلاصة دقيقة تعتمد عليها القرارات.
مهمتك (نفّذها بدقة وحرفية وأنت مسؤول عن جودة نتيجتها):
${task}

مساحة العمل: ${session.workspace}

قواعد:
- أنت وكيل تحليل وبحث فقط: مسموح لك أدوات القراءة والبحث وGit (قراءة) والويب. لا تعدّل أي ملف ولا تنفّذ أوامر طرفية ولا Git كتابيًا ولا MCP ولا تستخدم todo.
- افحص الملفات والبنية الفعلية قبل أي استنتاج؛ لا تخمّن ولا تدّع شيئًا لم تقرأه، واذكر صراحةً ما لم تجده.
- استخدم المسارات النسبية إلى جذر مساحة العمل فقط، واجمع القراءات والبحوث المستقلة في استدعاء أدوات واحد، وتابع read_files بالـ cursor حتى complete=true عند الحاجة.
- كفى بالقراءة بمجرد حصولك على المعلومات اللازمة: في أول جولة لا تتطلب أدوات جديدة أعد الخلاصة النهائية فورًا، ولا تعِد قراءة ملف كبير أكثر من مرة.

عند الانتهاء أعد خلاصة نهائية منظمة بنفس لغة المهمة يعتمد عليها المشرف بشكل كامل:
- الإجابات الدقيقة عن أسئلة المهمة مرفقة بالأدلة (المسار ورقم السطر إن أمكن).
- البنية والعلاقات بين الملفات التي اكتشفتها.
- أي مخاطر أو أجزاء لم تُفحص.
لا تكرر نصوص الملفات؛ كن مركّزًا وكاملًا ودقيقًا.`
}

async function projectInstructions(workspace: string): Promise<string> {  for (const name of ['AGENTS.md', 'CLAUDE.md']) { try { const target = path.join(workspace, name); const stat = await fs.stat(target); const cached = projectInstructionsCache.get(target); if (cached?.modifiedAt === stat.mtimeMs) return cached.content; let content = await fs.readFile(target, 'utf8'); if (content.length > 40_000) content = `${content.slice(0, 40_000)}\n\n[مقصوص: تجاوز ملف التعليمات 40,000 حرف، عُرضت البداية فقط]`; projectInstructionsCache.set(target, { modifiedAt: stat.mtimeMs, content }); return content } catch {} }
  return ''
}

const SKILL_DIRS = ['.skills', '.opencode/skills', 'skills', '.claude/skills']
const skillCache = new Map<string, { name: string; description: string; content: string }>()

interface ProjectCommand { name: string; description?: string; template: string; agent?: string; model?: string; subtask?: boolean }
const commandCache = new Map<string, { modifiedAt: number; commands: ProjectCommand[] }>()

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
  for (const dir of SKILL_DIRS) {
    const base = path.join(workspace, dir)
    for (const candidate of [path.join(base, safeName), path.join(base, safeName, 'SKILL.md')]) {
      try {
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
  return { role: message.role as 'user' | 'assistant' | 'system', content, providerPayload: message.providerPayload?.map((item) => item && typeof item === 'object' ? { ...(item as Record<string, unknown>) } : item), tool_calls: message.toolCalls?.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(projectToolInput(call.name, call.input)) } })) }
}

function isTextAttachment(mimeType: string): boolean { return mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mimeType) }
function decodeAttachmentText(data: string, size: number): string { try { return Buffer.from(data, 'base64').subarray(0, Math.min(size, 500_000)).toString('utf8') } catch { return '[تعذر قراءة محتوى المرفق]' } }

function validateCallIds(calls: ModelToolCall[]): void { const ids = new Set<string>(); for (const call of calls) { if (!call.id || !call.name) throw new Error('أعاد المزود استدعاء أداة بلا id أو name'); if (ids.has(call.id)) throw new Error(`كرر المزود tool call id: ${call.id}`); ids.add(call.id) } }

function createStepSignature(calls: ModelToolCall[], validations: Array<{ ok: boolean; input: Record<string, unknown> }>): string {
  return JSON.stringify(calls.map((call, index) => ({ name: call.name, input: validations[index]?.input ?? {} })))
}

function validateToolCall(call: ModelToolCall, definitions: ToolDefinition[] = toolDefinitions): { ok: true; input: Record<string, unknown> } | { ok: false; input: Record<string, unknown>; error: string } {
  const definition = definitions.find((item) => item.function.name === call.name)
  if (!definition) return { ok: false, input: {}, error: `الأداة غير معروفة: ${call.name}` }
  let input: Record<string, unknown>
  try { const parsed = JSON.parse(call.arguments); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('يجب أن تكون المدخلات object'); input = parsed as Record<string, unknown> } catch (error) { return { ok: false, input: {}, error: `JSON غير صالح: ${error instanceof Error ? error.message : String(error)}` } }
  const schema = definition.function.parameters as { properties?: Record<string, { type?: string; minimum?: number; maximum?: number }>; required?: string[]; additionalProperties?: boolean }
  for (const key of schema.required ?? []) if (!(key in input)) return { ok: false, input, error: `الحقل المطلوب مفقود: ${key}` }
  if (schema.additionalProperties === false) for (const key of Object.keys(input)) if (!schema.properties?.[key]) return { ok: false, input, error: `حقل غير مسموح: ${key}` }
  for (const [key, value] of Object.entries(input)) { const rule = schema.properties?.[key]; if (!rule) continue; if (rule.type === 'array' && typeof value === 'string') { try { const parsed = JSON.parse(value); if (!Array.isArray(parsed)) return { ok: false, input, error: `نوع الحقل ${key} غير صحيح` }; input[key] = parsed } catch { return { ok: false, input, error: `نوع الحقل ${key} غير صحيح` } } } if (rule.type === 'string' && typeof value !== 'string' || rule.type === 'boolean' && typeof value !== 'boolean' || rule.type === 'array' && !Array.isArray(value) || (rule.type === 'number' || rule.type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value) || rule.type === 'integer' && !Number.isInteger(value))) return { ok: false, input, error: `نوع الحقل ${key} غير صحيح` }; if (typeof value === 'number' && (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum)) return { ok: false, input, error: `قيمة الحقل ${key} خارج النطاق` } }
  return { ok: true, input }
}

function userTurns(messages: StoredMessage[]): StoredMessage[][] { const turns: StoredMessage[][] = []; for (const message of messages) { if (message.role === 'user' || !turns.length) turns.push([]); turns.at(-1)!.push(message) } return turns }
function summaryLine(message: StoredMessage): string { const tools = message.toolCalls?.map((call) => `${call.name}(${JSON.stringify(projectToolInput(call.name, call.input)).slice(0, 500)}): ${call.output?.slice(0, 1500) ?? call.status}`).join('\n') ?? ''; return `[seq ${message.sequence}] ${message.role}: ${message.content.slice(0, 4000)}${tools ? `\n${tools}` : ''}` }
function compactToolResult(message: ModelInput, previewChars: number): string { const contentStr = typeof message.content === 'string' ? message.content : JSON.stringify(message.content); let metadata = ''; try { const parsed = JSON.parse(contentStr); const data = parsed?.data; metadata = JSON.stringify({ ok: parsed?.ok, path: data?.path, totalLines: data?.totalLines, range: data?.range, count: data?.count, truncated: data?.truncated, bytes: data?.bytes }) } catch {} const retrieveHint = message.messageId ? `\n[استرجع النص الكامل عبر read_message بمعرّف ${message.messageId}]` : ''; return `${metadata ? `${metadata}\n` : ''}${contentStr.slice(0, previewChars)}\n[تم استهلاك هذه النتيجة في جولة سابقة وضغط محتواها الخام؛ أعد قراءة النطاق فقط إذا احتجت تفاصيله.]${retrieveHint}` }

function compactContextMessages(messages: ModelInput[], previewChars: number, keepUserTurns: number): void {
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
function mergeUsage(first: ModelUsage | undefined, second: ModelUsage | undefined): ModelUsage | undefined { if (!first) return second; if (!second) return first; return { input: first.input + second.input, output: first.output + second.output, total: (first.total ?? first.input + first.output) + (second.total ?? second.input + second.output), cacheRead: (first.cacheRead ?? 0) + (second.cacheRead ?? 0), cacheWrite: (first.cacheWrite ?? 0) + (second.cacheWrite ?? 0), reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) } }
async function runWithConcurrency(count: number, concurrency: number, execute: (index: number) => Promise<void>): Promise<void> { let next = 0; const worker = async (): Promise<void> => { while (next < count) { const index = next++; await execute(index) } }; await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker())) }
function projectToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> { if (name === 'write_file' && typeof input.content === 'string') { const { content, ...rest } = input; return { ...rest, contentReceipt: contentReceipt(content, input.path) } } if (name === 'edit_file') { const result = { ...input }; if (typeof result.old_string === 'string' && result.old_string.length > 2_000) { result.oldStringReceipt = contentReceipt(result.old_string, input.path); delete result.old_string } if (typeof result.new_string === 'string' && result.new_string.length > 2_000) { result.newStringReceipt = contentReceipt(result.new_string, input.path); delete result.new_string } return result } return input }
function contentReceipt(content: string, pathValue: unknown): Record<string, unknown> { return { bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), persistedAtPath: pathValue, note: 'المحتوى الكامل محفوظ في سجل الجلسة والملف الناتج؛ استخدم read_file/read_files عند الحاجة إليه.' } }
function projectProviderPayload(payload: unknown[] | undefined): unknown[] | undefined { if (!payload) return undefined; return payload.map((item) => { if (!item || typeof item !== 'object') return item; const value = item as Record<string, unknown>; if (value.type !== 'function_call' || typeof value.name !== 'string' || typeof value.arguments !== 'string') return item; try { const input = JSON.parse(value.arguments) as Record<string, unknown>; return { ...value, arguments: JSON.stringify(projectToolInput(value.name, input)) } } catch { return item } }) }
function forceCompactForOverflow(messages: ModelInput[]): ModelInput[] {
  const result = messages.map((message) => ({ ...message }))
  let userSeen = 0
  let assistantCallsSeen = 0
  for (let index = result.length - 1; index >= 0; index--) {
    const message = result[index]!
    if (message.role === 'user') userSeen++
    if (message.role === 'assistant' && message.tool_calls) {
      assistantCallsSeen++
      if (assistantCallsSeen > 2) {
        message.tool_calls = message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: call.function.arguments.length > 2_000 ? JSON.stringify({ receipt: 'مدخل أداة قديم محفوظ في السجل الكامل' }) : call.function.arguments } }))
      }
    }
    if (message.role === 'tool' && (userSeen >= 1 || message.content.length > 2_000)) message.content = compactToolResult(message, 500)
  }
  return result
}
