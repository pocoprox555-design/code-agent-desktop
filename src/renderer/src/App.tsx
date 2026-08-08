import { startTransition, useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Bot, Brain, Check, CheckCircle2, ChevronDown, Code2, Copy, FolderOpen, Gauge, KeyRound, ListChecks, LoaderCircle, Paperclip, PanelLeft, PanelRight, Plus, Search, Send, Settings, Shield, ShieldAlert, Square, Trash2, X, XCircle } from 'lucide-react'
import type { AgentEvent, AgentRunState, ApprovalRequest, Attachment, AuditEvent, Message, ProviderSettings, Session, SessionRunState, SubagentEvent, Todo, TreeEntry, UsageSummary } from '../../shared/types'
import { getGoModel, GO_MODELS, goProviderConfig } from '../../shared/models'

type Phase = 'idle' | 'running' | 'stopping'
interface SessionView { messages: Message[]; streamingId: string | null; phase: Phase; status: string; error: string | null; todos: Todo[]; subagents: SubagentEvent[]; context: { estimatedTokens: number; compacted: boolean; contextWindow: number }; usage: UsageSummary }
const emptyUsage: UsageSummary = { requests: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimatedInput: 0, cost: 0 }
const emptyView: SessionView = { messages: [], streamingId: null, phase: 'idle', status: '', error: null, todos: [], subagents: [], context: { estimatedTokens: 0, compacted: false, contextWindow: 0 }, usage: emptyUsage }
const initialConfig = goProviderConfig()
const defaultProvider: ProviderSettings = { name: initialConfig.name, baseUrl: initialConfig.baseUrl, apiPath: initialConfig.apiPath, apiStyle: initialConfig.apiStyle, model: initialConfig.model, contextWindow: initialConfig.contextWindow, maxOutputTokens: initialConfig.maxOutputTokens, hasApiKey: false }

