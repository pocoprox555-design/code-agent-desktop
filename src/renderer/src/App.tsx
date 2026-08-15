import { memo, startTransition, useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DOMPurify from 'dompurify'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Bot, Brain, Check, CheckCircle2, ChevronDown, Code2, Copy, FileText, FolderOpen, Gauge, KeyRound, Link, ListChecks, LoaderCircle, Paperclip, PanelLeft, PanelRight, Pencil, Play, Plus, Search, Send, Settings, Shield, ShieldAlert, Square, Terminal as TerminalIcon, Trash2, Undo2, X, XCircle } from 'lucide-react'
import { ExecutionTimeline as ExecutionTimelineImpl } from './components/ExecutionTimeline'
import { CodeBlock } from './components/CodeBlock'
import { SettingsModal } from './components/SettingsModal'
import { ApprovalModal, GitInitModal, TodoList } from './components/Modals'
import ModelSelect from './components/ModelSelector'
import { useFocusTrap } from './hooks/useFocusTrap'
import type { AgentEvent, AgentRunState, ApprovalRequest, Attachment, AuditEvent, CustomPrompt, Message, ProviderSettings, RuntimeMarker, Session, SessionRunState, Subagent, SubagentEvent, Todo, ToolCallRecord, TreeEntry, UsageSummary } from '../../shared/types'
import { getGoModel, GO_MODELS, goProviderConfig } from '../../shared/models'
import { BuildPage } from './components/BuildPage'

type Phase = 'initializing' | 'loading' | 'idle' | 'running' | 'awaiting_approval' | 'stopping' | 'failed' | 'interrupted'
interface SessionView { messages: Message[]; streamingId: string | null; phase: Phase; status: string; error: string | null; runId: string | null; todos: Todo[]; subagents: SubagentEvent[]; context: { estimatedTokens: number; compacted: boolean; contextWindow: number }; usage: UsageSummary }
const emptyUsage: UsageSummary = { requests: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimatedInput: 0, cost: 0 }
const emptyView: SessionView = { messages: [], streamingId: null, phase: 'idle', status: '', error: null, runId: null, todos: [], subagents: [], context: { estimatedTokens: 0, compacted: false, contextWindow: 0 }, usage: emptyUsage }
const initialConfig = goProviderConfig()
const defaultProvider: ProviderSettings = { name: initialConfig.name, baseUrl: initialConfig.baseUrl, apiPath: initialConfig.apiPath, apiStyle: initialConfig.apiStyle, model: initialConfig.model, contextWindow: initialConfig.contextWindow, maxOutputTokens: initialConfig.maxOutputTokens, hasApiKey: false }

export function decideRunAdoption(event: AgentEvent, knownRun: string | null | undefined, phase: Phase | undefined, cancelledRunIds?: Set<string>): { accept: boolean; adoptRunId: string | null } {
  if (event.type === 'run:start' && event.runId) {
    // منع اعتماد run مُلغى (حدث متأخر من الإلغاء)
    if (cancelledRunIds?.has(event.runId)) return { accept: false, adoptRunId: null }
    return { accept: true, adoptRunId: event.runId }
  }
  if (event.runId && knownRun && event.runId !== knownRun) return { accept: false, adoptRunId: null }
  if (!event.runId && knownRun && phase === 'idle') return { accept: false, adoptRunId: null }
  return { accept: true, adoptRunId: null }
}

