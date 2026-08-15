/**
 * BuildChat — شات متخصص داخل صفحة البناء
 * يرسل التعليمات للوكيل مباشرة على مشروع البناء
 */
import { memo, useState, useRef, useEffect, useCallback } from 'react'
import { Send, LoaderCircle, Bot, User, MessageSquarePlus, ChevronDown, Check, FileText, Square, Brain, Paperclip, X, ListTodo } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useBuildStore } from '../stores/buildStore'
import ModelSelect from './ModelSelector'
import { ExecutionTimeline } from './ExecutionTimeline'
import type { Attachment, ProviderSettings, AgentEvent, ApprovalRequest, BuildRunInfo } from '../../../shared/types'
import { compressImageAttachment } from '../image-attachment'

interface Props {
  provider: ProviderSettings
  onClose(): void
}

export function BuildChat({ provider, onClose }: Props) {
  const store = useBuildStore()
  const { buildSessionId, chatMessages, chatModel, project, pendingApproval, run, usage, telemetry, todos, files } = store
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshedRevision = useRef(0)
  const streamBuffers = useRef(new Map<string, string>())
  const streamFrames = useRef(new Map<string, number>())
  const reasoningBuffers = useRef(new Map<string, string>())
  const reasoningFrames = useRef(new Map<string, number>())
  const followMessages = useRef(true)

  const flushStream = useCallback((id: string) => {
    const delta = streamBuffers.current.get(id) ?? ''
    streamBuffers.current.delete(id)
    const frame = streamFrames.current.get(id)
    if (frame !== undefined) cancelAnimationFrame(frame)
    streamFrames.current.delete(id)
    if (!delta) return
    const state = useBuildStore.getState()
    const current = state.chatMessages.find((message) => message.id === id)?.content ?? ''
    state.updateChatMessage(id, current + delta)
  }, [])

  const queueDelta = useCallback((id: string, delta: string) => {
    streamBuffers.current.set(id, (streamBuffers.current.get(id) ?? '') + delta)
    if (streamFrames.current.has(id)) return
    streamFrames.current.set(id, requestAnimationFrame(() => flushStream(id)))
  }, [flushStream])

  // تابع آخر الرسائل فقط ما دام المستخدم قريبًا من الأسفل. تعيين scrollTop
  // يحصر الحركة في الشات ولا يحرك صفحة Build مثل scrollIntoView.
  useEffect(() => {
    const messages = messagesRef.current
    if (messages && followMessages.current) messages.scrollTop = messages.scrollHeight
  }, [chatMessages])

  const flushReasoning = useCallback((id: string, active: boolean) => {
    const delta = reasoningBuffers.current.get(id) ?? ''
    reasoningBuffers.current.delete(id)
    const frame = reasoningFrames.current.get(id)
    if (frame !== undefined) cancelAnimationFrame(frame)
    reasoningFrames.current.delete(id)
    const state = useBuildStore.getState()
    const current = state.chatMessages.find((message) => message.id === id)?.reasoning ?? ''
    if (delta || current) state.updateChatReasoning(id, current + delta, active)
  }, [])

  const queueReasoningDelta = useCallback((id: string, delta: string) => {
    reasoningBuffers.current.set(id, (reasoningBuffers.current.get(id) ?? '') + delta)
    if (reasoningFrames.current.has(id)) return
    reasoningFrames.current.set(id, requestAnimationFrame(() => flushReasoning(id, true)))
  }, [flushReasoning])

  const handleMessagesScroll = useCallback(() => {
    const messages = messagesRef.current
    if (!messages) return
    followMessages.current = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
  }, [])

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(100, Math.max(36, el.scrollHeight))}px`
  }, [input])

  // استقبال أحداث الوكيل
  useEffect(() => {
    if (!buildSessionId) return
    // يمنع انهيار صفحة Build عند تشغيل preload قديم أو غير مكتمل.
    const events = window.rCode?.events
    if (!events) return
    setSending(false)
    setStreamingId(null)

    const unsub = events.onBuildAgent((event: AgentEvent) => {
      if (event.sessionId !== buildSessionId) return
      const state = useBuildStore.getState()

      if (event.type === 'run:start') {
        if (!event.runId || state.cancelledRunIds.has(event.runId) || (!state.awaitingRunStart && state.run?.runId !== event.runId)) return
        const run: BuildRunInfo = { sessionId: buildSessionId, runId: event.runId, status: 'running', step: 0, startedAt: Date.now(), updatedAt: Date.now(), active: true, resumable: false }
        state.setRun(run)
        state.setAwaitingRunStart(false)
      } else {
        if (!event.runId || state.cancelledRunIds.has(event.runId) || !state.run || state.run.runId !== event.runId) return
      }

       if (event.type === 'message' && event.message && event.message.role === 'assistant') {
         const message = event.message
         // قد تسبق الرسالة النهائية stream:done؛ أفرغ delta المعلق أولًا ثم اعتمد
         // النص النهائي الموثوق كي لا يتكرر أي جزء.
         flushStream(message.id)
          flushReasoning(message.id, false)
          if (state.chatMessages.some((item) => item.id === message.id)) state.updateChatMessage(message.id, message.content, message.toolCalls, message.reasoning)
          else state.addChatMessage({ id: message.id, role: 'assistant', content: message.content, reasoning: message.reasoning, createdAt: message.createdAt, toolCalls: message.toolCalls })
         // رسالة المساعد بلا أدوات هي نهاية الجولة الفعلية، حتى لو وصل
         // حدث stream/status بترتيب مختلف بسبب سرعة المزود.
         if (!message.toolCalls?.length) {
           setStreamingId(null)
           setSending(false)
           state.setAwaitingRunStart(false)
           if (state.run?.active) state.setRun({ ...state.run, status: 'completed', active: false, resumable: false, updatedAt: Date.now() })
         }
       } else if (event.type === 'stream' && event.stream) {
        const s = event.stream
         if (s.state === 'start') {
           setStreamingId(s.id)
          state.addChatMessage({
            id: s.id, role: 'assistant', content: '', createdAt: Date.now(), streaming: true,
          })
         } else if (s.state === 'delta') {
           if (s.reasoning) {
             queueReasoningDelta(s.id, s.delta)
           } else {
             flushReasoning(s.id, false)
             queueDelta(s.id, s.delta)
           }
           } else if (s.state === 'done') {
             flushStream(s.id)
            flushReasoning(s.id, false)
            setStreamingId(null)
            state.finishChatMessage(s.id)
           } else if (s.state === 'discard') {
             flushStream(s.id)
             flushReasoning(s.id, false)
             state.removeChatMessage(s.id)
             setStreamingId(null)
           }
      } else if (event.type === 'status') {
        if (event.usage) state.setUsage(event.usage.total)
        if (!event.text) {
          setStreamingId(null)
          setSending(false)
          if (state.run) state.setRun({ ...state.run, status: 'completed', active: false, resumable: false, updatedAt: Date.now() })
        } else if (/إيقاف|أُلغي|ألغي|cancell?/i.test(event.text)) {
          setStreamingId(null)
          setSending(false)
          if (state.run) state.setRun({ ...state.run, status: 'interrupted', active: false, resumable: true, updatedAt: Date.now() })
        }
        } else if (event.type === 'error') {
        setStreamingId(null)
        setSending(false)
        if (state.run) {
          const interrupted = /توقف|مهلة|حد/.test(event.text ?? '')
          state.setRun({ ...state.run, status: interrupted ? 'interrupted' : 'failed', active: false, resumable: interrupted, error: event.text, updatedAt: Date.now() })
        }
        } else if (event.type === 'tool' && event.tool) {
         // أحداث الأدوات تصل قبل وبعد التنفيذ؛ حدّث السجل الموجود فورًا
         // حتى يظهر الاكتمال والخرج الحقيقيان دون انتظار رد النموذج التالي.
          const tool = event.tool
          if (tool.status !== 'running') state.recordToolTelemetry(tool)
         const message = state.chatMessages.find((item) => item.toolCalls?.some((call) => call.id === tool.id))
         if (message?.toolCalls) {
           state.updateChatMessage(message.id, message.content, message.toolCalls.map((call) => call.id === tool.id ? tool : call))
         }
       } else if (event.type === 'context' && event.context) {
         state.setContextTelemetry(event.context)
       } else if (event.type === 'todo' && event.todos) {
         state.setTodos(event.todos)
       } else if (event.type === 'preview' && event.preview) {
        state.setServer(event.preview)
        if (event.preview.running) state.setPhase('running')
        else if (event.preview.previewStarting) {}
        else if (event.preview.error) state.setPhase('error')
        else state.setPhase('ready')
      }

      // الإيصال هو المصدر الوحيد لحالة الملفات، وليس اسم الأداة أو مدخلاتها.
      if (event.type === 'tool' && event.tool?.status === 'completed' && event.tool.mutation) {
        const tool = event.tool
        const mutation = tool.mutation!
        if (mutation.effects.length) {
          const { project } = useBuildStore.getState()
          if (!project) return
          if (mutation.workspaceRevision > refreshedRevision.current) {
            refreshedRevision.current = mutation.workspaceRevision
            if (refreshTimer.current) clearTimeout(refreshTimer.current)
            refreshTimer.current = setTimeout(() => {
              window.rCode.build.readFiles(project.id).then((result) => { const current = useBuildStore.getState(); current.setFiles(result.files); current.setStats({ files: result.files.length, lines: result.files.reduce((sum, file) => sum + file.lines, 0), size: result.totalBytes, truncated: result.truncated }) }).catch(() => {})
            }, 60)
          }
          const affectedPaths = mutation.effects.flatMap((effect) => effect.kind === 'move' ? [effect.from, effect.path] : [effect.path])
           const { activeFile, setActiveFile } = useBuildStore.getState()
           if (activeFile && affectedPaths.some((affected) => activeFile === affected)) {
              const removed = mutation.effects.some((effect) => effect.kind === 'delete' && effect.path === activeFile || effect.kind === 'move' && effect.from === activeFile)
              if (removed) setActiveFile(null)
              else window.rCode.build.readFileContent(project.id, activeFile).then((c) => setActiveFile(activeFile, c)).catch(() => setActiveFile(null))
           }
        }
      }
    })
    const unsubApproval = events.onBuildApproval((request: ApprovalRequest) => {
      const current = useBuildStore.getState()
      if (request.sessionId !== buildSessionId || current.run?.runId && request.runId && current.run.runId !== request.runId) return
      current.setPendingApproval(request)
    })
    return () => { unsub(); unsubApproval(); if (refreshTimer.current) clearTimeout(refreshTimer.current); for (const id of streamFrames.current.keys()) flushStream(id); for (const id of reasoningFrames.current.keys()) flushReasoning(id, false) }
  }, [buildSessionId, flushReasoning, flushStream, queueDelta, queueReasoningDelta])

  // شبكة أمان: إذا اختفى التشغيل من المتجر (شات جديد/إغلاق مشروع/حذف) حرّر حقل الإدخال فورًا
  // — يمنع بقاء sending=true عالقًا في أي مسار مهما كان السبب
  useEffect(() => {
    return useBuildStore.subscribe((state, prev) => {
      if (prev.run && !state.run) {
        setSending(false)
        setStreamingId(null)
      }
    })
  }, [])

  // إرسال رسالة (مع مرفقات إن وُجدت)
  const handleSend = useCallback(async () => {
    if (!buildSessionId || (!input.trim() && !attachments.length) || sending) return
    // R8: فحص المشروع قبل أي شيء — لا نضيف رسالة ثم نرجع بصمت فنعلق حالة الإرسال.
    if (!project) {
      store.setCreateError('لا يوجد مشروع مفتوح. افتح مشروعًا أولًا.')
      return
    }
    const text = input.trim() || 'حلل الصورة المرفقة ونفّذ المطلوب الظاهر فيها.'
    const outgoing = attachments.length ? [...attachments] : undefined
    followMessages.current = true
    setInput('')
    setAttachments([])
    setMentionQuery(null)
    setSending(true)
    store.setAwaitingRunStart(true)

    store.addChatMessage({
      id: crypto.randomUUID(), role: 'user',
      content: outgoing?.length ? `${text}\n📎 ${outgoing.length} مرفق` : text,
      createdAt: Date.now(),
    })

    try {
       await window.rCode.buildAgent.send(project.id, text, outgoing, chatModel || provider.model)
       setSending(false)
    } catch (error) {
      setSending(false)
      store.setAwaitingRunStart(false)
      store.addChatMessage({
        id: crypto.randomUUID(), role: 'assistant',
        content: `❌ ${error instanceof Error ? error.message : 'فشل الإرسال'}`,
        createdAt: Date.now(),
      })
    }
  }, [buildSessionId, input, sending, store, chatModel, provider.model, project, attachments])

  // ─── إرفاق صور من الجهاز ─────────────────────────────────────────
  const addImageFiles = useCallback(async (fileList: File[]) => {
    const available = Math.max(0, 5 - attachments.length)
    const images = fileList.filter((file) => file.type.startsWith('image/') && file.size <= 20_000_000).slice(0, available)
    if (!images.length) return
    try {
      const compressed = await Promise.all(images.map((file, index) => compressImageAttachment(file, `pasted-image-${Date.now()}-${index}.jpg`)))
      setAttachments((current) => [...current, ...compressed].slice(0, 5))
    } catch (error) {
      store.setCreateError(error instanceof Error ? error.message : 'تعذر ضغط الصورة')
    }
  }, [attachments.length, store])

  const handlePickFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return
    void addImageFiles([...fileList])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [addImageFiles])

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (!images.length) return
    event.preventDefault()
    void addImageFiles(images)
  }, [addImageFiles])

  // ─── @file: إكمال تلقائي لمسارات المشروع ─────────────────────────
  const mentionMatches = mentionQuery === null ? [] : files.filter((file) => file.relativePath.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8)

  const handleInputChange = useCallback((value: string, caret: number) => {
    setInput(value)
    const beforeCaret = value.slice(0, caret)
    const match = /(?:^|\s)@([\w@./\\-]*)$/.exec(beforeCaret)
    setMentionQuery(match ? match[1] ?? '' : null)
    setMentionIndex(0)
  }, [])

  const insertMention = useCallback((relativePath: string) => {
    const el = inputRef.current
    const caret = el ? el.selectionStart : input.length
    const beforeCaret = input.slice(0, caret)
    const match = /(?:^|\s)@([\w@./\\-]*)$/.exec(beforeCaret)
    if (!match) { setMentionQuery(null); return }
    const insertAt = caret - (match[1]?.length ?? 0) - 1
    const next = `${input.slice(0, insertAt)}${relativePath} ${input.slice(caret)}`
    setInput(next)
    setMentionQuery(null)
    requestAnimationFrame(() => { if (inputRef.current) { inputRef.current.focus(); const pos = insertAt + relativePath.length + 1; inputRef.current.setSelectionRange(pos, pos) } })
  }, [input])

  // تغيير الموديل
  const handleModelChange = useCallback((modelId: string) => {
    store.setChatModel(modelId)
  }, [store])

  // مسح الشات
  const handleClear = async () => {
    if (!project || !confirm('مسح سجل محادثة Build؟ لن تُحذف ملفات المشروع.')) return
    try {
      await store.clearChat()
      setSending(false)
      setStreamingId(null)
    } catch (error) {
      // حتى لو فشل المسح، حرّر حقل الإدخال — لا نتركه مقفولًا
      setSending(false)
      setStreamingId(null)
      store.setAwaitingRunStart(false)
      store.addChatMessage({ id: crypto.randomUUID(), role: 'assistant', content: `❌ ${error instanceof Error ? error.message : 'تعذر مسح المحادثة'}`, createdAt: Date.now() })
    }
  }

  async function answerApproval(allowed: boolean, remember = false): Promise<void> {
    if (!pendingApproval) return
    const request = pendingApproval
    store.setPendingApproval(null)
    setSending(false)
    try { await window.rCode.buildApproval.answer(request.id, allowed, remember) } catch (error) { store.addChatMessage({ id: crypto.randomUUID(), role: 'assistant', content: `❌ ${error instanceof Error ? error.message : 'تعذر إرسال الموافقة'}`, createdAt: Date.now() }) }
  }

  async function handleStop(): Promise<void> {
    if (!project) return
    // ثبّت الإيقاف في الواجهة فورًا — لا ننتظر رد العملية الخلفية:
    // نحجب أي أحداث متأخرة من التشغيل الملغى حتى لا يُعاد اعتماده كـ "يعمل"،
    // ونحرر الإدخال فورًا بدل تعليقه على اكتمال waitForIdle في الخلفية.
    if (store.run?.runId) store.markRunCancelled(store.run.runId)
    store.setRun(null)
    store.setPendingApproval(null)
    store.setAwaitingRunStart(false)
    store.finishAllChatMessages()
    setSending(false)
    setStreamingId(null)
    for (const id of streamFrames.current.keys()) flushStream(id)
    try { await window.rCode.buildAgent.cancel(project.id) } catch { /* الإيقاف فوري في الواجهة؛ إخفاق IPC لا يعيد تشغيل الوكيل */ }
  }

  if (!buildSessionId) return null

  const working = sending || Boolean(run?.active)
  const visibleMessages = chatMessages.filter((message) => message.role !== 'system')
  const latestVisibleMessageId = visibleMessages.at(-1)?.id

  return (
    <div className={`build-chat ${working ? 'is-working' : ''}`}>
      <div className="build-chat-header">
        <button type="button" className="build-chat-toggle" onClick={onClose} aria-label="إغلاق شات البناء" title="إغلاق الشات">
          <Bot size={14} />
          {sending && <LoaderCircle size={12} className="spin" />}
          <X size={13} />
        </button>
        <div className="build-chat-header-right">
          <ModelSelect
            provider={{ ...provider, model: chatModel || provider.model }}
            change={handleModelChange}
          />
          <button type="button" className="build-chat-newchat" onClick={handleClear} title="مسح المحادثة وبدء شات جديد" aria-label="مسح المحادثة وبدء شات جديد">
            <MessageSquarePlus size={13}/><span>شات جديد</span>
          </button>
          {(sending || Boolean(run?.active)) && <button type="button" className="build-chat-stop" onClick={() => void handleStop()} title="إيقاف الوكيل الآن" aria-label="إيقاف الوكيل الآن"><Square size={12}/><span>إيقاف</span></button>}
        </div>
        <BuildTelemetryBar usage={usage} telemetry={telemetry} />
      </div>

      {pendingApproval && (
        <div className={`build-approval-card ${pendingApproval.risk === 'critical' ? 'critical' : ''}`}>
          <strong>{pendingApproval.title}</strong>
          <pre>{pendingApproval.detail}</pre>
          <div className="build-approval-actions">
            <button className="build-secondary-btn" onClick={() => void answerApproval(false)}>رفض</button>
            {pendingApproval.canRemember && <button className="build-secondary-btn" onClick={() => void answerApproval(true, true)}>سماح وتذكر</button>}
            <button className="build-primary-btn" onClick={() => void answerApproval(true)}>سماح</button>
          </div>
        </div>
      )}

      {
        <>
         <div ref={messagesRef} id="build-chat-content" className="build-chat-messages" onScroll={handleMessagesScroll} aria-live="polite" aria-busy={working}>
            {visibleMessages.length === 0 && (
              <div className="build-chat-empty">
                <Bot size={20} />
                <p>اكتب تعليماتك للوكيل لبناء وتعديل المشروع</p>
                <small>مثال: "غير لون الخلفية إلى أزرق غامق وأضف قائمة تنقل"</small>
              </div>
            )}
             {visibleMessages.map((msg) => <BuildChatMessage key={msg.id} message={msg} latest={msg.role === 'assistant' && msg.id === latestVisibleMessageId} />)}
          </div>

          {/* خطة العمل الحية للوكيل */}
          {todos.length > 0 && (
            <BuildTodosStrip todos={todos} />
          )}

          <div className="build-chat-input-wrap">
            {/* قائمة @file للإكمال التلقائي */}
            {mentionQuery !== null && mentionMatches.length > 0 && (
              <div className="build-mention-popup" role="listbox" aria-label="ملفات المشروع">
                {mentionMatches.map((file, index) => (
                  <button key={file.relativePath} type="button" role="option" aria-selected={index === mentionIndex}
                    className={`build-mention-item ${index === mentionIndex ? 'active' : ''}`}
                    onMouseDown={(event) => { event.preventDefault(); insertMention(file.relativePath) }}>
                    <FileText size={11} /><span dir="ltr">{file.relativePath}</span>
                  </button>
                ))}
              </div>
            )}

            {/* مرفقات مختارة */}
            {attachments.length > 0 && (
              <div className="build-attachments">
                {attachments.map((attachment, index) => (
                  <span key={`${attachment.name}-${index}`} className="build-attachment-chip" title={attachment.name}>
                    <Paperclip size={10} />
                    {attachment.name.length > 24 ? `${attachment.name.slice(0, 24)}…` : attachment.name}
                    <button type="button" aria-label={`إزالة ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}><X size={10} /></button>
                  </span>
                ))}
              </div>
            )}

            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => handlePickFiles(event.target.files)} />
            <div className="build-chat-input-row">
              <button type="button" className="build-chat-attach" title="إرفاق صور (لقطات شاشة، تصاميم...)" aria-label="إرفاق صور" onClick={() => fileInputRef.current?.click()} disabled={sending}>
                <Paperclip size={14} />
              </button>
              <textarea
                ref={inputRef}
                className="build-chat-input"
                aria-label="تعليمات البناء"
                dir="auto"
                value={input}
                onChange={(event) => handleInputChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
                onPaste={handlePaste}
                onKeyDown={(event) => {
                  if (mentionQuery !== null && mentionMatches.length > 0) {
                    if (event.key === 'ArrowDown') { event.preventDefault(); setMentionIndex((current) => (current + 1) % mentionMatches.length); return }
                    if (event.key === 'ArrowUp') { event.preventDefault(); setMentionIndex((current) => (current - 1 + mentionMatches.length) % mentionMatches.length); return }
                    if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); insertMention(mentionMatches[mentionIndex]?.relativePath ?? ''); return }
                    if (event.key === 'Escape') { setMentionQuery(null); return }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleSend() }
                }}
                placeholder={working ? 'الوكيل يعمل... اكتب رسالة متابعة للتدخل الفوري' : 'اكتب تعليمات البناء أو الصق صورة... (@ لملف، Shift+Enter لسطر جديد)'}
                rows={1}
                disabled={sending}
              />
              <button type="button" aria-label="إرسال تعليمات البناء"
                className="build-chat-send"
                onClick={handleSend}
                disabled={(!input.trim() && !attachments.length) || sending}
              >
                {sending ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
              </button>
            </div>
          </div>
        </>
      }
    </div>
  )
}

