import { memo, useMemo, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  Code2,
  FileText,
  FolderOpen,
  Gauge,
  ListChecks,
  LoaderCircle,
  Pencil,
  Search,
  Terminal as TerminalIcon,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import type { Message, ToolCallRecord } from '../../../shared/types'

/* ============================================================================
   مسارات التنفيذ المسطّحة — خطوات خفيفة فوق خلفية الشات مباشرة

   كل أداة تُعرض كصفّ واحد باسم ووصف صحيحين:
     ✎ تعديل  [TS] tools.ts  src/main/  +30 -8
     ⌨ تشغيل  cd /d/NT/MyOpenCode && npm test
   والقراءات/البحوث المتتالية تتجمع تحت سطر «استعراض» قابل للطي،
   وصفوفها المتداخلة تتصل بخط عمودي رفيع:
     🔍 استعراض · ملفان، بحث واحد
       │ قراءة [TS] index.ts  src/preload/
   والنقر على أي صفّ يوسّعه ليعرض النتيجة الكاملة أسفله.
   ========================================================================== */

type NodeStatus = 'pending' | 'running' | 'success' | 'error' | 'denied'

interface ParsedDiff { added: number; removed: number }

type StreamRow =
  | { kind: 'tool'; tool: ToolCallRecord }
  | { kind: 'explore'; tools: ToolCallRecord[] }

export interface ExecutionTimelineProps {
  messages?: Message[]
  tools?: ToolCallRecord[]
}

/* ──────────── فئات الأدوات ──────────── */

const READ_TOOLS = new Set(['read_file', 'read_files', 'read_message', 'list_directory', 'tree', 'glob_files', 'get_file_info'])
const SEARCH_TOOLS = new Set(['search_files', 'search_symbols', 'glob_files'])
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'patch_file', 'append_file', 'delete_file', 'move_file'])
const CMD_TOOLS = new Set(['run_powershell', 'run_command', 'shell'])
const EXPLORE_TOOLS = new Set([...READ_TOOLS, ...SEARCH_TOOLS])

/* ──────────── أدوات مساعدة ──────────── */

function toolStatus(t: ToolCallRecord['status']): NodeStatus {
  if (t === 'running') return 'running'
  if (t === 'completed') return 'success'
  if (t === 'denied') return 'denied'
  return 'error'
}

function fileExt(p: string): string | null {
  const f = p.split(/[\\/]/).pop() ?? ''
  const e = f.split('.').pop()?.toLowerCase()
  if (!e || e === f.toLowerCase()) return null
  const m: Record<string, string> = { ts: 'TS', tsx: 'TS', js: 'JS', jsx: 'JS', css: 'CSS', html: 'HTML', json: 'JSON', java: 'Java', py: 'PY', md: 'MD', go: 'GO', rs: 'RS' }
  return m[e] ?? e.toUpperCase().slice(0, 3)
}

function dirOf(target: string): string {
  const parts = target.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return ''
  return `${parts.slice(-3, -1).join('/')}/`
}

function diffStats(output: string | undefined): ParsedDiff | null {
  if (!output) return null
  try {
    const d = JSON.parse(output) as { data?: { diff?: string; addedLines?: number; removedLines?: number; diffTruncated?: boolean } }
    if (typeof d.data?.addedLines === 'number' || typeof d.data?.removedLines === 'number') {
      const a = d.data!.addedLines ?? 0
      const r = d.data!.removedLines ?? 0
      return a || r ? { added: a, removed: r } : null
    }
    if (typeof d.data?.diff !== 'string') return null
    let a = 0, r = 0
    for (const l of d.data.diff.split(/\r?\n/)) {
      if (l.startsWith('+') && !l.startsWith('+++')) a++
      else if (l.startsWith('-') && !l.startsWith('---')) r++
    }
    return a || r ? { added: a, removed: r } : null
  } catch { return null }
}