export function selectApproval(approvals: ApprovalRequest[], activeSessionId: string | null): ApprovalRequest | null {
  return approvals.find((item) => item.sessionId === activeSessionId) ?? approvals[0] ?? null
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [views, setViews] = useState<Record<string, SessionView>>({})
  const [input, setInput] = useState('')
  const [settings, setSettings] = useState(false)
  const [provider, setProvider] = useState<ProviderSettings>(defaultProvider)
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [answeringApproval, setAnsweringApproval] = useState<string | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [runtimeMarker, setRuntimeMarker] = useState<RuntimeMarker | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760)
  const [planOpen, setPlanOpen] = useState(false)
  const [planExpanded, setPlanExpanded] = useState(false)
  const planUserClosed = useRef(false)
  const prevAllDone = useRef(false)
  const [showLatest, setShowLatest] = useState(false)
  const [sessionQuery, setSessionQuery] = useState('')
  const [gitPrompt, setGitPrompt] = useState<{ workspace: string } | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([])
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([])
  const [treeSessionId, setTreeSessionId] = useState<string | null>(null)
  const [selectionLoading, setSelectionLoading] = useState(false)
  const [projectFilesOpen, setProjectFilesOpen] = useState(false)
  const [runState, setRunState] = useState<AgentRunState | undefined>()
  const [sessionPrompt, setSessionPrompt] = useState('')
  const [savedPrompts, setSavedPrompts] = useState<CustomPrompt[]>([])
  const [promptPanelOpen, setPromptPanelOpen] = useState(false)
  const [newPromptTitle, setNewPromptTitle] = useState('')
  const [newPromptContent, setNewPromptContent] = useState('')
  const [subagentsPage, setSubagentsPage] = useState(false)
  const [buildPageOpen, setBuildPageOpen] = useState(false)
  const [subagents, setSubagents] = useState<Subagent[]>([])
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [cancelledRunIds, setCancelledRunIds] = useState<Set<string>>(new Set())
  const endRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const followRef = useRef(true)
  const sendLock = useRef(new Set<string>())
  const pendingSendRef = useRef<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const selectionGeneration = useRef(0)
  const viewsRef = useRef(views)
  const cancelledRunIdsRef = useRef(cancelledRunIds)

  const active = sessions.find((session) => session.id === activeId) ?? null
  const view = activeId ? views[activeId] ?? emptyView : emptyView
	  const visibleSessions = sessions.filter((session) => !session.parentSessionId)
  const hasMessages = view.messages.some((message) => message.role !== 'tool')
  const approval = selectApproval(approvals, activeId)
  activeIdRef.current = activeId
  viewsRef.current = views

  useEffect(() => { void initialize() }, [])
  useEffect(() => { cancelledRunIdsRef.current = cancelledRunIds }, [cancelledRunIds])
  useEffect(() => {
    const events = window.rCode?.events
    return events?.onAgent(onEvent)
  }, [])
  useEffect(() => {
    const events = window.rCode?.events
    if (!events) return
    return events.onApproval((request) => {
    setApprovals((items) => items.some((item) => item.id === request.id) ? items : [...items, request])
    updateView(request.sessionId, (current) => current.runId && request.runId && current.runId !== request.runId ? current : ({ ...current, runId: request.runId ?? current.runId, phase: 'awaiting_approval', status: 'متوقف مؤقتًا بانتظار موافقتك' }))
    })
  }, [])
  useEffect(() => { if (followRef.current && virtuosoRef.current) virtuosoRef.current.autoscrollToBottom() }, [view.messages, view.status])
  useEffect(() => { if (view.todos.length > 0 && view.phase !== 'idle' && !planUserClosed.current) setPlanOpen(true) }, [view.todos.length, view.phase])
  useEffect(() => {
    const allDone = view.todos.length > 0 && view.todos.every((todo) => todo.status === 'completed' || todo.status === 'cancelled')
    if (allDone && !prevAllDone.current) { setPlanOpen(false); setPlanExpanded(false) }
    prevAllDone.current = allDone
  }, [view.todos])
  useEffect(() => { if (!sidebarOpen) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false) }; document.addEventListener('keydown', onKeyDown); return () => document.removeEventListener('keydown', onKeyDown) }, [sidebarOpen])

  async function initialize() {
    try {
       const [rows, settingsValue, states, marker] = await Promise.all([window.rCode.sessions.list(), window.rCode.provider.get(), window.rCode.agent.states(), window.rCode.diagnostics.runtimeMarker()])
      const visible = rows.filter((row) => !row.parentSessionId)
       setSessions(rows); setProvider(settingsValue); applyStates(states); setApprovals(states.flatMap((state) => state.pendingApprovals ?? [])); setRuntimeMarker(marker)
      if (visible[0]) await select(visible[0])
      else setSettings(!settingsValue.hasApiKey)
    } catch (error) { setAppError(errorText(error)) }
  }

  function applyStates(states: SessionRunState[]) { for (const state of states) updateView(state.sessionId, (current) => ({ ...current, runId: state.runId ?? current.runId, phase: state.state === 'idle' ? 'idle' : state.state === 'failed' ? 'failed' : state.state === 'cancelling' ? 'stopping' : state.state === 'awaiting_approval' ? 'awaiting_approval' : 'running', status: state.status, error: state.error ?? current.error })) }
  function updateView(sessionId: string, update: (current: SessionView) => SessionView) { startTransition(() => setViews((items) => ({ ...items, [sessionId]: update(items[sessionId] ?? emptyView) }))) }

	  function onEvent(event: AgentEvent) {
	    const current = viewsRef.current[event.sessionId]
    const knownRun = current?.runId
    const decision = decideRunAdoption(event, knownRun, current?.phase, cancelledRunIdsRef.current)
    if (!decision.accept) return
    if (decision.adoptRunId) {
      updateView(event.sessionId, (view) => ({ ...view, runId: decision.adoptRunId }))
      setApprovals((items) => items.filter((item) => !(item.sessionId === event.sessionId && item.runId && item.runId !== event.runId)))
    }
    if (event.type === 'todo' && event.todos) setSessions((items) => items.map((session) => session.id === event.sessionId ? { ...session, todos: event.todos! } : session))
    updateView(event.sessionId, (current) => {
      const withUsage = event.usage ? { ...current, usage: event.usage.total } : current
      if (event.type === 'message' && event.message) return { ...withUsage, messages: upsertMessage(current.messages, event.message) }
      if (event.type === 'stream' && event.stream) {
        const stream = event.stream
        if (stream.state === 'start') return { ...withUsage, streamingId: stream.id, messages: upsertMessage(current.messages, { id: stream.id, sessionId: event.sessionId, role: 'assistant', content: '', createdAt: Date.now() }) }
        if (stream.state === 'delta' && stream.reasoning) return { ...withUsage, messages: current.messages.map((message) => message.id === stream.id ? { ...message, reasoning: (message.reasoning ?? '') + stream.delta } : message) }
        if (stream.state === 'delta') return { ...withUsage, messages: current.messages.map((message) => message.id === stream.id ? { ...message, content: message.content + stream.delta } : message) }
        return { ...withUsage, streamingId: null, messages: current.messages.filter((message) => message.id !== stream.id || Boolean(message.content) || Boolean(message.toolCalls?.length)) }
      }
      if (event.type === 'tool' && event.tool) return { ...withUsage, messages: current.messages.map((message) => message.toolCalls?.some((tool) => tool.id === event.tool!.id) ? { ...message, toolCalls: message.toolCalls.map((tool) => tool.id === event.tool!.id ? event.tool! : tool) } : message) }
      if (event.type === 'status') {
        // تجاهل أحداث الحالة من run مختلف (حدث متأخر من جلسة سابقة)
        if (event.runId && current.runId && event.runId !== current.runId) return current
        const nextPhase = current.phase === 'stopping' ? 'stopping'
          : current.phase === 'idle' ? 'idle'  // حماية: لا تعد للحياة بعد الإلغاء
          : event.text?.includes('موافقت') ? 'awaiting_approval'
          : !event.text ? 'idle'
          : 'running'
        return { ...withUsage, runId: event.runId ?? current.runId, status: event.text ?? '', phase: nextPhase }
      }
      if (event.type === 'error') { const error = event.text ?? 'حدث خطأ غير معروف'; const alreadySaved = current.messages.some((message) => message.role === 'assistant' && (message.content === error || message.content === `فشل التنفيذ: ${error}`)); return { ...withUsage, phase: 'failed', status: '', error, streamingId: null, messages: alreadySaved ? current.messages : current.messages.map((message) => message.id === current.streamingId ? { ...message, interrupted: true, content: message.content ? `${message.content}\n\n[رد غير مكتمل بسبب فشل المزود]` : message.content } : message) } }
      if (event.type === 'todo' && event.todos) return { ...withUsage, todos: event.todos }
      if (event.type === 'subagent' && event.subagent) return { ...withUsage, subagents: upsertSubagent(current.subagents, event.subagent) }
      if (event.type === 'context' && event.context) return { ...withUsage, context: event.context }
      return withUsage
    })
  }

  async function select(session: Session) {
    const generation = ++selectionGeneration.current
    setActiveId(session.id); setSelectionLoading(true); setTreeEntries([]); setTreeSessionId(null); setProjectFilesOpen(false); followRef.current = true; setShowLatest(false); setPlanOpen(false); setPlanExpanded(false); planUserClosed.current = false; prevAllDone.current = false
    if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false)
    try { const [loaded, usage, subagents, tree, persistedRun] = await Promise.all([window.rCode.sessions.messages(session.id), window.rCode.sessions.usage(session.id), window.rCode.sessions.subagents(session.id), window.rCode.files.list(session.id), window.rCode.sessions.run(session.id)]); if (generation !== selectionGeneration.current || activeIdRef.current !== session.id) return; setTreeEntries(tree); setTreeSessionId(session.id); setRunState(persistedRun); updateView(session.id, (current) => ({ ...current, phase: persistedRun?.status === 'interrupted' ? 'interrupted' : current.phase, runId: current.runId ?? persistedRun?.runId ?? null, messages: mergeMessages(loaded, current.messages), usage, todos: session.todos, subagents })) }
    catch (error) { if (generation === selectionGeneration.current) updateView(session.id, (current) => ({ ...current, phase: 'failed', error: errorText(error) })) }
    finally { if (generation === selectionGeneration.current) setSelectionLoading(false) }
  }

  async function newSession() {
    try {
      const workspace = active?.workspace ?? await window.rCode.files.chooseFolder()
      if (!workspace) return
      setGitPrompt({ workspace })
    } catch (error) { setAppError(errorText(error)) }
  }

  async function openProject() {
    try {
      const workspace = await window.rCode.files.chooseFolder()
      if (!workspace) return
      setGitPrompt({ workspace })
    } catch (error) { setAppError(errorText(error)) }
  }

  async function createSessionWithGit(workspace: string, initGit: boolean) {
    try {
      const session = await window.rCode.sessions.create({ workspace, initGit })
      setGitPrompt(null)
      setSessions((items) => [session, ...items]); await select(session)
      // إرسال الرسالة المعلّقة التي كتبها المستخدم قبل إنشاء الجلسة
      const pending = pendingSendRef.current
      if (pending) { pendingSendRef.current = null; setInput(pending); void send(pending) }
    } catch (error) { setAppError(errorText(error)) }
  }

  async function removeSession(session: Session) {
    if (!window.confirm(`حذف المحادثة "${session.title}" نهائيًا؟ لا يمكن التراجع.`)) return
    try {
      await window.rCode.sessions.remove(session.id)
      setSessions((items) => items.filter((item) => item.id !== session.id))
      setViews((items) => { const next = { ...items }; delete next[session.id]; return next })
      if (activeId === session.id) {
        const remaining = visibleSessions.filter((item) => item.id !== session.id)
        if (remaining[0]) await select(remaining[0])
        else { setActiveId(null); setInput('') }
      }
    } catch (error) { setAppError(errorText(error)) }
  }

  async function clearAllSessions() {
    if (!window.confirm(`حذف جميع المحادثات (${sessions.length}) نهائيًا؟ لا يمكن التراجع.`)) return
    try {
      await window.rCode.sessions.clearAll()
      setSessions([])
      setViews({})
      setActiveId(null)
      setInput('')
    } catch (error) { setAppError(errorText(error)) }
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim()
    // لا جلسة نشطة (شاشة البداية): أنشئ جلسة أولًا ثم أرسل الرسالة تلقائيًا
    if (!active) {
      if (!text) return
      pendingSendRef.current = text
      try {
        const workspace = await window.rCode.files.chooseFolder()
        if (!workspace) { pendingSendRef.current = null; return }
        setGitPrompt({ workspace })
      } catch (error) { pendingSendRef.current = null; setAppError(errorText(error)) }
      return
    }
    const session = active
    const waitingForApproval = session ? approvals.some((item) => item.sessionId === session.id) : false
    if (!session || !text || waitingForApproval || view.phase === 'stopping' || view.phase === 'awaiting_approval' || sendLock.current.has(session.id)) return
    sendLock.current.add(session.id)
    const wasRunning = view.phase === 'running' || view.phase === 'interrupted'
    updateView(session.id, (current) => ({ ...current, phase: 'running', status: wasRunning ? 'تصل رسالتك للوكيل في الجولة التالية...' : 'يبدأ التنفيذ...', error: null, subagents: wasRunning ? current.subagents : [] }))
    setInput(''); followRef.current = true; setShowLatest(false)
    try {
      if (!provider.hasApiKey) { setSettings(true); throw new Error('أضف مفتاح API من الإعدادات أولًا') }
      if (!wasRunning && !view.messages.length && session.title === 'محادثة جديدة') {
        const updated = await window.rCode.sessions.update(session.id, { title: text.replace(/\s+/g, ' ').slice(0, 48) })
        setSessions((items) => items.map((item) => item.id === updated.id ? updated : item))
      }
      if (sessionPrompt.trim() && !view.messages.length) {
        const updated = await window.rCode.sessions.setPrompt(session.id, sessionPrompt.trim())
        setSessions((items) => items.map((item) => item.id === updated.id ? updated : item))
        setSessionPrompt('')
      }
      await window.rCode.agent.send(session.id, text, pendingAttachments.length ? pendingAttachments : undefined)
      setPendingAttachments([])
    } catch (error) {
      updateView(session.id, (current) => ({ ...current, phase: 'failed', status: wasRunning ? current.status : '', error: errorText(error) }))
      if (activeIdRef.current === session.id) setInput((current) => current || text)
    } finally { sendLock.current.delete(session.id) }
  }

  async function cancel() {
    if (!active || view.phase === 'idle' || view.phase === 'stopping') return
    const id = active.id
    const runId = view.runId
    // سجّل runId كملغى فورًا لمنع اعتماد أحداث متأخرة
    if (runId) setCancelledRunIds((prev) => { const next = new Set(prev); next.add(runId); return next })
    updateView(id, (current) => ({ ...current, phase: 'stopping', status: 'جارٍ إيقاف التنفيذ...', error: null }))
    try {
      await window.rCode.agent.cancel(id)
      // إصلاح ث2.1: إفراغ approvals لمنع ظهور نموذج موافقة متأخر
      setApprovals((items) => items.filter((item) => item.sessionId !== id))
      // إصلاح ث2.5: تنظيف streamingId + تحديد الرسالة المعلّقة كمقطوعة
      updateView(id, (current) => ({
        ...current,
        phase: 'idle', status: '', runId: null, streamingId: null, error: null,
        messages: current.messages.map((m) => m.id === current.streamingId ? { ...m, interrupted: true, content: m.content ? `${m.content}\n\n[تم الإيقاف]` : '' } : m)
      }))
    }
    catch (error) {
      setApprovals((items) => items.filter((item) => item.sessionId !== id))
      updateView(id, (current) => ({ ...current, phase: 'idle', status: '', runId: null, streamingId: null, error: `تعذر إيقاف التنفيذ: ${errorText(error)}` }))
    }
  }

  async function resume() {
    if (!active) return
    try { if (runState) setRunState({ ...runState, status: 'running' }); await window.rCode.agent.resume(active.id) } catch (error) { setAppError(errorText(error)) }
  }

  const editUserMessage = useCallback((message: Message) => {
    setInput(message.content)
    requestAnimationFrame(() => document.getElementById('agent-prompt')?.focus())
  }, [])

  const regenerateAssistant = useCallback((message: Message) => {
    if (!active || view.phase === 'awaiting_approval' || view.phase === 'stopping' || sendLock.current.has(active.id)) return
    void send(`أعد توليد الرد السابق مع الحفاظ على نفس الطلب وتجنب تكرار الأدوات المكتملة. الرد السابق:\n${message.content.slice(0, 4_000)}`)
  }, [active, view.phase])

  async function updateSession(patch: Partial<Pick<Session, 'permissionMode' | 'agentMode'>>) {
    if (!active) return
    try { const next = await window.rCode.sessions.update(active.id, patch); setSessions((items) => items.map((item) => item.id === next.id ? next : item)) }
    catch (error) { setAppError(errorText(error)) }
  }

  async function approvePlan() {
    if (!active) return
    try {
      const approved = await window.rCode.sessions.approvePlan(active.id)
      setSessions((items) => items.map((item) => item.id === approved.id ? approved : item))
      await updateSession({ agentMode: 'build' })
    } catch (error) { setAppError(errorText(error)) }
  }

  async function changeModel(modelId: string) {
    const previous = provider
    const model = getGoModel(modelId)
    setProvider({ ...provider, model: model.id, apiStyle: model.apiStyle, apiPath: model.apiStyle === 'chat' ? 'chat/completions' : model.apiStyle === 'responses' ? 'responses' : 'messages', contextWindow: model.contextWindow })
    try { setProvider(await window.rCode.provider.save({ model: modelId, contextWindow: model.contextWindow })) } catch (error) { setProvider(previous); setAppError(errorText(error)) }
  }

  async function loadPrompts() {
    try { setSavedPrompts(await window.rCode.prompts.list()) } catch {}
  }

  async function addPrompt() {
    const title = newPromptTitle.trim()
    const content = newPromptContent.trim()
    if (!title || !content) return
    try {
      const saved = await window.rCode.prompts.add(title, content)
      setSavedPrompts((items) => [saved, ...items])
      setNewPromptTitle('')
      setNewPromptContent('')
    } catch (error) { setAppError(errorText(error)) }
  }

  async function removePrompt(id: string) {
    try {
      await window.rCode.prompts.remove(id)
      setSavedPrompts((items) => items.filter((item) => item.id !== id))
    } catch (error) { setAppError(errorText(error)) }
  }

  function applyPrompt(content: string) {
    setInput(content)
    setPromptPanelOpen(false)
  }

  async function loadSubagents() { try { setSubagents(await window.rCode.subagents.list()) } catch {} }
  async function saveSubagent(input: Omit<Subagent, 'id' | 'createdAt' | 'updatedAt'>, editingId?: string) {
    if (editingId) { await window.rCode.subagents.update(editingId, input) }
    else { await window.rCode.subagents.create(input) }
    void loadSubagents()
  }
  async function removeSubagent(id: string) { await window.rCode.subagents.remove(id); loadSubagents() }
  async function toggleSubagent(id: string, enabled: boolean) { await window.rCode.subagents.update(id, { enabled }); loadSubagents() }

  useEffect(() => { void loadPrompts() }, [])

  useEffect(() => { if (subagentsPage) void loadSubagents() }, [subagentsPage])

  async function answerApproval(request: ApprovalRequest, allowed: boolean, remember: boolean) {
    setAnsweringApproval(request.id)
    try { await window.rCode.approval.answer(request.id, allowed, remember); setApprovals((items) => items.filter((item) => item.id !== request.id)) }
    catch (error) { setApprovals((items) => items.filter((item) => item.id !== request.id)); setAppError(errorText(error)) }
    finally { setAnsweringApproval(null) }
  }

  function handleAtBottomChange(atBottom: boolean) { followRef.current = atBottom; setShowLatest(!atBottom) }
  function jumpLatest() { followRef.current = true; setShowLatest(false); virtuosoRef.current?.autoscrollToBottom() }
  const todoProgress = view.todos.length > 0 ? { done: view.todos.filter((todo) => todo.status === 'completed' || todo.status === 'cancelled').length, total: view.todos.length, current: view.todos.find((todo) => todo.status === 'in_progress')?.content } : { done: 0, total: 0, current: undefined as string | undefined }
  // صفحة Build مستقلة تمامًا: تُعرض خارج إطار التطبيق الرئيسي (لا شريط جانبي ولا شريط علوي)
  if (buildPageOpen) return <BuildPage onClose={() => setBuildPageOpen(false)} />
  return <main dir="rtl" className={`app-shell ${sidebarOpen ? '' : 'sidebar-closed'}`}>
    {sidebarOpen && <><button className="sidebar-backdrop" aria-label="إغلاق الشريط الجانبي" onClick={() => setSidebarOpen(false)}/><aside id="app-sidebar" className="sidebar">
      <div className="sidebar-head"><button aria-label="إغلاق الشريط الجانبي" className="sidebar-toggle" onClick={() => setSidebarOpen(false)}><PanelLeft size={16}/></button><div className="brand"><div className="brand-mark"><Code2 size={18}/></div><strong>Code Agent</strong></div></div>
      <div className="project-buttons"><button className="new-task" onClick={() => void newSession()}><Plus size={15}/> مهمة جديدة</button><button className="open-project" onClick={() => void openProject()}><FolderOpen size={15}/> فتح مشروع</button></div>
      <label className="sidebar-search"><Search size={13}/><span className="sr-only">بحث في الجلسات</span><input aria-label="بحث في الجلسات" value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="بحث"/></label>
      <div className="sidebar-section-title">{sessions.length > 0 && <button className="clear-all-btn" onClick={() => clearAllSessions()} title="حذف جميع المحادثات"><Trash2 size={12}/></button>}المشاريع والجلسات</div>
      <div className="sidebar-list">
        {active && <button className={`sidebar-project ${projectFilesOpen ? 'open' : ''}`} aria-expanded={projectFilesOpen} onClick={() => setProjectFilesOpen((open) => !open)}><FolderOpen size={14}/><span>{active.workspace.split(/[\\/]/).pop()}</span><ChevronDown size={13} className="project-chevron"/></button>}
        {active && projectFilesOpen && <div className="file-tree" aria-label="شجرة الملفات">{selectionLoading ? <div className="file-tree-title" role="status">جارٍ تحميل ملفات المشروع...</div> : <><div className="file-tree-title"><FolderOpen size={12}/> ملفات المشروع <span>{treeSessionId === active.id ? treeEntries.length.toLocaleString('ar') : '0'}</span></div>{treeSessionId === active.id && treeEntries.map((entry) => <button className="file-tree-entry" key={entry.path} title={entry.path} onClick={() => void window.rCode.files.read(active.id, entry.path).then((content) => window.rCode.clipboard.writeText(content)).catch((error) => setAppError(errorText(error)))}><span>{entry.directory ? '▸' : '·'}</span><span>{entry.name}</span></button>)}</>}</div>}
        {visibleSessions.filter((session) => `${session.title} ${session.workspace}`.toLowerCase().includes(sessionQuery.trim().toLowerCase())).map((session) => { const itemView = views[session.id]; const state = itemView?.error ? 'error' : itemView?.phase !== 'idle' ? 'running' : ''; return <div key={session.id} className="sidebar-item-wrap"><button aria-current={activeId === session.id ? 'page' : undefined} className={`sidebar-item ${activeId === session.id ? 'active' : ''}`} onClick={() => void select(session)}><span className={`sidebar-dot ${state}`}/><span className="sidebar-item-title">{session.title}</span></button><button aria-label={`حذف المحادثة ${session.title}`} className="sidebar-delete" onClick={() => void removeSession(session)}><Trash2 size={12}/></button></div> })}
      </div>
	       {active && <button className={`sidebar-settings ${subagentsPage ? 'active' : ''}`} onClick={() => setSubagentsPage(!subagentsPage)} aria-label="الوكلاء المخصصون"><Bot size={15}/> الوكلاء</button>}
	       <button className={`sidebar-settings ${buildPageOpen ? 'active' : ''}`} onClick={() => { setBuildPageOpen(!buildPageOpen); setSubagentsPage(false) }} aria-label="بناء ومعاينة"><Play size={15} /> Build</button>
        <div className="sidebar-actions"><button className="sidebar-settings" onClick={() => setSettings(true)} aria-haspopup="dialog"><Settings size={15}/> الإعدادات <span className={`provider-state ${provider.hasApiKey ? 'ready' : ''}`}>{provider.hasApiKey ? 'جاهز' : 'مطلوب'}</span></button>{runtimeMarker && <div className="runtime-marker" title={`${runtimeMarker.appPath} | ${runtimeMarker.mainDir}`} data-testid="runtime-marker">نسخة التطبيق: <code dir="ltr">{runtimeMarker.marker}</code></div>}</div>
    </aside></>}
    {!sidebarOpen && <button aria-label="فتح الشريط الجانبي" aria-controls="app-sidebar" aria-expanded={sidebarOpen} className="sidebar-open-btn" onClick={() => setSidebarOpen(true)}><PanelRight size={16}/></button>}

    <section className="workspace">
        <header className={`topbar ${!hasMessages ? 'topbar-minimal' : ''}`}>
          <div className="topbar-left topbar-context">
            {active && <span className="session-context"><span className="session-title">{active.title}</span><span className="session-separator">/</span><span className="session-project" dir="ltr" title={active.workspace}>{active.workspace.split(/[\\/]/).pop()}</span></span>}
            {hasMessages && active?.systemPrompt && <span className="prompt-badge" title={active.systemPrompt}><Code2 size={11}/> Prompt محفوظ</span>}
          </div>
          <div className="topbar-right">
            {todoProgress.total > 0 && hasMessages && <button aria-pressed={planOpen} aria-label="إظهار أو إخفاء خطة العمل" className={`plan-toggle-btn ${planOpen ? 'on' : ''}`} title={todoProgress.current ? `الخطوة الحالية: ${todoProgress.current}` : 'خطة العمل'} onClick={() => { setPlanOpen(!planOpen); if (!planOpen) planUserClosed.current = false; else planUserClosed.current = true }}><ListChecks size={13}/><span>خطة العمل</span><span className="plan-toggle-progress">{todoProgress.done.toLocaleString('ar')}/{todoProgress.total.toLocaleString('ar')}</span></button>}
             <ModelSelect provider={provider} change={changeModel}/>
            {active && <button aria-pressed={active?.agentMode === 'plan'} className={`mode-pill ${active?.agentMode === 'plan' ? 'plan' : ''}`} onClick={() => void updateSession({ agentMode: active?.agentMode === 'plan' ? 'build' : 'plan' })}>{active?.agentMode === 'plan' ? 'Plan' : 'Build'}</button>}
            {active && <button aria-pressed={active?.permissionMode === 'full'} className={`perm-pill ${active?.permissionMode === 'full' ? 'full' : ''}`} onClick={() => void updateSession({ permissionMode: active?.permissionMode === 'full' ? 'ask' : 'full' })}>{active?.permissionMode === 'full' ? <><ShieldAlert size={13}/> وصول كامل</> : <><Shield size={13}/> اسألني</>}</button>}
            {active && <span className={`git-pill ${active?.gitTracked ? 'on' : ''}`} title={active?.gitTracked ? 'هذه الجلسة تحفظ كل تعديل في Git تلقائيًا' : 'هذه الجلسة دون تتبع Git؛ كل تعديل يُنفذ مباشرة دون commit'}><Code2 size={13}/> {active?.gitTracked ? 'Git مفعّل' : 'Git مققل'}</span>}
            {active && <button aria-label="حذف المحادثة" className="delete-chat-btn" title="حذف المحادثة" onClick={() => void removeSession(active)}><Trash2 size={14}/></button>}
          </div>
        </header>
	       {subagentsPage ? <SubagentsPage subagents={subagents} setSubagents={setSubagents} saveSubagent={saveSubagent} removeSubagent={removeSubagent} toggleSubagent={toggleSubagent} provider={provider}/> : !hasMessages ? <Welcome input={input} setInput={setInput} send={send} provider={provider} changeModel={changeModel} active={active} newSession={newSession} view={view} cancel={cancel} pendingAttachments={pendingAttachments} setPendingAttachments={setPendingAttachments} sessionPrompt={sessionPrompt} setSessionPrompt={setSessionPrompt}/> : <div className="chat-view">
        <div className="chat-messages-container">
          {runState?.status === 'interrupted' && <div className="resume-banner"><span>توقف التشغيل السابق عند الجولة {runState.step.toLocaleString('ar')}.</span><button onClick={() => void resume()}>استئناف التنفيذ</button></div>}
	         {(() => { const convItems = groupConversation(view.messages, view.todos); const latestAssistantId = [...view.messages].reverse().find((m) => m.role === 'assistant')?.id ?? null; const working = view.phase === 'running' || view.phase === 'awaiting_approval' || view.phase === 'initializing' || view.phase === 'loading'; return <Virtuoso ref={virtuosoRef} className={`messages ${view.phase === 'stopping' ? 'agent-stopping' : ''} ${working ? 'is-working' : ''}`} data={convItems} followOutput={() => followRef.current ? 'smooth' : false} atBottomThreshold={130} atBottomStateChange={handleAtBottomChange} itemContent={(_, item) => item.kind === 'execution' ? <MemoExecutionStage messages={item.messages} todoId={item.todoId} todos={view.todos}/> : <MemoMessageBubbleWithActions message={item.message} streaming={view.streamingId === item.message.id} latest={item.message.id === latestAssistantId} onEdit={editUserMessage} onRegenerate={regenerateAssistant}/>} components={{ Footer: () => <>{view.subagents.length > 0 && <SubagentInline subagents={view.subagents}/>}<div ref={endRef}/></> }}/> })()}
          {showLatest && <button aria-label="الانتقال إلى أحدث الرسائل" className="jump-latest" onClick={jumpLatest}><ChevronDown size={14}/> أحدث الرسائل</button>}
           {planOpen && todoProgress.total > 0 && <div id="app-plan" className={`plan-float ${planExpanded ? 'expanded' : ''}`} role="complementary" aria-label="خطة العمل">
             <div className="plan-float-head">
               <button className="plan-float-title" onClick={() => setPlanExpanded(!planExpanded)} aria-expanded={planExpanded} aria-label={planExpanded ? 'طي قائمة خطة العمل' : 'فتح قائمة خطة العمل'}><span className="plan-float-mark"><ListChecks size={13}/></span><strong>خطة العمل</strong><span className="plan-float-progress">{todoProgress.done.toLocaleString('ar')}/{todoProgress.total.toLocaleString('ar')}</span><ChevronDown size={12} className={`plan-float-chev ${planExpanded ? 'rot' : ''}`}/></button>
               <button className="plan-float-close" aria-label="إغلاق خطة العمل بالكامل" onClick={() => { setPlanOpen(false); planUserClosed.current = true }}><X size={12}/></button>
             </div>
             <div className="plan-float-progress-track"><div className="plan-float-progress-bar" style={{ width: `${Math.round(todoProgress.done / todoProgress.total * 100)}%` }}/></div>
             {planExpanded && <>{todoProgress.current && <div className="plan-float-current" title={todoProgress.current}><LoaderCircle size={11} className="spin"/><span>{todoProgress.current}</span></div>}<div className="plan-float-list"><TodoList todos={view.todos}/></div>{active?.agentMode === 'plan' && !active.planApproved && <button className="plan-approve-btn" onClick={() => void approvePlan()}>اعتماد الخطة والانتقال إلى Build</button>}</>}
           </div>}
        </div>
        <Composer input={input} setInput={setInput} send={send} provider={provider} changeModel={changeModel} active={active} view={view} cancel={cancel} dismissError={() => active && updateView(active.id, (current) => ({ ...current, error: null }))} pendingAttachments={pendingAttachments} setPendingAttachments={setPendingAttachments}/>
      </div>}
    </section>

    {appError && <div className="app-error" role="alert"><span>{appError}</span><button aria-label="إغلاق الخطأ" onClick={() => setAppError(null)}><X size={14}/></button></div>}
    {settings && <SettingsModal value={provider} close={() => setSettings(false)} saved={setProvider}/>} 
    {approval && <ApprovalModal request={approval} session={sessions.find((item) => item.id === approval.sessionId)} position={`طلب 1 من ${approvals.length}`} busy={answeringApproval === approval.id} answer={(allowed, remember) => void answerApproval(approval, allowed, remember)}/>} 
    {gitPrompt && <GitInitModal workspace={gitPrompt.workspace} create={(initGit) => void createSessionWithGit(gitPrompt.workspace, initGit)} close={() => setGitPrompt(null)}/>} 
  </main>
}

  function Welcome({ input, setInput, send, provider, changeModel, active, newSession, view, cancel, pendingAttachments, setPendingAttachments, sessionPrompt, setSessionPrompt }: { input: string; setInput(value: string): void; send(text?: string): void; provider: ProviderSettings; changeModel(id: string): void; active: Session | null; newSession(): void; view: SessionView; cancel(): void; pendingAttachments: Attachment[]; setPendingAttachments(value: Attachment[] | ((items: Attachment[]) => Attachment[])): void; sessionPrompt: string; setSessionPrompt(value: string): void }) {
  const prompts: { text: string; icon: typeof Code2 }[] = [
    { text: 'حلل بنية هذا المشروع', icon: Search },
    { text: 'احسب أسطر المشروع واشرح أهم الملفات', icon: Gauge },
    { text: 'راجع المشروع واكتشف الأخطاء ثم أصلحها', icon: Shield },
  ]
  return <div className="welcome-view"><div className="welcome-center"><div className="welcome-icon"><Code2 size={32}/></div><div className="welcome-badge">وكيلك البرمجي المحلي · جاهز للعمل</div><h1>اجعل <span className="accent">عملك البرمجي</span> أسرع وأسهل</h1><p>حلّل مشروعك، اكتب كودًا نظيفًا، نفّذ أدوات آمنة، وراجع الملفات — كل ذلك من محادثة واحدة.</p></div>{active && <div className="prompt-input-wrap"><label className="prompt-label"><Code2 size={13}/> تعليمات النظام (Prompt) — تحفظ تلقائيًا وتبقى فعّالة طوال الجلسة</label><textarea className="prompt-input" placeholder="مثال: لا تحذف أي ملف إلا بعد التأكيد. استخدم Git في كل تعديل. اكتب تعليقات بالعربية..." value={sessionPrompt} onChange={(e) => setSessionPrompt(e.target.value)} rows={3}/></div>}<Composer input={input} setInput={setInput} send={send} provider={provider} changeModel={changeModel} active={active} view={view} cancel={cancel} dismissError={() => {}} pendingAttachments={pendingAttachments} setPendingAttachments={setPendingAttachments}/>{!active && <button className="select-folder" onClick={() => void newSession()}><FolderOpen size={15}/> اختر مجلد المشروع للبدء</button>}<div className="quick-chips">{prompts.map(({ text, icon: Icon }) => <button key={text} onClick={() => setInput(text)}><Icon size={12}/> {text}</button>)}</div></div>
}

 function Composer({ input, setInput, send, provider, changeModel, active, view, cancel, dismissError, pendingAttachments, setPendingAttachments }: { input: string; setInput(value: string): void; send(text?: string): void; provider: ProviderSettings; changeModel(id: string): void; active: Session | null; view: SessionView; cancel(): void; dismissError(): void; pendingAttachments: Attachment[]; setPendingAttachments(value: Attachment[] | ((items: Attachment[]) => Attachment[])): void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lines = input ? input.split(/\r\n|\n|\r/).length : 0
  const windowSize = view.context.contextWindow || provider.contextWindow
  const contextPercent = view.context.estimatedTokens ? Math.min(100, Math.round(view.context.estimatedTokens / windowSize * 100)) : 0
  function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files
    if (!files) return
    for (const file of Array.from(files)) {
      if (file.size > 20_000_000) { console.warn(`${file.name} أكبر من 20 ميغابايت`); continue }
      const reader = new FileReader()
      reader.onload = () => { const data = reader.result; if (typeof data === 'string') { const base64 = data.split(',')[1] ?? ''; setPendingAttachments((items) => [...items, { name: file.name, mimeType: file.type || 'application/octet-stream', data: base64, size: file.size }]) } }
      reader.readAsDataURL(file)
    }
    event.target.value = ''
  }
  function handlePaste(event: React.ClipboardEvent) {
    const items = event.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (!file || file.size > 20_000_000) continue
        event.preventDefault()
        const reader = new FileReader()
        reader.onload = () => { const data = reader.result; if (typeof data === 'string') { const base64 = data.split(',')[1] ?? ''; setPendingAttachments((items) => [...items, { name: file.name || 'pasted-image', mimeType: file.type || 'image/png', data: base64, size: file.size }]) } }
        reader.readAsDataURL(file)
      }
    }
  }
  function removeAttachment(index: number) { setPendingAttachments(prev => prev.filter((_, i) => i !== index)) }
  return <div className="composer-wrap">{view.error && <div className="session-error" role="alert"><XCircle size={14}/><span>{view.error}</span><button aria-label="إغلاق الخطأ" onClick={dismissError}><X size={13}/></button></div>}{pendingAttachments.length > 0 && <div className="attachment-previews">{pendingAttachments.map((attachment, index) => <div key={`${attachment.name}-${index}`} className="attachment-preview">{attachment.mimeType.startsWith('image/') ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} className="attachment-thumb"/> : <div className="attachment-file"><Code2 size={16}/><span>{attachment.name}</span></div>}<button aria-label={`إزالة ${attachment.name}`} className="attachment-remove" onClick={() => removeAttachment(index)}><X size={12}/></button></div>)}</div>}<div className="composer"><label className="sr-only" htmlFor="agent-prompt">رسالة الوكيل</label><textarea id="agent-prompt" ref={ref} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} onPaste={handlePaste} placeholder={view.phase === 'stopping' ? 'جارٍ إيقاف التنفيذ...' : view.phase !== 'idle' ? 'اكتب رسالة وستصل في الجولة التالية...' : 'أرسل رسالة... Shift+Enter لسطر جديد | الصق صورة من الحافظة'} rows={1}/><div className="composer-bar"><div className="composer-left"><input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.txt,.json,.csv,.xml,.html,.md" className="sr-only" onChange={handleFileSelect}/><button aria-label="إرفاق ملف" className="attach-btn" onClick={() => fileInputRef.current?.click()}><Paperclip size={14}/></button><span className="composer-stat">{lines.toLocaleString('ar')} سطر</span><span className="composer-stat" title={`${view.context.estimatedTokens} رمز تقريبي`}><Gauge size={12}/> {contextPercent ? `السياق ${contextPercent}% تقريبي` : 'السياق غير محسوب'}</span>{view.usage.requests > 0 && <span className="composer-stat" title="الاستخدام الفعلي إن أرسله المزود"><Gauge size={12}/> {view.usage.input.toLocaleString('ar')} إدخال · {view.usage.output.toLocaleString('ar')} إخراج{view.usage.cost > 0 && <> · ${view.usage.cost.toFixed(4)}</>}</span>}{view.context.compacted && <span className="context-compacted">تم تلخيص السياق</span>}</div><div className="composer-right"><ModelSelect provider={provider} change={changeModel} small/>{view.phase !== 'idle' && !input.trim() ? <button aria-label={view.phase === 'stopping' ? 'جارٍ إيقاف التنفيذ' : 'إيقاف التنفيذ'} className="stop-btn" disabled={view.phase === 'stopping'} onClick={cancel}>{view.phase === 'stopping' ? <LoaderCircle className="spin" size={14}/> : <Square size={14}/>}</button> : <button aria-label="إرسال" className={`send-btn ${view.phase !== 'idle' ? 'queue' : ''}`} disabled={!active || !input.trim() || view.phase === 'stopping'} onClick={() => void send()}><Send size={14}/></button>}</div></div></div></div>
}