const BuildChatMessage = memo(function BuildChatMessage({ message, latest }: { message: import('../stores/buildStore').BuildChatMessage; latest: boolean }) {
  return (
    <div className={`build-chat-msg ${message.role} ${latest ? 'latest' : ''}`}>
      <span className="build-chat-role">
        {message.role === 'user' ? <User size={12} /> : <BuildBotIcon />}
      </span>
      <div className="build-chat-content">
        {message.reasoning && <BuildThinkingIndicator reasoning={message.reasoning} active={Boolean(message.reasoningActive)} />}
        {message.content ? <MsgContent role={message.role} content={message.content} streaming={message.streaming} /> : message.streaming && !message.reasoning && <div className="build-thinking" role="status"><LoaderCircle size={12} className="spin" /> <span>يجهز الرد...</span></div>}
        {message.toolCalls && message.toolCalls.length > 0 && <div className="execution-flat"><ExecutionTimeline tools={message.toolCalls} /></div>}
      </div>
    </div>
  )
})

function BuildThinkingIndicator({ reasoning, active }: { reasoning: string; active: boolean }) {
  return (
    <details className={`build-thinking-panel ${active ? 'active' : 'complete'}`}>
      <summary>
        <span className="build-thinking-icon"><Brain size={13} /></span>
        <span className="build-thinking-title">التفكير</span>
        <span className="build-thinking-pulse" aria-hidden="true"><i /><i /><i /></span>
        <span className="build-thinking-state">{active ? 'جارٍ' : 'اكتمل'}</span>
        <ChevronDown size={12} className="build-thinking-chevron" aria-hidden="true" />
      </summary>
      <div className="build-thinking-body">
        <div className="build-thinking-pattern" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        <div className="build-thinking-text" dir="auto">{reasoning}</div>
      </div>
    </details>
  )
}