/** كشف انتهاء المهلة من خرج الأداة لعرض شارة ⏱ بدل حالة الفشل الغامضة */
function isToolTimeout(tool: ToolCallRecord): boolean {
  if (tool.status !== 'error' || !tool.output) return false
  return /انتهت مهلة|timeout|timed out|مهلة تشغيل/i.test(tool.output)
}

/** الفعل الذي يصف الخطوة باسم عربي صحيح */
function toolVerb(name: string): string {
  if (name === 'read_file' || name === 'read_files' || name === 'read_message') return 'قراءة'
  if (name === 'list_directory' || name === 'tree' || name === 'get_file_info') return 'استعراض'
  if (name === 'search_files' || name === 'search_symbols' || name === 'glob_files') return 'بحث'
  if (name === 'write_file') return 'كتابة'
  if (name === 'edit_file' || name === 'append_file' || name === 'patch_file') return 'تعديل'
  if (name === 'delete_file') return 'حذف'
  if (name === 'move_file') return 'نقل'
  if (name === 'run_powershell' || name === 'run_command' || name === 'shell') return 'تشغيل'
  if (name.startsWith('git_')) return 'Git'
  if (name === 'web_fetch') return 'جلب ويب'
  if (name === 'web_search') return 'بحث ويب'
  if (name === 'todo_write' || name === 'todo_read') return 'خطة العمل'
  if (name === 'edit_file_undo') return 'تراجع'
  if (name === 'task' || name === 'task_parallel') return 'وكيل فرعي'
  if (name === 'load_skill') return 'تحميل مهارة'
  return name.replace(/_/g, ' ')
}

/** فئة الأداة لتلوين فاخر ومتّسق لأيقونات كل نوع خطوات */
function toolCategory(name: string): string {
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (SEARCH_TOOLS.has(name)) return 'search'
  if (READ_TOOLS.has(name)) return 'read'
  if (CMD_TOOLS.has(name) || name.startsWith('git_')) return 'cmd'
  if (name === 'web_fetch' || name === 'web_search') return 'web'
  return 'other'
}

function toolIcon(name: string, status: NodeStatus) {
  const s = 13
  if (status === 'running') return <LoaderCircle className="spin" size={s} />
  if (status === 'error' || status === 'denied') return <X size={s} />
  if (name === 'list_directory' || name === 'tree' || name === 'get_file_info') return <FolderOpen size={s} />
  if (READ_TOOLS.has(name)) return <FileText size={s} />
  if (name === 'write_file') return <Code2 size={s} />
  if (name === 'delete_file' || name === 'move_file') return <Trash2 size={s} />
  if (EDIT_TOOLS.has(name)) return <Pencil size={s} />
  if (SEARCH_TOOLS.has(name)) return <Search size={s} />
  if (CMD_TOOLS.has(name) || name.startsWith('git_')) return <TerminalIcon size={s} />
  if (name === 'web_fetch' || name === 'web_search') return <Gauge size={s} />
  if (name === 'todo_write' || name === 'todo_read') return <ListChecks size={s} />
  return <Wrench size={s} />
}

function countLabel(count: number, one: string, two: string, few: string, many: string): string {
  if (count === 1) return one
  if (count === 2) return two
  if (count <= 10) return `${count.toLocaleString('ar')} ${few}`
  return `${count.toLocaleString('ar')} ${many}`
}

/* ──────────── بناء الصفوف ──────────── */

function buildRows(messages: Message[], directTools?: ToolCallRecord[]): StreamRow[] {
  const rows: StreamRow[] = []
  let explore: ToolCallRecord[] = []
  const flush = () => {
    if (explore.length) {
      rows.push({ kind: 'explore', tools: explore })
      explore = []
    }
  }
  const tools = directTools?.length ? directTools : messages.flatMap((message) => message.toolCalls ?? [])
  for (const tool of tools) {
      if (EXPLORE_TOOLS.has(tool.name)) explore.push(tool)
      else { flush(); rows.push({ kind: 'tool', tool }) }
  }
  flush()
  return rows
}

/* ──────────── المكوّن الرئيسي ──────────── */