// ModelSelect, SettingsModal, ApprovalModal, GitInitModal, TodoList are now imported from ./components/
// (was inline — extracted to reduce App.tsx size)

function ReasoningBlock({ reasoning }: { reasoning: string }) { const [open, setOpen] = useState(false); return <div className={`reasoning-block ${open ? 'open' : ''}`}><button className="reasoning-head" onClick={() => setOpen(!open)} aria-expanded={open}><span className="reasoning-icon"><Brain size={11}/></span><span className="reasoning-label">Thought</span><ChevronDown size={11} className={open ? 'rot' : ''}/></button>{open && <pre className="reasoning-body">{reasoning}</pre>}</div> }

/** أيقونة روبوت الشات الأساسي — نفس شكل وحركة عيون روبوت شات البناء بالضبط */
function ChatBotIcon() {
  return (
    <svg className="chat-bot-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v3M9 3h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="4" y="6" width="16" height="14" rx="4" fill="rgba(148, 163, 184, .08)" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 11H2.8M20 11h1.2M8 20v1M16 20v1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle className="chat-bot-eye chat-bot-eye-left" cx="9" cy="13" r="1.5" />
      <circle className="chat-bot-eye chat-bot-eye-right" cx="15" cy="13" r="1.5" />
    </svg>
  )
}
function MessageBubble({ message, streaming, latest = false }: { message: Message; streaming: boolean; latest?: boolean }) { const waiting = streaming && !message.content && !message.toolCalls?.length; const sanitized = useMemo(() => message.content ? DOMPurify.sanitize(message.content, { ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'code', 'pre', 'br', 'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'a', 'img', 'hr', 'del', 'sub', 'sup'], ALLOWED_ATTR: ['href', 'src', 'alt', 'className', 'target', 'rel', 'colSpan', 'rowSpan'] }) : '', [message.content]); return <article className={`message ${message.role} ${streaming ? 'streaming' : ''} ${message.role === 'assistant' && latest ? 'latest' : ''}`}>{message.role === 'assistant' && <div className="msg-role"><ChatBotIcon/></div>}<div className="msg-body">{message.reasoning && <ReasoningBlock reasoning={message.reasoning}/>}{message.attachments?.length ? <div className="message-attachments">{message.attachments.map((att, i) => att.mimeType.startsWith('image/') ? <img key={`${att.name}-${i}`} src={`data:${att.mimeType};base64,${att.data}`} alt={att.name} className="message-attachment-img"/> : <div key={`${att.name}-${i}`} className="message-attachment-file"><Code2 size={14}/>{att.name}</div>)}</div> : null}{message.content && <div className="msg-text streaming-text"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code({ className, children }) { const block = /language-(\w+)/.exec(className ?? ''); return block ? <CodeBlock language={block[1] ?? 'text'} code={String(children).replace(/\n$/, '')}/> : <code className="inline-code">{children}</code> }, pre({ children }) { return <>{children}</> }, a({ children, href }) { return <a href={safeLink(href)} target="_blank" rel="noreferrer">{children}</a> }, table({ children }) { return <div className="table-scroll"><table>{children}</table></div> } }}>{sanitized}</ReactMarkdown>{streaming && <span className="stream-caret" aria-hidden="true"/>}</div>}{waiting && <span className="writing-state"><i/><i/><i/> يجهز الرد</span>}</div></article> }
function MessageBubbleWithActions({ message, streaming, latest = false, onEdit, onRegenerate }: { message: Message; streaming: boolean; latest?: boolean; onEdit(message: Message): void; onRegenerate(message: Message): void }) {
  if (streaming || message.role === 'tool') return <MemoMessageBubble message={message} streaming={streaming} latest={latest}/>
  return <div className="message-with-actions"><MemoMessageBubble message={message} streaming={false} latest={latest}/><div className="message-actions">{message.role === 'user' ? <button onClick={() => onEdit(message)}>تعديل الرسالة</button> : message.role === 'assistant' && message.content ? <button onClick={() => void onRegenerate(message)}>إعادة توليد</button> : null}</div></div>
}

function SubagentInline({ subagents }: { subagents: SubagentEvent[] }) {
  return <div className="subagent-inline">{subagents.map((item) => <SubagentInlineRow key={item.id} item={item}/>)}</div>
}

function SubagentInlineRow({ item }: { item: SubagentEvent }) {
  const icon = item.state === 'running' ? <LoaderCircle className="spin" size={12}/> : item.state === 'completed' ? <Check size={12}/> : <X size={12}/>
  return <div className={`subagent-inline-row ${item.state}`}>
    <span className={`subagent-inline-icon ${item.state}`}>{icon}</span>
    <span className="subagent-inline-text">{item.description}</span>
  </div>
}

export function ExecutionStage({ messages }: { messages: Message[]; todoId?: string | null; todos?: Todo[] }) {
  // عرض مسطّح: صفوف الأدوات فوق خلفية الشات مباشرة دون بطاقات أو تقسيم مراحل
  return (
    <section className="execution-flat" aria-label="خطوات التنفيذ">
      <ExecutionTimelineImpl messages={messages} />
    </section>
  )
}

// CodeBlock is now imported from ./components/CodeBlock (with Shiki syntax highlighting)
export function ToolCard({ tool, compact = false }: { tool: NonNullable<Message['toolCalls']>[number]; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const target = String(tool.input.path ?? tool.input.command ?? tool.input.query ?? tool.input.prompt ?? '')
  const toolIcon = getToolIcon(tool.name, tool.status)
  const diffStats = extractDiffStats(tool.output)
  const fileExt = getFileExt(target)
   return <div className={`tool-card ${tool.status} ${compact ? 'tool-card-compact' : ''}`}><button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}><span className="tool-icon">{toolIcon}</span>{fileExt && <span className="tool-ext">{fileExt}</span>}<span className="tool-info"><b>{toolInlineLabel(tool.name, target)}</b><small>{toolStatusLabel(tool)}{tool.status === 'running' && tool.startedAt ? <ToolElapsed startedAt={tool.startedAt}/> : null}</small></span>{diffStats && <span className="tool-diff" dir="ltr"><span className="diff-added">{diffStats.split(' ')[0]}</span><span className="diff-removed">{diffStats.split(' ')[1]}</span></span>}<ChevronDown size={11} className={open ? 'rot' : ''}/></button>{open && <div className="tool-body">{isAgentTool(tool.name) ? <AgentReport tool={tool}/> : (tool.name === 'web_search' || tool.name === 'web_fetch') ? <WebResult tool={tool}/> : tool.name === 'edit_file_undo' ? <div className="undo-result"><span className="undo-icon"><Undo2 size={14}/></span><div className="undo-info"><strong>تم إرجاع آخر تعديل</strong><small>{tool.status === 'completed' ? 'تم استعادة المحتوى كما كان بالضبط' : tool.status === 'error' ? 'فشل الإرجاع' : 'جاري الإرجاع...'}</small></div></div> : <ToolResultRenderer name={tool.name} input={tool.input} output={tool.output}/>}</div>}</div>
}

function toolStatusLabel(tool: NonNullable<Message['toolCalls']>[number]): string {
  if (tool.status === 'running') return 'الأمر يعمل... لم يصل إخراج بعد'
  if (tool.status === 'completed') return 'تم التنفيذ بنجاح'
  try {
    const parsed = JSON.parse(tool.output ?? '') as { error?: { code?: string; message?: string } }
    if (parsed.error?.code === 'ABORTED') return 'تم الإلغاء'
    if (parsed.error?.code === 'INVALID_TOOL_INPUT') return parsed.error.message ?? 'مدخلات الأداة غير مكتملة'
    if (parsed.error?.message) return parsed.error.message
  } catch {}
  return tool.status === 'denied' ? 'تم رفض العملية' : 'تعذر إكمال الأداة'
}

function isAgentTool(name: string): boolean { return name === 'task' || name === 'task_parallel' }

function WebResult({ tool }: { tool: NonNullable<Message['toolCalls']>[number] }) {
  if (tool.status === 'running') return <pre className="web-waiting">جاري جلب البيانات من الويب...</pre>
  try {
    const parsed = JSON.parse(tool.output ?? '{}') as { ok?: boolean; data?: { query?: string; provider?: string; results?: Array<{ title?: string; url?: string; snippet?: string }>; content?: string; url?: string; contentType?: string; bytes?: number; truncated?: boolean }; error?: { message?: string } }
    if (parsed.ok === false) return <pre className="web-error">{parsed.error?.message ?? 'فشل الاتصال بالموقع'}</pre>
    if (tool.name === 'web_search' && parsed.data?.results) return <div className="web-search-results"><div className="web-search-header">نتائج البحث: {parsed.data.query}</div>{parsed.data.results.map((r, i) => <a key={i} className="web-search-item" href={r.url} target="_blank" rel="noreferrer"><strong>{r.title}</strong><small>{r.url}</small><span>{r.snippet}</span></a>)}</div>
    if (tool.name === 'web_fetch' && parsed.data?.content) return <div className="web-fetch-result"><div className="web-fetch-header">{parsed.data.url} <span>({parsed.data.contentType})</span>{parsed.data.truncated && <span className="web-truncated"> — مقتطع</span>}</div><pre className="web-fetch-content">{parsed.data.content.slice(0, 3000)}</pre></div>
    return <pre>{tool.output?.slice(0, 2000) ?? ''}</pre>
  } catch { return <pre>{tool.output?.slice(0, 2000) ?? ''}</pre> }
}

function AgentReport({ tool }: { tool: NonNullable<Message['toolCalls']>[number] }) {
  const taskInputs = tool.name === 'task_parallel'
    ? (Array.isArray(tool.input.tasks) ? tool.input.tasks : []).map((item) => typeof item === 'object' && item !== null ? { prompt: String((item as Record<string, unknown>).prompt ?? ''), description: String((item as Record<string, unknown>).description ?? 'وكيل فرعي') } : null).filter((item): item is { prompt: string; description: string } => Boolean(item?.prompt))
    : [{ prompt: String(tool.input.prompt ?? ''), description: String(tool.input.description ?? 'وكيل فرعي') }].filter((item) => Boolean(item.prompt))
  let reports: Array<{ description: string; summary: string; error?: string }> = []
  try {
    const parsed = JSON.parse(tool.output ?? '{}') as { data?: { summary?: string; description?: string; results?: Array<{ description?: string; summary?: string; error?: string }> } }
    if (Array.isArray(parsed.data?.results)) reports = parsed.data.results.map((item) => ({ description: item.description ?? 'وكيل فرعي', summary: item.summary ?? '', error: item.error }))
    else if (parsed.data) reports = [{ description: parsed.data.description ?? 'تقرير الوكيل الفرعي', summary: parsed.data.summary ?? '' }]
  } catch {
    reports = [{ description: 'تقرير الوكيل الفرعي', summary: tool.output ?? '' }]
  }
  return <div className="agent-report"><div className="agent-report-section agent-prompt"><div className="agent-report-label"><span className="agent-report-dot prompt"/>البرومبت والمهام المرسلة</div>{taskInputs.map((task, index) => <article className="agent-task-card" key={index}><div className="agent-task-head"><span className="agent-task-number">{index + 1}</span><div><strong>الوكيل {index + 1}: {task.description}</strong><small>وكيل فرعي مستقل، ينفذ هذه المهمة ثم يعيد تقريرًا مختصرًا بالأدلة والنتائج.</small></div></div><pre>{task.prompt}</pre></article>)}</div><div className="agent-report-section agent-result"><div className="agent-report-label"><span className="agent-report-dot result"/>التقارير الكاملة من الوكلاء</div>{reports.map((report, index) => <article className="agent-report-item" key={index}><div className="agent-result-head"><span className="agent-task-number">{index + 1}</span><strong>تقرير الوكيل {index + 1}: {report.description}</strong></div><div>{report.error ? report.error : report.summary || 'لم يصل تقرير نصي بعد.'}</div></article>)}</div></div>
}

function getToolIcon(name: string, status: string): React.ReactNode {
  if (status === 'running') return <LoaderCircle className="spin" size={12}/>
  if (status === 'error' || status === 'denied') return <X size={12}/>
  if (name === 'read_file' || name === 'read_files') return <FileText size={12}/>
  if (name === 'list_directory' || name === 'tree' || name === 'get_file_info') return <FolderOpen size={12}/>
  if (name === 'edit_file' || name === 'append_file') return <Pencil size={12}/>
  if (name === 'edit_file_undo') return <Undo2 size={12}/>
  if (name === 'write_file') return <Code2 size={12}/>
  if (name === 'delete_file' || name === 'move_file') return <Trash2 size={12}/>
  if (name === 'search_files' || name === 'search_symbols' || name === 'glob_files') return <Search size={12}/>
  if (name === 'run_powershell' || name === 'run_command' || name === 'shell' || name.startsWith('git_')) return <TerminalIcon size={12}/>
  if (name === 'web_fetch' || name === 'web_search') return <Gauge size={12}/>
  if (name === 'todo_write') return <ListChecks size={12}/>
  return <Check size={12}/>
}

function extractDiffStats(output: string | undefined): string | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output) as { data?: { diff?: string; addedLines?: number; removedLines?: number; diffTruncated?: boolean } }
    if (typeof parsed.data?.addedLines === 'number' || typeof parsed.data?.removedLines === 'number') {
      const added = parsed.data!.addedLines ?? 0
      const removed = parsed.data!.removedLines ?? 0
      if (added === 0 && removed === 0) return null
      return `+${added} -${removed}`
    }
    if (typeof parsed.data?.diff !== 'string') return null
    const lines = parsed.data.diff.split(/\r?\n/)
    let added = 0
    let removed = 0
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      else if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
    if (added === 0 && removed === 0) return null
    return `+${added} -${removed}`
  } catch { return null }
}

function getFileExt(target: string): string | null {
  const file = target.split(/[\\/]/).pop() ?? ''
  const ext = file.split('.').pop()?.toLowerCase()
  if (!ext || ext === file.toLowerCase()) return null
  const map: Record<string, string> = { ts: 'TS', tsx: 'TS', js: 'JS', jsx: 'JS', css: 'CSS', html: 'HTML', json: 'JSON', java: 'Java', py: 'PY', md: 'MD', go: 'GO', rs: 'RS' }
  return map[ext] ?? ext.toUpperCase().slice(0, 3)
}

function toolInlineLabel(name: string, target: string): string {
  const file = target.split(/[\\/]/).pop() ?? target
  const dir = target.split(/[\\/]/).slice(-2).join('/')
  if (name === 'read_file' || name === 'read_files') return file ? `قراءة ${file}` : 'قراءة ملف'
  if (name === 'read_message') return 'استعادة نتيجة سابقة'
  if (name === 'search_files' || name === 'search_symbols') return `بحث داخل المشروع: ${target.slice(0, 50)}`
  if (name === 'write_file') return file ? `إنشاء أو استبدال ${file}` : 'كتابة ملف'
  if (name === 'edit_file' || name === 'append_file' || name === 'patch_file') return file ? `تعديل ${file}` : 'تعديل ملف'
  if (name === 'delete_file') return file ? `حذف ${file}` : 'حذف ملف'
  if (name === 'move_file') return file ? `نقل ${file}` : 'نقل ملف'
  if (name === 'run_powershell' || name === 'run_command') return `تشغيل أمر: ${target.slice(0, 50)}`
  if (name === 'glob_files') return `العثور على الملفات: ${target.slice(0, 50)}`
  if (name === 'list_directory' || name === 'tree') return dir ? `استعراض ${dir}` : 'استعراض المجلد'
  if (name === 'get_file_info') return file ? `معلومات ${file}` : 'معلومات الملف'
  if (name === 'web_fetch') return `قراءة صفحة ويب: ${target.slice(0, 50)}`
  if (name === 'web_search') return `بحث ويب: ${target.slice(0, 50)}`
  if (name === 'todo_write') return 'تحديث خطة العمل'
  if (name === 'todo_read') return 'قراءة خطة العمل'
  if (name === 'shell') return `تشغيل shell: ${target.slice(0, 50)}`
  if (name.startsWith('git_')) return `Git: ${name.slice(4).replaceAll('_', ' ')}`
  if (name === 'edit_file_undo') return 'إرجاع آخر تعديل'
  if (name === 'task') return 'تشغيل وكيل فرعي'
  if (name === 'task_parallel') return 'تشغيل وكلاء فرعيين بالتوازي'
  if (name === 'load_skill') return `تحميل المهارة: ${target.slice(0, 50)}`
  return name.replaceAll('_', ' ')
}

type ToolEnvelope = { ok: boolean; data?: unknown; error?: { code?: string; message?: string; details?: unknown }; raw: unknown; text: string }
const TOOL_PREVIEW_LIMIT = 50
const TOOL_TEXT_LIMIT = 3000

export function parseToolEnvelope(value: unknown): ToolEnvelope {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)
  let parsed: unknown = value
  if (typeof value === 'string') { try { parsed = JSON.parse(value) } catch { return { ok: true, data: value, raw: value, text: value } } }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    if (record.ok === false) return { ok: false, error: record.error as ToolEnvelope['error'], raw: parsed, text }
    if (record.ok === true) return { ok: true, data: record.data, raw: parsed, text }
  }
  if (Array.isArray(parsed) && parsed.every((item) => item && typeof item === 'object' && 'type' in item)) {
    const content = parsed.map((item) => String((item as Record<string, unknown>).text ?? '')).filter(Boolean).join('\n')
    return parseToolEnvelope(content)
  }
  if (parsed && typeof parsed === 'object' && 'content' in (parsed as Record<string, unknown>)) return parseToolEnvelope((parsed as Record<string, unknown>).content)
  return { ok: true, data: parsed, raw: parsed, text }
}