function BuildBotIcon() {
  return (
    <svg className="build-bot-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v3M9 3h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="4" y="6" width="16" height="14" rx="4" fill="rgba(148, 163, 184, .08)" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 11H2.8M20 11h1.2M8 20v1M16 20v1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle className="build-bot-eye build-bot-eye-left" cx="9" cy="13" r="1.5" />
      <circle className="build-bot-eye build-bot-eye-right" cx="15" cy="13" r="1.5" />
    </svg>
  )
}

function safeLink(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return /^(https?|mailto|tel):$/i.test(url.protocol) ? url.toString() : undefined
  } catch { return undefined }
}

function MsgContent({ role, content, streaming }: { role: string; content: string; streaming?: boolean }) {
  if (role === 'user') return <>{content}</>
  if (streaming) return <div className="build-stream-text" dir="auto">{content}</div>
  return (
    <div className="build-markdown" dir="auto">
    <ReactMarkdown remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children }) {
          const isBlock = /language-(\w+)/.exec(className ?? '')
          if (isBlock) {
            return <pre className="bg-code"><code className={className}>{children}</code></pre>
          }
          return <code className="inline-code">{children}</code>
        },
        pre({ children }) { return <>{children}</> },
        a({ children, href }) { return <a href={safeLink(href)} target="_blank" rel="noreferrer">{children}</a> },
        table({ children }) { return <div className="build-table-wrap"><table>{children}</table></div> },
      }}
    >
      {content}
    </ReactMarkdown></div>
  )
}