export function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [views, setViews] = useState<Record<string, SessionView>>({})
  const [input, setInput] = useState('')
  const [settings, setSettings] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [provider, setProvider] = useState<ProviderSettings>(defaultProvider)
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [answeringApproval, setAnsweringApproval] = useState<string | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
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
  const [runState, setRunState] = useState<AgentRunState | undefined>()
  const [sessionPrompt, setSessionPrompt] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const sendLock = useRef(new Set<string>())
  const activeIdRef = useRef<string | null>(null)

  const active = sessions.find((session) => session.id === activeId) ?? null
  const view = activeId ? views[activeId] ?? emptyView : emptyView
  const hasMessages = view.messages.some((message) => message.role !== 'tool')
  const approval = approvals[0]
  activeIdRef.current = activeId

  useEffect(() => { void initialize() }, [])
  useEffect(() => window.rCode.events.onAgent(onEvent), [])
  useEffect(() => window.rCode.events.onApproval((request) => setApprovals((items) => items.some((item) => item.id === request.id) ? items : [...items, request])), [])
  useEffect(() => { if (followRef.current) endRef.current?.scrollIntoView({ block: 'end' }); else setShowLatest(true) }, [view.messages, view.status])
  useEffect(() => { if (view.todos.length > 0 && view.phase !== 'idle' && !planUserClosed.current) setPlanOpen(true) }, [view.todos.length, view.phase])
  useEffect(() => {
    const allDone = view.todos.length > 0 && view.todos.every((todo) => todo.status === 'completed')
    if (allDone && !prevAllDone.current) { setPlanOpen(false); setPlanExpanded(false) }
    prevAllDone.current = allDone
  }, [view.todos])
  useEffect(() => { if (!sidebarOpen) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false) }; document.addEventListener('keydown', onKeyDown); return () => document.removeEventListener('keydown', onKeyDown) }, [sidebarOpen])

  async function initialize() {
    try {
      const [rows, settingsValue, states] = await Promise.all([window.rCode.sessions.list(), window.rCode.provider.get(), window.rCode.agent.states()])
      setSessions(rows); setProvider(settingsValue); applyStates(states); setApprovals(states.flatMap((state) => state.pendingApprovals ?? []))
      if (rows[0]) await select(rows[0])
      else setSettings(!settingsValue.hasApiKey)
    } catch (error) { setAppError(errorText(error)) }
  }

  function applyStates(states: SessionRunState[]) { for (const state of states) updateView(state.sessionId, (current) => ({ ...current, phase: state.state === 'idle' || state.state === 'failed' ? 'idle' : state.state === 'cancelling' ? 'stopping' : 'running', status: state.status, error: state.error ?? current.error })) }
  function updateView(sessionId: string, update: (current: SessionView) => SessionView) { startTransition(() => setViews((items) => ({ ...items, [sessionId]: update(items[sessionId] ?? emptyView) }))) }

  function onEvent(event: AgentEvent) {
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
      if (event.type === 'status') return { ...withUsage, status: event.text ?? '', phase: event.text ? current.phase === 'idle' || current.phase === 'stopping' ? current.phase : 'running' : 'idle' }
      if (event.type === 'error') return { ...withUsage, phase: 'idle', status: '', error: event.text ?? 'حدث خطأ غير معروف', streamingId: null, messages: current.messages.map((message) => message.id === current.streamingId ? { ...message, interrupted: true, content: message.content ? `${message.content}\n\n[رد غير مكتمل بسبب فشل المزود]` : message.content } : message) }
      if (event.type === 'todo' && event.todos) return { ...withUsage, todos: event.todos }
      if (event.type === 'subagent' && event.subagent) return { ...withUsage, subagents: upsertSubagent(current.subagents, event.subagent) }
      if (event.type === 'context' && event.context) return { ...withUsage, context: event.context }
      return withUsage
    })
  }

  async function select(session: Session) {
    setActiveId(session.id); followRef.current = true; setShowLatest(false); setPlanOpen(false); setPlanExpanded(false); planUserClosed.current = false; prevAllDone.current = false
    if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false)
    try { const [loaded, usage, subagents, tree, persistedRun] = await Promise.all([window.rCode.sessions.messages(session.id), window.rCode.sessions.usage(session.id), window.rCode.sessions.subagents(session.id), window.rCode.files.list(session.id), window.rCode.sessions.run(session.id)]); setTreeEntries(tree); setRunState(persistedRun); updateView(session.id, (current) => ({ ...current, messages: mergeMessages(loaded, current.messages), usage, todos: session.todos, subagents })) }
    catch (error) { updateView(session.id, (current) => ({ ...current, error: errorText(error) })) }
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
    } catch (error) { setAppError(errorText(error)) }
  }

  async function removeSession(session: Session) {
    if (!window.confirm(`حذف المحادثة "${session.title}" نهائيًا؟ لا يمكن التراجع.`)) return
    try {
      await window.rCode.sessions.remove(session.id)
      setSessions((items) => items.filter((item) => item.id !== session.id))
      setViews((items) => { const next = { ...items }; delete next[session.id]; return next })
      if (activeId === session.id) {
        const remaining = sessions.filter((item) => item.id !== session.id)
        if (remaining[0]) await select(remaining[0])
        else { setActiveId(null); setInput('') }
      }
    } catch (error) { setAppError(errorText(error)) }
  }

  async function send() {
    const session = active
    const text = input.trim()
    if (!session || !text || view.phase === 'stopping' || sendLock.current.has(session.id)) return
    sendLock.current.add(session.id)
    const wasRunning = view.phase !== 'idle'
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
      updateView(session.id, (current) => ({ ...current, phase: wasRunning ? current.phase : 'idle', status: wasRunning ? current.status : '', error: errorText(error) }))
      if (activeIdRef.current === session.id) setInput((current) => current || text)
    } finally { sendLock.current.delete(session.id) }
  }

  async function cancel() {
    if (!active || view.phase === 'idle' || view.phase === 'stopping') return
    const id = active.id
    updateView(id, (current) => ({ ...current, phase: 'stopping', status: 'جارٍ إيقاف التنفيذ...', error: null }))
    try { await window.rCode.agent.cancel(id); updateView(id, (current) => ({ ...current, phase: 'idle', status: 'تم الإيقاف' })) }
    catch (error) { updateView(id, (current) => ({ ...current, phase: 'running', status: 'التنفيذ مستمر', error: `تعذر إيقاف التنفيذ: ${errorText(error)}` })) }
  }

  async function resume() {
    if (!active) return
    try { if (runState) setRunState({ ...runState, status: 'running' }); await window.rCode.agent.resume(active.id) } catch (error) { setAppError(errorText(error)) }
  }

  function editUserMessage(message: Message) {
    setInput(message.content)
    requestAnimationFrame(() => document.getElementById('agent-prompt')?.focus())
  }

  async function regenerateAssistant(message: Message) {
    if (!active) return
    try { await window.rCode.agent.send(active.id, `أعد توليد الرد السابق مع الحفاظ على نفس الطلب وتجنب تكرار الأدوات المكتملة. الرد السابق:\n${message.content.slice(0, 4_000)}`) } catch (error) { setAppError(errorText(error)) }
  }

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

  async function answerApproval(request: ApprovalRequest, allowed: boolean, remember: boolean) {
    setAnsweringApproval(request.id)
    try { await window.rCode.approval.answer(request.id, allowed, remember); setApprovals((items) => items.filter((item) => item.id !== request.id)) }
    catch (error) { setAppError(errorText(error)) }
    finally { setAnsweringApproval(null) }
  }

  async function openAudit() { try { setAuditEvents(await window.rCode.audit.list(300)); setAuditOpen(true) } catch (error) { setAppError(errorText(error)) } }

  function trackScroll() { const element = messagesRef.current; if (!element) return; const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 110; followRef.current = nearBottom; if (nearBottom) setShowLatest(false) }
  function jumpLatest() { followRef.current = true; setShowLatest(false); endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }
  const todoProgress = view.todos.length > 0 ? { done: view.todos.filter((todo) => todo.status === 'completed').length, total: view.todos.length, current: view.todos.find((todo) => todo.status === 'in_progress')?.content } : { done: 0, total: 0, current: undefined as string | undefined }
  return <main className={`app-shell ${sidebarOpen ? '' : 'sidebar-closed'}`}>
    {sidebarOpen && <><button className="sidebar-backdrop" aria-label="إغلاق الشريط الجانبي" onClick={() => setSidebarOpen(false)}/><aside id="app-sidebar" className="sidebar">
      <div className="sidebar-head"><button aria-label="إغلاق الشريط الجانبي" className="sidebar-toggle" onClick={() => setSidebarOpen(false)}><PanelLeft size={16}/></button><div className="brand"><div className="brand-mark"><Code2 size={18}/></div><strong>Rahma Code Agent</strong></div></div>
      <div className="project-buttons"><button className="new-task" onClick={() => void newSession()}><Plus size={15}/> مهمة جديدة</button><button className="open-project" onClick={() => void openProject()}><FolderOpen size={15}/> فتح مشروع</button></div>
      <label className="sidebar-search"><Search size={13}/><span className="sr-only">بحث في الجلسات</span><input aria-label="بحث في الجلسات" value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="بحث"/></label>
      <div className="sidebar-section-title">المشاريع والجلسات</div>
      <div className="sidebar-list">
       {active && <div className="sidebar-project"><FolderOpen size={14}/><span>{active.workspace.split(/[\\/]/).pop()}</span></div>}
       {active && <div className="file-tree" aria-label="شجرة الملفات"><div className="file-tree-title"><FolderOpen size={12}/> ملفات المشروع</div>{treeEntries.map((entry) => <button className="file-tree-entry" key={entry.path} title={entry.path} onClick={() => void window.rCode.files.read(active.id, entry.path).then((content) => window.rCode.clipboard.writeText(content)).catch((error) => setAppError(errorText(error)))}><span>{entry.directory ? '▸' : '·'}</span><span>{entry.name}</span></button>)}</div>}
        {sessions.filter((session) => `${session.title} ${session.workspace}`.toLowerCase().includes(sessionQuery.trim().toLowerCase())).map((session) => { const itemView = views[session.id]; const state = itemView?.error ? 'error' : itemView?.phase !== 'idle' ? 'running' : ''; return <div key={session.id} className="sidebar-item-wrap"><button aria-current={activeId === session.id ? 'page' : undefined} className={`sidebar-item ${activeId === session.id ? 'active' : ''}`} onClick={() => void select(session)}><span className={`sidebar-dot ${state}`}/><span className="sidebar-item-title">{session.title}</span></button><button aria-label={`حذف المحادثة ${session.title}`} className="sidebar-delete" onClick={() => void removeSession(session)}><Trash2 size={12}/></button></div> })}
      </div>
      <div className="sidebar-actions"><button className="sidebar-settings" onClick={() => setSettings(true)} aria-haspopup="dialog"><Settings size={15}/> الإعدادات <span className={`provider-state ${provider.hasApiKey ? 'ready' : ''}`}>{provider.hasApiKey ? 'جاهز' : 'مطلوب'}</span></button><button className="sidebar-settings" onClick={() => void openAudit()} aria-haspopup="dialog"><Shield size={15}/> سجل النشاط</button></div>
    </aside></>}
    {!sidebarOpen && <button aria-label="فتح الشريط الجانبي" aria-controls="app-sidebar" aria-expanded={sidebarOpen} className="sidebar-open-btn" onClick={() => setSidebarOpen(true)}><PanelRight size={16}/></button>}

    <section className="workspace">
        {hasMessages && <header className="topbar"><div className="topbar-left"><span className="session-title">{active?.title}</span>{active?.systemPrompt && <span className="prompt-badge" title={active.systemPrompt}><Code2 size={11}/> Prompt محفوظ</span>}</div><div className="topbar-right">{todoProgress.total > 0 && <button aria-pressed={planOpen} aria-label="إظهار أو إخفاء خطة العمل" className={`plan-toggle-btn ${planOpen ? 'on' : ''}`} title={todoProgress.current ? `الخطوة الحالية: ${todoProgress.current}` : 'خطة العمل'} onClick={() => { setPlanOpen(!planOpen); if (!planOpen) planUserClosed.current = false; else planUserClosed.current = true }}><ListChecks size={13}/><span>خطة العمل</span><span className="plan-toggle-progress">{todoProgress.done.toLocaleString('ar')}/{todoProgress.total.toLocaleString('ar')}</span></button>}<ModelSelect provider={provider} change={changeModel}/><button aria-pressed={active?.agentMode === 'plan'} className={`mode-pill ${active?.agentMode === 'plan' ? 'plan' : ''}`} onClick={() => void updateSession({ agentMode: active?.agentMode === 'plan' ? 'build' : 'plan' })}>{active?.agentMode === 'plan' ? 'Plan' : 'Build'}</button><button aria-pressed={active?.permissionMode === 'full'} className={`perm-pill ${active?.permissionMode === 'full' ? 'full' : ''}`} onClick={() => void updateSession({ permissionMode: active?.permissionMode === 'full' ? 'ask' : 'full' })}>{active?.permissionMode === 'full' ? <><ShieldAlert size={13}/> وصول كامل</> : <><Shield size={13}/> اسألني</>}</button><span className={`git-pill ${active?.gitTracked ? 'on' : ''}`} title={active?.gitTracked ? 'هذه الجلسة تحفظ كل تعديل في Git تلقائيًا' : 'هذه الجلسة دون تتبع Git؛ كل تعديل يُنفذ مباشرة دون commit'}><Code2 size={13}/> {active?.gitTracked ? 'Git مفعّل' : 'Git مققل'}</span>{active && <button aria-label="حذف المحادثة" className="delete-chat-btn" title="حذف المحادثة" onClick={() => void removeSession(active)}><Trash2 size={14}/></button>}</div></header>}
       {!hasMessages ? <Welcome input={input} setInput={setInput} send={send} provider={provider} changeModel={changeModel} active={active} newSession={newSession} view={view} cancel={cancel} pendingAttachments={pendingAttachments} setPendingAttachments={setPendingAttachments} sessionPrompt={sessionPrompt} setSessionPrompt={setSessionPrompt}/> : <div className="chat-view">
         {runState?.status === 'interrupted' && <div className="resume-banner"><span>توقف التشغيل السابق عند الجولة {runState.step.toLocaleString('ar')}.</span><button onClick={() => void resume()}>استئناف التنفيذ</button></div>}
         <div className="messages" ref={messagesRef} onScroll={trackScroll}><div className="messages-inner">{groupConversation(view.messages).map((item) => item.kind === 'execution' ? <ExecutionStage key={item.id} messages={item.messages}/> : <MessageBubbleWithActions key={item.message.id} message={item.message} streaming={view.streamingId === item.message.id} onEdit={editUserMessage} onRegenerate={regenerateAssistant}/>)}<div ref={endRef}/></div></div>
        {view.subagents.length > 0 && <SubagentPanel subagents={view.subagents}/>}
        {showLatest && <button aria-label="الانتقال إلى أحدث الرسائل" className="jump-latest" onClick={jumpLatest}><ChevronDown size={14}/> أحدث الرسائل</button>}
        <Composer input={input} setInput={setInput} send={send} provider={provider} changeModel={changeModel} active={active} view={view} cancel={cancel} dismissError={() => active && updateView(active.id, (current) => ({ ...current, error: null }))} pendingAttachments={pendingAttachments} setPendingAttachments={setPendingAttachments}/>
      </div>}
    </section>

    {planOpen && todoProgress.total > 0 && <div id="app-plan" className={`plan-float ${planExpanded ? 'expanded' : ''}`} role="complementary" aria-label="خطة العمل">
      <div className="plan-float-head">
        <button className="plan-float-title" onClick={() => setPlanExpanded(!planExpanded)} aria-expanded={planExpanded} aria-label={planExpanded ? 'طي قائمة خطة العمل' : 'فتح قائمة خطة العمل'}>
          <span className="plan-float-mark"><ListChecks size={13}/></span>
          <strong>خطة العمل</strong>
          <span className="plan-float-progress">{todoProgress.done.toLocaleString('ar')}/{todoProgress.total.toLocaleString('ar')}</span>
          <ChevronDown size={12} className={`plan-float-chev ${planExpanded ? 'rot' : ''}`}/>
        </button>
        <button className="plan-float-close" aria-label="إغلاق خطة العمل بالكامل" onClick={() => { setPlanOpen(false); planUserClosed.current = true }}><X size={12}/></button>
      </div>
      <div className="plan-float-progress-track"><div className="plan-float-progress-bar" style={{ width: `${Math.round(todoProgress.done / todoProgress.total * 100)}%` }}/></div>
          {planExpanded && <>
           {todoProgress.current && <div className="plan-float-current" title={todoProgress.current}><LoaderCircle size={11} className="spin"/><span>{todoProgress.current}</span></div>}
            <div className="plan-float-list"><TodoList todos={view.todos}/></div>
           {active?.agentMode === 'plan' && !active.planApproved && <button className="plan-approve-btn" onClick={() => void approvePlan()}>اعتماد الخطة والانتقال إلى Build</button>}
         </>}
    </div>}

    {appError && <div className="app-error" role="alert"><span>{appError}</span><button aria-label="إغلاق الخطأ" onClick={() => setAppError(null)}><X size={14}/></button></div>}
    {settings && <SettingsModal value={provider} close={() => setSettings(false)} saved={setProvider}/>} 
    {auditOpen && <AuditModal events={auditEvents} close={() => setAuditOpen(false)}/>} 
    {approval && <ApprovalModal request={approval} session={sessions.find((item) => item.id === approval.sessionId)} position={`طلب 1 من ${approvals.length}`} busy={answeringApproval === approval.id} answer={(allowed, remember) => void answerApproval(approval, allowed, remember)}/>} 
    {gitPrompt && <GitInitModal workspace={gitPrompt.workspace} create={(initGit) => void createSessionWithGit(gitPrompt.workspace, initGit)} close={() => setGitPrompt(null)}/>} 
  </main>
}

  function Welcome({ input, setInput, send, provider, changeModel, active, newSession, view, cancel, pendingAttachments, setPendingAttachments, sessionPrompt, setSessionPrompt }: { input: string; setInput(value: string): void; send(): void; provider: ProviderSettings; changeModel(id: string): void; active: Session | null; newSession(): void; view: SessionView; cancel(): void; pendingAttachments: Attachment[]; setPendingAttachments(value: Attachment[] | ((items: Attachment[]) => Attachment[])): void; sessionPrompt: string; setSessionPrompt(value: string): void }) {
  const prompts: { text: string; icon: typeof Code2 }[] = [
    { text: 'حلل بنية هذا المشروع', icon: Search },
    { text: 'احسب أسطر المشروع واشرح أهم الملفات', icon: Gauge },
    { text: 'راجع المشروع واكتشف الأخطاء ثم أصلحها', icon: Shield },
  ]
  return <div className="welcome-view"><div className="welcome-center"><div className="welcome-icon"><Code2 size={32}/></div><div className="welcome-badge">وكيلك البرمجي المحلي · جاهز للعمل</div><h1>اجعل <span className="accent">عملك البرمجي</span> أسرع وأسهل</h1><p>حلّل مشروعك، اكتب كودًا نظيفًا، نفّذ أدوات آمنة، وراجع الملفات — كل ذلك من محادثة واحدة.</p></div>{active && <div className="prompt-input-wrap"><label className="prompt-label"><Code2 size={13}/> تعليمات النظام (Prompt) — تحفظ تلقائيًا وتبقى فعّالة طوال الجلسة</label><textarea className="prompt-input" placeholder="مثال: لا تحذف أي ملف إلا بعد التأكيد. استخدم Git في كل تعديل. اكتب تعليقات بالعربية..." value={sessionPrompt} onChange={(e) => setSessionPrompt(e.target.value)} rows={3}/></div>}<Composer input={input} setInput={setInput} send={send} provider={provider} changeModel={changeModel} active={active} view={view} cancel={cancel} dismissError={() => {}} pendingAttachments={pendingAttachments} setPendingAttachments={setPendingAttachments}/>{!active && <button className="select-folder" onClick={() => void newSession()}><FolderOpen size={15}/> اختر مجلد المشروع للبدء</button>}<div className="quick-chips">{prompts.map(({ text, icon: Icon }) => <button key={text} onClick={() => setInput(text)}><Icon size={12}/> {text}</button>)}</div></div>
}

 function Composer({ input, setInput, send, provider, changeModel, active, view, cancel, dismissError, pendingAttachments, setPendingAttachments }: { input: string; setInput(value: string): void; send(): void; provider: ProviderSettings; changeModel(id: string): void; active: Session | null; view: SessionView; cancel(): void; dismissError(): void; pendingAttachments: Attachment[]; setPendingAttachments(value: Attachment[] | ((items: Attachment[]) => Attachment[])): void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { const area = ref.current; if (!area) return; area.style.height = 'auto'; area.style.height = `${Math.min(160, Math.max(44, area.scrollHeight))}px` }, [input])
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
  function removeAttachment(index: number) { setPendingAttachments(pendingAttachments.filter((_, i) => i !== index)) }
  return <div className="composer-wrap">{view.error && <div className="session-error" role="alert"><XCircle size={14}/><span>{view.error}</span><button aria-label="إغلاق الخطأ" onClick={dismissError}><X size={13}/></button></div>}{pendingAttachments.length > 0 && <div className="attachment-previews">{pendingAttachments.map((attachment, index) => <div key={`${attachment.name}-${index}`} className="attachment-preview">{attachment.mimeType.startsWith('image/') ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} className="attachment-thumb"/> : <div className="attachment-file"><Code2 size={16}/><span>{attachment.name}</span></div>}<button aria-label={`إزالة ${attachment.name}`} className="attachment-remove" onClick={() => removeAttachment(index)}><X size={12}/></button></div>)}</div>}<div className="composer"><label className="sr-only" htmlFor="agent-prompt">رسالة الوكيل</label><textarea id="agent-prompt" ref={ref} value={input} disabled={view.phase === 'stopping'} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} onPaste={handlePaste} placeholder={view.phase === 'stopping' ? 'جارٍ إيقاف التنفيذ...' : view.phase !== 'idle' ? 'اكتب رسالة وستصل في الجولة التالية...' : 'أرسل رسالة... Shift+Enter لسطر جديد | الصق صورة من الحافظة'} rows={1}/><div className="composer-bar"><div className="composer-left"><input ref={fileInputRef} type="file" multiple accept="image/*,.pdf,.txt,.json,.csv,.xml,.html,.md" className="sr-only" onChange={handleFileSelect}/><button aria-label="إرفاق ملف" className="attach-btn" onClick={() => fileInputRef.current?.click()}><Paperclip size={14}/></button><span className="composer-stat">{lines.toLocaleString('ar')} سطر</span><span className="composer-stat" title={`${view.context.estimatedTokens} رمز تقريبي`}><Gauge size={12}/> {contextPercent ? `السياق ${contextPercent}% تقريبي` : 'السياق غير محسوب'}</span>{view.usage.requests > 0 && <span className="composer-stat" title="الاستخدام الفعلي إن أرسله المزود"><Gauge size={12}/> {view.usage.input.toLocaleString('ar')} إدخال · {view.usage.output.toLocaleString('ar')} إخراج{view.usage.cost > 0 && <> · ${view.usage.cost.toFixed(4)}</>}</span>}{view.context.compacted && <span className="context-compacted">تم تلخيص السياق</span>}</div><div className="composer-right"><ModelSelect provider={provider} change={changeModel} small/>{view.phase !== 'idle' && !input.trim() ? <button aria-label={view.phase === 'stopping' ? 'جارٍ إيقاف التنفيذ' : 'إيقاف التنفيذ'} className="stop-btn" disabled={view.phase === 'stopping'} onClick={cancel}>{view.phase === 'stopping' ? <LoaderCircle className="spin" size={14}/> : <Square size={14}/>}</button> : <button aria-label="إرسال" className={`send-btn ${view.phase !== 'idle' ? 'queue' : ''}`} disabled={!active || !input.trim() || view.phase === 'stopping'} onClick={send}><Send size={14}/></button>}</div></div>{view.status && <div className="composer-status" role="status" aria-live="polite"><LoaderCircle className="spin" size={13}/>{view.status}</div>}</div></div>
}