function ExecutionTimelineImpl({ messages = [], tools }: ExecutionTimelineProps) {
  const rows = useMemo(() => buildRows(messages, tools), [messages, tools])
  if (rows.length === 0) return null
  return (
    <div className="ts-stream">
      {rows.map((row) =>
        row.kind === 'explore'
          ? <ExploreGroup key={`explore-${row.tools[0]?.id ?? 'x'}`} tools={row.tools} />
          : <ToolRow key={row.tool.id} tool={row.tool} />,
      )}
    </div>
  )
}

export const ExecutionTimeline = memo(ExecutionTimelineImpl)

/* ──────────── صفّ أداة مسطّح ──────────── */

function ToolRow({ tool, nested = false }: { tool: ToolCallRecord; nested?: boolean }) {
  const [open, setOpen] = useState(false)
  const status = toolStatus(tool.status)
  const isCmd = CMD_TOOLS.has(tool.name) || tool.name.startsWith('git_')
  const target = String(tool.input.path ?? tool.input.command ?? tool.input.query ?? tool.input.prompt ?? '')
  const ext = isCmd ? null : fileExt(target)
  const dir = isCmd ? '' : dirOf(target)
  const name = isCmd ? '' : (target.split(/[\\/]/).pop() ?? '') || target.slice(0, 40)
  const diff = diffStats(tool.output)
  const timeout = isToolTimeout(tool)

  return (
    <div className={`ts-row ts-${status}${nested ? ' ts-nested' : ''}`}>
      <button type="button" className="ts-row-btn" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }} aria-expanded={open}>
        <span className={`ts-icon cat-${toolCategory(tool.name)}`}>{toolIcon(tool.name, status)}</span>
        <span className="ts-verb">{toolVerb(tool.name)}</span>
        {isCmd
          ? <span className="ts-cmd" dir="ltr">{target.slice(0, 110)}</span>
          : <>
            {ext && <span className="ts-ext" data-ext={ext}>{ext}</span>}
            <span className="ts-name" dir="auto">{name}</span>
            {dir && <span className="ts-dir" dir="ltr">{dir}</span>}
          </>}
        {timeout && <span className="ts-timeout" title="انتهت مهلة تنفيذ الأداة">⏱ مهلة</span>}
        {diff && <span className="ts-diff" dir="ltr"><i className="a">+{diff.added}</i><i className="r">-{diff.removed}</i></span>}
        <ChevronDown size={11} className={`ts-chev${open ? ' rot' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="ts-detail">
          {isCmd ? <CmdOutput tool={tool} /> : <ToolOutput tool={tool} />}
        </div>
      )}
    </div>
  )
}

/* ──────────── مجموعة استعراض قابلة للطي ──────────── */

function ExploreGroup({ tools }: { tools: ToolCallRecord[] }) {
  const [open, setOpen] = useState(true)
  const reads = tools.filter((t) => READ_TOOLS.has(t.name)).length
  const searches = tools.length - reads
  const parts: string[] = []
  if (reads > 0) parts.push(countLabel(reads, 'ملف واحد', 'ملفان', 'ملفات', 'ملفًا'))
  if (searches > 0) parts.push(countLabel(searches, 'بحث واحد', 'بحثان', 'بحوث', 'بحث'))
  const running = tools.some((t) => t.status === 'running')

  return (
    <div className="ts-explore">
      <button type="button" className="ts-explore-btn" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }} aria-expanded={open}>
        {running ? <LoaderCircle className="spin ts-icon cat-search" size={13} /> : <Search size={13} className="ts-icon cat-search" />}
        <span className="ts-explore-label">استعراض · {parts.join('، ') || tools.length.toLocaleString('ar')}</span>
        <ChevronDown size={11} className={`ts-chev${open ? ' rot' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="ts-explore-body">
          {tools.map((tool) => <ToolRow key={tool.id} tool={tool} nested />)}
        </div>
      )}
    </div>
  )
}

/* ──────────── خرج الأوامر ──────────── */