function BuildTelemetryBar({ usage, telemetry }: { usage: import('../../../shared/types').UsageSummary; telemetry: import('../stores/buildStore').BuildTelemetry }) {
  const percent = telemetry.contextWindow ? Math.min(100, Math.round(telemetry.estimatedTokens / telemetry.contextWindow * 100)) : null
  return <div className="build-telemetry" title={`زمن الأدوات ${telemetry.toolMs}ms${telemetry.compacted ? '، تم ضغط السياق' : ''}`} aria-label="إحصاءات شات البناء" dir="rtl">
    <span>الجولات <b dir="ltr">{telemetry.rounds}</b></span><span>الرموز <b dir="ltr">{usage.total.toLocaleString('en')}</b></span><span>السياق <b dir="ltr">{percent === null ? 'غير متاح' : `${percent}%`}</b></span><span className="build-telemetry-low" title={`التكلفة $${usage.cost.toFixed(3)}`}>$<b dir="ltr">{usage.cost.toFixed(3)}</b></span><span className="build-telemetry-low" title={`رموز التخزين المؤقت ${usage.cacheRead.toLocaleString('en')}`}>C <b dir="ltr">{usage.cacheRead.toLocaleString('en')}</b></span>
  </div>
}

function BuildTodosStrip({ todos }: { todos: import('../../../shared/types').Todo[] }) {
  const [open, setOpen] = useState(true)
  const visible = todos.filter((t) => t.status !== 'cancelled')
  const completed = visible.filter((t) => t.status === 'completed').length
  const inProgress = visible.filter((t) => t.status === 'in_progress').length
  const pending = visible.filter((t) => t.status === 'pending').length

  return (
    <div className="build-todos-panel" aria-label="خطة العمل">
      <button type="button" className="build-todos-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ListTodo size={13} className="build-todos-header-icon" />
        <span className="build-todos-header-title">خطة العمل</span>
        <span className="build-todos-header-count">
          {completed}/{visible.length}
        </span>
        <span className="build-todos-progress">
          <span className="build-todos-progress-fill" style={{ width: visible.length ? `${(completed / visible.length) * 100}%` : '0%' }} />
        </span>
        {inProgress > 0 && <span className="build-todos-header-active"><LoaderCircle size={10} className="spin" /> {inProgress}</span>}
        {pending > 0 && <span className="build-todos-header-pending">{pending} متبقٍ</span>}
        <ChevronDown size={12} className={`build-todos-chev${open ? ' rot' : ''}`} />
      </button>
      {open && (
        <div className="build-todos-list">
          {visible.map((todo) => (
            <div key={todo.id} className={`build-todos-row ${todo.status}`}>
              <span className="build-todos-status">
                {todo.status === 'completed' ? <Check size={11} /> : todo.status === 'in_progress' ? <LoaderCircle size={11} className="spin" /> : <span className="build-todos-dot" />}
              </span>
              <span className="build-todos-text">{todo.content}</span>
              {todo.priority === 'high' && <span className="build-todos-priority-high">مهم</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