function ModelSelect({ provider, change, small = false }: { provider: ProviderSettings; change(id: string): void; small?: boolean }) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const menuId = useId()
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const btn = btnRef.current
      if (!btn) return
      const rect = btn.getBoundingClientRect()
      const margin = 8; const gap = 8; const preferredHeight = 360
      const width = Math.min(Math.max(300, rect.width), window.innerWidth - margin * 2)
      const above = rect.top - margin - gap; const below = window.innerHeight - rect.bottom - margin - gap
      const openAbove = above >= preferredHeight || above > below
      const maxHeight = Math.max(120, Math.min(preferredHeight, openAbove ? above : below))
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin)
      setMenuPos({ top: openAbove ? Math.max(margin, rect.top - gap - maxHeight) : rect.bottom + gap, left, width, maxHeight })
    }
    updatePosition()
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    const keyHandler = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); btnRef.current?.focus() } }
    document.addEventListener('keydown', keyHandler)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])
  const selected = GO_MODELS.find((m) => m.id === provider.model)
  return <div className={`model-select ${small ? 'small' : ''}`}><button ref={btnRef} className="model-select-btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)} type="button"><span className="model-dot"/><span>{selected?.name ?? provider.model}</span><ChevronDown size={12} className={`chev ${open ? 'rot' : ''}`}/></button>{open && menuPos && <div id={menuId} ref={menuRef} className="model-select-menu" role="listbox" style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width, maxHeight: menuPos.maxHeight }}>{GO_MODELS.map((model) => <button key={model.id} role="option" aria-selected={model.id === provider.model} className={`model-select-item ${model.id === provider.model ? 'active' : ''}`} onClick={() => { change(model.id); setOpen(false) }} type="button"><span className="model-select-name">{model.name}</span><span className="model-select-meta">{model.apiStyle === 'chat' ? 'Chat' : model.apiStyle === 'responses' ? 'Responses' : 'Anthropic'} · {(model.contextWindow / 1_000_000).toFixed(0)}M</span></button>)}</div>}</div>
}

