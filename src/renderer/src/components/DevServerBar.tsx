/**
 * DevServerBar — شريط أدوات: تشغيل | إيقاف | معاينة | نشر | إيقاف تام
 */
import { memo, useEffect, useRef, useState } from 'react'
import { Play, Square, ExternalLink, Rocket, LoaderCircle, Circle, StopCircle, FolderOpen, X, Clock } from 'lucide-react'
import { useBuildStore } from '../stores/buildStore'
import type { DevServerState } from '../../../shared/types'

interface Props {
  server: DevServerState
  phase: 'home' | 'empty' | 'creating' | 'ready' | 'running' | 'error'
  projectId: string
  onDeploy(): void
  onClose(): void
}

function formatRunTime(totalSec: number): string {
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export const DevServerBar = memo(function DevServerBar({ server, phase, projectId, onDeploy, onClose }: Props) {
  const store = useBuildStore()
  const [starting, setStarting] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [runElapsedSec, setRunElapsedSec] = useState(0)
  const cancelledRef = useRef(false)
  const isRunning = server.running
  const canStart = (phase === 'ready' || phase === 'error') && !server.running && !starting
  const runActive = Boolean(store.run?.active)

  // R1: مؤقت ثوانٍ أثناء التشغيل ليعرف المستخدم أن العمل جارٍ (قد يكون تثبيت اعتماديات)
  useEffect(() => {
    if (!starting) { setElapsedSec(0); return }
    const timer = setInterval(() => setElapsedSec((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [starting])

  // مؤقت تشغيل الوكيل — يرى المستخدم أن الوكيل يعمل فعلًا وليس عالقًا بصمت
  useEffect(() => {
    if (!runActive || !store.run?.startedAt) { setRunElapsedSec(0); return }
    const startedAt = store.run.startedAt
    setRunElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    const timer = setInterval(() => setRunElapsedSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 1000)
    return () => clearInterval(timer)
  }, [runActive, store.run?.startedAt])

  async function handleStart() {
    setStarting(true)
    cancelledRef.current = false
    store.setPhase('running'); store.setCreateError(null)
    store.setServer({ running: false, previewStarting: true })
    try {
      const s = await window.rCode.devserver.start(projectId)
      if (cancelledRef.current) {
        // أُلغي التشغيل أثناء البدء — لا نظهر خطأً وهميًا من عملية قتلها الإلغاء
        store.setServer({ running: false })
        store.setPhase('ready')
        return
      }
      store.setServer(s)
      store.setPhase(s.running ? 'running' : s.error ? 'error' : 'ready')
      if (!s.running && s.error) store.setCreateError(s.error)
    } catch (e) { store.setCreateError(e instanceof Error ? e.message : 'فشل'); store.setServer({ running: false, error: String(e) }); store.setPhase('error') }
    finally { setStarting(false) }
  }

  // R1: إلغاء فوري أثناء البدء — stop() تقتل العمليات فورًا (لا تنتظر التثبيت)
  async function handleCancelStart() {
    cancelledRef.current = true
    setStarting(false)
    store.setPhase('ready')
    store.setServer({ running: false })
    store.setCreateError(null)
    try { await window.rCode.devserver.stop(projectId) } catch {}
  }

  async function handleStop() {
    // إيقاف الخادم، ومع وجود تشغيل نشط نلغي الوكيل أيضًا — وإلا أعاد الوكيل
    // تشغيل المعاينة تلقائيًا في جولته التالية فبدا زر الإيقاف بلا أثر.
    if (store.run?.active) {
      if (store.run.runId) store.markRunCancelled(store.run.runId)
      store.setRun(null)
      store.setPendingApproval(null)
      store.setAwaitingRunStart(false)
      try { await window.rCode.buildAgent.cancel(projectId) } catch {}
    }
    store.setServer(await window.rCode.devserver.stop(projectId))
    store.setPhase('ready')
  }

  /** إيقاف تام — يقطع الخادم + وكيل البناء فورًا وبالتوازي */
  async function handleKill() {
    // ثبّت الإيقاف في الواجهة فورًا — لا نعلّق الحالة على رد العملية الخلفية.
    if (store.run?.runId) store.markRunCancelled(store.run.runId)
    store.setRun(null)
    store.setPendingApproval(null)
    store.setAwaitingRunStart(false)
    store.setServer({ running: false })
    store.setPhase('ready')
    store.setCreateError(null)
    // أوقف الخادم والوكيل بالتوازي — كان إيقاف الخادم معلقًا على انتظار الوكيل
    // وقد يبقى الخادم يعمل لو تأخر الإلغاء.
    await Promise.all([
      window.rCode.devserver.stop(projectId).catch(() => {}),
      store.project ? window.rCode.buildAgent.cancel(projectId).catch(() => {}) : Promise.resolve(),
    ])
  }

  return (
      <header className="devserver-bar">
      <div className="devserver-left">
        <span className="devserver-status-pill">
          {isRunning ? <><Circle size={8} className="status-dot live" fill="currentColor"/> يعمل</>
          : starting ? <><LoaderCircle size={10} className="spin"/> جارٍ التشغيل... {elapsedSec > 0 && `(${elapsedSec} ث)`}{elapsedSec > 60 && <span className="devserver-slow-hint"> ⏳ قد يكون تثبيت اعتماديات</span>}</>
          : server.error ? <><Circle size={8} className="status-dot error" fill="currentColor"/> خطأ</>
          : <><Circle size={8} className="status-dot idle" fill="currentColor"/> متوقف</>}
        </span>
        {runActive && (
          <span className="devserver-runinfo" title="الوكيل يعمل الآن — اكتب رسالة متابعة في الشات للتدخل الفوري أو اضغط إيقاف">
            <LoaderCircle size={10} className="spin" />
            الوكيل يعمل · جولة {Math.max(1, store.telemetry.rounds)} · {formatRunTime(runElapsedSec)}
          </span>
        )}
        {server.url && <code className="devserver-url" dir="ltr">{server.url}</code>}
      </div>

      <div className="devserver-actions">
        {isRunning ? (
          <button className="devserver-btn stop" onClick={handleStop}><Square size={14}/> إيقاف</button>
        ) : starting ? (
          <button className="devserver-btn stop" onClick={() => void handleCancelStart()} title="إلغاء التشغيل وإيقاف أي عملية بدأت">
            <Square size={14}/> إلغاء ({elapsedSec}s)
          </button>
        ) : (
          <button className="devserver-btn start" onClick={() => void handleStart()} disabled={!canStart}>
            <Play size={14}/> تشغيل ومعاينة
          </button>
        )}
        <button className="devserver-btn preview" onClick={() => server.url && window.open(server.url, '_blank')} disabled={!isRunning}>
          <ExternalLink size={14}/> معاينة
        </button>
        <button className="devserver-btn deploy" onClick={onDeploy} disabled={phase !== 'ready' && !isRunning}>
          <Rocket size={14}/> نشر
        </button>
        <button className="devserver-btn kill" onClick={handleKill} title="إيقاف تام — يقطع الخادم والوكيل">
          <StopCircle size={14}/> إيقاف كامل
        </button>
        <div className="devserver-separator"/>
        {store.project && <button className="devserver-btn secondary" onClick={() => void store.closeProject()} title="الخروج من شات الوكيل والمشروع الحالي وفتح مشروع آخر"><FolderOpen size={14}/> مشروع آخر</button>}
        <button className="devserver-btn close" onClick={onClose} title="الخروج من Build"><X size={14}/> خروج</button>
      </div>
    </header>
  )
})
