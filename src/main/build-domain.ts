import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import type { AgentRunState, AuditEvent, BuildProject, BuildProjectOpenPayload, BuildRunInfo, DevServerState, Session } from '../shared/types'
import { AgentRunner } from './agent'
import { AppDatabase } from './database'
import type { ProviderStore } from './provider-store'
import type { TavilyStore } from './tavily-store'
import type { requestModel } from './provider'
import { McpManager } from './mcp'
import { DEDICATED_BUILD_PROFILE } from './agent-profile'

export const BUILD_SYSTEM_PROMPT = `You are the dedicated Build agent for this project. Your specialty: implement changes inside the project root, run and verify them, and keep the preview honest. The general engineering rules come from the core prompt; this file defines Build-specific behavior.

# Language rule
Always reply in exactly the same language as the user's latest message (Arabic in → Arabic out, English in → English out).

# Operating rules
- Understand the request, inspect only what is needed, make the smallest correct change, then verify it.
- You have full permissions on the project root (no approval popups); sandbox path and command checks still apply.
- Never touch anything outside the project root. Never claim a build or test passed unless you actually ran it.
- Preserve the project's existing capabilities unless the user asks to change them.
- If the system rejects a tool input, correct it directly once — no apologies, no repeating the same broken input.
- write_file and append_file require the full actual content in the same call; never call them with a path only or promise the content later.

# Smart workflow (read → analyze → execute → verify)
1. Explore first: tree or glob_files to understand the project layout before reading or editing.
2. Read every affected file at once: read_files runs in parallel; use dependency_graph to know what depends on what.
3. Analyze before editing: use find_references before changing any function signature, API, or UI element to locate every affected spot.
4. Execute in bulk: Prefer edit_files_bulk for 2+ ready, independent edits across different files — one call instead of many (3-5x faster, fewer tokens). Use edit_file for a single edit only; never batch edits whose outcomes depend on each other.
5. Verify once: run typecheck/lint/test one time after all edits instead of after each file, and fix whatever fails.
6. Smart preview: run start_preview after runtime changes (JS/TS/JSX/TSX/CSS/HTML, package.json, build config). Skip it for documentation-only changes. Never restart a server that is already running or starting; if start_preview reports "starting", wait for the link instead of calling it again.
7. See with your own eyes: after any visible change use preview_screenshot — it returns a real post-JavaScript screenshot plus console errors. Inspect it and fix any visual breakage or console error before delivering; never assume the page works.
8. Need facts: use web_research for up-to-date documentation or precise information instead of guessing (search technical topics in English too); fallback web_search then web_fetch.
9. Fix issues in one shot: read the full error message, identify the root cause, apply one correct fix instead of repeated attempts on the same error.

# Known pitfalls
- .env is protected by path policy — create it via shell (Set-Content) when genuinely needed.
- Vite does not read .env automatically — use loadEnv.
- Blank page → check console errors via preview_screenshot.
- Missing file → locate it with glob_files; never guess paths.`