function GitInitModal({ workspace, create, close }: { workspace: string; create(initGit: boolean): void; close(): void }) {
  const [initGit, setInitGit] = useState(false)
  const folder = workspace.split(/[\\/]/).pop() ?? workspace
  return <div className="modal-backdrop" onClick={close}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="git-init-title" onClick={(event) => event.stopPropagation()}><header><h2 id="git-init-title">فتح مشروع جديد</h2><button aria-label="إغلاق" onClick={close}><X size={18}/></button></header><p className="git-init-folder" dir="ltr">{workspace}</p><div className={`git-init-option ${initGit ? 'on' : ''}`}><label className="remember-approval"><input type="checkbox" checked={initGit} onChange={(event) => setInitGit(event.target.checked)}/> تفعيل تتبع Git وحفظ العمليات تلقائيًا</label></div><small>الخانة <b>مقفلة افتراضيًا</b>: دون تفعيلها لن يُنشأ أي مستودع ولن تُحفظ عمليات في Git. عند التفعيل سيُنشئ مستودعًا في <b>{folder}</b> مع .gitignore يستثني مجلدات البناء، ويحفظ كل تعديل في commit تلقائي.</small><footer><button className="btn-ghost" onClick={close}>إلغاء</button><button className="btn-primary" onClick={() => create(initGit)}>إنشاء الجلسة</button></footer></div></div>
}

