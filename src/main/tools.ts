import { constants, createReadStream, promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { Session, Todo } from '../shared/types'
import type { ToolDefinition } from './provider'
import type { McpToolExecutor } from './mcp'

const MAX_READ_LINES = 2_000
const MAX_OUTPUT_BYTES = 100_000
const MAX_SEARCH_RESULTS = 500
const MAX_GLOB_RESULTS = 2_000

export const toolDefinitions: ToolDefinition[] = [
  tool('read_file', 'اقرأ ملفًا نصيًا مع أرقام الأسطر وإجمالي عدد الأسطر. يقرأ حتى 2000 سطر افتراضيًا؛ استخدم offset فقط إذا أعادت النتيجة truncated=true.', { path: str('مسار الملف'), offset: integer('أول سطر، يبدأ من 1', 1), limit: integer('عدد الأسطر، الافتراضي والأقصى 2000', 1, MAX_READ_LINES) }, ['path']),
  tool('read_files', 'اقرأ عدة ملفات نصية كاملة في استدعاء واحد. تعيد nextCursor فقط إذا لم تتسع كل الملفات.', { paths: str('مسارات مفصولة بأسطر جديدة'), path: str('مجلد البداية'), include: str('glob مثل **/*.java'), cursor: str('مؤشر متابعة تعيده الأداة'), max_files: integer('أقصى ملفات في الدفعة', 1, 100) }, []),
  tool('read_message', 'استرجع رسالة سابقة كاملة من سجل هذه الجلسة بمعرّفها id. تُستخدم لاستعادة محتوى أو نتيجة أداة ضُغطت في سياق سابق.', { id: str('معرّف الرسالة كما يظهر في السجل') }, ['id']),
  tool('load_skill', 'حمّل مهارة (Skill) من مجلد .skills أو .opencode/skills أو skills في مساحة العمل بقراءة SKILL.md. تُستخدم لمهام متخصصة مثل مراجعة الكود، البحث العميق، إنشاء الوثائق، أو أي إجراء موثّق بخطوات. أعد النص الكامل للمهارة مع وصفها.', { name: str('اسم المهارة (اسم مجلدها)'), max_chars: integer('حد أقصى للأحرف', 1000, 100000) }, ['name']),
  tool('task', 'أطلق وكيلًا فرعيًا مستقلاً يعمل في سياق منفصل تمامًا عن محادثتك (لا يشارك سياقك ولا يلوّثه). مثالي للمشاريع الضخمة: فكّر في تقسيم عملك إلى مهام متوازية أو متسلسلة لكل منها هدف واضح — يفهم الوكلاء الفرعيون وحدات المشروع، ويتتبعون دوالًا عبر ملفات متعددة، ويراجعون مجلدات كاملة، ويبحثون ويحللون، ثم يعيدون خلاصة مركزة منظمة فقط. أنت كمشرف تبقى مسؤولًا عن دقة النتيجة، فاصنع المهام بدقة، وأدمج الخلاصات، وطبّق قراراتك بنفسك.', { prompt: str('المهمة الكاملة بالتفصيل: ما التحليل المطلوب، الملفات/المجلدات المستهدفة، الأسئلة الدقيقة التي يجب الإجابة عنها، ومواصفات الخلاصة المطلوبة'), description: str('وصف مختصر (سطر واحد) يظهر للمستخدم') }, ['prompt', 'description']),
  tool('task_parallel', 'أطلق عدة وكلاء فرعيين متوازيين في سياقات مستقلة تمامًا، كلٌّ يعمل على جزء منفصل من المهمة ولا يرى محادثتك. الحد الأقصى 10 مهام، ويُدار التوازي بجدولة آمنة.', { tasks: arr('مصفوفة (array) فعلية من المهام، كل منها: {prompt, description} — حتى 10 مهام') }, ['tasks']),
  tool('todo_write', 'حدّث خطة العمل (Todos) لهذه الجلسة. استدعِها أولًا قبل تنفيذ مهمة متعددة الخطوات، وحدّثها بعد كل خطوة. items مصفوفة JSON كاملة تحل محل القائمة السابقة.', { items: str('مصفوفة JSON من المهام: [{content, status: pending|in_progress|completed|cancelled, priority: high|medium|low}]') }, ['items']),
  tool('todo_read', 'اقرأ خطة العمل (Todos) الحالية لهذه الجلسة.', {}, []),
  tool('run_command', 'نفّذ أمرًا معرفًا (Slash Command) من ملف commands.json في مساحة العمل. يستبدل القالب بالوسائط المعطاة ويعيد النص الناتج لتنفيذه. استخدمه عندما يطلب المستخدم أمرًا معرفًا مثل /review أو /test أو /init.', { name: str('اسم الأمر'), arguments: str('الوسائط (اختياري)') }, ['name']),
  tool('count_lines', 'احسب عدد أسطر ملف نصي أو مجلد بالكامل. يدعم مجلدات recursion ويحصّل كل ملفات نصية.', { path: str('مسار الملف أو المجلد'), include: str('glob مثل *.java أو *.xml لتصفيتها') }, ['path']),
  tool('list_directory', 'اعرض محتويات مجلد.', { path: str('المجلد، الافتراضي الجذر'), limit: integer('أقصى عدد عناصر', 1, 1000) }, []),
  tool('glob_files', 'ابحث عن ملفات بنمط glob مثل **/*.ts.', { path: str('مجلد البداية، الافتراضي الجذر'), pattern: str('نمط glob'), limit: integer('أقصى عدد نتائج', 1, MAX_GLOB_RESULTS) }, ['pattern']),
  tool('search_files', 'ابحث نصيًا داخل ملف محدد أو ملفات مجلد، وأعد file:line:column.', { path: str('ملف محدد أو مجلد بداية، الافتراضي الجذر'), pattern: str('نص أو regex'), include: str('glob اختياري مثل *.ts عند البحث في مجلد'), fixed_strings: bool('اعتبر النمط نصًا حرفيًا'), case_sensitive: bool('بحث حساس لحالة الأحرف'), limit: integer('أقصى عدد نتائج', 1, MAX_SEARCH_RESULTS) }, ['pattern']),
  tool('search_symbols', 'ابحث عن رموز برمجية (دوال، أصناف، واجهات، متغيرات عامة) في المشروع وأعدها مع أرقام الأسطر. مفيد لتتبع التعريفات في المشاريع الكبيرة دون قراءة كل ملف.', { path: str('مجلد البداية، الافتراضي الجذر'), query: str('اسم الرمز أو جزء منه (غير حساس لحالة الأحرف)'), limit: integer('أقصى عدد نتائج', 1, MAX_SEARCH_RESULTS) }, ['query']),
  tool('write_file', 'أنشئ ملفًا أو استبدل محتواه بالكامل.', { path: str('مسار الملف'), content: str('المحتوى الكامل') }, ['path', 'content']),
  tool('patch_file', 'عدّل ملف بعدة تغييرات دفعة واحدة. كل تغيير يحدد start_line و end_line و new_lines و expected (اختياري: نص الأسطر الحالية من start_line إلى end_line كما قرأتها — يُتحقق من مطابقته قبل التطبيق ويرفض التعديل إن تغيّرت). اقرأ الملف أولًا بأداة read_file وضمّن expected دائمًا لضمان عدم تعديل مواضع خاطئة. أعد diff كامل.', { path: str('مسار الملف'), patches: str('مصفوفة JSON من التغييرات: [{start_line, end_line, new_lines, expected}]') }, ['path', 'patches']),
  tool('create_directory', 'أنشئ مجلدًا.', { path: str('مسار المجلد') }, ['path']),
  tool('get_file_info', 'أعد معلومات ملف أو مجلد مع عدد الأسطر.', { path: str('المسار') }, ['path']),
  tool('web_fetch', 'اجلب صفحة HTTPS عامة. يمنع localhost ويتطلب موافقة.', { url: str('رابط HTTPS'), max_bytes: integer('حد المحتوى', 1000, 500000) }, ['url']),
  tool('web_search', 'ابحث في الويب عن معلومات حديثة وأعد روابط وعناوين ومقتطفات.', { query: str('عبارة البحث'), max_results: integer('أقصى عدد نتائج', 1, 10) }, ['query']),
  tool('git_status', 'اعرض حالة مستودع Git داخل مساحة العمل.', { path: str('مجلد المستودع، الافتراضي الجذر') }, []),
  tool('git_diff', 'اعرض الفرق الحالي في مستودع Git دون تنفيذ تغيير.', { path: str('مجلد المستودع، الافتراضي الجذر'), staged: bool('اعرض التغييرات المرحّلة فقط') }, []),
  tool('git_log', 'اعرض آخر commits في مستودع Git.', { path: str('مجلد المستودع، الافتراضي الجذر'), limit: integer('عدد commits', 1, 50) }, []),
  tool('delete_file', 'احذف ملفًا واحدًا نهائيًا داخل مساحة العمل. يرفض حذف المجلدات، ويتطلب موافقة صريحة دائمًا.', { path: str('مسار الملف') }, ['path']),
  tool('move_file', 'انقل أو أعد تسمية ملف داخل مساحة العمل. الوجهة يجب أن تكون داخل المساحة.', { from: str('المسار الحالي'), to: str('المسار الجديد') }, ['from', 'to']),
  tool('append_file', 'أضف نصًا إلى نهاية ملف نصي (أو أنشئه إن لم يوجد). يبقي المحتوى السابق كما هو.', { path: str('مسار الملف'), content: str('النص المضاف') }, ['path', 'content']),
  tool('tree', 'اعرض شجرة بنية المشروع داخل مساحة العمل مع تجاهل مجلدات البناء تلقائيًا.', { path: str('مجلد البداية، الافتراضي الجذر'), max_entries: integer('أقصى عدد عناصر', 1, 2000) }, []),
  tool('git_branch', 'اعرض الفروع المحلية للريبو الحالي.', { path: str('مجلد المستودع، الافتراضي الجذر') }, []),
  tool('git_show', 'اعرض محتوى commit أو ملف من ريفزيون معين مثل HEAD أو HEAD~1 أو commit:file.', { path: str('مجلد المستودع، الافتراضي الجذر'), spec: str('المواصفة مثل HEAD أو commit-hash أو commit:path') }, ['spec']),
  tool('git_add', 'أضف ملفات إلى منطقة staging في الريبو (لا ينشئ commit).', { path: str('مجلد المستودع، الافتراضي الجذر'), files: str('مسارات مفصولة بأسطر جديدة، أو "." للكل') }, ['files']),
  tool('git_fetch', 'اجلب تحديثات الفروع البعيدة دون دمجها.', { path: str('مجلد المستودع، الافتراضي الجذر'), remote: str('اسم remote اختياري') }, []),
  tool('git_pull', 'اجلب وادمج تحديثات الفرع الحالي من remote.', { path: str('مجلد المستودع، الافتراضي الجذر'), remote: str('اسم remote اختياري'), branch: str('اسم الفرع اختياري') }, []),
  tool('git_push', 'ادفع commits الفرع الحالي إلى remote.', { path: str('مجلد المستودع، الافتراضي الجذر'), remote: str('اسم remote اختياري'), branch: str('اسم الفرع اختياري') }, []),
  tool('git_checkpoint', 'أنشئ نقطة رجوع محلية باسم فرع آمن عند HEAD الحالي.', { path: str('مجلد المستودع، الافتراضي الجذر'), name: str('اسم checkpoint اختياري') }, []),
  tool('git_isolate_branch', 'أنشئ فرع عمل معزولًا للمهمة الحالية وانتقل إليه.', { path: str('مجلد المستودع، الافتراضي الجذر'), name: str('اسم الفرع') }, ['name']),
  tool('git_restore', 'استعد ملفًا من HEAD (يُلغي تغييراته غير الملتزمة نهائيًا). يتطلب موافقة صريحة دائمًا.', { path: str('مجلد المستودع، الافتراضي الجذر'), file: str('مسار الملف بالنسبة لمسار المستودع') }, ['file']),
  tool('git_checkout', 'بدّل إلى فرع موجود في الريبو.', { path: str('مجلد المستودع، الافتراضي الجذر'), branch: str('اسم الفرع') }, ['branch']),
  tool('git_reset', 'ألغِ الترحيل إلى HEAD (mixed) أو حرّك HEAD دون لمس الملفات (soft). يرفض --hard نهائيًا.', { path: str('مجلد المستودع، الافتراضي الجذر'), mode: str('soft أو mixed، الافتراضي mixed') }, []),
  tool('git_commit', 'أنشئ commit في المستودع الحالي. يتطلب موافقة صريحة دائمًا حتى في وضع الوصول الكامل.', { path: str('مجلد المستودع، الافتراضي الجذر'), message: str('رسالة commit'), all: bool('أضف كل التغييرات قبل commit') }, ['message']),
  tool('git_revert', 'تراجع بأمان عن commit محدد بإنشاء revert commit جديد. استخدم hash الذي أعادته gitAutoCommit، ويتطلب موافقة صريحة دائمًا.', { path: str('مجلد المستودع، الافتراضي الجذر'), commit: str('hash كامل أو مختصر للـcommit') }, ['commit']),
  tool('git_revert_step', 'ألغِ آخر خطوة تنفيذ كاملة: يسترجع كل التعديلات التي حُفظت في آخر commit تلقائي (gitAutoCommit) بإنشاء revert commit واحد، دون لمس التغييرات غير الملتزمة. يتطلب موافقة صريحة دائمًا.', { path: str('مجلد المستودع، الافتراضي الجذر') }, []),
  tool('run_powershell', 'شغّل أمر PowerShell مع مهلة وحد مخرجات. يتطلب موافقة في كل مرة. المهلة حتى 10 دقائق.', { command: str('الأمر الكامل'), cwd: str('مجلد التشغيل داخل مساحة العمل'), timeout_ms: integer('المهلة بالمللي ثانية', 1000, 600000) }, ['command'])
]

export interface StoredMessageView {
  id: string
  sequence: number
  role: string
  content: string
  toolCallId?: string
  toolName?: string
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown>; output?: string; status: string; startedAt?: number; completedAt?: number }>
  createdAt: number
}