function CmdOutput({ tool }: { tool: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false)
  const command = String(tool.input.command ?? '')
  let stdout = '', stderr = '', exitCode: number | null = null

  if (tool.output) {
    try {
      const p = JSON.parse(tool.output) as { data?: { output?: string; stderr?: string; exitCode?: number }; error?: { message?: string } }
      stdout = p.data?.output ?? ''
      stderr = p.data?.stderr ?? ''
      exitCode = p.data?.exitCode ?? null
      if (p.error) stderr = stderr || (p.error.message ?? '')
    } catch { stdout = tool.output }
  }

  const full = `${stdout}${stderr ? (stdout ? '\n\n[stderr]\n' : '') + stderr : ''}`
  const truncated = full.length > 1500
  const preview = expanded || !truncated ? full : full.slice(0, 1500)

  return (
    <div className="ts-cmdout">
      <div className="ts-cmdout-head" dir="ltr">
        <span className="ts-cmdout-prompt">$</span>
        <code>{command || '(بدون أمر)'}</code>
        {exitCode !== null && <span className={`ts-cmdout-exit ${exitCode === 0 ? 'ok' : 'fail'}`}>{exitCode}</span>}
      </div>
      <pre className="ts-cmdout-out" dir="ltr">{preview || (tool.status === 'running' ? 'جارٍ التنفيذ...' : '(لا يوجد خرج)')}{truncated && !expanded ? '\n…' : ''}</pre>
      {truncated && <button type="button" className="ts-expand-btn" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}>{expanded ? 'طي' : 'عرض الكامل'}</button>}
    </div>
  )
}

/* ──────────── خرج الأدوات العام ──────────── */

/** حاوية ناتج قابلة للتمرير بالكامل — تعرض كل المحتوى مع زر عرض/طي */
function ExpandableOutput({ children, className = 'ts-output', dir = 'ltr' }: { children: ReactNode; className?: string; dir?: 'ltr' | 'rtl' }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`ts-output-wrap ${expanded ? 'expanded' : ''}`}>
      <pre className={className} dir={dir}>{children}</pre>
      <button type="button" className="ts-expand-btn" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}>
        {expanded ? 'طي النتيجة' : 'عرض الكامل'}
      </button>
    </div>
  )
}