function ReasoningBlock({ reasoning }: { reasoning: string }) { const [open, setOpen] = useState(false); return <div className={`reasoning-block ${open ? 'open' : ''}`}><button className="reasoning-head" onClick={() => setOpen(!open)} aria-expanded={open}><Brain size={13}/> <span>تفكير النموذج</span><ChevronDown size={12} className={open ? 'rot' : ''}/></button>{open && <pre className="reasoning-body">{reasoning}</pre>}</div> }

function MessageBubble({ message, streaming }: { message: Message; streaming: boolean }) { const waiting = streaming && !message.content && !message.toolCalls?.length; return <article className={`message ${message.role} ${streaming ? 'streaming' : ''}`}>{message.role === 'assistant' && <div className="msg-avatar assistant"><Bot size={17}/></div>}<div className="msg-body"><div className="msg-meta"><strong>{message.role === 'user' ? 'أنت' : 'Rahma Code Agent'}</strong>{message.role === 'assistant' && <span className="msg-badge">وكيل</span>}<time>{new Date(message.createdAt).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}</time>{waiting && <span className="writing-state"><i/><i/><i/> يجهز الرد</span>}</div>{message.reasoning && <ReasoningBlock reasoning={message.reasoning}/>}{message.attachments?.length ? <div className="message-attachments">{message.attachments.map((att, i) => att.mimeType.startsWith('image/') ? <img key={`${att.name}-${i}`} src={`data:${att.mimeType};base64,${att.data}`} alt={att.name} className="message-attachment-img"/> : <div key={`${att.name}-${i}`} className="message-attachment-file"><Code2 size={14}/>{att.name}</div>)}</div> : null}{message.content && <div className="msg-text streaming-text"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code({ className, children }) { const block = /language-(\w+)/.exec(className ?? ''); return block ? <CodeBlock language={block[1] ?? 'text'} code={String(children).replace(/\n$/, '')}/> : <code className="inline-code">{children}</code> }, pre({ children }) { return <>{children}</> }, a({ children, href }) { return <a href={safeLink(href)} target="_blank" rel="noreferrer">{children}</a> }, table({ children }) { return <div className="table-scroll"><table>{children}</table></div> } }}>{message.content}</ReactMarkdown>{streaming && <span className="stream-caret" aria-hidden="true"/>}</div>}{message.toolCalls?.length ? <div className="tool-list">{message.toolCalls.map((tool) => <ToolCard key={tool.id} tool={tool}/>)}</div> : null}</div>{message.role === 'user' && <div className="msg-avatar user"><Bot size={17}/></div>}</article> }
function MessageBubbleWithActions({ message, streaming, onEdit, onRegenerate }: { message: Message; streaming: boolean; onEdit(message: Message): void; onRegenerate(message: Message): void }) {
  if (streaming || message.role === 'tool') return <MessageBubble message={message} streaming={streaming}/>
  return <div className="message-with-actions"><MessageBubble message={message} streaming={false}/><div className="message-actions">{message.role === 'user' ? <button onClick={() => onEdit(message)}>تعديل الرسالة</button> : message.role === 'assistant' && message.content ? <button onClick={() => void onRegenerate(message)}>إعادة توليد</button> : null}</div></div>
}