export interface ToolContext {
  session: Session
  approve(title: string, detail: string, critical: boolean, rememberKey?: string): Promise<boolean>
  signal: AbortSignal
  maxOutputChars?: number
  trackProcess?(child: import('child_process').ChildProcess): void
  deadlineAt?: number
  mcp?: McpToolExecutor
  readStoredMessage?(id: string): Promise<StoredMessageView | undefined>
  loadSkill?(name: string): Promise<{ name: string; description: string; content: string } | undefined>
  todos?: { get(): Promise<Todo[]>; set(items: Array<{ content: string; status?: Todo['status']; priority?: Todo['priority'] }>): Promise<Todo[]> }
  runSubagent?(input: { prompt: string; description: string }, signal: AbortSignal): Promise<{ ok: boolean; summary: string; error?: string; steps: number }>
  runSubagentBatch?(tasks: Array<{ prompt: string; description: string }>, signal: AbortSignal): Promise<Array<{ ok: boolean; description: string; summary: string; error?: string; steps: number }>>
  runCommand?(name: string, argumentsText?: string): Promise<{ ok: boolean; output?: string; error?: string }>
  deferAutoCommit?(action: string, paths: string[]): void
}

export async function executeTool(name: string, input: Record<string, unknown>, context: ToolContext): Promise<string> {
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) return failure('DEADLINE_EXCEEDED', 'انتهى الوقت المتاح للجولة الحالية.')
  const mutating = ['write_file', 'edit_file', 'patch_file', 'create_directory', 'run_powershell', 'git_commit', 'git_revert', 'git_revert_step', 'git_add', 'git_fetch', 'git_pull', 'git_push', 'git_checkpoint', 'git_isolate_branch', 'delete_file', 'move_file', 'append_file', 'git_restore', 'git_checkout', 'git_reset'].includes(name)
  if (context.session.agentMode === 'plan' && mutating) return failure('PLAN_MODE', 'وضع Plan لا يسمح بالتعديل أو تنفيذ الأوامر.')
  const destructive = ['delete_file', 'git_restore', 'git_checkout', 'git_reset', 'git_revert', 'git_revert_step'].includes(name)

  const root = await canonicalWorkspace(context.session.workspace)
  if (name.startsWith('mcp_') || name.startsWith('tavily_')) {
    if (context.session.agentMode === 'plan') return failure('PLAN_MODE', 'وضع Plan لا يسمح باستدعاء أدوات MCP لأنها قد تعدل خارج المشروع.')
    if (!context.mcp) return failure('MCP_UNAVAILABLE', 'مدير MCP غير متاح.')
    if (context.session.permissionMode === 'ask' && !await context.approve(`السماح بأداة MCP ${name}؟`, JSON.stringify({ tool: name, input }, null, 2), true)) return failure('APPROVAL_DENIED', 'رفض المستخدم تنفيذ أداة MCP.')
    return context.mcp.call(name, input, context.signal, context.session.workspace)
  }
  const targetInput = name === 'read_files' && typeof input.paths === 'string' ? '.' : name === 'move_file' && typeof input.from === 'string' ? input.from : typeof input.path === 'string' ? input.path : typeof input.cwd === 'string' ? input.cwd : '.'
  const target = name === 'web_fetch' || name === 'web_search' ? { absolute: root.canonical, relative: '.' } : name === 'write_file' || name === 'create_directory' || name === 'append_file' ? await resolveCreatable(root, targetInput) : await resolveExisting(root, targetInput)
  const sensitive = isSensitiveInput(name, input, target.relative)
  const shell = name === 'run_powershell'
  const criticalShell = shell && isCriticalCommand(String(input.command ?? ''))
  const web = name === 'web_fetch' || name === 'web_search'
  const criticalGit = name === 'git_commit' || name === 'git_revert'
  const needsApproval = context.session.permissionMode === 'ask' && (sensitive || shell || web || criticalGit || destructive || mutating)
  if (needsApproval) {
    const preview = await buildApprovalPreview(name, input, target, sensitive)
    if (!await context.approve(`السماح بأداة ${name}؟`, preview.detail, criticalShell || shell || criticalGit || sensitive, preview.rememberKey)) return failure('APPROVAL_DENIED', 'رفض المستخدم تنفيذ الأداة.')
    if (preview.verify) await preview.verify()
    if (name === 'write_file' || name === 'create_directory' || name === 'append_file') await resolveCreatable(root, targetInput)
    else if (name !== 'move_file') await resolveExisting(root, targetInput)
  }

  switch (name) {
    case 'read_file': return readTextFile(target.absolute, target.relative, number(input.offset, 1, 1), number(input.limit, MAX_READ_LINES, 1, MAX_READ_LINES))
    case 'read_files': return readFiles(root.canonical, target.absolute, optionalString(input.paths), optionalString(input.include), optionalString(input.cursor), number(input.max_files, 10, 1, 100), context.maxOutputChars ?? 300_000, context.signal)
    case 'read_message': {
      const id = requiredString(input.id, 'id')
      if (!context.readStoredMessage) return failure('READ_MESSAGE_UNAVAILABLE', 'أداة read_message غير متاحة في هذا السياق.')
      const stored = await context.readStoredMessage(id)
      if (!stored) return failure('MESSAGE_NOT_FOUND', `لا توجد رسالة بمعرّف ${id} في سجل هذه الجلسة.`)
      return success({ ...stored, content: stored.content.slice(0, 200_000) })
    }
    case 'load_skill': {
      const name = requiredString(input.name, 'name')
      if (!context.loadSkill) return failure('SKILL_UNAVAILABLE', 'أداة load_skill غير متاحة في هذا السياق.')
      const skill = await context.loadSkill(name)
      if (!skill) return failure('SKILL_NOT_FOUND', `لا توجد مهارة باسم ${name} في مجلدات مهارات المشروع.`)
      const maxChars = number(input.max_chars, 60_000, 1_000, 100_000)
      return success({ name: skill.name, description: skill.description, content: skill.content.slice(0, maxChars), truncated: skill.content.length > maxChars })
    }
    case 'task': {
      if (!context.runSubagent) return failure('SUBAGENT_UNAVAILABLE', 'أداة task غير متاحة في هذا السياق.')
      const prompt = requiredString(input.prompt, 'prompt')
      const description = String(input.description ?? '')
      if (prompt.length > 100_000) return failure('INVALID_TASK_INPUT', 'prompt أطول من الحد المسموح (100000 حرف).')
      const signal = context.signal
      const subagent = await context.runSubagent({ prompt, description }, signal)
      if (!subagent.ok) return failure('SUBAGENT_FAILED', `فشل الوكيل الفرعي: ${subagent.error ?? 'خطأ غير معروف'}`)
      return success({ description, steps: subagent.steps, summary: subagent.summary })
    }
    case 'task_parallel': {
      if (!context.runSubagentBatch) return failure('SUBAGENT_UNAVAILABLE', 'أداة task_parallel غير متاحة في هذا السياق.')
      let parsed: Array<Record<string, unknown>>
      if (Array.isArray(input.tasks)) {
        parsed = input.tasks as Array<Record<string, unknown>>
      } else {
        const raw = requiredString(input.tasks, 'tasks')
        try { parsed = JSON.parse(raw); if (!Array.isArray(parsed)) throw new Error() } catch { return failure('INVALID_TASKS_INPUT', 'tasks يجب أن تكون مصفوفة JSON صالحة.') }
      }
      const tasks = parsed.slice(0, 5).map((item) => ({ prompt: typeof item.prompt === 'string' ? item.prompt.slice(0, 100_000) : '', description: typeof item.description === 'string' ? item.description.slice(0, 200) : 'وكيل فرعي' }))
      if (!tasks.length || tasks.some((task) => !task.prompt.trim())) return failure('INVALID_TASKS_INPUT', 'كل مهمة تتطلب prompt نصيًا.')
      const results = await context.runSubagentBatch(tasks, context.signal)
      return success({ count: results.length, results })
    }
    case 'todo_write': {
      if (!context.todos) return failure('TODOS_UNAVAILABLE', 'أداة todo_write غير متاحة في هذا السياق.')
      const raw = requiredString(input.items, 'items')
      let parsed: Array<Record<string, unknown>>
      try { parsed = JSON.parse(raw); if (!Array.isArray(parsed)) throw new Error() } catch { return failure('INVALID_TODO_INPUT', 'items يجب أن تكون مصفوفة JSON صالحة.') }
      const items: Array<{ content: string; status?: Todo['status']; priority?: Todo['priority'] }> = parsed.slice(0, 100).map((item) => { const status = item.status === 'completed' || item.status === 'in_progress' || item.status === 'cancelled' ? item.status as Todo['status'] : undefined; const priority = item.priority === 'high' || item.priority === 'low' ? item.priority as Todo['priority'] : undefined; return { content: typeof item.content === 'string' ? item.content.slice(0, 500) : '', status, priority } })
      if (items.some((item) => !item.content.trim())) return failure('INVALID_TODO_INPUT', 'كل مهمة تتطلب content نصيًا.')
      const todos = await context.todos.set(items)
      return success({ count: todos.length, todos })
    }
    case 'todo_read': {
      if (!context.todos) return failure('TODOS_UNAVAILABLE', 'أداة todo_read غير متاحة في هذا السياق.')
      return success({ count: (await context.todos.get()).length, todos: await context.todos.get() })
    }
    case 'run_command': {
      if (!context.runCommand) return failure('COMMAND_UNAVAILABLE', 'أداة run_command غير متاحة في هذا السياق.')
      const result = await context.runCommand(requiredString(input.name, 'name'), typeof input.arguments === 'string' ? input.arguments : undefined)
      if (!result.ok) return failure('COMMAND_FAILED', result.error ?? 'فشل تنفيذ الأمر')
      return success({ name: input.name, output: result.output })
    }
    case 'count_lines': return countLines(target.absolute, target.relative, optionalString(input.include), context.signal)
    case 'list_directory': return listDirectory(target.absolute, target.relative, number(input.limit, 500, 1, 1000))
    case 'glob_files': return globFiles(target.absolute, root.canonical, requiredString(input.pattern, 'pattern'), number(input.limit, 1000, 1, MAX_GLOB_RESULTS), context.signal)
    case 'search_files': return searchFiles(target.absolute, root.canonical, requiredString(input.pattern, 'pattern'), optionalString(input.include), Boolean(input.fixed_strings), Boolean(input.case_sensitive), number(input.limit, MAX_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS), context.signal)
    case 'search_symbols': return searchSymbols(target.absolute, root.canonical, requiredString(input.query, 'query'), number(input.limit, MAX_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS), context.signal)
    case 'write_file': { const output = await writeFileAtomic(target.absolute, target.relative, requiredString(input.content, 'content')); return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, 'write_file', [target.relative])) }
    case 'edit_file': { const output = await editFile(target.absolute, target.relative, requiredString(input.old_string, 'old_string'), String(input.new_string ?? '')); return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, 'edit_file', [target.relative])) }
    case 'patch_file': { const output = await patchFile(target.absolute, target.relative, requiredString(input.patches, 'patches')); return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, 'patch_file', [target.relative])) }
    case 'create_directory': { await fs.mkdir(target.absolute, { recursive: true }); return success({ path: target.relative, created: true }) }
    case 'get_file_info': return fileInfo(target.absolute, target.relative)
    case 'web_fetch': return webFetch(requiredString(input.url, 'url'), number(input.max_bytes, 200_000, 1_000, 500_000), context.signal, context.deadlineAt)
    case 'web_search': return webSearch(requiredString(input.query, 'query'), number(input.max_results, 5, 1, 10), context.signal, context.deadlineAt)
    case 'git_status': return gitStatus(target.absolute, context.signal, context.trackProcess, context.deadlineAt)
    case 'git_diff': return gitDiff(target.absolute, Boolean(input.staged), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_log': return gitLog(target.absolute, number(input.limit, 10, 1, 50), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_commit': return gitCommit(target.absolute, requiredString(input.message, 'message'), Boolean(input.all), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_revert': return gitRevert(target.absolute, requiredString(input.commit, 'commit'), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_revert_step': return gitRevertStep(target.absolute, context.signal, context.trackProcess, context.deadlineAt)
    case 'delete_file': { const output = await deleteFile(target.absolute, target.relative); return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, 'delete_file', [target.relative])) }
    case 'move_file': { const destination = await resolveCreatable(root, requiredString(input.to, 'to')); const output = await moveFile(root.canonical, requiredString(input.from, 'from'), requiredString(input.to, 'to')); return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, 'move_file', [target.relative, destination.relative])) }
    case 'append_file': { const output = await appendFile(target.absolute, target.relative, requiredString(input.content, 'content')); return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, 'append_file', [target.relative])) }
    case 'tree': return projectTree(target.absolute, root.canonical, number(input.max_entries, 1000, 1, 2000), context.signal)
    case 'git_branch': return gitBranch(target.absolute, context.signal, context.trackProcess, context.deadlineAt)
    case 'git_show': return gitShow(target.absolute, requiredString(input.spec, 'spec'), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_add': return gitAdd(target.absolute, requiredString(input.files, 'files'), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_fetch': return gitFetch(target.absolute, optionalString(input.remote), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_pull': return gitPull(target.absolute, optionalString(input.remote), optionalString(input.branch), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_push': return gitPush(target.absolute, optionalString(input.remote), optionalString(input.branch), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_checkpoint': return gitCheckpoint(target.absolute, optionalString(input.name), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_isolate_branch': return gitIsolateBranch(target.absolute, requiredString(input.name, 'name'), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_restore': return gitRestore(target.absolute, requiredString(input.file, 'file'), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_checkout': return gitCheckout(target.absolute, requiredString(input.branch, 'branch'), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_reset': return gitReset(target.absolute, String(input.mode ?? 'mixed'), context.signal, context.trackProcess, context.deadlineAt)
    case 'run_powershell': {
      const requestedTimeout = number(input.timeout_ms, 30_000, 1_000, 600_000)
      const remaining = context.deadlineAt === undefined ? requestedTimeout : Math.max(1_000, Math.min(requestedTimeout, context.deadlineAt - Date.now()))
      const result = await runPowerShell(requiredString(input.command, 'command'), target.absolute, context.signal, remaining, context.trackProcess)
      return success(result)
    }
    default: throw new Error(`أداة غير معروفة: ${name}`)
  }
}

export async function runPowerShell(command: string, cwd: string, signal?: AbortSignal, timeoutMs = 30_000, trackProcess?: (child: import('child_process').ChildProcess) => void): Promise<{ output: string; exitCode: number; timedOut: boolean; truncated: boolean; durationMs: number }> {
  const policyError = validateSandboxCommand(command, cwd)
  if (policyError) throw new Error(`رفض PowerShell المقيد: ${policyError}`)
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const sandboxCommand = `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; Set-Location -LiteralPath '${escapePowerShellLiteral(cwd)}'; & { ${command} }`
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', sandboxCommand], { cwd, windowsHide: true, env: safeEnvironment() })
    trackProcess?.(child)
    const chunks: Buffer[] = []
    let bytes = 0
    let truncated = false
    let timedOut = false
    let settled = false
    const append = (chunk: Buffer): void => {
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return }
      const remaining = MAX_OUTPUT_BYTES - bytes
      chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining)
      if (chunk.length > remaining) truncated = true
    }
    const killTree = (): void => {
      if (!child.pid || child.killed) return
      child.kill()
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.unref()
    }
    const timeout = setTimeout(() => { timedOut = true; killTree() }, timeoutMs)
    const abort = (): void => killTree()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error) => { if (!settled) { settled = true; cleanup(); reject(error) } })
    child.on('close', (code) => {
      if (settled) return
      settled = true; cleanup()
      if (signal?.aborted) { reject(new DOMException('تم إلغاء الأمر', 'AbortError')); return }
      resolve({ output: Buffer.concat(chunks).toString('utf8'), exitCode: code ?? -1, timedOut, truncated, durationMs: Date.now() - startedAt })
    })
    function cleanup(): void { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
  })
}