function ToolOutput({ tool }: { tool: ToolCallRecord }) {
  if (!tool.output) return <span className="ts-empty">جارٍ التنفيذ…</span>

  try {
    const p = JSON.parse(tool.output) as { ok?: boolean; data?: unknown; error?: { message?: string } }
    if (p.ok === false) return <div className="ts-error"><XCircle size={12} /> {p.error?.message ?? 'فشلت الأداة'}</div>

    if (p.data && typeof p.data === 'object') {
      const d = p.data as Record<string, unknown>

      // أسطر قراءة ملف — كل الأسطر مع تمرير كامل
      if (READ_TOOLS.has(tool.name) && Array.isArray(d.lines)) {
        const lines = d.lines as Array<{ line?: number; content?: string } | string>
        if (lines.length === 0) return <span className="ts-empty">الملف فارغ أو لا توجد أسطر.</span>
        return (
          <ExpandableOutput>
            {lines.map((l, i) => typeof l === 'string' ? <div key={i}>{l}</div> : <div key={i}><span className="ts-line-no">{l.line}</span>{l.content}</div>)}
          </ExpandableOutput>
        )
      }

      // read_message — استعادة رسالة سابقة
      if (tool.name === 'read_message' && typeof d.content === 'string') {
        const content = d.content as string
        if (!content.trim()) return <span className="ts-empty">لا يوجد محتوى نصي في الرسالة المستعادة.</span>
        return (
          <ExpandableOutput dir="rtl" className="ts-output ts-output-rtl">
            {content}
          </ExpandableOutput>
        )
      }

      // todo_write / todo_read
      if (tool.name === 'todo_write' || tool.name === 'todo_read' || Array.isArray(d.todos)) {
        const todos = Array.isArray(d.todos) ? d.todos as Array<Record<string, unknown>> : []
        if (todos.length === 0) return <span className="ts-empty">لا توجد مهام.</span>
        return (
          <div className="ts-output">
            {todos.map((t, i) => (
              <div key={i} style={{ padding: '2px 0', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ color: t.status === 'completed' ? 'var(--green)' : t.status === 'in_progress' ? 'var(--orange)' : 'var(--text-3)', fontSize: '11px' }}>
                  {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : t.status === 'cancelled' ? '✗' : '○'}
                </span>
                <span style={{ flex: 1, fontSize: '11px', color: 'var(--text-2)' }}>{String(t.content ?? '')}</span>
              </div>
            ))}
          </div>
        )
      }

      // نتائج البحث — كل النتائج مع تمرير
      if (tool.name === 'search_files' && Array.isArray(d.matches)) {
        const m = d.matches as Array<{ path: string; line: number; text: string }>
        if (m.length === 0) return <span className="ts-empty">لا توجد نتائج مطابقة.</span>
        return (
          <ExpandableOutput>
            {m.map((x, i) => <div key={i}><span className="ts-line-no">{x.path}:{x.line}</span>{x.text}</div>)}
          </ExpandableOutput>
        )
      }

      // Diff
      if (typeof d.diff === 'string') {
        return <DiffView diff={d.diff} />
      }

      // قراءة ملفات متعددة — أسماء الملفات مع الحجم والأسطر
      if (tool.name === 'read_files' && Array.isArray(d.files)) {
        const files = d.files as Array<{ path: string; bytes?: number; totalLines?: number }>
        if (files.length === 0) return <span className="ts-empty">لا توجد ملفات.</span>
        return (
          <ul className="ts-file-list">
            {files.map((f, i) => <li key={i}><FileText size={10} /> <span dir="ltr">{f.path}</span> <small>{f.totalLines !== undefined ? `${f.totalLines} سطر · ` : ''}{f.bytes ?? ''}b</small></li>)}
          </ul>
        )
      }

      // count_lines — أسماء الملفات مع عدد الأسطر
      if (tool.name === 'count_lines' && Array.isArray(d.files)) {
        const files = d.files as Array<{ path: string; lines?: number; totalLines?: number; bytes?: number; totalBytes?: number }>
        if (files.length === 0) return <span className="ts-empty">لا توجد ملفات.</span>
        return (
          <ul className="ts-file-list">
            {files.map((f, i) => <li key={i}><FileText size={10} /> <span dir="ltr">{f.path}</span> <small>{f.lines ?? f.totalLines ?? 0} سطر</small></li>)}
          </ul>
        )
      }

      // قائمة مجلد — كل العناصر مع تمرير
      if (Array.isArray(d.entries)) {
        const entries = d.entries as Array<{ name: string; path?: string; directory: boolean }>
        if (entries.length === 0) return <span className="ts-empty">المجلد فارغ.</span>
        return (
          <ExpandableOutput className="ts-output ts-output-list">
            {entries.map((e, i) => <div key={i} style={{ padding: '2px 0' }}><span style={{ color: e.directory ? 'var(--accent)' : 'var(--text-3)', marginInlineEnd: 6 }}>{e.directory ? '📁' : '📄'}</span><span dir="ltr">{String(e.path ?? e.name ?? '')}</span></div>)}
          </ExpandableOutput>
        )
      }
    }
  } catch {}

  // احتياط: نص عادي — كامل مع تمرير
  const text = String(tool.output)
  return (
    <ExpandableOutput className="ts-output">
      {text}
    </ExpandableOutput>
  )
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="ts-diff-block" dir="ltr">
      {diff.split(/\r?\n/).slice(0, 60).map((l, i) => {
        const cls = l.startsWith('+') && !l.startsWith('+++') ? 'd-add' : l.startsWith('-') && !l.startsWith('---') ? 'd-rem' : l.startsWith('@@') ? 'd-hunk' : ''
        return <div key={i} className={cls}>{l}</div>
      })}
    </pre>
  )
}