function TodoList({ todos }: { todos: Todo[] }) {
  return <div className="todo-body">{todos.map((todo, index) => <div key={todo.id} className={`todo-item ${todo.status}`}>
    <span className="todo-index">{index + 1}</span>
    <span className={`todo-status ${todo.status}`} aria-label={todo.status === 'completed' ? 'مكتملة' : todo.status === 'in_progress' ? 'قيد التنفيذ' : 'لم تبدأ'}>{todo.status === 'completed' ? <Check size={11}/> : todo.status === 'in_progress' ? <LoaderCircle className="spin" size={12}/> : <Square size={11}/>}</span>
    <span className="todo-content">{todo.content}</span>
    <span className={`todo-priority ${todo.priority}`}>{todo.priority}</span>
  </div>)}</div>
}

function SubagentPanel({ subagents }: { subagents: SubagentEvent[] }) {
  const [open, setOpen] = useState(true)
  const running = subagents.filter((item) => item.state === 'running').length
  const done = subagents.filter((item) => item.state === 'completed').length
  const failed = subagents.filter((item) => item.state === 'failed').length
  const allDone = subagents.length > 0 && running === 0
  const summary = allDone ? `${done.toLocaleString('ar')} مكتملة${failed ? ` · ${failed.toLocaleString('ar')} فشلت` : ''}` : running > 0 ? `${running.toLocaleString('ar')} يعمل الآن` : ''
  return <section className={`subagent-panel ${open ? 'open' : ''}`}>
    <button className="subagent-head" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="subagent-head-icon"><Bot size={15}/></span>
      <span className="subagent-head-title"><strong>مهام الوكلاء</strong><small className={allDone && !failed ? 'done' : failed ? 'failed' : ''}>{summary}</small></span>
      <ChevronDown className={open ? 'rot' : ''} size={14}/>
    </button>
    {open && <div className="subagent-body">{subagents.map((item) => <SubagentRow key={item.id} item={item}/>)}</div>}
  </section>
}

function SubagentRow({ item }: { item: SubagentEvent }) {
  const [open, setOpen] = useState(item.state === 'completed' && !item.error)
  useEffect(() => { if (item.state === 'completed' || item.state === 'failed') setOpen(true) }, [item.state])
  const label = item.state === 'running' ? 'قيد العمل' : item.state === 'completed' ? 'مكتملة' : 'فشلت'
  return <div className={`subagent-row ${item.state} ${open ? 'open' : ''}`}>
    <button className="subagent-row-head" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className={`subagent-status ${item.state}`}>{item.state === 'running' ? <LoaderCircle className="spin" size={13}/> : item.state === 'completed' ? <CheckCircle2 size={13}/> : <XCircle size={13}/>}</span>
      <span className="subagent-row-title" dir="rtl"><b>{item.description}</b>{item.tool && <small dir="ltr">{item.tool.replaceAll('_', ' ')}</small>}</span>
      <span className="subagent-tag">{label}</span>
      <ChevronDown className={open ? 'rot' : ''} size={12}/>
    </button>
    {open && (item.summary || item.error) && <div className="subagent-row-body">{item.summary && <div className="subagent-summary"><p>{item.summary}</p></div>}{item.error && <div className="subagent-error"><p>{item.error}</p></div>}</div>}
  </div>
}