const POWERSHELL_ALLOWED_COMMANDS = new Set(['Add-Content', 'Copy-Item', 'Get-ChildItem', 'Get-Content', 'Get-Location', 'Get-Item', 'Get-Process', 'Move-Item', 'New-Item', 'Pop-Location', 'Push-Location', 'Remove-Item', 'Rename-Item', 'Resolve-Path', 'Select-String', 'Set-Content', 'Set-Location', 'Test-Path', 'Write-Error', 'Write-Output', 'Write-Verbose', 'Write-Warning', 'Where-Object', 'ForEach-Object', 'Sort-Object', 'git', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'py', 'dotnet', 'cargo', 'go', 'java', 'mvn', 'gradle', 'tsc', 'jest', 'pytest', 'where', 'cmd', 'echo', 'type', 'dir', 'findstr', 'rg'])

function validateSandboxCommand(command: string, cwd: string): string | undefined {
  const value = command.trim()
  if (!value) return 'الأمر فارغ.'
  if (/(?:-EncodedCommand|-e\b|FromBase64String|Add-Type|Reflection|Start-Process|Invoke-Expression|Invoke-Command|powershell(?:\.exe)?\s+-(?:Command|EncodedCommand)|pwsh\s+-)/i.test(value)) return 'تشغيل كود أو PowerShell متداخل غير مسموح.'
  if (/(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|curl(?:\.exe)?\b|wget(?:\.exe)?\b|ssh(?:\.exe)?\b|scp(?:\.exe)?\b|netsh\b|New-PSSession)/i.test(value)) return 'أوامر الشبكة والاتصالات الخارجية غير مسموحة داخل العزل.'
  if (/(?:^|[;&|])\s*(?:Remove-Item\s+[^\r\n;|]*-Recurse\b[^\r\n;|]*-Force\b|Format-Volume|Clear-Disk|diskpart|reg\s+(?:add|delete)|schtasks|Set-MpPreference)/i.test(value)) return 'الأمر قد يسبب حذفًا أو تغييرًا خارج نطاق المشروع.'
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return 'المسارات النسبية إلى الأب غير مسموحة.'
  const absolutePaths = value.match(/[A-Za-z]:[\\/][^\s"'`;&|]*/g) ?? []
  const canonicalCwd = path.resolve(cwd).toLowerCase()
  for (const candidate of absolutePaths) if (!path.resolve(candidate).toLowerCase().startsWith(`${canonicalCwd}${path.sep}`) && path.resolve(candidate).toLowerCase() !== canonicalCwd) return 'المسار المطلق خارج مساحة العمل غير مسموح.'
  const commands = value.split(/[;|&\r\n]+/).map((part) => part.trim()).filter(Boolean)
  for (const part of commands) {
    const name = /^\.?[\\/]?([^\s]+?)(?:\.exe)?(?:\s|$)/i.exec(part)?.[1]
    if (!name) return 'تعذر التحقق من اسم الأمر.'
    const normalized = name.split(/[\\/]/).pop() ?? name
    if (!POWERSHELL_ALLOWED_COMMANDS.has(normalized) && !POWERSHELL_ALLOWED_COMMANDS.has(`${normalized[0]?.toUpperCase() ?? ''}${normalized.slice(1)}`)) return `الأمر غير موجود في allowlist: ${normalized}`
  }
  return undefined
}

function escapePowerShellLiteral(value: string): string { return value.replaceAll("'", "''") }

interface WorkspaceRoot { canonical: string }
interface ResolvedPath { absolute: string; relative: string }

async function canonicalWorkspace(workspace: string): Promise<WorkspaceRoot> {
  const canonical = await fs.realpath(path.resolve(workspace))
  const stat = await fs.stat(canonical)
  if (!stat.isDirectory()) throw new Error('مساحة العمل ليست مجلدًا')
  return { canonical }
}

async function resolveExisting(root: WorkspaceRoot, input: string): Promise<ResolvedPath> {
  const candidate = path.resolve(root.canonical, input)
  const canonical = await fs.realpath(candidate)
  assertInside(root.canonical, canonical)
  return { absolute: canonical, relative: relativePath(root.canonical, canonical) }
}

async function resolveCreatable(root: WorkspaceRoot, input: string): Promise<ResolvedPath> {
  const candidate = path.resolve(root.canonical, input)
  assertInside(root.canonical, candidate)
  let ancestor = candidate
  while (true) {
    try { await fs.lstat(ancestor); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
  const canonicalAncestor = await fs.realpath(ancestor)
  assertInside(root.canonical, canonicalAncestor)
  let current = root.canonical
  for (const part of path.relative(root.canonical, ancestor).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error('لا يسمح بالكتابة عبر رابط رمزي أو junction')
  }
  return { absolute: candidate, relative: relativePath(root.canonical, candidate) }
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('المسار خارج مساحة العمل')
}

function relativePath(root: string, target: string): string { return path.relative(root, target).replaceAll('\\', '/') || '.' }

export async function scanLines(filePath: string, collectStart?: number, collectLimit?: number): Promise<{ totalLines: number; bytes: number; lines: string[]; outputTruncated: boolean }> {
  const stat = await fs.stat(filePath)
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const lines: string[] = []
  let totalLines = 0
  let outputBytes = 0
  let outputTruncated = false
  let binary = false
  let streamError: Error | null = null
  stream.on('error', (error: Error) => { streamError = error; reader.close() })
  reader.on('error', (error: Error) => { streamError = error })
  stream.on('data', (chunk: string | Buffer) => { if (!binary && String(chunk).includes('\0')) { binary = true; reader.close(); stream.destroy() } })
  try {
    for await (const line of reader) {
      if (binary) break
      totalLines++
      if (collectStart && collectLimit && totalLines >= collectStart && totalLines < collectStart + collectLimit) {
        const rendered = `${totalLines}: ${line}`
        const size = Buffer.byteLength(rendered) + 1
        if (outputBytes + size <= MAX_OUTPUT_BYTES) { lines.push(rendered); outputBytes += size } else outputTruncated = true
      }
    }
    if (streamError && !binary) throw streamError
    if (binary) throw new Error('الملف ثنائي وليس نصيًا')
    return { totalLines, bytes: stat.size, lines, outputTruncated }
  } finally { try { reader.close() } catch {}; try { stream.destroy() } catch {} }
}

async function readTextFile(filePath: string, relative: string, offset: number, limit: number): Promise<string> {
  const result = await scanLines(filePath, offset, limit)
  return success({ path: relative, totalLines: result.totalLines, bytes: result.bytes, range: { start: result.lines.length ? offset : null, end: result.lines.length ? offset + result.lines.length - 1 : null, requestedLimit: limit }, truncated: result.outputTruncated || offset + result.lines.length <= result.totalLines, lines: result.lines })
}

async function readFiles(root: string, directory: string, pathsValue: string | undefined, include: string | undefined, cursorValue: string | undefined, maxFiles: number, maxOutputChars: number, signal: AbortSignal): Promise<string> {
  const candidates: Array<{ absolute: string; relative: string }> = []
  if (pathsValue) {
    const paths = [...new Set(pathsValue.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
    for (const input of paths) {
      signal.throwIfAborted()
      const canonical = await fs.realpath(path.resolve(root, input))
      assertInside(root, canonical)
      if ((await fs.stat(canonical)).isFile()) candidates.push({ absolute: canonical, relative: relativePath(root, canonical) })
    }
  } else {
    if (!include) throw new Error('read_files يتطلب paths أو include')
    const matcher = globRegex(include)
    await walkFiles(directory, root, signal, async (absolute, relative) => { if (matcher.test(relative) || matcher.test(path.basename(relative))) candidates.push({ absolute, relative }); return candidates.length < 2000 })
  }
  candidates.sort((a, b) => a.relative.localeCompare(b.relative))
  const cursorMatch = /^(\d+):(\d+)(?::(\d+))?$/.exec(cursorValue ?? '0:0:0')
  if (!cursorMatch) throw new Error('cursor غير صالح؛ استخدم القيمة التي أعادتها read_files كما هي')
  let fileIndex = Number(cursorMatch[1])
  let lineIndex = Number(cursorMatch[2])
  let characterIndex = Number(cursorMatch[3] ?? 0)
  const files: Array<{ path: string; totalLines: number; bytes: number; range: { start: number; end: number; startCharacter: number; endCharacter: number }; complete: boolean; content: string }> = []
  let usedChars = 0
  let processedFiles = 0
  while (fileIndex < candidates.length && processedFiles < maxFiles) {
    const candidate = candidates[fileIndex]!
    signal.throwIfAborted()
    const stat = await fs.stat(candidate.absolute)
    if (stat.size > 5_000_000) { fileIndex++; lineIndex = 0; characterIndex = 0; continue }
    const text = await fs.readFile(candidate.absolute, 'utf8')
    if (text.includes('\0')) { fileIndex++; lineIndex = 0; characterIndex = 0; continue }
    const rawLines = text.split(/\r\n|\n|\r/)
    if (rawLines.at(-1) === '') rawLines.pop()
    const rendered: string[] = []
    const startLine = lineIndex + 1
    const startCharacter = characterIndex
    while (lineIndex < rawLines.length) {
      const rawLine = rawLines[lineIndex]!
      const prefix = `${lineIndex + 1}${characterIndex ? `[char ${characterIndex + 1}]` : ''}: `
      const available = Math.max(1, maxOutputChars - usedChars - prefix.length - 1)
      const segment = rawLine.slice(characterIndex, characterIndex + available)
      rendered.push(`${prefix}${segment}`); usedChars += prefix.length + segment.length + 1; characterIndex += segment.length
      if (characterIndex < rawLine.length) break
      lineIndex++; characterIndex = 0
      if (usedChars >= maxOutputChars) break
    }
    files.push({ path: candidate.relative, totalLines: rawLines.length, bytes: stat.size, range: { start: startLine, end: Math.min(rawLines.length, lineIndex + (characterIndex ? 1 : 0)), startCharacter, endCharacter: characterIndex }, complete: lineIndex >= rawLines.length, content: rendered.join('\n') })
    if (lineIndex < rawLines.length) break
    fileIndex++; lineIndex = 0; characterIndex = 0; processedFiles++
    if (usedChars >= maxOutputChars) break
  }
  const nextCursor = fileIndex < candidates.length ? `${fileIndex}:${lineIndex}:${characterIndex}` : null
  return success({ totalFiles: candidates.length, cursor: cursorValue ?? '0:0:0', filesRead: files.length, nextCursor, complete: nextCursor === null, files })
}

async function countLines(filePath: string, relative: string, include: string | undefined, signal: AbortSignal): Promise<string> {
  const stat = await fs.stat(filePath)
  if (!stat.isDirectory()) {
    const result = await scanLines(filePath)
    return success({ path: relative, totalLines: result.totalLines, bytes: result.bytes })
  }
  const includePattern = include ? globToRegex(include) : null
  const files: Array<{ path: string; lines: number; bytes: number }> = []
  let totalLines = 0
  let totalBytes = 0
  let totalFiles = 0
  await walkFiles(filePath, filePath, signal, async (absolute, rel) => {
    if (includePattern && !includePattern.test(rel)) return true
    try { const result = await scanLines(absolute); files.push({ path: rel, lines: result.totalLines, bytes: result.bytes }); totalLines += result.totalLines; totalBytes += result.bytes; totalFiles++ } catch {}
    return true
  })
  files.sort((a, b) => b.lines - a.lines)
  return success({ path: relative, totalFiles, totalLines, totalBytes, files: files.slice(0, 200) })
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '{{GLOBSTAR}}').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\{\{GLOBSTAR\}\}/g, '.*')
  return new RegExp(`${escaped}$`, 'i')
}

async function listDirectory(directory: string, relative: string, limit: number): Promise<string> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const items = entries.slice(0, limit).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file' }))
  return success({ path: relative, totalEntries: entries.length, truncated: entries.length > limit, entries: items })
}

async function walkFiles(directory: string, root: string, signal: AbortSignal, onFile: (absolute: string, relative: string) => Promise<boolean>): Promise<boolean> {
  signal.throwIfAborted()
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    signal.throwIfAborted()
    if (entry.isSymbolicLink() || isIgnoredEntry(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) { if (!await walkFiles(absolute, root, signal, onFile)) return false }
    else if (entry.isFile() && !await onFile(absolute, relativePath(root, absolute))) return false
  }
  return true
}
function isIgnoredEntry(name: string): boolean {
  return ['node_modules', '.git', 'out', 'dist'].includes(name) || name.startsWith('release-') || name.startsWith('dist-v') || name.startsWith('win-unpacked') || name.endsWith('.tmp')
}

async function globFiles(directory: string, root: string, pattern: string, limit: number, signal: AbortSignal): Promise<string> {
  const matcher = globRegex(pattern)
  const ignored = await gitignorePatterns(root)
  const files: string[] = []
  const completed = await walkFiles(directory, root, signal, async (_absolute, relative) => { if (!isGitignored(relative, ignored) && matcher.test(relative)) files.push(relative); return files.length < limit })
  return success({ pattern, count: files.length, truncated: !completed, files })
}

async function searchFiles(directory: string, root: string, pattern: string, include: string | undefined, fixed: boolean, caseSensitive: boolean, limit: number, signal: AbortSignal): Promise<string> {
  const ripgrep = await searchFilesWithRipgrep(directory, root, pattern, include, fixed, caseSensitive, limit, signal)
  if (ripgrep) return ripgrep
  let matcher: RegExp
  try { matcher = new RegExp(fixed ? escapeRegex(pattern) : pattern, caseSensitive ? 'g' : 'gi') } catch (error) { throw new Error(`تعبير البحث غير صالح: ${error instanceof Error ? error.message : String(error)}`) }
  const includeMatcher = include ? globRegex(include) : null
  const ignored = await gitignorePatterns(root)
  const matches: Array<{ path: string; line: number; column: number; text: string }> = []
  let skippedBinary = 0
  const searchFile = async (absolute: string, relative: string): Promise<boolean> => {
    if (isGitignored(relative, ignored)) return true
    if (includeMatcher && !includeMatcher.test(relative) && !includeMatcher.test(path.basename(relative))) return true
    const stat = await fs.stat(absolute)
    if (stat.size > 5_000_000) return true
    let text: string
    try { text = await fs.readFile(absolute, 'utf8') } catch { return true }
    if (text.includes('\0')) { skippedBinary++; return true }
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      matcher.lastIndex = 0
      const match = matcher.exec(lines[index]!)
      if (match) { const start = Math.max(0, match.index - 50); matches.push({ path: relative, line: index + 1, column: match.index + 1, text: lines[index]!.slice(start, start + 120) }) }
      if (matches.length >= limit) return false
    }
    return true
  }
  const stat = await fs.stat(directory)
  const completed = stat.isFile() ? await searchFile(directory, relativePath(root, directory)) : await walkFiles(directory, root, signal, searchFile)
  return success({ pattern, count: matches.length, truncated: !completed, skippedBinary, matches })
}

async function searchFilesWithRipgrep(directory: string, root: string, pattern: string, include: string | undefined, fixed: boolean, caseSensitive: boolean, limit: number, signal: AbortSignal): Promise<string | null> {
  const args = ['--json', '--no-heading', '--color', 'never']
  if (fixed) args.push('--fixed-strings')
  args.push(caseSensitive ? '--case-sensitive' : '--ignore-case')
  for (const rule of await gitignoreGlobs(root)) args.push('--glob', rule)
  if (include?.trim()) args.push('--glob', include.trim())
  args.push(pattern, directory)
  const result = await runRipgrep(args, root, signal)
  if (result === null) return null
  const matches: Array<{ path: string; line: number; column: number; text: string }> = []
  const ignored = await gitignorePatterns(root)
  let skippedBinary = 0
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue
    try {
      const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string }; submatches?: Array<{ start?: number }> } }
      if (event.type === 'summary' && result.exitCode === 0) continue
      if (event.type !== 'match' || !event.data?.path?.text) continue
      const relative = event.data.path.text.replaceAll('\\', '/')
      if (isGitignored(relative, ignored)) continue
      matches.push({ path: relative, line: Number(event.data.line_number ?? 0), column: Number((event.data.submatches?.[0]?.start ?? 0) + 1), text: String(event.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 120) })
      if (matches.length >= limit) break
    } catch { /* ignore malformed ripgrep events */ }
  }
  if (result.exitCode > 1) throw new Error(`فشل ripgrep (${result.exitCode}): ${result.stderr.slice(0, 1000)}`)
  if (result.stderr.includes('binary file matches')) skippedBinary++
  return success({ pattern, count: matches.length, truncated: matches.length >= limit, skippedBinary, matches })
}

