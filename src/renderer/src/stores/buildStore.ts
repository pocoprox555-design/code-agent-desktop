/**
 * Build Store — Zustand state for Build → Preview → Share page
 * Includes dedicated build chat session
 */
import { create } from 'zustand'
import type {
  BuildProject, BuildProjectOpenPayload, BuildRunInfo, BuildStats, Checkpoint, DevServerState, DeployState, ProjectFile, Todo, ToolCallRecord,
  ScaffoldResult, SubagentEvent, TemplateInfo, UsageSummary,
} from '../../../shared/types'

export interface BuildChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  reasoning?: string
  reasoningActive?: boolean
  createdAt: number
  streaming?: boolean
  toolCalls?: ToolCallRecord[]
}
export interface BuildTelemetry { rounds: number; estimatedTokens: number; contextWindow: number; compacted: boolean; toolMs: number }

export interface BuildStore {
  // المشروع الحالي
  project: BuildProject | null
  setProject(project: BuildProject | null): void

  // المشاريع المحفوظة (من خادم Build المنفصل)
  savedProjects: BuildProject[]
  setSavedProjects(projects: BuildProject[]): void
  loadSavedProjects(): Promise<void>
  registerProject(input: { name: string; path: string; template: string; filesCount: number; totalLines: number }): Promise<BuildProject>
  saveProject(input: { name: string; path: string; template: string; filesCount: number; totalLines: number }): Promise<BuildProject>
  openProject(id: string): Promise<void>
  removeProject(id: string): Promise<void>
  clearChat(): Promise<void>
  resumeProject(): Promise<void>
  closeProject(): Promise<void>

  // القوالب
  templates: TemplateInfo[]
  setTemplates(templates: TemplateInfo[]): void

  // إنشاء مشروع جديد
  scaffoldResult: ScaffoldResult | null
  isCreating: boolean
  createError: string | null
  setScaffoldResult(result: ScaffoldResult | null): void
  setCreating(creating: boolean): void
  setCreateError(error: string | null): void

  // خادم التطوير
  server: DevServerState
  setServer(state: DevServerState): void

  // ملخص الملفات
  files: ProjectFile[]
  setFiles(files: ProjectFile[]): void
  stats: BuildStats
  setStats(stats: BuildStats): void

  // الملف النشط
  activeFile: string | null
  activeContent: string
  setActiveFile(path: string | null, content?: string): void

  // حالة التطبيق
  phase: 'home' | 'empty' | 'creating' | 'ready' | 'running' | 'error'
  setPhase(phase: BuildStore['phase']): void

  // النشر
  deploy: DeployState
  setDeploy(state: DeployState): void

  // ─── شات البناء المخصص ───
  buildSessionId: string | null
  setBuildSessionId(id: string | null): void
  run: BuildRunInfo | null
  setRun(run: BuildRunInfo | null): void
  pendingApproval: import('../../../shared/types').ApprovalRequest | null
  setPendingApproval(request: import('../../../shared/types').ApprovalRequest | null): void
  awaitingRunStart: boolean
  setAwaitingRunStart(value: boolean): void
  cancelledRunIds: Set<string>
  markRunCancelled(runId: string): void
  usage: UsageSummary
  setUsage(usage: UsageSummary): void
  telemetry: BuildTelemetry
  setContextTelemetry(context: { estimatedTokens: number; contextWindow: number; compacted: boolean }): void
  recordToolTelemetry(tool: ToolCallRecord): void
  subagents: SubagentEvent[]
  checkpoints: Checkpoint[]

  /** خطة العمل الحية للوكيل (todo_write) — تُعرض في شات Build */
  todos: Todo[]
  setTodos(todos: Todo[]): void

  chatMessages: BuildChatMessage[]
  addChatMessage(msg: BuildChatMessage): void
  removeChatMessage(id: string): void
  updateChatMessage(id: string, content: string, toolCalls?: ToolCallRecord[], reasoning?: string): void
  updateChatReasoning(id: string, reasoning: string, active: boolean): void
  finishChatMessage(id: string): void
  finishAllChatMessages(): void

  chatModel: string
  setChatModel(model: string): void
}