namespace LegacyBuildPrompt {
export const BUILD_SYSTEM_PROMPT = 'أنت وكيل Build متخصص بالكامل في إنشاء وتطوير المشاريع والمواقع وتشغيلها داخل تطبيق Build. صلاحياتك كاملة على جذر المشروع دون نوافذ موافقة: عدّل الملفات مباشرة، شغّل أوامر البناء وتثبيت الحزم. لديك تحكم كامل بالمعاينة: استخدم start_preview لتشغيل الخادم وإظهار الموقع، وstop_preview لإيقافه، وpreview_status لمعرفة حالته الحالية. بعد إكمال أي جولة تعديلات شغّل المعاينة فورًا بأداة start_preview حتى يظهر الموقع في لوحة المعاينة داخل التطبيق. أنت المتحكم الوحيد في الجلسة: شغّل وأوقف الخادم كما تراه مناسبًا حسب طلب المستخدم. يمكنك تثبيت أي حزم وتشغيل أي أوامر بناء يحتاجها المشروع — لست مقيدًا بتقنية معينة. لا تلمس أي شيء خارج جذر المشروع. أداة start_preview هي الوسيلة الأفضل لتشغيل المعاينة؛ استخدم preview_status أولًا للتحقق من حالة الخادم قبل اتخاذ أي إجراء. إذا أعاد start_preview نتيجة "قيد التشغيل" أو "ما زال يجهز" فلا تكرر الاستدعاء — انتظر الجولة التالية أو استخدم preview_status للتحقق من ظهور الرابط. لا تستدعي stop_preview ثم start_preview في نفس الجولة إلا إذا طلب المستخدم ذلك صراحة.\n\n## ⭐ طريقة العمل الذكية (مهم جداً - اتبعها دائماً)\n\n### المرحلة1: التخطيط (قبل أي تعديل)\n1. **استكشف المشروع أولاً**: استخدم tree أو glob_files لفهم بنية المشروع\n2. **اقرأ الملفات المهمة**: اقرأ الملفات الرئيسية لفهم الارتباطات\n3. **حلّل التبعيات**: استخدم dependency_graph أو find_references لمعرفة أي ملفات تعتمد على بعضها\n4. **خطط التعديلات**: حدد بدقة أي ملفات ستعدل وما الذي ستفعله بالترتيب\n5. **اكتب التعديلات كاملة**: اكتب كل تعديل بالتفصيل قبل البدء\n6. **افحص مسبقاً**: تحقق من أن التعديلات لن تكسر اعتماديات أو تسبب أخطاء\n\n### المرحلة2: التنفيذ الذكي\n**استخدم أداة edit_files_bulk لتعديل عدة ملفات في استدعاء واحد:**\n\n```json\n{\n  "edits": [\n    {"path": "src/App.js", "old_string": "...", "new_string": "..."},\n    {"path": "src/styles.css", "old_string": "...", "new_string": "..."},\n    {"path": "src/utils.js", "old_string": "...", "new_string": "..."}\n  ]\n}\n```\n\n**مزايا هذه الطريقة:**\n- ✅ تعديل عدة ملفات في طلب واحد (أسرع بـ3-5 مرات)\n- ✅ لا تكرار في القراءة\n- ✅ تنفيذ متزامن للتعديلات\n- ✅ auto-commit تلقائي لجميع التغييرات\n\n### المرحلة3: التحقق والمعاينة\n1. **تحقق من التعديلات**: اقرأ الملفات المعدلة للتأكد\n2. **شغّل المعاينة**: استخدم start_preview لإظهار النتيجة\n3. **أبلغ المستخدم**: اشرح ما تم فعله\n\n## ⭐ اكتشاف المشاكل مسبقاً (قبل التعديل)\n- عند إضافة دالة async: تحقق من وجود await في الأماكن الصحيحة\n- عند تعديل واجهة: تحقق من جميع الملفات التي تستخدم هذه الواجهة\n- عند حذف دالة: تحقق من عدم وجود استدعاءات لها\n- عند إضافة import: تأكد من أن الملف المستورد موجود\n- عند تعديل type: تحقق من جميع المتغيرات التي تستخدم هذا النوع\n- استخدم analyze_file و find_references لاكتشاف المشاكل قبل التعديل\n\n## ⭐ قاعدة معرفة المشاكل الشائعة: .env محمي استخدم shell، Vite لا يقرأ .env استخدم loadEnv، الصفحة بيضاء افحص Console، الملف غير موجود استخدم glob_files.'
}
const LEGACY_BUILD_MARKER = '[FULL_SHELL_ACCESS]'

interface BuildProjectRow {
  id: string
  name: string
  path: string
  template: string
  files_count: number
  total_lines: number
  chat_session_id: string
  created_at: number
  updated_at: number
}

export interface ResolvedBuildProject {
  project: BuildProject
  path: string
  session: Session
}

export class BuildDomain {
  readonly db: AppDatabase
  readonly runner: AgentRunner