async function gitignoreGlobs(root: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    return content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('!')).flatMap((line) => {
      const rule = line.endsWith('/') ? `${line}**` : line
      return [`!${rule}`, `!**/${rule}`]
    })
  } catch { return [] }
}

async function gitignorePatterns(root: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    return content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
  } catch { return [] }
}

function isGitignored(relative: string, patterns: string[]): boolean {
  const normalized = relative.replaceAll('\\', '/')
  return patterns.some((pattern) => {
    const clean = pattern.replace(/^\/+/, '')
    const matcher = globToRegex(clean.endsWith('/') ? `${clean}**` : clean)
    return matcher.test(normalized) || (!clean.includes('/') && matcher.test(path.posix.basename(normalized)))
  })
}

interface RipgrepResult { stdout: string; stderr: string; exitCode: number }

function runRipgrep(args: string[], cwd: string, signal: AbortSignal): Promise<RipgrepResult | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const finish = (value: RipgrepResult | null, error?: Error): void => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(value) }
    const abort = (): void => { try { child.kill() } catch {}; finish(null, new DOMException('تم إلغاء البحث', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') finish(null); else finish(null, error) })
    child.once('close', (code) => finish({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? -1 }))
  })
}

const SYMBOL_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.kts', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.swift', '.dart', '.sh', '.sql', '.vue', '.svelte', '.json', '.css', '.scss', '.html', '.xml', '.yml', '.yaml', '.toml', '.md', '.gradle', '.groovy'])