export const useBuildStore = create<BuildStore>((set, get) => ({
  project: null,
  setProject: (project) => set({ project }),

  savedProjects: [],
  setSavedProjects: (savedProjects) => set({ savedProjects }),
  loadSavedProjects: async () => {
    try { set({ savedProjects: await window.rCode.buildProjects.list() }) } catch { /* لا تكسر الصفحة */ }
  },
  registerProject: async (input) => {
    const project = await window.rCode.buildProjects.save(input)
    const payload = await window.rCode.buildProjects.open(project.id)
    const [scan, stats, serverStatus] = await Promise.all([
      window.rCode.build.readFiles(project.id),
      window.rCode.build.getStats(project.id),
      window.rCode.devserver.status(project.id),
    ])
    hydrate(set, payload, scan.files, stats, serverStatus)
    await get().loadSavedProjects()
    return project
  },
  saveProject: async (input): Promise<BuildProject> => get().registerProject(input),
  openProject: async (id) => {
    const requestId = ++openProjectRequestId
    const current = get().project
    if (current && current.id !== id) {
      // R12: نلغي وكيل المشروع القديم أيضًا (كان يستمر بالعمل في الخلفية حتى 30 دقيقة)
      try { await window.rCode.buildAgent.cancel(current.id) } catch {}
      try { await window.rCode.devserver.stop(current.id) } catch {}
    }
    const payload = await window.rCode.buildProjects.open(id)
    const [scan, stats, serverStatus] = await Promise.all([
      window.rCode.build.readFiles(payload.project.id),
      window.rCode.build.getStats(payload.project.id),
      // R3: استعادة حالة الخادم الحقيقية — إذا كان الخادم يعمل فعلًا يظهر الرابط فورًا
      window.rCode.devserver.status(payload.project.id),
    ])
    if (requestId !== openProjectRequestId) return
    hydrate(set, payload, scan.files, stats, serverStatus)
    await get().loadSavedProjects()
  },
  removeProject: async (id) => {
    await window.rCode.buildProjects.remove(id)
    const state = get()
    const removedCurrent = state.project?.id === id
    if (removedCurrent) {
      set({ project: null, buildSessionId: null, chatMessages: [], files: [], server: { running: false }, activeFile: null, activeContent: '', phase: 'home', createError: null, run: null, pendingApproval: null, awaitingRunStart: false })
    }
    await state.loadSavedProjects()
  },

  templates: [],
  setTemplates: (templates) => set({ templates }),

  scaffoldResult: null,
  isCreating: false,
  createError: null,
  setScaffoldResult: (result) => set({ scaffoldResult: result }),
  setCreating: (creating) => set({ isCreating: creating }),
  setCreateError: (error) => set({ createError: error }),

  server: { running: false },
  setServer: (server) => set({ server }),

  files: [],
  setFiles: (files) => set({ files }),
  stats: { files: 0, lines: 0, size: 0, truncated: false },
  setStats: (stats) => set({ stats }),

  activeFile: null,
  activeContent: '',
  setActiveFile: (path, content) => set({ activeFile: path, activeContent: content ?? '' }),

  phase: 'home',
  setPhase: (phase) => set({ phase }),

  deploy: { status: 'idle' },
  setDeploy: (deploy) => set({ deploy }),

  // شات البناء
  buildSessionId: null,
  setBuildSessionId: (id) => set({ buildSessionId: id }),
  run: null,
  setRun: (run) => set({ run }),
  pendingApproval: null,
  setPendingApproval: (pendingApproval) => set({ pendingApproval }),
  awaitingRunStart: false,
  setAwaitingRunStart: (awaitingRunStart) => set({ awaitingRunStart }),
  cancelledRunIds: new Set<string>(),
  markRunCancelled: (runId) => set((state) => {
    const next = new Set(state.cancelledRunIds)
    next.add(runId)
    // حد أمان: لا نكدّس معرّفات ملغاة طوال عمر التطبيق
    while (next.size > 64) next.delete(next.values().next().value!)
    return { cancelledRunIds: next }
  }),
  usage: { requests: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimatedInput: 0, cost: 0 },
  setUsage: (usage) => set({ usage }),
  telemetry: { rounds: 0, estimatedTokens: 0, contextWindow: 0, compacted: false, toolMs: 0 },
  setContextTelemetry: (context) => set((state) => ({ telemetry: { ...state.telemetry, ...context, rounds: state.telemetry.rounds + 1 } })),
  recordToolTelemetry: (tool) => set((state) => ({ telemetry: { ...state.telemetry, toolMs: state.telemetry.toolMs + (tool.startedAt && tool.completedAt ? Math.max(0, tool.completedAt - tool.startedAt) : 0) } })),
  subagents: [],
  checkpoints: [],

  todos: [],
  setTodos: (todos) => set({ todos }),

  chatMessages: [],
  addChatMessage: (msg) => set((s) => ({ chatMessages: [...s.chatMessages, msg] })),
  removeChatMessage: (id) => set((s) => ({ chatMessages: s.chatMessages.filter((message) => message.id !== id) })),
  updateChatMessage: (id, content, toolCalls, reasoning) => set((s) => ({
    chatMessages: s.chatMessages.map((m) => m.id === id ? { ...m, content, ...(toolCalls ? { toolCalls } : {}), ...(reasoning !== undefined ? { reasoning, reasoningActive: false } : {}) } : m),
  })),
  updateChatReasoning: (id, reasoning, active) => set((s) => ({
    chatMessages: s.chatMessages.map((m) => m.id === id ? { ...m, reasoning, reasoningActive: active } : m),
  })),
  finishChatMessage: (id) => set((s) => ({
    chatMessages: s.chatMessages.map((m) => m.id === id ? { ...m, streaming: false } : m),
  })),
  finishAllChatMessages: () => set((s) => ({
    chatMessages: s.chatMessages.map((m) => m.streaming ? { ...m, streaming: false } : m),
  })),
  clearChat: async () => {
    const current = get()
    if (!current.project) return
    if (current.run?.runId) current.markRunCancelled(current.run.runId)
    await window.rCode.buildProjects.clearChat(current.project.id)
    // R12: نزيل previewStarting العالق حتى لا تبقى لوحة المعاينة "جارٍ تجهيز الخادم..." للأبد
    set({ chatMessages: [], run: null, pendingApproval: null, awaitingRunStart: false, todos: [], server: { ...current.server, previewStarting: false }, telemetry: { rounds: 0, estimatedTokens: 0, contextWindow: 0, compacted: false, toolMs: 0 } })
  },
  resumeProject: async () => {
    const current = get()
    if (!current.project || !current.run?.resumable) return
    set({ awaitingRunStart: true, pendingApproval: null })
    try { await window.rCode.buildAgent.resume(current.project.id) } catch (error) { set({ awaitingRunStart: false }); throw error }
  },
  closeProject: async () => {
    const current = get()
    if (current.project) {
      if (current.run?.runId) current.markRunCancelled(current.run.runId)
      try { await window.rCode.buildAgent.cancel(current.project.id) } catch {}
      try { await window.rCode.devserver.stop(current.project.id) } catch {}
    }
    set({ project: null, buildSessionId: null, chatMessages: [], files: [], server: { running: false }, activeFile: null, activeContent: '', phase: 'home', createError: null, run: null, pendingApproval: null, awaitingRunStart: false, todos: [], stats: { files: 0, lines: 0, size: 0, truncated: false } })
    await get().loadSavedProjects()
  },

  chatModel: '',
  setChatModel: (model) => set({ chatModel: model }),
}))