  constructor(opts: { userData: string; providers: ProviderStore; mcp: McpManager; getWebContents: () => WebContents | null; modelRequest?: typeof requestModel; startPreview?: (projectId: string, projectPath: string, signal?: AbortSignal) => Promise<DevServerState>; stopPreview?: (projectId: string) => Promise<DevServerState>; previewStatus?: (projectId: string) => DevServerState; tavilyStore?: TavilyStore }) {
    this.db = new AppDatabase(join(opts.userData, 'build.db'))
    const startPreview = opts.startPreview ? async (session: Session, signal?: AbortSignal): Promise<DevServerState> => {
      const row = this.db.rawDb.prepare('SELECT id FROM build_projects WHERE chat_session_id=?').get(session.id) as { id?: string } | undefined
      if (!row?.id) throw new Error('مشروع Build غير مسجل لهذه الجلسة.')
      const resolved = this.resolveProject(row.id)
      return opts.startPreview!(resolved.project.id, resolved.path, signal)
    } : undefined
    const stopPreview = opts.stopPreview ? async (session: Session): Promise<DevServerState> => {
      const row = this.db.rawDb.prepare('SELECT id FROM build_projects WHERE chat_session_id=?').get(session.id) as { id?: string } | undefined
      if (!row?.id) throw new Error('مشروع Build غير مسجل لهذه الجلسة.')
      return opts.stopPreview!(row.id)
    } : undefined
    // Q7: حالة حية من مدير الخادم مباشرة (لا حالة مخزنة قديمة) — يستخدمها preview_status في الوكيل.
    const previewStatus = opts.previewStatus ? (session: Session): DevServerState => {
      const row = this.db.rawDb.prepare('SELECT id FROM build_projects WHERE chat_session_id=?').get(session.id) as { id?: string } | undefined
      if (!row?.id) return { running: false }
      return opts.previewStatus!(row.id)
    } : undefined
    this.runner = new AgentRunner(this.db, opts.providers, opts.getWebContents, opts.modelRequest, opts.mcp, DEDICATED_BUILD_PROFILE.eventChannel, DEDICATED_BUILD_PROFILE.approvalChannel, startPreview, stopPreview, previewStatus, opts.tavilyStore, DEDICATED_BUILD_PROFILE)
    this.ensureProjectsTable()
    this.migrateLegacyBuildSessions()
    this.syncProjectSessionPrompts()
  }