const SYMBOL_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'function', pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
  { kind: 'class', pattern: /^(?:export\s+)?class\s+(\w+)/ },
  { kind: 'interface', pattern: /^(?:export\s+)?interface\s+(\w+)/ },
  { kind: 'type', pattern: /^(?:export\s+)?(?:type|enum)\s+(\w+)/ },
  { kind: 'const', pattern: /(?:const|let|var)\s+(\w+)\s*=\s*(?:function|\(|async|class)/ },
  { kind: 'method', pattern: /(?:def\s+|async\s+def\s+|func\s+|public\s+\w+\s+|private\s+\w+\s+|protected\s+\w+\s+)(\w+)\s*\(/ },
  { kind: 'method', pattern: /^\s*(?:(?:public|private|protected)\s+)?[\w<>[\],?]+\s+(\w+)\s*\([^)]*\)\s*\{?\s*$/ },
  { kind: 'import', pattern: /^import\s+(?:\{\s*([^}]+?)\s*\}|(\w+))\s+from/ },
]

async function searchSymbols(directory: string, root: string, query: string, limit: number, signal: AbortSignal): Promise<string> {
  const lower = query.trim().toLowerCase()
  if (!lower) throw new Error('query لا يمكن أن يكون فارغًا')
  const symbols: Array<{ path: string; line: number; kind: string; name: string }> = []
  const ignored = await gitignorePatterns(root)
  const completed = await walkFiles(directory, root, signal, async (absolute, relative) => {
    if (isGitignored(relative, ignored)) return true
    const ext = path.extname(absolute).toLowerCase()
    if (!SYMBOL_EXTENSIONS.has(ext)) return true
    const stat = await fs.stat(absolute)
    if (stat.size > 2_000_000) return true
    let text: string
    try { text = await fs.readFile(absolute, 'utf8') } catch { return true }
    if (text.includes('\0')) return true
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      if (!line.toLowerCase().includes(lower)) continue
      for (const { kind, pattern } of SYMBOL_PATTERNS) {
        const match = pattern.exec(line)
        if (!match) continue
        const name = (match[1] ?? '').trim().split(/[,}\s]/)[0] ?? ''
        if (!name || !name.toLowerCase().includes(lower)) continue
        symbols.push({ path: relative, line: index + 1, kind, name: name.slice(0, 120) })
        break
      }
      if (symbols.length >= limit) return false
    }
    return true
  })
  return success({ query: query.trim(), count: symbols.length, truncated: !completed, symbols })
}