function ToolElapsed({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt)
  useEffect(() => { const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 1000); return () => window.clearInterval(timer) }, [startedAt])
  return <span dir="ltr"> · {Math.max(0, Math.floor(elapsed / 1000))}s</span>
}

function formatCount(value: unknown): string { return typeof value === 'number' ? value.toLocaleString('ar') : String(value ?? 0) }
function formatBytes(value: unknown): string { const bytes = Number(value); if (!Number.isFinite(bytes)) return ''; if (bytes < 1024) return `${bytes} بايت`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} كيلوبايت`; return `${(bytes / 1024 / 1024).toFixed(1)} ميغابايت` }
function formatDate(value: unknown): string { const date = typeof value === 'number' ? new Date(value) : new Date(String(value ?? '')); return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleString('ar') }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function RawDetails({ value }: { value: unknown }) { return <details className="tool-result-raw"><summary>عرض النتيجة الأصلية</summary><pre dir="ltr">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></details> }
function EmptyResult() { return <div className="tool-result-empty">اكتملت الأداة دون بيانات إضافية.</div> }
function Meta({ items }: { items: Array<[string, unknown]> }) { return <div className="tool-result-meta">{items.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => <span key={label}><b>{label}</b><code dir="ltr">{String(value)}</code></span>)}</div> }
function ToolList({ items, render }: { items: unknown[]; render(item: unknown, index: number): React.ReactNode }) { return <div className="tool-result-list">{items.slice(0, TOOL_PREVIEW_LIMIT).map(render)}{items.length > TOOL_PREVIEW_LIMIT && <div className="tool-result-more">و{formatCount(items.length - TOOL_PREVIEW_LIMIT)} عنصر إضافي في النتيجة الأصلية.</div>}</div> }

export function ToolResultRenderer({ name, input, output }: { name: string; input: Record<string, unknown>; output?: string }) {
  const envelope = parseToolEnvelope(output ?? input)
  if (!envelope.ok) return <div className="tool-result-error"><strong>تعذر تنفيذ الأداة</strong><span>{envelope.error?.code}</span><p>{envelope.error?.message ?? 'حدث خطأ غير معروف'}</p>{envelope.error?.details !== undefined && <pre dir="ltr">{JSON.stringify(envelope.error.details, null, 2)}</pre>}</div>
  if (output === undefined && Object.keys(input).length === 0) return <EmptyResult/>
  const data = record(envelope.data)
  const files = list(data.files)
  const matches = list(data.matches)
  const symbols = list(data.symbols)
  const entries = list(data.entries)
  let body: React.ReactNode
  if (name === 'tree' || name === 'list_directory') body = entries.length ? <><Meta items={[['العناصر', data.count ?? data.totalEntries ?? entries.length], ['المقتطع', data.truncated ? 'نعم' : undefined]]}/><ToolList items={entries} render={(item, index) => { const row = record(item); const directory = row.directory === true || row.type === 'directory'; return <div className="tool-result-tree" key={index} style={{ paddingInlineStart: `${Number(row.depth ?? 0) * 14}px` }}><span>{directory ? 'مجلد' : 'ملف'}</span><code dir="ltr">{String(row.path ?? row.name ?? '')}</code></div> }}/></> : <div className="tool-result-empty">المجلد فارغ أو لا يحتوي على عناصر</div>
  else if (entries.length) body = <><Meta items={[['العناصر', data.count ?? data.totalEntries ?? entries.length], ['المقتطع', data.truncated ? 'نعم' : undefined]]}/><ToolList items={entries} render={(item, index) => { const row = record(item); const directory = row.directory === true || row.type === 'directory'; return <div className="tool-result-tree" key={index} style={{ paddingInlineStart: `${Number(row.depth ?? 0) * 14}px` }}><span>{directory ? 'مجلد' : 'ملف'}</span><code dir="ltr">{String(row.path ?? row.name ?? '')}</code></div> }}/></>
  else if (name === 'glob_files') body = files.length ? <ToolList items={files} render={(item, index) => <div className="tool-result-row" key={index}><code dir="ltr">{String(item)}</code></div>}/> : <div className="tool-result-empty">لم يتم العثور على ملفات تطابق النمط <code dir="ltr">{String(input.pattern ?? '')}</code></div>
  else if (files.length && files.every((item) => typeof item === 'string')) body = <ToolList items={files} render={(item, index) => <div className="tool-result-row" key={index}><code dir="ltr">{String(item)}</code></div>}/>
  else if (name === 'search_files') body = matches.length ? <><Meta items={[['المطابقات', data.count ?? matches.length], ['ثنائي متجاوز', data.skippedBinary], ['مقتطع', data.truncated ? 'نعم' : undefined]]}/><ToolList items={matches} render={(item, index) => { const row = record(item); return <div className="tool-result-row" key={index}><code dir="ltr">{String(row.path ?? row.file ?? '')}:{String(row.line ?? '')}:{String(row.column ?? '')}</code><span>{String(row.text ?? '')}</span></div> }}/></> : <div className="tool-result-empty">لم يتم العثور على مطابقات للبحث <code dir="ltr">{String(input.query ?? input.pattern ?? '')}</code></div>
  else if (matches.length) body = <><Meta items={[['المطابقات', data.count ?? matches.length], ['مقتطع', data.truncated ? 'نعم' : undefined]]}/><ToolList items={matches} render={(item, index) => { const row = record(item); return <div className="tool-result-row" key={index}><code dir="ltr">{String(row.path ?? row.file ?? '')}:{String(row.line ?? '')}:{String(row.column ?? '')}</code><span>{String(row.text ?? '')}</span></div> }}/></>
  else if (name === 'search_symbols' || symbols.length) body = <ToolList items={symbols} render={(item, index) => { const row = record(item); return <div className="tool-result-row" key={index}><b>{String(row.kind ?? 'رمز')}</b><code dir="ltr">{String(row.name ?? '')} {row.path ? `· ${row.path}` : ''}:{String(row.line ?? '')}</code></div> }}/>
   else if (name === 'read_file' && Array.isArray(data.lines)) body = <><Meta items={[['المسار', data.path], ['إجمالي الأسطر', data.totalLines], ['النطاق', data.range ? JSON.stringify(data.range) : undefined]]}/><pre className="tool-result-code" dir="ltr">{list(data.lines).map((item) => { if (typeof item === 'string') return item; const row = record(item); return `${String(row.line ?? '').padStart(5, ' ')} | ${String(row.content ?? '')}` }).join('\n')}</pre></>
  else if (name === 'read_files' && files.length) body = <><Meta items={[['الملفات', data.filesRead ?? files.length], ['المؤشر التالي', data.nextCursor], ['كامل', data.complete === false ? 'لا' : 'نعم']]}/><div className="tool-result-files">{files.slice(0, TOOL_PREVIEW_LIMIT).map((item, index) => { const row = record(item); return <details key={index} open={index === 0}><summary dir="ltr">{String(row.path ?? '')} <span>{formatBytes(row.bytes)} · {formatCount(row.totalLines)} سطر</span></summary><pre className="tool-result-code" dir="ltr">{String(row.content ?? '')}</pre><Meta items={[['النطاق', row.range ? JSON.stringify(row.range) : undefined], ['كامل', row.complete === false ? 'لا' : 'نعم']]}/></details> })}</div></>
  else if (name === 'todo_read' || name === 'todo_write' || Array.isArray(data.todos)) { const todos = list(data.todos); body = todos.length ? <><Meta items={[['المهام', todos.length], ['المكتملة', todos.filter((item) => record(item).status === 'completed').length]]}/><ToolList items={todos} render={(item, index) => { const row = record(item); return <div className={`tool-result-todo ${String(row.status ?? '')}`} key={index}><b>{String(row.status ?? 'pending')}</b><span>{String(row.content ?? '')}</span><small>{String(row.priority ?? '')}</small></div> }}/></> : <EmptyResult/> }
  else if (['run_powershell', 'shell', 'run_command', 'git_status', 'git_diff', 'git_log', 'git_show', 'git_branch'].includes(name) || typeof data.output === 'string') { const text = String(data.output ?? data.diff ?? data.text ?? ''); body = <><Meta items={[['كود الخروج', data.exitCode], ['المدة', data.duration ? `${data.duration}ms` : undefined]]}/>{text ? <pre className={`tool-result-code ${data.diff || name === 'git_diff' ? 'tool-result-diff' : ''}`} dir="ltr">{text}</pre> : <EmptyResult/>}</> }
  else if (name === 'get_file_info') body = <Meta items={[['المسار', data.path], ['النوع', data.type], ['الحجم', formatBytes(data.size ?? data.bytes)], ['الأسطر', data.totalLines], ['ثنائي', data.binary ? 'نعم' : 'لا'], ['الإنشاء', formatDate(data.createdAt ?? data.created)], ['التعديل', formatDate(data.modifiedAt ?? data.modified)]]}/>
  else if (['analyze_file', 'find_references', 'dependency_graph'].includes(name)) body = <div className="tool-result-sections">{Object.entries(data).filter(([key]) => key !== 'path').map(([key, value]) => <section key={key}><h4>{key}</h4>{Array.isArray(value) ? <ToolList items={value} render={(item, index) => <div className="tool-result-row" key={index}><code dir="ltr">{typeof item === 'string' ? item : JSON.stringify(item)}</code></div>}/> : <pre dir="ltr">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>}</section>)}</div>
  else if (['remember_project', 'recall_project'].includes(name)) body = <div className="tool-result-sections"><Meta items={Object.entries(data).filter(([, value]) => !Array.isArray(value))}/><ToolList items={list(data.entries)} render={(item, index) => <div className="tool-result-memory" key={index}><b>{String(record(item).key ?? '')}</b><span>{String(record(item).value ?? item)}</span></div>}/></div>
  else if (typeof data.diff === 'string') body = <pre className="tool-result-code tool-result-diff" dir="ltr">{data.diff}</pre>
  else if (typeof envelope.data === 'string') body = <pre className="tool-result-code" dir="ltr">{envelope.data.slice(0, TOOL_TEXT_LIMIT)}{envelope.data.length > TOOL_TEXT_LIMIT ? '\n... النتيجة مقتطعة في المعاينة' : ''}</pre>
  else if (Object.keys(data).length === 0) body = <EmptyResult/>
  else body = <div className="tool-result-sections">{Object.entries(data).map(([key, value]) => <section key={key}><h4>{key}</h4><pre dir={typeof value === 'string' ? 'ltr' : undefined}>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></section>)}</div>
  return <div className="tool-result"><div className="tool-result-header"><strong>{toolInlineLabel(name, String(input.path ?? input.command ?? ''))}</strong><span>{name}</span></div>{body}<RawDetails value={envelope.raw}/></div>
}

// ApprovalModal, SettingsModal, GitInitModal, TodoList imported from ./components/Modals
// ApprovalDetail, SubagentsPage remain inline (complex internal state dependencies)

// GitInitModal also imported from ./components/Modals


function upsertMessage(messages: Message[], incoming: Message): Message[] { const found = messages.some((message) => message.id === incoming.id); return (found ? messages.map((message) => message.id === incoming.id ? incoming : message) : [...messages, incoming]).sort(compareMessages) }
function upsertSubagent(subagents: SubagentEvent[], incoming: SubagentEvent): SubagentEvent[] { const found = subagents.some((item) => item.id === incoming.id); return (found ? subagents.map((item) => item.id === incoming.id ? incoming : item) : [...subagents, incoming]) }
function mergeMessages(loaded: Message[], live: Message[]): Message[] { const values = new Map(loaded.map((message) => [message.id, message])); for (const message of live) values.set(message.id, message); return [...values.values()].sort(compareMessages) }
function compareMessages(a: Message, b: Message): number { if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence; return a.createdAt - b.createdAt || a.id.localeCompare(b.id) }
function errorText(error: unknown): string { const raw = error instanceof Error ? error.message : String(error); return raw.replace(/^Error invoking remote method '[^']+': Error: /, '') }
function safeLink(value: string | undefined): string | undefined { if (!value) return undefined; try { const url = new URL(value); return /^(https?|mailto|tel):$/i.test(url.protocol) ? url.toString() : undefined } catch { return undefined } }
type ConversationItem = { kind: 'message'; message: Message } | { kind: 'execution'; id: string; todoId: string | null; messages: Message[] }
function ConversationItems({ items, todos, streamingId, onEdit, onRegenerate }: { items: ConversationItem[]; todos: Todo[]; streamingId: string | null; onEdit(message: Message): void; onRegenerate(message: Message): void }) {
  const groups: Array<{ kind: 'message'; item: ConversationItem & { kind: 'message' } } | { kind: 'track'; items: Array<ConversationItem & { kind: 'execution' }> }> = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (item.kind === 'execution' && last?.kind === 'track') last.items.push(item)
    else if (item.kind === 'execution') groups.push({ kind: 'track', items: [item] })
    else groups.push({ kind: 'message', item })
  }
  return <>{groups.map((group) => group.kind === 'track' ? <div className="execution-track" key={group.items[0]?.id}>{group.items.map((item) => <MemoExecutionStage key={item.id} messages={item.messages} todoId={item.todoId} todos={todos}/>)}</div> : <MemoMessageBubbleWithActions key={group.item.message.id} message={group.item.message} streaming={streamingId === group.item.message.id} onEdit={onEdit} onRegenerate={onRegenerate}/>)}</>
}
export function groupConversation(messages: Message[], _todos: Todo[] = []): ConversationItem[] {
  // لا تقسيم لمراحل: كل رسالة أدوات تصبح مقطعًا مسطّحًا واحدًا يعرض
  // خطواتها بالترتيب الزمني مباشرة فوق خلفية الشات
  const result: ConversationItem[] = []
  for (const message of messages) {
    if (message.role === 'tool') continue
    if (message.toolCalls?.length) {
      // استخراج النص كفقاعة مستقلة أولًا حتى لا يختفي كلام الوكيل خلف الأدوات
      if (message.content.trim()) result.push({ kind: 'message', message: { ...message, toolCalls: undefined } })
      result.push({ kind: 'execution', id: `execution-${message.id}`, todoId: null, messages: [{ ...message, content: '', toolCalls: message.toolCalls }] })
      continue
    }
    result.push({ kind: 'message', message })
  }
  return result
}

const MemoMessageBubble = memo(MessageBubble)
const MemoMessageBubbleWithActions = memo(MessageBubbleWithActions)
const MemoExecutionStage = memo(ExecutionStage, (prev, next) => prev.messages.length === next.messages.length && prev.messages.every((message, index) => message === next.messages[index]))

const SUBAGENT_COLORS = ['#7e9cf0', '#5fd9a4', '#f0a84e', '#f47a8c', '#b07cf0', '#f07cb0', '#4ecdc4', '#8b8b8b']
const TOOL_LABELS: Record<string, string> = { all: 'جميع الأدوات', read: 'قراءة فقط', edit: 'قراءة وتعديل' }
function SubagentsPage({ subagents, setSubagents, saveSubagent, removeSubagent, toggleSubagent, provider }: { subagents: Subagent[]; setSubagents: (fn: (items: Subagent[]) => Subagent[]) => void; saveSubagent: (input: Omit<Subagent, 'id' | 'createdAt' | 'updatedAt'>, editingId?: string) => Promise<void>; removeSubagent: (id: string) => Promise<void>; toggleSubagent: (id: string, enabled: boolean) => Promise<void>; provider: ProviderSettings }) {
  const [search, setSearch] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formColor, setFormColor] = useState(SUBAGENT_COLORS[0]!)
  const [formModel, setFormModel] = useState<string>(GO_MODELS[0]?.id ?? '')
  const [formPrompt, setFormPrompt] = useState('')
  const [formTools, setFormTools] = useState('all')
  const filtered = subagents.filter(sa => !search || sa.name.includes(search) || sa.description.includes(search))
  const enabledCount = subagents.filter(sa => sa.enabled).length
  function openForm(sa?: Subagent) {
    if (sa) { setEditingId(sa.id); setFormName(sa.name); setFormDesc(sa.description); setFormColor(sa.color); setFormModel(sa.model); setFormPrompt(sa.systemPrompt); setFormTools(sa.allowedTools) }
    else { setEditingId(null); setFormName(''); setFormDesc(''); setFormColor(SUBAGENT_COLORS[0]!); setFormModel(GO_MODELS[0]?.id ?? ''); setFormPrompt(''); setFormTools('all') }
    setFormOpen(true)
  }
  async function handleSave() {
    await saveSubagent({ name: formName, description: formDesc, color: formColor, model: formModel, systemPrompt: formPrompt, allowedTools: formTools, enabled: editingId ? subagents.find(sa => sa.id === editingId)?.enabled ?? true : true }, editingId ?? undefined)
    setFormOpen(false)
  }
  const modelName = (id: string) => GO_MODELS.find(m => m.id === id)?.name ?? id
  if (formOpen) {
    return (
      <div className="sa-page">
        <div className="sa-panel">
          <div className="sa-panel-head">
            <button className="sa-back-btn" onClick={() => setFormOpen(false)}><X size={16}/></button>
            <h3>{editingId ? 'تعديل الوكيل' : 'وكيل جديد'}</h3>
          </div>
          <div className="sa-form">
            <div className="sa-form-row">
              <div className="sa-field"><label>الاسم</label><input value={formName} onChange={e => setFormName(e.target.value)} placeholder="مثال: مستكشف, مراجع, باحث..." dir="auto"/></div>
              <div className="sa-field"><label>اللون</label><div className="sa-color-picker">{SUBAGENT_COLORS.map(c => <button key={c} className={`sa-color-dot ${formColor === c ? 'selected' : ''}`} style={{ background: c }} onClick={() => setFormColor(c)} aria-label={`لون ${c}`}/>)}</div></div>
            </div>
            <div className="sa-form-row">
              <div className="sa-field"><label>النموذج</label><select value={formModel} onChange={e => setFormModel(e.target.value)}>{GO_MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
              <div className="sa-field"><label>الصلاحيات</label><select value={formTools} onChange={e => setFormTools(e.target.value)}><option value="all">جميع الأدوات</option><option value="read">قراءة وبحث فقط</option><option value="edit">قراءة وتعديل</option></select></div>
            </div>
            <div className="sa-field"><label>الوصف</label><input value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="وصف مختصر يظهر للنموذج الرئيسي عند اختيار الوكيل..." dir="auto"/></div>
            <div className="sa-field"><label>البرومبت النظامي</label><textarea value={formPrompt} onChange={e => setFormPrompt(e.target.value)} placeholder={`أنت وكيل متخصص في ... مهمتك هي ...\n\nالقواعد:\n- افحص الملفات قبل أي استنتاج\n- أعد خلاصة دقيقة ومنظمة\n- لا تخمن، اذكر صراحة ما لم تجده`} rows={8} dir="auto"/></div>
            <div className="sa-form-actions"><button className="sa-btn-primary" onClick={handleSave} disabled={!formName.trim()}>{editingId ? 'حفظ التعديلات' : 'إنشاء الوكيل'}</button><button className="sa-btn-ghost" onClick={() => setFormOpen(false)}>إلغاء</button></div>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="sa-page">
      <div className="sa-hero">
        <div className="sa-hero-content">
          <div className="sa-hero-icon"><Bot size={28}/></div>
          <div>
            <h2>الوكلاء المخصصون</h2>
            <p>{enabledCount > 0 ? `${enabledCount} وكلاء مفعّلين — النموذج الرئيسي سيوزع المهام عليهم تلقائيًا` : 'أنشئ وكلاءك المتخصصين. النموذج الرئيسي سيستخدمهم لتوزيع العمل حسب تخصص كل منهم.'}</p>
          </div>
        </div>
        <button className="sa-btn-primary" onClick={() => openForm()}><Plus size={16}/> وكيل جديد</button>
      </div>
      <div className="sa-search"><Search size={14}/><input placeholder="بحث في الوكلاء..." value={search} onChange={e => setSearch(e.target.value)}/>{filtered.length > 0 && <span className="sa-search-count">{filtered.length.toLocaleString('ar')} وكيل</span>}</div>
      {filtered.length === 0 ? (
        <div className="sa-empty">
          <div className="sa-empty-visual"><Bot size={56} strokeWidth={1}/><div className="sa-empty-pulse"/></div>
          <h3>{search ? 'لا توجد نتائج' : 'لا يوجد وكلاء بعد'}</h3>
          <p>{search ? 'جرّب كلمة بحث مختلفة' : 'كل وكيل تحدده بنفسك — اسمه، تخصصه، نموذجه، صلاحياته، وبرومبته. عندما تضغط إرسال، النموذج الرئيسي سيختار الوكيل المناسب للمهمة.'}</p>
          {!search && <button className="sa-btn-primary" onClick={() => openForm()}><Plus size={15}/> أنشئ أول وكيل</button>}
        </div>
      ) : (
        <div className="sa-grid">
          {filtered.map(sa => (
            <div key={sa.id} className={`sa-card ${sa.enabled ? '' : 'disabled'}`}>
              <div className="sa-card-accent" style={{ background: sa.color }}/>
              <div className="sa-card-header">
                <div className="sa-card-badge" style={{ background: `${sa.color}18`, color: sa.color, borderColor: `${sa.color}30` }}>
                  <Bot size={16}/>
                  <span>{sa.name}</span>
                </div>
                <div className="sa-card-controls">
                  <label className="sa-toggle" title={sa.enabled ? 'مفعّل' : 'معطّل'}><input type="checkbox" checked={sa.enabled} onChange={e => toggleSubagent(sa.id, e.target.checked)}/><span className="sa-toggle-slider"/></label>
                  <button className="sa-icon-btn" onClick={() => openForm(sa)} title="تعديل"><Pencil size={14}/></button>
                  <button className="sa-icon-btn danger" onClick={() => removeSubagent(sa.id)} title="حذف"><Trash2 size={14}/></button>
                </div>
              </div>
              <p className="sa-card-desc">{sa.description || 'بدون وصف'}</p>
              <div className="sa-card-meta">
                <span className="sa-meta-item"><Brain size={12}/> {modelName(sa.model)}</span>
                <span className="sa-meta-item"><Shield size={12}/> {TOOL_LABELS[sa.allowedTools] || sa.allowedTools}</span>
                {sa.systemPrompt && <span className="sa-meta-item"><Code2 size={12}/> برومبت مخصص</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