  private ensureProjectsTable(): void {
    this.db.rawDb.exec(`CREATE TABLE IF NOT EXISTS build_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, template TEXT NOT NULL DEFAULT 'existing',
      files_count INTEGER NOT NULL DEFAULT 0, total_lines INTEGER NOT NULL DEFAULT 0, chat_session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
  }

  projects = {
    list: (): BuildProject[] => {
      const rows = this.db.rawDb.prepare('SELECT * FROM build_projects ORDER BY updated_at DESC').all() as unknown as BuildProjectRow[]
      return rows.map(mapBuildProject)
    },

    save: async (input: { name: string; path: string; template: string; filesCount: number; totalLines: number }): Promise<BuildProject> => {
      const resolvedPath = realpathSync(resolve(input.path))
      if (!statSync(resolvedPath).isDirectory()) throw new Error('مجلد المشروع غير صالح')
      if (isElectronAppFolder(resolvedPath)) throw new Error('هذا المجلد يحتوي على تطبيق Electron (مثل Code Agent نفسه). اختر مجلدًا آخر للمشروع لتجنب تشغيل التطبيق داخل نفسه في المعاينة.')
      const existing = this.db.rawDb.prepare('SELECT * FROM build_projects WHERE path=?').get(resolvedPath) as BuildProjectRow | undefined
      if (existing) {
        const now = Date.now()
        this.db.rawDb.prepare('UPDATE build_projects SET name=?,template=?,files_count=?,total_lines=?,updated_at=? WHERE id=?')
          .run(input.name, input.template || 'existing', input.filesCount, input.totalLines, now, existing.id)
        this.db.updateSession(existing.chat_session_id, { permissionMode: 'full', agentMode: 'build' })
        this.db.setSystemPrompt(existing.chat_session_id, BUILD_SYSTEM_PROMPT)
        return mapBuildProject({ ...existing, name: input.name, template: input.template || 'existing', files_count: input.filesCount, total_lines: input.totalLines, updated_at: now })
      }

      const session = this.db.createSession(resolvedPath, input.name)
      this.db.updateSession(session.id, { permissionMode: 'full', agentMode: 'build' })
      this.db.setSystemPrompt(session.id, BUILD_SYSTEM_PROMPT)
      const now = Date.now()
      const id = randomUUID()
      this.db.rawDb.prepare(`INSERT INTO build_projects (id,name,path,template,files_count,total_lines,chat_session_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, input.name, resolvedPath, input.template || 'existing', input.filesCount, input.totalLines, session.id, now, now)
      return { id, name: input.name, path: resolvedPath, template: input.template || 'existing', filesCount: input.filesCount, totalLines: input.totalLines, chatSessionId: session.id, createdAt: now, status: 'ready' }
    },

    open: (id: string): BuildProjectOpenPayload => {
      const resolved = this.resolveProject(id)
      const messages = this.db.listMessages(resolved.session.id)
      const usage = this.db.getUsageSummary(resolved.session.id)
      const subagents = this.db.listSubagentEvents(resolved.session.id)
      const checkpoints = this.db.listCheckpoints(resolved.session.id)
      const persistedRun = this.db.getAgentRun(resolved.session.id)
      const todos = this.db.getTodos(resolved.session.id)
      return { project: resolved.project, session: resolved.session, messages, usage, subagents, checkpoints, todos, run: mapRun(this.runner, resolved.session.id, persistedRun) }
    },

    remove: (id: string): void => {
      const row = this.db.rawDb.prepare('SELECT * FROM build_projects WHERE id=?').get(id) as BuildProjectRow | undefined
      if (!row) return
      try { this.runner.cancel(row.chat_session_id) } catch { /* لا يتوقف الحذف على الإلغاء */ }
      this.runner.forgetSession(row.chat_session_id)
      this.db.deleteSession(row.chat_session_id)
      this.db.rawDb.prepare('DELETE FROM build_projects WHERE id=?').run(id)
      try { this.db.addAudit({ category: 'build' as AuditEvent['category'], action: 'project-removed', detail: `حذف مشروع البناء: ${row.name} (${row.path})`, outcome: 'completed' }) } catch { /* اختياري */ }
    },

    clearChat: async (id: string): Promise<void> => {
      // الإلغاء لا يعتمد على وجود مجلد المشروع — نعتمد على معرف الجلسة المسجل مباشرة
      // حتى لا يستمر وكيل في الخلفية لمشروع حُذف أو نُقل مجلده.
      const sessionId = this.sessionIdFor(id)
      if (sessionId) {
        this.runner.cancel(sessionId)
        // مهلة أمان: لا نترك واجهة "شات جديد" معلقة إلى الأبد لو تأخر إيقاف الوكيل
        // (كان هذا يترك حقل الإدخال مقفولًا لأن الواجهة تنتظر اكتمال الـ IPC)
        await Promise.race([
          this.runner.waitForIdle(sessionId),
          new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
        ])
        this.runner.forgetSession(sessionId)
        this.db.clearConversation(sessionId)
      }
    },
  }

  /** معرف جلسة الوكيل المسجلة للمشروع — دون أي تحقق من نظام الملفات (يُستخدم للإلغاء والتنظيف). */
  sessionIdFor(projectId: string): string | null {
    const row = this.db.rawDb.prepare('SELECT chat_session_id FROM build_projects WHERE id=?').get(projectId) as { chat_session_id?: string } | undefined
    return row?.chat_session_id ?? null
  }