async function writeFileAtomic(target: string, relative: string, content: string): Promise<string> {
  const previous = await readOptionalText(target)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.r-code-${randomBytes(8).toString('hex')}.tmp`
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
  const backup = `${target}.r-code-${randomBytes(8).toString('hex')}.bak`
  let backedUp = false
  try {
    try { await fs.rename(target, backup); backedUp = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await fs.rename(temporary, target)
    if (backedUp) await fs.rm(backup, { force: true })
  } catch (error) {
    await fs.rm(temporary, { force: true })
    if (backedUp) { await fs.rm(target, { force: true }); await fs.rename(backup, target) }
    throw error
  }
  const diff = isSensitive(relative) ? { text: '[محتوى ملف حساس محجوب]', truncated: false } : diffPreview(previous ?? '', content)
  return success({ path: relative, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), diff: diff.text, diffTruncated: diff.truncated })
}

async function editFile(target: string, relative: string, oldString: string, newString: string): Promise<string> {
  if (!oldString) throw new Error('old_string لا يمكن أن يكون فارغًا')
  const content = await fs.readFile(target, 'utf8')
  const applied = applyEdit(content, oldString, newString)
  await writeFileAtomic(target, relative, applied.content)
  const diff = isSensitive(relative) ? { text: '[محتوى ملف حساس محجوب]', truncated: false } : diffPreview(content, applied.content)
  return success({ path: relative, changed: true, startLine: applied.startLine, removedLines: applied.removedLines, addedLines: applied.addedLines, diff: diff.text, diffTruncated: diff.truncated, totalLines: applied.content.split('\n').length })
}

function applyEdit(content: string, oldString: string, newString: string): { content: string; startLine: number; removedLines: number; addedLines: number } {
  if (!oldString) throw new Error('old_string لا يمكن أن يكون فارغًا')
  let matchStart = content.indexOf(oldString)
  let matchEnd = matchStart === -1 ? -1 : matchStart + oldString.length
  if (matchStart !== -1) {
    const exactCount = countOccurrences(content, oldString)
    if (exactCount > 1) throw new Error(`النص المطابق موجود ${exactCount} مرات؛ اجعل old_string أطول وأكثر تحديدًا`)
  } else {
    const range = findLineEndingMatch(content, oldString)
    if (range) { matchStart = range.start; matchEnd = range.end }
  }
  if (matchStart === -1 || matchEnd === -1) throw new Error('لم يتم العثور على تطابق آمن. اقرأ الملف مجددًا واستخدم النص الدقيق بما فيه المسافات وtabs.')
  const eol = preferredLineEnding(content)
  const replacement = normalizeLineEndings(newString).replaceAll('\n', eol)
  const startLine = normalizeLineEndings(content.slice(0, matchStart)).split('\n').length
  const removedLines = normalizeLineEndings(content.slice(matchStart, matchEnd)).split('\n').length
  const addedLines = normalizeLineEndings(newString).split('\n').length
  return { content: content.slice(0, matchStart) + replacement + content.slice(matchEnd), startLine, removedLines, addedLines }
}

function normalizeForMatch(value: string): string { return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '  ').replace(/ +$/gm, '') }
function countOccurrences(haystack: string, needle: string): number { if (!needle) return 0; let count = 0; let index = haystack.indexOf(needle); while (index !== -1) { count++; index = haystack.indexOf(needle, index + needle.length) } return count }

function findLineEndingMatch(content: string, needle: string): { start: number; end: number } | undefined {
  const normalizedNeedle = normalizeLineEndings(needle)
  const normalizedChars: string[] = []
  const rawBoundaries: number[] = [0]
  for (let raw = 0; raw < content.length;) {
    if (content[raw] === '\r') {
      raw += content[raw + 1] === '\n' ? 2 : 1
      normalizedChars.push('\n')
    } else {
      normalizedChars.push(content[raw]!)
      raw++
    }
    rawBoundaries.push(raw)
  }
  const normalizedContent = normalizedChars.join('')
  const count = countOccurrences(normalizedContent, normalizedNeedle)
  if (count > 1) throw new Error(`النص المطابق موجود ${count} مرات؛ اجعل old_string أطول وأكثر تحديدًا`)
  if (count !== 1) return undefined
  const start = normalizedContent.indexOf(normalizedNeedle)
  return { start: rawBoundaries[start]!, end: rawBoundaries[start + normalizedNeedle.length]! }
}

function normalizeLineEndings(value: string): string { return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n') }
function preferredLineEnding(value: string): '\r\n' | '\n' { return value.includes('\r\n') ? '\r\n' : '\n' }

async function patchFile(target: string, relative: string, patchesRaw: string): Promise<string> {
  const content = await fs.readFile(target, 'utf8')
  const applied = applyPatches(content, patchesRaw)
  await writeFileAtomic(target, relative, applied.content)
  const diff = isSensitive(relative) ? { text: '[محتوى ملف حساس محجوب]', truncated: false } : diffPreview(content, applied.content)
  return success({ path: relative, patchesApplied: applied.applied.length, applied: applied.applied, totalLines: applied.content.split('\n').length, diff: diff.text, diffTruncated: diff.truncated })
}

function applyPatches(content: string, patchesRaw: string): { content: string; applied: Array<{ start: number; removed: number; added: number }> } {
  const patches = JSON.parse(patchesRaw)
  if (!Array.isArray(patches) || patches.length === 0) throw new Error('patches يجب أن تكون مصفوفة JSON غير فارغة')
  const eol = preferredLineEnding(content)
  const lines = normalizeLineEndings(content).split('\n')
  const parsed: Array<{ start: number; end: number; newLines: string[]; expected?: string }> = []
  for (const patch of patches as Array<Record<string, unknown>>) {
    const start = Number(patch.start_line)
    const end = Number(patch.end_line)
    const newLines = typeof patch.new_lines === 'string' ? normalizeLineEndings(patch.new_lines).split('\n') : Array.isArray(patch.new_lines) ? patch.new_lines.flatMap((line) => normalizeLineEndings(String(line)).split('\n')) : []
    if (!Number.isFinite(start) || start < 1 || start > lines.length + 1) throw new Error(`start_line غير صالح: ${start}`)
    if (!Number.isFinite(end) || end < start - 1 || end > lines.length) throw new Error(`end_line غير صالح: ${end}`)
    const expected = typeof patch.expected === 'string' ? patch.expected : undefined
    parsed.push({ start, end, newLines, expected })
  }
  // تُطبَّق التعديلات من الأسفل إلى الأعلى (على أرقام الأسطر الأصلية)
  // حتى لا تُزيح التعديلات السفلية أرقام التعديلات الأعلى، وتُرفض المتداخلة.
  const sorted = [...parsed].sort((a, b) => b.start - a.start)
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1]!.start <= sorted[index]!.end) throw new Error('تتداخل التعديلات في نفس الأسطر؛ ادمجها في تعديل واحد')
  }
  const applied: Array<{ start: number; removed: number; added: number }> = []
  for (const patch of sorted) {
    const before = lines.slice(patch.start - 1, patch.end).join('\n')
    if (patch.expected !== undefined && normalizePatchExpected(before) !== normalizePatchExpected(patch.expected)) {
      throw new Error(`الأسطر ${patch.start}-${patch.end} لا تطابق المحتوى المتوقع؛ أعد قراءة الملف وحدّث expected من الأرقام الجديدة. الفعلي: ${before.slice(0, 300)} | المتوقع: ${patch.expected.slice(0, 300)}`)
    }
    lines.splice(patch.start - 1, patch.end - patch.start + 1, ...patch.newLines)
    applied.push({ start: patch.start, removed: patch.end - patch.start + 1, added: patch.newLines.length })
  }
  return { content: lines.join(eol), applied }
}

function normalizePatchExpected(value: string): string { return normalizeForMatch(value).replace(/\n$/, '') }

async function fileInfo(target: string, relative: string): Promise<string> {
  const stat = await fs.stat(target)
  const info: Record<string, unknown> = { path: relative, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtime.toISOString(), createdAt: stat.birthtime.toISOString() }
  if (stat.isFile() && stat.size <= 20_000_000) { try { info.totalLines = (await scanLines(target)).totalLines } catch { info.binary = true } }
  return success(info)
}

async function readOptionalText(target: string): Promise<string | undefined> {
  try { return await fs.readFile(target, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

function hashText(value: string | undefined): string { return value === undefined ? 'missing' : createHash('sha256').update(value).digest('hex') }

function diffPreview(before: string, after: string): { text: string; truncated: boolean } {
  const oldLines = before.split(/\r\n|\n|\r/)
  const newLines = after.split(/\r\n|\n|\r/)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++
  const changedOld = oldLines.slice(prefix, oldLines.length - suffix)
  const changedNew = newLines.slice(prefix, newLines.length - suffix)
  const output = [`@@ السطور ${prefix + 1}-${Math.max(prefix + changedOld.length, prefix + changedNew.length)} @@`, ...changedOld.map((line) => `-${line}`), ...changedNew.map((line) => `+${line}`)]
  const maxLines = 80
  const maxChars = 12_000
  let truncated = output.length > maxLines
  let text = output.slice(0, maxLines).join('\n')
  if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true }
  if (truncated) text += '\n...[تم اختصار الفرق]'
  return { text, truncated }
}

function operationKey(name: string, target: string, payload: string): string { return `${name}:${target}:${createHash('sha256').update(payload).digest('hex')}` }

function isSensitiveInput(name: string, input: Record<string, unknown>, target: string): boolean {
  const values = [target, input.path, input.cwd, input.paths, input.include, input.from, input.to, input.file].filter((value): value is string => typeof value === 'string')
  return values.some((value) => isSensitive(value))
}

interface ApprovalPreview { detail: string; rememberKey?: string; verify?: () => Promise<void> }

async function buildApprovalPreview(name: string, input: Record<string, unknown>, target: ResolvedPath, sensitive: boolean): Promise<ApprovalPreview> {
  if (name === 'web_fetch') return { detail: JSON.stringify({ tool: name, url: input.url, maxBytes: input.max_bytes ?? 200_000 }, null, 2) }
  if (name === 'web_search') return { detail: JSON.stringify({ tool: name, query: String(input.query ?? '').slice(0, 500), maxResults: input.max_results ?? 5 }, null, 2) }
  if (name === 'run_powershell') return { detail: JSON.stringify({ tool: name, cwd: target.relative, command: input.command, timeoutMs: input.timeout_ms ?? 30_000 }, null, 2) }
  if (name === 'git_commit') return { detail: JSON.stringify({ tool: name, repository: target.relative, message: String(input.message ?? '').slice(0, 1000), all: Boolean(input.all) }, null, 2) }
  if (name === 'git_revert') return { detail: JSON.stringify({ tool: name, repository: target.relative, commit: String(input.commit ?? '').slice(0, 40), operation: 'create a new commit that safely reverses the selected commit' }, null, 2) }
  if (name === 'git_revert_step') return { detail: JSON.stringify({ tool: name, repository: target.relative, operation: 'reverse the last automatic (gitAutoCommit) commit with a new commit' }, null, 2) }
  if (name === 'delete_file') {
    const current = await readOptionalText(target.absolute)
    const fingerprint = hashText(current)
    return { detail: JSON.stringify({ tool: name, target: target.relative, operation: 'delete file permanently (لا يمكن التراجع)' }, null, 2), rememberKey: operationKey(name, target.relative, fingerprint), verify: async () => { const now = await readOptionalText(target.absolute); if (hashText(now) !== fingerprint) throw new Error('تغيّر الملف بعد عرض المعاينة؛ اطلب الحذف من جديد.') } }
  }
  if (name === 'move_file') return { detail: JSON.stringify({ tool: name, from: String(input.from ?? ''), to: String(input.to ?? ''), operation: 'move/rename file داخل مساحة العمل' }, null, 2), rememberKey: operationKey(name, `${input.from}:${input.to}`, '') }
  if (name === 'git_add') return { detail: JSON.stringify({ tool: name, repository: target.relative, files: String(input.files ?? '').slice(0, 2000) }, null, 2) }
  if (name === 'git_restore') return { detail: JSON.stringify({ tool: name, repository: target.relative, file: input.file, operation: 'discard uncommitted changes for this file (لا يمكن التراجع)' }, null, 2) }
  if (name === 'git_checkout') return { detail: JSON.stringify({ tool: name, repository: target.relative, branch: input.branch }, null, 2) }
  if (name === 'git_reset') return { detail: JSON.stringify({ tool: name, repository: target.relative, mode: input.mode ?? 'mixed', operation: 'unstage or move HEAD دون لمس ملفات العمل' }, null, 2) }
  if (name === 'create_directory') {
    const key = operationKey(name, target.relative, '')
    return { detail: JSON.stringify({ tool: name, target: target.relative, operation: 'create directory' }, null, 2), rememberKey: key }
  }

  const current = await readOptionalText(target.absolute)
  const currentHash = hashText(current)
  let next = current ?? ''
  let payload = ''
  if (name === 'write_file') {
    payload = requiredString(input.content, 'content')
    next = payload
  } else if (name === 'edit_file') {
    const applied = applyEdit(current ?? '', requiredString(input.old_string, 'old_string'), String(input.new_string ?? ''))
    payload = String(input.new_string ?? '')
    next = applied.content
  } else if (name === 'patch_file') {
    const applied = applyPatches(current ?? '', requiredString(input.patches, 'patches'))
    payload = String(input.patches)
    next = applied.content
  } else if (name === 'append_file') {
    payload = requiredString(input.content, 'content')
    next = current ? `${current}${current.endsWith('\n') ? '' : '\n'}${payload}` : payload
  }
  const nextHash = hashText(next)
  const preview = sensitive ? { text: '[محتوى ملف حساس محجوب]', truncated: false } : diffPreview(current ?? '', next)
  const detail = JSON.stringify({ tool: name, target: target.relative, currentExists: current !== undefined, currentSha256: currentHash, newSha256: nextHash, contentBytes: Buffer.byteLength(next), diff: preview.text, diffTruncated: preview.truncated }, null, 2)
  const key = sensitive ? undefined : operationKey(name, target.relative, `${currentHash}:${hashText(payload)}`)
  return { detail, rememberKey: key, verify: async () => { const now = await readOptionalText(target.absolute); if (hashText(now) !== currentHash) throw new Error('تغير الملف بعد عرض المعاينة؛ أعد قراءة الملف واطلب العملية من جديد.') } }
}

async function webFetch(value: string, maxBytes: number, signal: AbortSignal, deadlineAt?: number): Promise<string> {
  const MAX_REDIRECTS = 2
  let url = new URL(value)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || isBlockedHost(url.hostname)) throw new Error('يسمح فقط بروابط HTTPS العامة دون بيانات دخول')
    let response: PublicHttpsResponse
    try {
      response = await requestPublicHttps(url, maxBytes, signal, deadlineAt)
    } catch (error) {
      if (!(error instanceof Error) || !(error as { redirectStatus?: number }).redirectStatus) throw error
      const location = String((error as { headers?: Record<string, string | string[] | undefined> }).headers?.['location'] ?? '')
      if (!location) throw new Error(`إعادة توجيه بلا وجهة من ${url.toString()}`)
      url = new URL(location, url)
      continue
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`فشل جلب الصفحة (${response.status})`)
    if (!/(?:text|json|xml|javascript)/i.test(response.contentType)) throw new Error(`نوع المحتوى غير مدعوم: ${response.contentType}`)
    const rawContent = response.body.toString('utf8')
    const content = /html/i.test(response.contentType) ? htmlToText(rawContent) : rawContent
    return success({ url: url.toString(), contentType: response.contentType, bytes: response.body.length, truncated: response.truncated, content })
  }
  throw new Error(`أكثر من ${MAX_REDIRECTS} إعادة توجيه متتالية؛ أُوقف الجلب.`)
}

const webSearchCache = new Map<string, { at: number; results: Array<{ title: string; url: string; snippet: string }> }>()
const WEB_SEARCH_CACHE_MS = 10 * 60_000

async function webSearch(query: string, maxResults: number, signal: AbortSignal, deadlineAt?: number): Promise<string> {
  const trimmed = query.trim()
  if (!trimmed) throw new Error('query لا يمكن أن يكون فارغًا')
  const cacheKey = `${trimmed.slice(0, 300)}:${maxResults}`
  const cached = webSearchCache.get(cacheKey)
  if (cached && Date.now() - cached.at < WEB_SEARCH_CACHE_MS) return success({ query: trimmed, provider: 'cache', results: cached.results.slice(0, maxResults) })
  try {
    const results = await searchDuckDuckGo(trimmed, maxResults, signal, deadlineAt)
    if (results.length) { webSearchCache.set(cacheKey, { at: Date.now(), results }); return success({ query: trimmed, provider: 'DuckDuckGo HTML', results }) }
  } catch { /* ينتقل لمزود بديل */ }
  const results = await searchBing(trimmed, maxResults, signal, deadlineAt)
  if (!results.length) throw new Error('لم يُعد البحث أي نتائج من المزودين المتاحين')
  webSearchCache.set(cacheKey, { at: Date.now(), results })
  return success({ query: trimmed, provider: 'Bing HTML', results })
}

async function searchDuckDuckGo(query: string, maxResults: number, signal: AbortSignal, deadlineAt?: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  let url = new URL('https://html.duckduckgo.com/html/')
  url.searchParams.set('q', query.slice(0, 500))
  let response: PublicHttpsResponse
  try {
    response = await requestPublicHttps(url, 1_000_000, signal, deadlineAt)
  } catch (error) {
    if (!(error instanceof Error) || !(error as { redirectStatus?: number }).redirectStatus) throw error
    const location = String((error as { headers?: Record<string, string | string[] | undefined> }).headers?.['location'] ?? '')
    if (!location) throw error
    url = new URL(location, url)
    response = await requestPublicHttps(url, 1_000_000, signal, deadlineAt)
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`فشل البحث (${response.status})`)
  const html = response.body.toString('utf8')
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const matcher = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a|<div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)(?:<\/a>|<\/div>)/gi
  for (const match of html.matchAll(matcher)) {
    const rawUrl = decodeRedirectUrl(match[1] ?? '')
    if (!/^https:\/\//i.test(rawUrl)) continue
    results.push({ title: htmlToText(match[2] ?? '').slice(0, 300), url: rawUrl, snippet: htmlToText(match[3] ?? '').slice(0, 500) })
    if (results.length >= maxResults) break
  }
  return results
}

async function searchBing(query: string, maxResults: number, signal: AbortSignal, deadlineAt?: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = new URL('https://www.bing.com/search')
  url.searchParams.set('q', query.slice(0, 500))
  const response = await requestPublicHttps(url, 1_500_000, signal, deadlineAt)
  if (response.status < 200 || response.status >= 300) throw new Error(`فشل البحث (${response.status})`)
  const html = response.body.toString('utf8')
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const blockMatcher = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi
  for (const match of html.matchAll(blockMatcher)) {
    const rawUrl = match[1] ?? ''
    if (!/^https:\/\//i.test(rawUrl)) continue
    results.push({ title: htmlToText(match[2] ?? '').slice(0, 300), url: rawUrl, snippet: htmlToText(match[3] ?? '').slice(0, 500) })
    if (results.length >= maxResults) break
  }
  return results
}

interface PublicHttpsResponse { status: number; contentType: string; headers: Record<string, string | string[] | undefined>; body: Buffer; truncated: boolean }

async function requestPublicHttps(url: URL, maxBytes: number, signal: AbortSignal, deadlineAt?: number): Promise<PublicHttpsResponse> {
  const remaining = deadlineAt === undefined ? 30_000 : deadlineAt - Date.now()
  if (remaining <= 0) throw new Error('انتهى الوقت المتاح لطلب الويب')
  const addresses = await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address))) throw new Error('النطاق يشير إلى شبكة محلية أو عنوان غير مسموح')
  const selected = addresses[0]!
  return new Promise((resolve, reject) => {
    let settled = false
    const chunks: Buffer[] = []
    let bytes = 0
    let truncated = false
    let timeout: NodeJS.Timeout
    const cleanup = (): void => { clearTimeout(timeout); signal.removeEventListener('abort', abort) }
    const fail = (error: Error): void => { if (settled) return; settled = true; cleanup(); reject(error) }
    const request = httpsRequest(url, { method: 'GET', headers: { 'user-agent': 'Rahma-Code-Agent/1.0' }, servername: url.hostname, lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family as 4 | 6) }, (response) => {
      const status = response.statusCode ?? 0
      const contentType = String(response.headers['content-type'] ?? '')
      if (status >= 300 && status < 400) { const headers = response.headers as Record<string, string | string[] | undefined>; response.resume(); fail(Object.assign(new Error('REDIRECT'), { redirectStatus: status, headers })); return }
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        const available = maxBytes - bytes
        if (available <= 0) { truncated = true; response.destroy(); return }
        chunks.push(chunk.subarray(0, available)); bytes += Math.min(chunk.length, available)
        if (chunk.length > available) { truncated = true; response.destroy() }
      })
      const finish = (): void => { if (settled) return; settled = true; cleanup(); resolve({ status, contentType, headers: response.headers as Record<string, string | string[] | undefined>, body: Buffer.concat(chunks), truncated }) }
      response.on('end', finish)
      response.on('error', (error) => truncated ? finish() : fail(error))
    })
    const abort = (): void => { request.destroy(new DOMException('تم إلغاء طلب الويب', 'AbortError')) }
    timeout = setTimeout(() => request.destroy(new Error('انتهت مهلة طلب الويب')), Math.min(30_000, remaining))
    signal.addEventListener('abort', abort, { once: true })
    request.on('error', fail)
    request.end()
  })
}

function decodeRedirectUrl(value: string): string {
  try {
    const url = new URL(value, 'https://html.duckduckgo.com')
    const redirected = url.searchParams.get('uddg')
    return redirected ? decodeURIComponent(redirected) : url.toString()
  } catch { return '' }
}

async function gitStatus(cwd: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> { return success(await runGit(['status', '--short', '--branch'], cwd, signal, trackProcess, deadlineAt)) }
async function gitDiff(cwd: string, staged: boolean, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> { return success(await runGit(['diff', '--no-ext-diff', '--unified=3', ...(staged ? ['--staged'] : [])], cwd, signal, trackProcess, deadlineAt)) }
async function gitLog(cwd: string, limit: number, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> { return success(await runGit(['log', `-${limit}`, '--date=iso', '--pretty=format:%h%n%an%n%ad%n%s%n---'], cwd, signal, trackProcess, deadlineAt)) }
async function gitCommit(cwd: string, message: string, all: boolean, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  if (!message.trim()) throw new Error('رسالة commit لا يمكن أن تكون فارغة')
  if (all) await runGit(['add', '--all'], cwd, signal, trackProcess, deadlineAt)
  return success({ output: await runGit(['-c', 'user.name=Rahma Code Agent', '-c', 'user.email=rahma@local', 'commit', '--message', message.slice(0, 500)], cwd, signal, trackProcess, deadlineAt) })
}

async function gitRevert(cwd: string, commit: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  const hash = commit.trim()
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('commit يجب أن يكون hash صالحًا من 7 إلى 40 خانة')
  const output = await runGit(['-c', 'user.name=Rahma Code Agent', '-c', 'user.email=rahma@local', 'revert', '--no-edit', hash], cwd, signal, trackProcess, deadlineAt)
  const revertCommit = (await runGit(['rev-parse', 'HEAD'], cwd, signal, trackProcess, deadlineAt)).trim()
  return success({ reverted: hash, revertCommit, output })
}

async function gitRevertStep(cwd: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  const head = (await runGit(['rev-parse', 'HEAD'], cwd, signal, trackProcess, deadlineAt)).trim()
  const headMessage = (await runGit(['log', '-1', '--pretty=%s'], cwd, signal, trackProcess, deadlineAt)).replace(/^\uFEFF/, '').trim()
  if (!headMessage.startsWith('تلقائي [')) throw new Error('آخر commit ليس تلقائيًا (gitAutoCommit)؛ استخدم git_revert مع hash محدد.')
  const output = await runGit(['-c', 'user.name=Rahma Code Agent', '-c', 'user.email=rahma@local', 'revert', '--no-edit', head], cwd, signal, trackProcess, deadlineAt)
  const revertCommit = (await runGit(['rev-parse', 'HEAD'], cwd, signal, trackProcess, deadlineAt)).trim()
  return success({ revertedStep: head, revertCommit, revertedMessage: headMessage, output })
}

async function deleteFile(target: string, relative: string): Promise<string> {
  const stat = await fs.lstat(target)
  if (stat.isDirectory()) throw new Error('delete_file يحذف الملفات فقط؛ لا يحذف المجلدات.')
  if (stat.isSymbolicLink()) throw new Error('لا يسمح بحذف روابط رمزية عبر delete_file.')
  await fs.rm(target, { force: false })
  return success({ path: relative, deleted: true })
}

async function moveFile(root: string, fromInput: string, toInput: string): Promise<string> {
  const source = await resolveExisting({ canonical: root }, fromInput)
  const sourceStat = await fs.lstat(source.absolute)
  if (sourceStat.isDirectory()) throw new Error('move_file ينقل الملفات فقط؛ لا ينقل المجلدات.')
  if (sourceStat.isSymbolicLink()) throw new Error('لا يسمح بنقل روابط رمزية عبر move_file.')
  const destination = await resolveCreatable({ canonical: root }, toInput)
  if (source.absolute === destination.absolute) throw new Error('المصدر والوجهة متطابقان')
  const existing = await fs.lstat(destination.absolute).catch(() => null)
  if (existing) throw new Error(`الوجهة موجودة بالفعل: ${destination.relative}`)
  await fs.rename(source.absolute, destination.absolute)
  return success({ from: source.relative, to: destination.relative, moved: true })
}

async function appendFile(target: string, relative: string, content: string): Promise<string> {
  if (!content) throw new Error('content لا يمكن أن يكون فارغًا')
  const previous = await readOptionalText(target)
  const next = previous ? `${previous}${previous.endsWith('\n') ? '' : '\n'}${content}` : content
  await writeFileAtomic(target, relative, next)
  return success({ path: relative, appendedBytes: Buffer.byteLength(content), totalBytes: Buffer.byteLength(next) })
}

async function projectTree(directory: string, root: string, maxEntries: number, signal: AbortSignal): Promise<string> {
  const entries: Array<{ path: string; type: 'directory' | 'file'; depth: number }> = []
  let count = 0
  let truncated = false
  const walk = async (current: string, depth: number): Promise<void> => {
    signal.throwIfAborted()
    if (count >= maxEntries) { truncated = true; return }
    const children = await fs.readdir(current, { withFileTypes: true })
    const dirs = children.filter((item) => item.isDirectory() && !item.isSymbolicLink() && !isIgnoredEntry(item.name)).sort((a, b) => a.name.localeCompare(b.name))
    const files = children.filter((item) => item.isFile() && !item.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))
    for (const dir of dirs) {
      if (count >= maxEntries) { truncated = true; return }
      entries.push({ path: relativePath(root, path.join(current, dir.name)), type: 'directory', depth })
      count++
      await walk(path.join(current, dir.name), depth + 1)
    }
    for (const file of files) {
      if (count >= maxEntries) { truncated = true; return }
      entries.push({ path: relativePath(root, path.join(current, file.name)), type: 'file', depth })
      count++
    }
  }
  await walk(directory, 0)
  return success({ path: relativePath(root, directory), totalEntries: entries.length, truncated, entries })
}

async function gitBranch(cwd: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> { return success({ output: await runGit(['branch', '--list'], cwd, signal, trackProcess, deadlineAt) }) }

async function gitShow(cwd: string, spec: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> { return success({ output: await runGit(['show', '--no-ext-diff', '--unified=3', spec.trim().slice(0, 500)], cwd, signal, trackProcess, deadlineAt) }) }

async function gitAdd(cwd: string, files: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  const paths = [...new Set(files.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
  if (!paths.length) throw new Error('files لا يمكن أن يكون فارغًا')
  return success({ output: await runGit(['add', '--', ...paths.slice(0, 100)], cwd, signal, trackProcess, deadlineAt) })
}

async function gitFetch(cwd: string, remote: string | undefined, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  return success({ output: await runGit(['fetch', '--prune', ...(remote ? [remote] : [])], cwd, signal, trackProcess, deadlineAt) })
}

async function gitPull(cwd: string, remote: string | undefined, branch: string | undefined, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  return success({ output: await runGit(['pull', ...(remote ? [remote] : []), ...(branch ? [branch] : [])], cwd, signal, trackProcess, deadlineAt) })
}

async function gitPush(cwd: string, remote: string | undefined, branch: string | undefined, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  return success({ output: await runGit(['push', ...(remote ? [remote] : []), ...(branch ? [branch] : [])], cwd, signal, trackProcess, deadlineAt) })
}

async function gitCheckpoint(cwd: string, requested: string | undefined, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  const name = sanitizeGitRef(requested || `rahma/checkpoint-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  return success({ branch: name, output: await runGit(['branch', name], cwd, signal, trackProcess, deadlineAt) })
}