let openProjectRequestId = 0

function hydrate(set: (partial: Partial<BuildStore>) => void, payload: BuildProjectOpenPayload, files: ProjectFile[], stats: BuildStats, serverStatus?: DevServerState): void {
  const chatMessages = payload.messages.filter((message) => message.role !== 'tool').map((message) => ({ id: message.id, role: message.role as 'user' | 'assistant' | 'system', content: message.content, reasoning: message.reasoning, createdAt: message.createdAt, toolCalls: message.toolCalls }))
  // لا تنقل رابط خادم المشروع السابق إلى المشروع المفتوح حديثًا؛ نستعيد الحالة الحقيقية من المدير
  const server = serverStatus?.running && serverStatus.url
    ? { ...serverStatus, projectId: payload.project.id, projectPath: payload.project.path }
    : { running: false, projectId: payload.project.id, projectPath: payload.project.path }
  set({ project: payload.project, buildSessionId: payload.project.chatSessionId, phase: 'ready', chatMessages, files, stats, server, activeFile: null, activeContent: '', createError: null, run: payload.run ?? null, usage: payload.usage, telemetry: { rounds: payload.run?.step ?? 0, estimatedTokens: 0, contextWindow: 0, compacted: false, toolMs: 0 }, subagents: payload.subagents, checkpoints: payload.checkpoints, todos: payload.todos ?? [], pendingApproval: null, awaitingRunStart: false })
}