function ExecutionStage({ messages }: { messages: Message[] }) {
  const [open, setOpen] = useState(false)
  const tools = messages.flatMap((message) => message.toolCalls ?? [])
  const running = tools.some((tool) => tool.status === 'running')
  const failed = tools.some((tool) => tool.status === 'error' || tool.status === 'denied')
  const completed = tools.filter((tool) => tool.status === 'completed').length
  const visibleTools = open ? tools : tools.filter((tool) => tool.status === 'running' || tool.status === 'error' || tool.status === 'denied')
  const visibleIds = new Set(visibleTools.map((tool) => tool.id))
  const progress = tools.length ? Math.round((completed / tools.length) * 100) : 0
  useEffect(() => { setOpen(running || failed) }, [running, failed])
  return <section className={`execution-step ${running ? 'running' : failed ? 'failed' : 'completed'} ${open ? 'details-open' : ''}`}>
    <button className="execution-head" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="execution-mark">{running ? <LoaderCircle className="spin" size={16}/> : failed ? <XCircle size={16}/> : <CheckCircle2 size={16}/>}</span>
      <span><strong>{running ? 'قيد التنفيذ الآن' : failed ? 'تحتاج مراجعة' : 'اكتملت'}</strong><small><span className="exec-counter">{tools.length.toLocaleString('ar')} عملية</span><span>{executionSummary(tools)}</span></small></span>
      <ChevronDown className={open ? 'rot' : ''} size={14}/>
    </button>
    {running && <div className="execution-progress"><div className="execution-progress-bar" style={{ width: `${progress}%` }}/></div>}
    {!open && !running && !failed && tools.length > 0 && <div className="execution-collapsed-note">اكتمل التنفيذ · اضغط لعرض سجل الأدوات</div>}
    {open && <div className="execution-body">{messages.map((message) => { const messageTools = message.toolCalls?.filter((tool) => visibleIds.has(tool.id)); return messageTools?.length || message.content ? <div className="execution-round" key={message.id}>{message.content && <p>{message.content}</p>}<div className="tool-list">{messageTools?.map((tool) => <ToolCard key={tool.id} tool={tool}/>)}</div></div> : null })}</div>}
  </section>
}

function executionSummary(tools: NonNullable<Message['toolCalls']>): string {
  const reads = tools.filter((tool) => ['read_file', 'read_files', 'list_directory', 'tree', 'glob_files', 'get_file_info'].includes(tool.name)).length
  const changes = tools.filter((tool) => ['write_file', 'edit_file', 'append_file', 'delete_file', 'move_file'].includes(tool.name)).length
  const parts = [`${tools.filter((tool) => tool.status === 'completed').length.toLocaleString('ar')} مكتملة`]
  if (reads) parts.push(`${reads.toLocaleString('ar')} قراءة`)
  if (changes) parts.push(`${changes.toLocaleString('ar')} تعديل`)
  return parts.join(' · ')
}
function CodeBlock({ language, code }: { language: string; code: string }) { const [copied, setCopied] = useState(false); async function copy() { try { await window.rCode.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {} } return <div className="code-block" dir="ltr"><div className="code-head"><span><span className="code-lang-dot"/>{language}</span><button aria-label="نسخ الكود" onClick={() => void copy()}>{copied ? <Check size={12}/> : <Copy size={12}/>} {copied ? 'تم النسخ' : 'نسخ'}</button></div><pre><code>{code}</code></pre></div> }
  function ToolCard({ tool }: { tool: NonNullable<Message['toolCalls']>[number] }) { const [open, setOpen] = useState(false); const target = String(tool.input.path ?? tool.input.command ?? ''); const statusLabel: Record<string, string> = { running: 'قيد التنفيذ', completed: 'تم', error: 'فشل', denied: 'مرفوض' }; return <div className={`tool-card ${tool.status}`}><button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}><span className="tool-icon">{tool.status === 'running' ? <LoaderCircle className="spin" size={14}/> : tool.status === 'completed' ? <CheckCircle2 size={14}/> : <XCircle size={14}/>}</span><span className="tool-info"><b>{tool.name.replaceAll('_', ' ')}</b><div className="tool-meta-row">{target && <small dir="ltr">{target}</small>}<span className="tool-tag">{statusLabel[tool.status] ?? tool.status}</span></div></span><ChevronDown className={open ? 'rot' : ''} size={13}/></button>{open && <div className="tool-body"><strong>المدخلات</strong><pre>{JSON.stringify(tool.input, null, 2)}</pre>{tool.output !== undefined && <><strong>النتيجة</strong>{tool.name === 'run_powershell' ? <AnsiOutput value={tool.output}/> : <DiffOrText name={tool.name} value={tool.output}/>}</>}</div>}</div> }

function DiffOrText({ name, value }: { name: string; value: string }) {
  if (!['patch_file', 'write_file', 'edit_file', 'append_file', 'delete_file'].includes(name)) return <pre>{value}</pre>
  try {
    const parsed = JSON.parse(value) as { data?: { diff?: string } }
    if (typeof parsed.data?.diff === 'string') return <pre className="diff-view">{parsed.data.diff.split(/\r?\n/).map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>)}</pre>
  } catch {}
  return <pre>{value}</pre>
}

function AnsiOutput({ value }: { value: string }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    const terminal = new Terminal({ convertEol: true, disableStdin: true, scrollback: 5_000, fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 12, theme: { background: '#0b0f16', foreground: '#d7e1ef' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current)
    fit.fit()
    terminal.write(value.replace(/\r?\n/g, '\r\n'))
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(host.current)
    return () => { observer.disconnect(); terminal.dispose() }
  }, [value])
  return <div ref={host} className="terminal-output" aria-label="مخرجات الطرفية" />
}