async function gitIsolateBranch(cwd: string, requested: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  const name = sanitizeGitRef(requested)
  return success({ branch: name, output: await runGit(['switch', '-c', name], cwd, signal, trackProcess, deadlineAt) })
}

function sanitizeGitRef(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._/-]/g, '-').replace(/^[-/.]+|[-/.]+$/g, '')
  if (!normalized || normalized.startsWith('-') || normalized.includes('..')) throw new Error('اسم فرع Git غير صالح')
  return normalized.slice(0, 180)
}

async function gitRestore(cwd: string, file: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  if (!file.trim()) throw new Error('file لا يمكن أن يكون فارغًا')
  return success({ output: await runGit(['restore', '--', file.trim().slice(0, 1000)], cwd, signal, trackProcess, deadlineAt) })
}

async function gitCheckout(cwd: string, branch: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  if (!branch.trim()) throw new Error('branch لا يمكن أن يكون فارغًا')
  return success({ output: await runGit(['checkout', branch.trim().slice(0, 500)], cwd, signal, trackProcess, deadlineAt) })
}

async function gitReset(cwd: string, mode: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  if (!['soft', 'mixed'].includes(mode)) throw new Error('mode يجب أن يكون soft أو mixed فقط؛ يمنع --hard نهائيًا')
  return success({ output: await runGit(['reset', mode === 'soft' ? '--soft' : '--mixed', 'HEAD'], cwd, signal, trackProcess, deadlineAt) })
}

