/**
 * BuildPage — شات يسار | معاينة وسط | ملفات يمين
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useBuildStore } from '../stores/buildStore'
import { TemplatePicker } from './TemplatePicker'
import { DevServerBar } from './DevServerBar'
import { PreviewPanel } from './PreviewPanel'
import { DeployDialog } from './DeployDialog'
import { BuildChat } from './BuildChat'
import { FileSidebar } from './FileSidebar'
import { FolderOpen, Plus, AlertTriangle, LoaderCircle, Trash2, MessageSquare } from 'lucide-react'
import type { ProviderSettings } from '../../../shared/types'
import { goProviderConfig } from '../../../shared/models'

interface Props { onClose(): void }
const defaultProv = goProviderConfig()
let buildPageGeneration = 0

export function BuildPage({ onClose }: Props) {
  const store = useBuildStore()
  const { project, templates, server, files, phase, isCreating, deploy, createError, savedProjects, activeFile, activeContent, stats, run } = store
  const [showDeploy, setShowDeploy] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)
  const [initError, setInitError] = useState<string | null>(null)
  const [openingExisting, setOpeningExisting] = useState(false)
  const [provider, setProvider] = useState<ProviderSettings>({
    name: defaultProv.name, baseUrl: defaultProv.baseUrl, apiPath: defaultProv.apiPath,
    apiStyle: defaultProv.apiStyle, model: defaultProv.model,
    contextWindow: defaultProv.contextWindow, maxOutputTokens: defaultProv.maxOutputTokens, hasApiKey: false,
  })
  const pageGeneration = useRef(++buildPageGeneration)

  useEffect(() => {
    return () => {
      const generation = pageGeneration.current
      void (async () => {
        const state = useBuildStore.getState()
        if (state.project) {
          // R13: لا نوقف خادم المعاينة عند مجرد مغادرة الصفحة/تبديل التبويب —
          // يبقى الخادم يعمل وتُستعاد حالته عند فتح المشروع مجددًا (انظر openProject).
          if (state.run?.active) await window.rCode.buildAgent.cancel(state.project.id).catch(() => {})
        }
        if (generation === buildPageGeneration) {
          useBuildStore.setState({ project: null, files: [], server: { running: false }, phase: 'home', buildSessionId: null, chatMessages: [], activeFile: null, activeContent: '', createError: null, run: null, pendingApproval: null, awaitingRunStart: false, todos: [] })
        }
      })()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if (!window.rCode?.scaffold?.templates) return
        const [tpl, prov] = await Promise.all([
          window.rCode.scaffold.templates(),
          window.rCode.provider.get(),
        ])
        if (cancelled) return
         store.setTemplates(tpl)
         setProvider(prov)
        if (!store.chatModel) store.setChatModel(prov.model)
      } catch (e) {
        if (!cancelled) setInitError(e instanceof Error ? e.message : 'تعذر تحميل البيانات')
      }
      void store.loadSavedProjects()
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line

  async function loadProjectIntoStore(projectPath: string, projectName: string, templateId: string, filesCount: number, totalLines: number) {
    store.setCreating(true)
    try {
      await store.registerProject({ name: projectName, path: projectPath, template: templateId, filesCount, totalLines })
      store.setCreating(false)
      store.setCreateError(null)
    } catch (e) {
      store.setCreating(false)
      store.setCreateError(e instanceof Error ? e.message : 'تعذر حفظ المشروع')
    }
  }

  const handleCreate = useCallback(async (templateId: string, projectName: string) => {
    store.setCreating(true); store.setCreateError(null)
    try {
      const workspace = await window.rCode.files.chooseFolder()
      if (!workspace) { store.setCreating(false); return }
      const result = await window.rCode.scaffold.create({ template: templateId, projectName, targetDir: workspace })
      if (!result.ok) { store.setCreateError(result.error ?? 'فشل'); store.setCreating(false); return }
      await loadProjectIntoStore(result.projectPath!, result.projectName!, result.templateId!, result.filesCount!, result.totalLines!)
    } catch (e) { store.setCreateError(e instanceof Error ? e.message : 'خطأ'); store.setCreating(false) }
  }, [store, provider.model])

  const handleOpenExisting = useCallback(async () => {
    setOpeningExisting(true); store.setCreateError(null)
    try {
      const folder = await window.rCode.files.chooseFolder()
      if (!folder) { setOpeningExisting(false); return }
       const projectName = folder.split(/[\\/]/).pop() ?? 'مشروع'
       await loadProjectIntoStore(folder, projectName, 'existing', 0, 0)
    } catch (e) { store.setCreateError(e instanceof Error ? e.message : 'تعذر فتح المشروع') }
    finally { setOpeningExisting(false) }
  }, [store, provider.model])

  // R13: الخروج الصريح من Build يوقف الوكيل والخادم معًا — أما مجرد تبديل التبويب فلا يوقفهما.
  const handleClose = useCallback(() => {
    void (async () => {
      const state = useBuildStore.getState()
      if (state.project) {
        // بالتوازي: لا نعلّق إيقاف الخادم على انتظار الوكيل
        await Promise.all([
          window.rCode.buildAgent.cancel(state.project.id).catch(() => {}),
          window.rCode.devserver.stop(state.project.id).catch(() => {}),
        ])
      }
      onClose()
    })()
  }, [onClose])

  // ─── عرض ──────────────────────────────────────────────────────

  // إطار مستقل تمامًا: الهيدر خاص بصفحة Build فقط (تطبيق منفصل داخل النافذة)
  const frame = (content: ReactNode): ReactNode => (
    <div className="build-app-shell" dir="rtl">
      <div className="build-app-content">{content}</div>
    </div>
  )

  if (initError) return frame(<div className="build-error"><AlertTriangle size={24}/><h3>خطأ</h3><p>{initError}</p><button onClick={onClose}>العودة</button></div>)
  if (phase === 'creating' && !project) return frame(
    <div className="build-workspace">
      <TemplatePicker templates={templates} onSelect={handleCreate} onBack={() => { store.setPhase('home'); store.setCreateError(null) }} isCreating={isCreating}/>
      {createError && <div className="build-error-inline"><AlertTriangle size={14}/><span>{createError}</span><button onClick={() => store.setCreateError(null)}>✕</button></div>}
    </div>
  )
  if (createError && !project) return frame(<div className="build-error"><AlertTriangle size={24}/><h3>تعذر إنشاء المشروع</h3><p>{createError}</p><button onClick={() => { store.setCreateError(null); store.setPhase('home') }}>العودة</button></div>)

  if (phase === 'home' || !project) return frame(
    <div className="build-empty">
      <div className="build-empty-content">
        <div className="build-empty-icon"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>
        <h2>ابنِ موقعك</h2>
        <p>أنشئ موقعًا من قالب، شغّل الخادم، عاين النتيجة، وشاركها للعالم — كله من هنا.</p>
        {createError && <div className="build-error-inline"><AlertTriangle size={14}/><span>{createError}</span><button onClick={() => store.setCreateError(null)}>✕</button></div>}
        {savedProjects.length > 0 && (
          <div className="build-saved">
            <h4>مشاريعك المحفوظة</h4>
            <div className="build-saved-list">
              {savedProjects.map((p) => (
                <div key={p.id} className="build-saved-item">
                  <div className="build-saved-info">
                    <strong>{p.name}</strong>
                    <small>{p.template} · {new Date(p.createdAt).toLocaleDateString('ar')}</small>
                  </div>
                  <div className="build-saved-actions">
                    <button className="build-secondary-btn" onClick={() => { store.setCreateError(null); void store.openProject(p.id) }}><FolderOpen size={14}/> فتح</button>
                    <button className="build-saved-delete" title="حذف المشروع نهائيًا" onClick={() => { if (confirm(`حذف مشروع "${p.name}" من قائمة البناء نهائيًا؟ لا يُحذف مجلد المشروع.`)) void store.removeProject(p.id) }}><Trash2 size={14}/></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="build-empty-actions">
          <button className="build-primary-btn" onClick={() => { store.setCreateError(null); store.setPhase('creating') }}><Plus size={16}/> مشروع جديد من قالب</button>
          <button className="build-secondary-btn" onClick={handleOpenExisting} disabled={openingExisting}>{openingExisting ? <LoaderCircle size={16} className="spin"/> : <FolderOpen size={16}/>} فتح مشروع موجود</button>
        </div>
        {templates.length > 0 && <div className="build-template-previews"><h4>القوالب</h4><div className="build-template-cards">{templates.map(t => <div key={t.id} className="build-template-mini"><span className="build-template-mini-icon">{t.icon}</span><strong>{t.name}</strong></div>)}</div></div>}
      </div>
    </div>
  )

  async function selectFile(relativePath: string): Promise<void> {
    if (!project) return
    store.setActiveFile(relativePath)
    try { store.setActiveFile(relativePath, await window.rCode.build.readFileContent(project.id, relativePath)) } catch (error) { store.setCreateError(error instanceof Error ? error.message : 'تعذر قراءة الملف') }
  }

  // ─── المشروع جاهز: شات | معاينة | ملفات ──────────────────────
  return frame(
    <div className="build-workspace">
      <DevServerBar server={server} phase={phase} projectId={project.id} onDeploy={() => setShowDeploy(true)} onClose={handleClose} />
      {(server.error || createError) && <div className="build-error-inline"><AlertTriangle size={14}/><span>{server.error || createError}</span><button onClick={() => { store.setServer({ ...server, error: undefined }); store.setCreateError(null) }}>✕</button></div>}
      {run?.status === 'interrupted' && run.resumable && !run.active && <div className="build-resume-banner"><AlertTriangle size={14}/><span>توقف التشغيل السابق قبل اكتماله. الاستئناف يبدأ ميزانية تشغيل جديدة ولا يعيد أداة منقطعة.</span><button className="build-secondary-btn" onClick={() => void store.resumeProject()}>استئناف</button></div>}
      <div className="build-layout">
        {chatOpen ? <div className="build-chat-panel">
          <BuildChat key={project.id} provider={provider} onClose={() => setChatOpen(false)} />
        </div> : <button type="button" className="build-chat-open" onClick={() => setChatOpen(true)} title="فتح شات البناء" aria-label="فتح شات البناء"><MessageSquare size={17}/><span>فتح الشات</span></button>}
        <div className="build-preview-panel">
          <PreviewPanel url={server.url} running={server.running || phase === 'running'} previewStarting={server.previewStarting} />
        </div>
        <FileSidebar files={files} activeFile={activeFile} onSelectFile={(path) => void selectFile(path)} />
      </div>
      {showDeploy && <DeployDialog deploy={deploy} onDeploy={async (t, r, branch) => { try { store.setDeploy(await window.rCode.deploy.githubPages({ projectId: project.id, token: t, repoUrl: r, branch })) } catch (e) { store.setDeploy({ status: 'failed', projectId: project.id, error: String(e) }) } }} onClose={() => setShowDeploy(false)} />}
    </div>
  )
}
