/**
 * ApprovalModal + GitInitModal + TodoPanel — مكونات مستقلة
 * مستخرجة من App.tsx (P1-01)
 */
import { useState, useEffect, useRef } from 'react'
import { Check, ChevronDown, FolderOpen, LoaderCircle, ListChecks, Shield, ShieldAlert, Square, X, Code2 } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import type { ApprovalRequest, Session, Todo } from '../../../shared/types'

// ─── ApprovalModal ─────────────────────────────────────────────────

interface ApprovalModalProps {
  request: ApprovalRequest
  session?: Session
  position: string
  busy: boolean
  answer(allowed: boolean, remember: boolean): void
}

export function ApprovalModal({ request, session, position, busy, answer }: ApprovalModalProps) {
  const focusRef = useRef<HTMLDivElement>(null)
  useFocusTrap(focusRef, true)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) answer(false, false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [answer, busy])

  return (
    <div className="modal-backdrop">
      <div ref={focusRef} className="modal approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div className={`approval-icon ${request.risk}`}>{request.risk === 'critical' ? <ShieldAlert size={24} /> : <Shield size={24} />}</div>
        <h2 id="approval-title">{request.title}</h2>
        <p>{request.risk === 'critical' ? 'عملية عالية الخطورة وتتطلب مراجعة دقيقة.' : 'راجع التعديل الفعلي قبل السماح.'}<strong className="approval-paused">النموذج متوقف بالكامل بانتظار قرارك.</strong></p>
        <div className="approval-context"><span>{position}</span><span>{session?.title ?? request.sessionId}</span><span dir="ltr">{session?.workspace}</span></div>
        <ApprovalDetail detail={request.detail} />
        {request.canRemember && <label className="remember-approval"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> السماح لنفس العملية لبقية هذه الجلسة</label>}
        <footer><button autoFocus className="btn-ghost" disabled={busy} onClick={() => answer(false, false)}>رفض</button><button className={`btn-primary ${request.risk === 'critical' ? 'danger' : ''}`} disabled={busy} onClick={() => answer(true, remember)}>{busy ? 'جارٍ الإرسال...' : 'سماح'}</button></footer>
      </div>
    </div>
  )
}

function ApprovalDetail({ detail }: { detail: string }) {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(detail)
    data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed }
  } catch {
    return <pre className="approval-detail approval-raw-detail">{detail}</pre>
  }
  const diff = typeof data.diff === 'string' ? data.diff : typeof data.command === 'string' ? data.command : JSON.stringify(data.input ?? data, null, 2)
  const rows: Array<[string, unknown]> = [['الأداة', data.tool], ['المسار', data.target ?? data.file ?? data.repository], ['العملية', data.operation]]
  return (
    <div className="approval-detail-wrap">
      <div className="approval-change-heading">ما الذي سيحدث؟</div>
      <div className="approval-summary">
        {rows.filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label}><span>{label}</span><code dir="ltr">{String(value)}</code></div>)}
        {data.currentExists !== undefined && <div><span>الملف موجود</span><strong>{data.currentExists ? 'نعم، سيتم استبداله' : 'لا، سيتم إنشاؤه'}</strong></div>}
        {data.contentBytes !== undefined && <div><span>الحجم الجديد</span><strong>{String(data.contentBytes)} بايت</strong></div>}
      </div>
      <div className="approval-change-heading">التعديل الفعلي</div>
      <pre className="approval-detail approval-diff" dir="ltr">{diff}</pre>
    </div>
  )
}

// ─── GitInitModal ───────────────────────────────────────────────────

interface GitInitModalProps {
  workspace: string
  create(initGit: boolean): void
  close(): void
}

export function GitInitModal({ workspace, create, close }: GitInitModalProps) {
  const focusRef = useRef<HTMLDivElement>(null)
  useFocusTrap(focusRef, true)
  const [initGit, setInitGit] = useState(false)
  const folder = workspace.split(/[\\/]/).pop() ?? workspace
  return (
    <div className="modal-backdrop" onClick={close}>
      <div ref={focusRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="git-init-title" onClick={(event) => event.stopPropagation()}>
        <header><h2 id="git-init-title">فتح مشروع جديد</h2><button aria-label="إغلاق" onClick={close}><X size={18} /></button></header>
        <p className="git-init-folder" dir="ltr">{workspace}</p>
        <div className={`git-init-option ${initGit ? 'on' : ''}`}>
          <label className="remember-approval"><input type="checkbox" checked={initGit} onChange={(event) => setInitGit(event.target.checked)} /> تفعيل تتبع Git وحفظ العمليات تلقائيًا</label>
        </div>
        <small>الخانة <b>مقفلة افتراضيًا</b>: دون تفعيلها لن يُنشأ أي مستودع ولن تُحفظ عمليات في Git. عند التفعيل سيُنشئ مستودعًا في <b>{folder}</b> مع .gitignore يستثني مجلدات البناء، ويحفظ كل تعديل في commit تلقائي.</small>
        <footer><button className="btn-ghost" onClick={close}>إلغاء</button><button className="btn-primary" onClick={() => create(initGit)}>إنشاء الجلسة</button></footer>
      </div>
    </div>
  )
}

// ─── TodoList ───────────────────────────────────────────────────────

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <div className="todo-body">
      {todos.map((todo, index) => (
        <div key={todo.id} className={`todo-item ${todo.status}`}>
          <span className="todo-index">{index + 1}</span>
          <span className={`todo-status ${todo.status}`} aria-label={todo.status === 'completed' ? 'مكتملة' : todo.status === 'cancelled' ? 'ملغاة' : todo.status === 'in_progress' ? 'قيد التنفيذ' : 'لم تبدأ'}>
            {todo.status === 'completed' ? <Check size={11} /> : todo.status === 'cancelled' ? <X size={11} /> : todo.status === 'in_progress' ? <LoaderCircle className="spin" size={12} /> : <Square size={11} />}
          </span>
          <span className="todo-content">{todo.content}</span>
          <span className={`todo-priority ${todo.priority}`}>{todo.priority}</span>
        </div>
      ))}
    </div>
  )
}