function SettingsModal({ value, close, saved }: { value: ProviderSettings; close(): void; saved(value: ProviderSettings): void }) {
  const [modelId, setModelId] = useState(value.model); const [contextWindow, setContextWindow] = useState(value.contextWindow); const [apiKey, setApiKey] = useState(''); const [result, setResult] = useState(''); const [busy, setBusy] = useState<'save' | 'test' | null>(null); const model = getGoModel(modelId)
  function selectModel(id: string) { setModelId(id); setContextWindow(getGoModel(id).contextWindow) }
  async function save() { setBusy('save'); setResult(''); try { const settings = await window.rCode.provider.save({ model: modelId, contextWindow, apiKey: apiKey || undefined }); saved(settings); close() } catch (error) { setResult(errorText(error)) } finally { setBusy(null) } }
  async function test() { setBusy('test'); setResult('جارٍ الاختبار...'); try { setResult(await window.rCode.provider.test({ model: modelId, contextWindow, apiKey: apiKey || undefined })) } catch (error) { setResult(errorText(error)) } finally { setBusy(null) } }
  async function clearKey() { if (!window.confirm('حذف مفتاح API المحفوظ من هذا الجهاز؟')) return; setBusy('save'); setResult(''); try { saved(await window.rCode.provider.clear()); setApiKey(''); close() } catch (error) { setResult(errorText(error)) } finally { setBusy(null) } }
  const source = model.contextSource === 'catalog' ? 'موثّق في كتالوج models.dev' : model.contextSource === 'official-threshold' ? 'عتبة منشورة في توثيق OpenCode Go' : 'حد محافظ لأن Go لا ينشر قيمة سياق مؤكدة'
  return <div className="modal-backdrop" onClick={close}><div className="modal" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}><header><h2 id="settings-title">إعداد المزود</h2><button aria-label="إغلاق الإعدادات" onClick={close}><X size={18}/></button></header><p>المفتاح يبقى مشفرًا داخل Windows ولا يعاد إلى الواجهة. اترك الحقل فارغًا للاحتفاظ بالمفتاح المحفوظ.</p><label className="field"><KeyRound size={14}/> مفتاح API<input autoFocus dir="ltr" type="password" placeholder={value.hasApiKey ? 'مفتاح محفوظ، اكتب لاستبداله' : 'opencode_...'} value={apiKey} onChange={(event) => setApiKey(event.target.value)}/></label><label className="field">النموذج<select value={modelId} onChange={(event) => selectModel(event.target.value)}>{GO_MODELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{model.apiStyle === 'anthropic' ? 'Anthropic Messages' : model.apiStyle === 'responses' ? 'Responses API' : 'Chat Completions'}</small></label><label className="field">نافذة السياق الفعلية<input dir="ltr" type="number" min={32000} max={2000000} step={1000} value={contextWindow} onChange={(event) => setContextWindow(Math.min(2000000, Math.max(32000, Number(event.target.value) || 32000)))}/><small>الحالي: {contextWindow.toLocaleString('en')} رمز · {source}.</small></label>{result && <div className="test-result" role="status">{result}</div>}<footer>{value.hasApiKey && <button className="btn-ghost danger-text" onClick={() => void clearKey()} disabled={Boolean(busy)}>حذف المفتاح</button>}<button className="btn-ghost" onClick={() => void test()} disabled={Boolean(busy) || !apiKey && !value.hasApiKey}>{busy === 'test' ? 'يختبر...' : 'اختبار'}</button><button className="btn-primary" onClick={() => void save()} disabled={Boolean(busy) || !apiKey && !value.hasApiKey}>{busy === 'save' ? 'يحفظ...' : 'حفظ'}</button></footer></div></div>
}

function ApprovalModal({ request, session, position, busy, answer }: { request: ApprovalRequest; session?: Session; position: string; busy: boolean; answer(allowed: boolean, remember: boolean): void }) {
  const [remember, setRemember] = useState(false)
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) answer(false, false) }; document.addEventListener('keydown', onKeyDown); return () => document.removeEventListener('keydown', onKeyDown) }, [answer, busy])
  return <div className="modal-backdrop"><div className="modal approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title"><div className={`approval-icon ${request.risk}`}>{request.risk === 'critical' ? <ShieldAlert size={24}/> : <Shield size={24}/>}</div><h2 id="approval-title">{request.title}</h2><p>{request.risk === 'critical' ? 'عملية عالية الخطورة وتتطلب مراجعة دقيقة.' : 'راجع التفاصيل قبل السماح.'}</p><div className="approval-context"><span>{position}</span><span>{session?.title ?? request.sessionId}</span><span dir="ltr">{session?.workspace}</span></div><pre className="approval-detail">{request.detail}</pre>{request.canRemember && <label className="remember-approval"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)}/> السماح لنفس العملية لبقية هذه الجلسة</label>}<footer><button autoFocus className="btn-ghost" disabled={busy} onClick={() => answer(false, false)}>رفض</button><button className={`btn-primary ${request.risk === 'critical' ? 'danger' : ''}`} disabled={busy} onClick={() => answer(true, remember)}>{busy ? 'جارٍ الإرسال...' : 'سماح'}</button></footer></div></div>
}

function AuditModal({ events, close }: { events: AuditEvent[]; close(): void }) { return <div className="modal-backdrop" onClick={close}><div className="modal audit-modal" role="dialog" aria-modal="true" aria-labelledby="audit-title" onClick={(event) => event.stopPropagation()}><header><h2 id="audit-title">سجل النشاط</h2><button aria-label="إغلاق سجل النشاط" onClick={close}><X size={18}/></button></header><p>آخر العمليات والموافقات محفوظة محليًا في قاعدة البيانات.</p><div className="audit-list">{events.length ? events.map((event) => <article className={`audit-item ${event.outcome}`} key={event.id}><div><strong>{event.action}</strong><span>{event.category} · {event.outcome}</span><time>{new Date(event.createdAt).toLocaleString('ar')}</time></div><pre>{event.detail}</pre></article>) : <div className="audit-empty">لا توجد أحداث مسجلة بعد.</div>}</div></div></div> }

function upsertMessage(messages: Message[], incoming: Message): Message[] { const found = messages.some((message) => message.id === incoming.id); return (found ? messages.map((message) => message.id === incoming.id ? incoming : message) : [...messages, incoming]).sort(compareMessages) }
function upsertSubagent(subagents: SubagentEvent[], incoming: SubagentEvent): SubagentEvent[] { const found = subagents.some((item) => item.id === incoming.id); return (found ? subagents.map((item) => item.id === incoming.id ? incoming : item) : [...subagents, incoming]) }
function mergeMessages(loaded: Message[], live: Message[]): Message[] { const values = new Map(loaded.map((message) => [message.id, message])); for (const message of live) values.set(message.id, message); return [...values.values()].sort(compareMessages) }
function compareMessages(a: Message, b: Message): number { if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence; return a.createdAt - b.createdAt || a.id.localeCompare(b.id) }
function errorText(error: unknown): string { const raw = error instanceof Error ? error.message : String(error); return raw.replace(/^Error invoking remote method '[^']+': Error: /, '') }
function safeLink(value: string | undefined): string | undefined { if (!value) return undefined; try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : undefined } catch { return undefined } }
type ConversationItem = { kind: 'message'; message: Message } | { kind: 'execution'; id: string; messages: Message[] }
function groupConversation(messages: Message[]): ConversationItem[] { const result: ConversationItem[] = []; for (const message of messages.filter((item) => item.role !== 'tool')) { if (message.toolCalls?.length) { const previous = result.at(-1); if (previous?.kind === 'execution') previous.messages.push(message); else result.push({ kind: 'execution', id: `execution-${message.id}`, messages: [message] }) } else result.push({ kind: 'message', message }) } return result }