  resolveProject(id: string): ResolvedBuildProject {
    const row = this.db.rawDb.prepare('SELECT * FROM build_projects WHERE id=?').get(id) as BuildProjectRow | undefined
    if (!row) throw new Error('المشروع غير موجود')
    let resolvedPath: string
    try { resolvedPath = realpathSync(resolve(row.path)) } catch { throw new Error('مجلد المشروع لم يعد موجودًا') }
    if (!statSync(resolvedPath).isDirectory() || !samePath(resolvedPath, row.path)) throw new Error('مسار المشروع المسجل لم يعد يطابق المجلد الأصلي')
    const session = this.db.getSession(row.chat_session_id)
    if (!samePath(session.workspace, resolvedPath)) throw new Error('جلسة المشروع لا تملك المجلد المسجل')
    return { project: mapBuildProject(row), path: resolvedPath, session }
  }

  async shutdown(): Promise<void> {
    await this.runner.shutdown(false)
    this.db.close()
  }

  private migrateLegacyBuildSessions(): void {
    const rows = this.db.rawDb.prepare("SELECT id FROM sessions WHERE instr(system_prompt, ?) > 0").all(LEGACY_BUILD_MARKER) as Array<{ id: string }>
    for (const row of rows) {
      try {
        this.db.updateSession(row.id, { permissionMode: 'full', agentMode: 'build' })
        this.db.setSystemPrompt(row.id, BUILD_SYSTEM_PROMPT)
      } catch { /* جلسة تالفة لا تمنع فتح Build */ }
    }
  }

  private syncProjectSessionPrompts(): void {
    const rows = this.db.rawDb.prepare('SELECT chat_session_id FROM build_projects').all() as Array<{ chat_session_id: string }>
    for (const row of rows) {
      try {
        this.db.updateSession(row.chat_session_id, { permissionMode: 'full', agentMode: 'build' })
        this.db.setSystemPrompt(row.chat_session_id, BUILD_SYSTEM_PROMPT)
      } catch { /* مشروع تالف لا يمنع فتح بقية مشاريع Build */ }
    }
  }
}

export function cleanupLegacyBuildSessions(db: AppDatabase, mainAgent: AgentRunner): void {
  try {
    const rows = db.rawDb.prepare("SELECT id, title, workspace FROM sessions WHERE substr(system_prompt, 1, 19) = '[FULL_SHELL_ACCESS]'").all() as Array<{ id: string; title: string; workspace: string }>
    for (const row of rows) {
      try { mainAgent.cancel(row.id) } catch { /* تجاهل */ }
      mainAgent.forgetSession(row.id)
      db.deleteSession(row.id)
      try { db.addAudit({ category: 'build' as AuditEvent['category'], action: 'project-removed', detail: `تنظيف جلسة بناء قديمة: ${row.title} (${row.workspace})`, outcome: 'completed' }) } catch { /* اختياري */ }
    }
  } catch { /* لا يرمي أبدًا */ }
}

function mapBuildProject(row: BuildProjectRow): BuildProject {
  return { id: row.id, name: row.name, path: row.path, template: row.template, filesCount: Number(row.files_count), totalLines: Number(row.total_lines), chatSessionId: row.chat_session_id, createdAt: Number(row.created_at), status: 'ready' }
}

function mapRun(runner: AgentRunner, sessionId: string, persisted: AgentRunState | undefined): BuildRunInfo | null {
  const active = runner.states().find((state) => state.sessionId === sessionId)
  if (active) {
    return { sessionId, runId: active.runId ?? persisted?.runId ?? '', status: 'running', step: persisted?.step ?? 0, startedAt: persisted?.startedAt ?? Date.now(), updatedAt: Date.now(), active: true, resumable: false }
  }
  if (!persisted) return null
  return { ...persisted, active: false, resumable: persisted.status === 'interrupted' }
}

function samePath(first: string, second: string): boolean {
  const a = resolve(first).replace(/[\\/]$/, '')
  const b = resolve(second).replace(/[\\/]$/, '')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isElectronAppFolder(dir: string): boolean {
  try {
    const pkgPath = join(dir, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    if ('electron' in deps || 'electron-builder' in deps || 'electron-updater' in deps) return true
    if (typeof pkg.main === 'string' && pkg.main.includes('electron')) return true
    return false
  } catch { return false }
}