async function runGit(args: string[], cwd: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git.exe', args, { cwd, windowsHide: true, env: safeEnvironment() })
    trackProcess?.(child)
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const append = (chunk: Buffer): void => { if (bytes >= MAX_OUTPUT_BYTES) return; const remaining = MAX_OUTPUT_BYTES - bytes; chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining) }
    const kill = (): void => { if (!child.killed) child.kill() }
    const abort = (): void => kill()
    signal.addEventListener('abort', abort, { once: true })
    const remaining = deadlineAt === undefined ? 60_000 : deadlineAt - Date.now()
    if (remaining <= 0) { kill(); reject(new Error('انتهى الوقت المتاح لـ Git')); return }
    const timeout = setTimeout(kill, Math.min(60_000, remaining))
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (error) => { if (settled) return; settled = true; cleanup(); reject(error) })
    child.on('close', (code) => { if (settled) return; settled = true; cleanup(); const output = Buffer.concat(chunks).toString('utf8'); if (signal.aborted) reject(new DOMException('تم إلغاء Git', 'AbortError')); else if (code !== 0) reject(new Error(`فشل Git (${code ?? -1}): ${output.slice(0, 4000)}`)); else resolve(output) })
    function cleanup(): void { clearTimeout(timeout); signal.removeEventListener('abort', abort) }
  })
}

export interface AutoCommitResult { enabled: true; committed: boolean; commit?: string; paths: string[]; error?: string; deferred?: boolean }

async function maybeAutoCommit(context: ToolContext, repoRoot: string, action: string, relatives: string[]): Promise<AutoCommitResult | undefined> {
  if (!context.session.gitTracked) return undefined
  const paths = [...new Set(relatives)].filter((item) => item && item !== '.')
  if (!paths.length) return { enabled: true, committed: false, paths, error: 'لا توجد مسارات قابلة للحفظ' }
  if (context.deferAutoCommit) {
    context.deferAutoCommit(action, paths)
    return { enabled: true, committed: false, paths, deferred: true }
  }
  return commitAutoChanges(context, repoRoot, action, paths)
}

export async function commitAutoChanges(context: ToolContext, repoRoot: string, action: string, relatives: string[]): Promise<AutoCommitResult | undefined> {
  if (!context.session.gitTracked) return undefined
  const paths = [...new Set(relatives)].filter((item) => item && item !== '.')
  if (!paths.length) return { enabled: true, committed: false, paths, error: 'لا توجد مسارات قابلة للحفظ' }
  try {
    const gitOptions = { signal: context.signal, timeoutMs: 30_000, trackProcess: context.trackProcess }
    await runGitQuiet(['add', '--all', '--', ...paths], repoRoot, gitOptions)
    await runGitQuiet(['-c', 'user.name=Rahma Code Agent', '-c', 'user.email=rahma@local', 'commit', '--only', '--message', `تلقائي [${action}] ${paths.join(', ')}`.slice(0, 200), '--', ...paths], repoRoot, gitOptions)
    return { enabled: true, committed: true, commit: (await runGitQuiet(['rev-parse', 'HEAD'], repoRoot, gitOptions)).trim(), paths }
  } catch (error) { return { enabled: true, committed: false, paths, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) } }
}

export function withAutoCommit(output: string, gitAutoCommit: AutoCommitResult | undefined): string {
  if (!gitAutoCommit) return output
  try { const parsed = JSON.parse(output) as { ok?: boolean; data?: unknown }; if (parsed.ok && parsed.data && typeof parsed.data === 'object') return success({ ...(parsed.data as Record<string, unknown>), gitAutoCommit }) } catch {}
  return output
}

export async function ensureGitRepository(workspace: string): Promise<{ initialized: boolean; committed: boolean; gitignore: boolean }> {
  const root = await canonicalWorkspace(workspace)
  const gitignorePath = path.join(root.canonical, '.gitignore')
  let gitignore = false
  try { await fs.access(gitignorePath) } catch { await fs.writeFile(gitignorePath, 'node_modules\nout\ndist\nrelease-*\ndist-v*\nwin-unpacked*\n*.tmp\n*.log\n.DS_Store\n', 'utf8'); gitignore = true }
  let initialized = false
  try { await fs.access(path.join(root.canonical, '.git')) } catch {
    await runGitQuiet(['init', '-b', 'main'], root.canonical, { timeoutMs: 120_000 })
    initialized = true
  }
  let committed = false
  try {
    await runGitQuiet(['add', '--all'], root.canonical, { timeoutMs: 120_000 })
    await runGitQuiet(['-c', 'user.name=Rahma Code Agent', '-c', 'user.email=rahma@local', 'commit', '--allow-empty', '--message', 'بداية المشروع: قاعدة أولية'], root.canonical, { timeoutMs: 120_000 })
    committed = true
  } catch { /* commit أولي اختياري */ }
  return { initialized, committed, gitignore }
}

async function runGitQuiet(args: string[], cwd: string, options: { signal?: AbortSignal; timeoutMs?: number; trackProcess?: (child: import('child_process').ChildProcess) => void } = {}): Promise<string> {
  const { signal, timeoutMs = 30_000, trackProcess } = options
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('تم إلغاء Git', 'AbortError')); return }
    const child = spawn('git.exe', args, { cwd, windowsHide: true, env: safeEnvironment() })
    trackProcess?.(child)
    const chunks: Buffer[] = []
    let settled = false
    let timedOut = false
    const cleanup = (): void => { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
    const abort = (): void => { if (!child.killed) child.kill() }
    const timeout = setTimeout(() => { timedOut = true; if (!child.killed) child.kill() }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', (error) => { if (settled) return; settled = true; cleanup(); reject(error) })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true; cleanup()
      const output = Buffer.concat(chunks).toString('utf8')
      if (signal?.aborted) reject(new DOMException('تم إلغاء Git', 'AbortError'))
      else if (timedOut) reject(new Error(`انتهت مهلة Git التلقائي (${timeoutMs}ms): ${output.slice(0, 500)}`))
      else if (exitCode === 0) resolve(output)
      else reject(new Error(output.slice(0, 2000)))
    })
  })
}

export function isBlockedHost(host: string): boolean { const value = host.toLowerCase().replace(/^\[|\]$/g, ''); return value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || Boolean(isIP(value) && isBlockedAddress(value)) }
export function isBlockedAddress(address: string): boolean {
  const value = (address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '')
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1]
  if (mapped) return isBlockedAddress(mapped)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value)
  if (mappedHex) { const high = Number.parseInt(mappedHex[1]!, 16); const low = Number.parseInt(mappedHex[2]!, 16); return isBlockedAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`) }
  if (isIP(value) === 4) {
    const parts = value.split('.').map(Number); const first = parts[0] ?? 0; const second = parts[1] ?? 0
    return first === 0 || first === 10 || first === 127 || first >= 224 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first === 100 && second >= 64 && second <= 127 || first === 198 && (second === 18 || second === 19)
  }
  if (isIP(value) === 6) {
    if (value === '::' || value === '::1') return true
    const first = Number.parseInt(value.split(':')[0] || '0', 16)
    return first >= 0xfc00 && first <= 0xfdff || first >= 0xfe80 && first <= 0xfebf || first >= 0xff00
  }
  return true
}
function htmlToText(value: string): string { return decodeHtmlEntities(value.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim() }
function decodeHtmlEntities(value: string): string { const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }; return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => { if (entity[0] === '#') { const hex = entity[1]?.toLowerCase() === 'x'; const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10); return Number.isFinite(code) ? String.fromCodePoint(code) : ' ' } return named[entity.toLowerCase()] ?? ' ' }) }

function isSensitive(value: string): boolean { const normalized = value.replaceAll('\\', '/'); return /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|ed25519)|credentials|auth\.json|provider\.json|kubeconfig)(?:$|\/)/i.test(normalized) || /(?:^|\/)(?:\.ssh|\.aws|\.azure)(?:\/|$)/i.test(normalized) }
function isCriticalCommand(command: string): boolean { return /(?:Remove-Item\s+.*(?:-Recurse|-Force)|Format-Volume|Clear-Disk|Stop-Computer|Restart-Computer|Set-MpPreference|reg(?:\.exe)?\s+delete|diskpart|bcdedit|cipher\s+\/w|taskkill\s+.*\/f)/i.test(command) }
function safeEnvironment(): NodeJS.ProcessEnv { return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } }
function success(data: unknown): string { return JSON.stringify({ ok: true, data }, null, 2) }
function failure(code: string, message: string): string { return JSON.stringify({ ok: false, error: { code, message } }, null, 2) }
function requiredString(value: unknown, field: string): string { if (typeof value !== 'string') throw new Error(`${field} يجب أن يكون نصًا`); return value }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function number(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number { const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback; return Math.min(max, Math.max(min, parsed)) }
function globRegex(pattern: string): RegExp { let source = '^'; for (let i = 0; i < pattern.length; i++) { const char = pattern[i]!; if (char === '*') { if (pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?' } else source += '.*' } else source += '[^/]*' } else if (char === '?') source += '[^/]' ; else source += escapeRegex(char) } return new RegExp(`${source}$`, 'i') }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition { return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } } }
function str(description: string): Record<string, unknown> { return { type: 'string', description } }
function arr(description: string): Record<string, unknown> { return { type: 'array', description } }
function bool(description: string): Record<string, unknown> { return { type: 'boolean', description } }
function integer(description: string, minimum: number, maximum?: number): Record<string, unknown> { return { type: 'integer', description, minimum, ...(maximum ? { maximum } : {}) } }
