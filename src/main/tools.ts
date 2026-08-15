import { constants, createReadStream, promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { DevServerState, MutationReceipt, Session, Todo } from '../shared/types'
import type { ToolDefinition } from './provider'
import type { McpToolExecutor } from './mcp'
import { getProjectIndexer, syntaxDiagnostics, type ProjectIndexer } from './code-intelligence'
import type { ProjectMemory, MemoryCategory } from './memory'

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && (error.name === 'AbortError' || /(?:cancel|abort|إلغاء|أُلغي)/i.test(error.message))
}

// ─── نظام رسائل الخطأ الذكي ─────────────────────────────────────────
// يوفر معلومات تفصيلية للمبرمج لفهم سبب الخطأ وحله

interface ToolError {
  code: string
  message: string
  suggestion: string
  context?: Record<string, unknown>
}

function createToolError(code: string, message: string, suggestion: string, context?: Record<string, unknown>): string {
  const error: ToolError = { code, message, suggestion, context }
  return JSON.stringify({ ok: false, error }, null, 2)
}

// رسائل خطأ edit_file الذكية
const EDIT_FILE_ERRORS = {
  EMPTY_OLD_STRING: {
    code: 'EMPTY_OLD_STRING',
    message: 'old_string فارغ',
    suggestion: 'حدد النص القديم الذي تريد استبداله. اقرأ الملف أولًا لتحديد النص الدقيق.'
  },
  NO_MATCH: {
    code: 'NO_MATCH',
    message: 'لم يتم العثور على تطابق للنص المحدد',
    suggestion: 'تحقق من: 1) النص موجود بالضبط كما هو 2) لا توجد مسافات أو tabs إضافية 3) اقرأ الملف مجددًا للحصول على النص الحالي'
  },
  MULTIPLE_MATCHES: {
    code: 'MULTIPLE_MATCHES',
    message: 'النص المطابق موجود في عدة أماكن',
    suggestion: 'اجعل old_string أطول وأكثر تحديدًا لضمان تطابق واحد فقط. أضف سطور محيطة للتحديد.'
  },
  FILE_NOT_FOUND: {
    code: 'FILE_NOT_FOUND',
    message: 'الملف غير موجود',
    suggestion: 'استخدم glob_files أو list_directory لاكتشاف الملفات المتاحة. تأكد من المسار الصحيح.'
  },
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    message: 'ليس لديك صلاحية للوصول للملف',
    suggestion: 'تحقق من صلاحيات الملف أو تواصل مع المسؤول.'
  }
}

// رسائل خطأ shell الذكية
const SHELL_ERRORS = {
  COMMAND_NOT_FOUND: {
    code: 'COMMAND_NOT_FOUND',
    message: 'الأمر غير موجود',
    suggestion: 'تأكد من تثبيت الأداة أو استخدم npm/npx لتشغيل الأوامر المحلية.'
  },
  SYNTAX_ERROR: {
    code: 'SYNTAX_ERROR',
    message: 'خطأ في صيغة الأمر',
    suggestion: 'راجع صيغة الأمر وتأكد من صحة الأقواس والفواصل.'
  },
  TIMEOUT: {
    code: 'TIMEOUT',
    message: 'تجاوز الوقت المحدد للأمر',
    suggestion: 'قسم المهمة إلى خطوات أصغر أو زد المهلة الزمنية.'
  }
}

// رسائل خطأ git الذكية
const GIT_ERRORS = {
  NOT_A_REPOSITORY: {
    code: 'NOT_A_REPOSITORY',
    message: 'المجلد ليس مستودع git',
    suggestion: 'استخدم git_init لإنشاء مستودع جديد أو افتح مجلدًا يحتوي على مستودع.'
  },
  CONFLICT: {
    code: 'CONFLICT',
    message: 'تعارض في الدمج',
    suggestion: 'حل التعارضات يدويًا أو استخدم git_revert للتراجع.'
  },
  NOTHING_TO_COMMIT: {
    code: 'NOTHING_TO_COMMIT',
    message: 'لا توجد تغييرات للحفظ',
    suggestion: 'تأكد من أنك عدّلت ملفات قبل محاولة الحفظ.'
  }
}

const MAX_READ_LINES = 5_000
const MAX_OUTPUT_BYTES = 100_000
const READ_OUTPUT_BYTES = 600_000
const MAX_SEARCH_RESULTS = 500
const MAX_GLOB_RESULTS = 2_000

// ─── Per-tool timeout for directory-walking tools ─────────────────────
const TOOL_TIMEOUT_MS = 30_000 // 30 ثانية لكل أداة قراءة
const TOOLS_WITH_TIMEOUT = new Set(['count_lines', 'search_symbols', 'search_files', 'glob_files', 'tree', 'read_files'])

function createToolTimeoutSignal(parentSignal: AbortSignal): { signal: AbortSignal; clear: () => void } {
  if (parentSignal.aborted) return { signal: parentSignal, clear: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS)
  const onParentAbort = (): void => { clearTimeout(timer); controller.abort() }
  parentSignal.addEventListener('abort', onParentAbort, { once: true })
  return {
    signal: controller.signal,
    clear: () => { clearTimeout(timer); parentSignal.removeEventListener('abort', onParentAbort) }
  }
}

// ─── File Content Cache ────────────────────────────────────────────────
// يتجنب إعادة قراءة نفس الملفات غير المتغيرة ويوفر الرموز والنطاق الترددي
// تحسين: LRU بدل FIFO — الملفات الأكثر استخدامًا تبقى في الكاش
const fileCache = new Map<string, { mtimeMs: number; size: number; sha256: string; content: string; cachedAt: number; bytes: number }>()
const FILE_CACHE_MAX_ENTRIES = 300
const FILE_CACHE_MAX_CONTENT = 2_000_000
/** سقف إجمالي صارم بالبايت — بدون هذا الحد يمكن أن يبلغ الكاش 600MB في المشاريع الكبيرة */
const FILE_CACHE_MAX_TOTAL_BYTES = 120_000_000
const FILE_CACHE_TTL_MS = 5 * 60_000 // 5 دقائق
let fileCacheTotalBytes = 0

function dropFileCacheEntry(absPath: string): void {
  const cached = fileCache.get(absPath)
  if (cached) fileCacheTotalBytes -= cached.bytes
  fileCache.delete(absPath)
}

async function getCachedFile(absPath: string): Promise<{ content: string; sha256: string; size: number } | null> {
  const cached = fileCache.get(absPath)
  if (!cached) return null
  if (Date.now() - cached.cachedAt > FILE_CACHE_TTL_MS) { dropFileCacheEntry(absPath); return null }
  try {
    const stat = await fs.stat(absPath)
    if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
      // تحسين LRU: نحذف ثم نعيد الإدراج لتحديث ترتيب الوصول (الأحدث في النهاية)
      // (حذف عادي دون خصم البايتات — المدخل يُعاد فورًا بنفس الحجم)
      fileCache.delete(absPath)
      fileCache.set(absPath, cached)
      return { content: cached.content, sha256: cached.sha256, size: cached.size }
    }
  } catch { /* file deleted or inaccessible */ }
  dropFileCacheEntry(absPath)
  return null
}

async function setCachedFile(absPath: string, content: string): Promise<void> {
  if (content.length > FILE_CACHE_MAX_CONTENT) return
  if (fileCache.has(absPath)) dropFileCacheEntry(absPath)
  try {
    const stat = await fs.stat(absPath)
    const sha256 = createHash('sha256').update(content).digest('hex')
    const bytes = Buffer.byteLength(content, 'utf8')
    // تحسين LRU: حذف أقدم المدخلات حتى يتسع الكاش ضمن حدّي العدد وإجمالي البايتات
    while (fileCache.size >= FILE_CACHE_MAX_ENTRIES || fileCacheTotalBytes + bytes > FILE_CACHE_MAX_TOTAL_BYTES) {
      const first = fileCache.keys().next().value
      if (!first) break
      dropFileCacheEntry(first)
    }
    fileCacheTotalBytes += bytes
    fileCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, sha256, content, cachedAt: Date.now(), bytes })
  } catch { /* file inaccessible */ }
}

/** إبطال الكاش لملف بعد تعديله */
export function invalidateFileCache(absPath: string): void {
  dropFileCacheEntry(absPath)
}

export const toolDefinitions: ToolDefinition[] = [
  tool('read_file', 'اقرأ ملفًا نصيًا مع أرقام الأسطر وعددها الإجمالي. حتى 5000 سطر افتراضيًا؛ اقرأ الملفات الصغيرة كاملة لتفهمها، واستخدم offset/limit لنطاق محدد أو عندما تعيد النتيجة truncated=true.', { path: str('مسار الملف'), offset: integer('أول سطر، يبدأ من 1', 1), limit: integer('عدد الأسطر، الافتراضي والأقصى 5000', 1, MAX_READ_LINES) }, ['path']),
  tool('read_files', 'اقرأ عدة ملفات كاملة في استدعاء واحد. مرر paths كمصفوفة مسارات (ويقبل أيضًا نصًا مفصولًا بأسطر للتوافق)، أو path لملف واحد، أو include للبحث بنمط glob. تعيد nextCursor إن لم تتسع كل الملفات.', { paths: stringOrArray('مصفوفة مسارات، أو مسارات مفصولة بأسطر جديدة'), path: str('مسار ملف واحد (بديل لـ paths)'), include: str('glob مثل **/*.java'), cursor: str('مؤشر متابعة تعيده الأداة'), max_files: integer('أقصى ملفات في الدفعة', 1, 100) }, []),
  tool('read_message', 'استرجع رسالة سابقة كاملة من سجل هذه الجلسة بمعرّفها id. لاستعادة محتوى أو نتيجة أداة ضُغطت في سياق سابق.', { id: str('معرّف الرسالة') }, ['id']),
  tool('load_skill', 'حمّل مهارة (Skill) من مجلد .skills أو .opencode/skills أو skills بقراءة SKILL.md. أعد النص الكامل للمهارة مع وصفها.', { name: str('اسم المهارة (اسم مجلدها)'), max_chars: integer('حد أقصى للأحرف', 1000, 100000) }, ['name']),
  tool('task', 'أطلق وكيلًا فرعيًا مستقلًا في سياق معزول تمامًا (لا يشارك سياقك). مثالي للمشاريع الكبيرة: قسّم العمل إلى مهام لكل منها هدف واضح، ويعيد خلاصة مركزة. أنت المشرف المسؤول عن دقة النتيجة؛ اصنع المهام بدقة، أدمج الخلاصات، وطبّق قراراتك بنفسك.', { prompt: str('المهمة بالتفصيل: التحليل المطلوب، الملفات المستهدفة، الأسئلة، ومواصفات الخلاصة'), description: str('وصف مختصر (سطر واحد) يظهر للمستخدم'), subagentName: str('اسم وكيل مخصص من صفحة الوكلاء (اختياري)') }, ['prompt', 'description']),
  tool('task_parallel', 'أطلق 1-3 وكلاء فرعيين متوازيين في سياقات معزولة، كلٌّ يعمل على جزء منفصل من المهمة ولا يرى محادثتك.', { tasks: arr('مصفوفة المهام', objectSchema({ prompt: str('المهمة بالتفصيل'), description: str('وصف مختصر'), subagentName: str('اسم وكيل مخصص اختياري') }, ['prompt', 'description']), 1, 3) }, ['tasks']),
  tool('todo_write', 'حدّث خطة العمل (Todos) لهذه الجلسة. items مصفوفة كاملة تحل محل القائمة السابقة.', { items: arr('مصفوفة المهام', objectSchema({ content: str('نص المهمة'), status: enumString(['pending', 'in_progress', 'completed', 'cancelled']), priority: enumString(['high', 'medium', 'low']) }, ['content']), 0, 100) }, ['items']),
  tool('todo_read', 'اقرأ خطة العمل (Todos) الحالية لهذه الجلسة.', {}, []),
  tool('run_command', 'نفّذ أمرًا معرفًا (Slash Command) من ملف commands.json في مساحة العمل. يستبدل القالب بالوسائط المعطاة ويعيد النص الناتج لتنفيذه. استخدمه عندما يطلب المستخدم أمرًا معرفًا مثل /review أو /test أو /init. تحقق أولًا من وجود commands.json في مساحة العمل (استخدم glob_files أو list_directory)؛ إذا غير موجود فالأمر سيفشل.', { name: str('اسم الأمر'), arguments: str('الوسائط (اختياري)') }, ['name']),
  tool('count_lines', 'احسب عدد أسطر ملف نصي أو مجلد بالكامل. يدعم مجلدات recursion ويحصّل كل ملفات نصية.', { path: str('مسار الملف أو المجلد'), include: str('glob مثل *.java أو *.xml لتصفيتها'), limit: integer('حد أقصى للنتائج (يتجاهل)', 1, 10000) }, ['path']),
  tool('list_directory', 'اعرض محتويات مجلد.', { path: str('المجلد، الافتراضي الجذر'), limit: integer('أقصى عدد عناصر', 1, 1000) }, []),
  tool('glob_files', 'ابحث عن ملفات بنمط glob مثل **/*.ts.', { path: str('مجلد البداية، الافتراضي الجذر'), pattern: nonEmptyString('نمط glob'), limit: integer('أقصى عدد نتائج', 1, MAX_GLOB_RESULTS) }, ['pattern']),
  tool('search_files', 'ابحث نصيًا داخل ملف محدد أو ملفات مجلد، وأعد file:line:column.', { path: str('ملف محدد أو مجلد بداية، الافتراضي الجذر'), pattern: nonEmptyString('نص أو regex'), include: str('glob اختياري مثل *.ts عند البحث في مجلد'), fixed_strings: bool('اعتبر النمط نصًا حرفيًا'), case_sensitive: bool('بحث حساس لحالة الأحرف'), limit: integer('أقصى عدد نتائج', 1, MAX_SEARCH_RESULTS) }, ['pattern']),
  tool('search_symbols', 'ابحث عن رموز برمجية (دوال، أصناف، واجهات، متغيرات عامة) في المشروع وأعدها مع أرقام الأسطر. مفيد لتتبع التعريفات في المشاريع الكبيرة دون قراءة كل ملف.', { path: str('مجلد البداية، الافتراضي الجذر'), query: nonEmptyString('اسم الرمز أو جزء منه (غير حساس لحالة الأحرف)'), limit: integer('أقصى عدد نتائج', 1, MAX_SEARCH_RESULTS) }, ['query']),
  tool('write_file', 'أنشئ ملفًا أو استبدل محتواه بالكامل. أرسل path وcontent معًا في نفس استدعاء الأداة. content يجب أن يكون النص الفعلي الكامل للملف؛ لا تستدع الأداة إذا لم تكن قد جهزت المحتوى، ولا ترسل وصفًا أو وعدًا أو contentReceipt بدل النص.', { path: str('مسار الملف النسبي'), content: str('النص الفعلي الكامل الذي سيكتب حرفيًا داخل الملف؛ حقل إلزامي ولا يجوز حذفه أو تأجيله') }, ['path', 'content']),
  tool('edit_file', 'عدّل جزءًا محددًا من ملف نصي باستبدال تطابق وحيد آمن. اقرأ الملف أولًا واستخدم نصًا قديمًا غير فارغ ومحددًا بما يكفي.', { path: str('مسار الملف'), old_string: nonEmptyString('النص الحالي المطلوب استبداله'), new_string: str('النص الجديد، ويمكن أن يكون فارغًا للحذف') }, ['path', 'old_string', 'new_string']),
  tool('edit_files_bulk', 'عدّل 1-20 ملفًا مختلفًا في استدعاء واحد ذري قدر الإمكان. فضّلها على استدعاءات edit_file المتعددة عندما تكون كل الاستبدالات جاهزة ومستقلة؛ تفحص الدفعة كاملة قبل الكتابة ولا تكتب شيئًا عند فشل الفحص.', { edits: arr('تعديلات على ملفات مختلفة', objectSchema({ path: str('مسار الملف'), old_string: nonEmptyString('النص القديم ذو التطابق الوحيد'), new_string: str('النص الجديد، ويمكن أن يكون فارغًا للحذف') }, ['path', 'old_string', 'new_string']), 1, 20) }, ['edits']),
  tool('edit_file_undo', 'أعد آخر تعديل تم على الملف الأقرب (سهم الإرجاع). يُرجع المحتوى كما كان بالضبط قبل آخر edit_file. لا يحتاج أي معلمات.', {}, []),
  tool('patch_file', 'عدّل عدة مواضع في ملف واحد في استدعاء واحد. تُطبَّق من الأسفل للأعلى، وتُرفض المتداخلة. اقرأ الملف أولًا؛ استخدم end_line=start_line-1 للإدراج دون حذف.', { path: str('مسار الملف'), patches: arr('رقع الأسطر', objectSchema({ start_line: integer('أول سطر، يبدأ من 1', 1), end_line: integer('آخر سطر؛ أقل من start_line بواحد للإدراج', 0), new_lines: stringOrArray('النص الجديد أو مصفوفة أسطر'), expected: str('النص الحالي المتوقع اختياريًا') }, ['start_line', 'end_line', 'new_lines']), 1, 100) }, ['path', 'patches']),
  tool('create_directory', 'أنشئ مجلدًا.', { path: str('مسار المجلد') }, ['path']),
  tool('get_file_info', 'أعد معلومات ملف أو مجلد مع عدد الأسطر.', { path: str('المسار') }, ['path']),
  tool('web_fetch', 'اجلب صفحة HTTPS عامة. يمنع localhost ويتطلب موافقة. الحد الزمني 30 ثانية.', { url: nonEmptyString('رابط HTTPS عام كامل'), max_bytes: integer('حد المحتوى', 1000, 500000) }, ['url']),
  tool('web_search', 'ابحث في الويب عن معلومات حديثة وأعد روابط HTTPS وعناوين ومقتطفات. للمواضيع التقنية ابحث أيضًا بالمصطلحات الإنجليزية للحصول على نتائج أدق، واتبع النتيجة الأفضل عبر web_fetch أو استخدم web_research مباشرة.', { query: nonEmptyString('عبارة البحث'), max_results: integer('أقصى عدد نتائج', 1, 10) }, ['query']),
  tool('web_research', 'بحث ويب معمّق في استدعاء واحد: يبحث ثم يفتح أفضل النتائج تلقائيًا ويعيد إجابة جاهزة (إن توفرت) ونصوصًا نظيفة من الصفحات مع مصادرها. فضّله على web_search + web_fetch اليدوي عندما تحتاج معلومات دقيقة وحديثة.', { query: nonEmptyString('عبارة البحث — اجعلها دقيقة، وابحث باللغتين العربية والإنجليزية للمواضيع التقنية'), max_results: integer('أقصى عدد مصادر معادة', 1, 8), fetch_pages: integer('عدد الصفحات التي تُفتح وتُقرأ تلقائيًا', 0, 4) }, ['query']),
  tool('git_status', 'اعرض حالة مستودع Git داخل مساحة العمل.', { path: str('مجلد المستودع، الافتراضي الجذر') }, []),
  tool('git_diff', 'اعرض الفرق الحالي في مستودع Git دون تنفيذ تغيير.', { path: str('مجلد المستودع، الافتراضي الجذر'), staged: bool('اعرض التغييرات المرحّلة فقط') }, []),
  tool('git_log', 'اعرض آخر commits في مستودع Git.', { path: str('مجلد المستودع، الافتراضي الجذر'), limit: integer('عدد commits', 1, 50) }, []),
  tool('delete_file', 'احذف ملفًا واحدًا نهائيًا داخل مساحة العمل. يرفض حذف المجلدات، ويتطلب موافقة صريحة دائمًا.', { path: str('مسار الملف') }, ['path']),
  tool('move_file', 'انقل أو أعد تسمية ملف داخل مساحة العمل. الوجهة يجب أن تكون داخل المساحة.', { from: str('المسار الحالي'), to: str('المسار الجديد') }, ['from', 'to']),
  tool('append_file', 'أضف نصًا إلى نهاية ملف نصي (أو أنشئه إن لم يوجد). يبقي المحتوى السابق كما هو.', { path: str('مسار الملف'), content: str('النص المضاف') }, ['path', 'content']),
  tool('tree', 'اعرض شجرة بنية المشروع داخل مساحة العمل مع تجاهل مجلدات البناء تلقائيًا.', { path: str('مجلد البداية، الافتراضي الجذر'), max_entries: integer('أقصى عدد عناصر', 1, 2000), limit: integer('حد أقصى للنتائج (يتجاهل)', 1, 10000) }, []),
  tool('git_branch', 'اعرض الفروع المحلية للريبو الحالي.', { path: str('مجلد المستودع، الافتراضي الجذر') }, []),
  tool('git_show', 'اعرض محتوى commit أو ملف من ريفزيون معين مثل HEAD أو HEAD~1 أو commit:file.', { path: str('مجلد المستودع، الافتراضي الجذر'), spec: nonEmptyString('المواصفة مثل HEAD أو commit-hash أو commit:path؛ ليست خيارًا يبدأ بشرطة') }, ['spec']),
  tool('git_add', 'أضف ملفات إلى منطقة staging في الريبو (لا ينشئ commit).', { path: str('مجلد المستودع، الافتراضي الجذر'), files: str('مسارات مفصولة بأسطر جديدة، أو "." للكل') }, ['files']),
  tool('git_fetch', 'اجلب تحديثات الفروع البعيدة دون دمجها.', { path: str('مجلد المستودع، الافتراضي الجذر'), remote: str('اسم remote اختياري') }, []),
  tool('git_pull', 'اجلب وادمج تحديثات الفرع الحالي من remote.', { path: str('مجلد المستودع، الافتراضي الجذر'), remote: str('اسم remote اختياري'), branch: str('اسم الفرع اختياري') }, []),
  tool('git_push', 'ادفع commits الفرع الحالي إلى remote.', { path: str('مجلد المستودع، الافتراضي الجذر'), remote: str('اسم remote اختياري'), branch: str('اسم الفرع اختياري') }, []),
  tool('git_checkpoint', 'أنشئ نقطة رجوع محلية باسم فرع آمن عند HEAD الحالي.', { path: str('مجلد المستودع، الافتراضي الجذر'), name: str('اسم checkpoint اختياري') }, []),
  tool('git_isolate_branch', 'أنشئ فرع عمل معزولًا للمهمة الحالية وانتقل إليه.', { path: str('مجلد المستودع، الافتراضي الجذر'), name: nonEmptyString('اسم الفرع') }, ['name']),
  tool('git_restore', 'استعد ملفًا من HEAD (يُلغي تغييراته غير الملتزمة نهائيًا). يتطلب موافقة صريحة دائمًا.', { path: str('مجلد المستودع، الافتراضي الجذر'), file: str('مسار الملف بالنسبة لمسار المستودع') }, ['file']),
  tool('git_checkout', 'بدّل إلى فرع موجود في الريبو.', { path: str('مجلد المستودع، الافتراضي الجذر'), branch: nonEmptyString('اسم الفرع، وليس خيارًا يبدأ بشرطة') }, ['branch']),
  tool('git_reset', 'ألغِ الترحيل إلى HEAD (mixed) أو حرّك HEAD دون لمس الملفات (soft). يرفض --hard نهائيًا.', { path: str('مجلد المستودع، الافتراضي الجذر'), mode: str('soft أو mixed، الافتراضي mixed') }, []),
  tool('git_commit', 'أنشئ commit في المستودع الحالي. يتطلب موافقة صريحة دائمًا حتى في وضع الوصول الكامل.', { path: str('مجلد المستودع، الافتراضي الجذر'), message: str('رسالة commit'), all: bool('أضف كل التغييرات قبل commit') }, ['message']),
  tool('git_revert', 'تراجع بأمان عن commit محدد بإنشاء revert commit جديد. استخدم hash الذي أعادته gitAutoCommit، ويتطلب موافقة صريحة دائمًا.', { path: str('مجلد المستودع، الافتراضي الجذر'), commit: str('hash كامل أو مختصر للـcommit') }, ['commit']),
  tool('git_revert_step', 'ألغِ آخر خطوة تنفيذ كاملة: يسترجع كل التعديلات التي حُفظت في آخر commit تلقائي (gitAutoCommit) بإنشاء revert commit واحد، دون لمس التغييرات غير الملتزمة. يتطلب موافقة صريحة دائمًا.', { path: str('مجلد المستودع، الافتراضي الجذر') }, []),
  tool('run_powershell', 'شغّل أمر PowerShell مع مهلة وحد مخرجات. يتطلب موافقة. المهلة حتى 10 دقائق. لا يحتفظ بحالة بين الأوامر.', { command: str('الأمر الكامل'), cwd: str('مجلد التشغيل داخل مساحة العمل'), timeout_ms: integer('المهلة بالمللي ثانية', 1000, 600000) }, ['command']),
  tool('shell', 'نفّذ أمر PowerShell في shell دائم خاص بهذه الجلسة يحتفظ تلقائيًا بـ cwd والبيئة بين الأوامر. أسرع لسلاسل الأوامر المتتابعة (بناء/اختبار متكرر). يبدأ في جذر مساحة العمل. يتطلب موافقة. المهلة حتى 10 دقائق.', { command: str('الأمر الكامل'), timeout_ms: integer('المهلة بالمللي ثانية', 1000, 600000) }, ['command']),
  tool('start_preview', 'شغّل خادم تطوير مشروع Build واعرض الرابط في لوحة المعاينة داخل التطبيق. استخدمها عندما يطلب المستخدم تشغيل الموقع أو معاينته. لا تُشغّل npm/npx يدويًا ولا تستخدم taskkill أبدًا؛ هذه الأداة تعيد استخدام الخادم إن كان يعمل، وتشغّل المشروع الصحيح تلقائيًا. أعد معلومات تفصيلية عن حالة الخادم والمحتوى.', {}, []),
  tool('stop_preview', 'أوقف خادم تطوير مشروع Build وأغلق المعاينة. استخدمها عندما يطلب المستخدم إيقاف المعاينة.', {}, []),
  tool('preview_status', 'استعلم عن حالة خادم المعاينة والرابط والخطأ. أي ملخص محتوى هو تحليل محدود لـHTML الخام وليس DOM بعد تشغيل JavaScript.', {}, []),
  tool('get_page_content', 'اقرأ HTML الخام الذي يعيده خادم المعاينة. لا يمثل DOM بعد تشغيل JavaScript أو حالة SPA المرئية.', {}, []),
  tool('preview_screenshot', 'التقط إطار المعاينة المفتوح الظاهر للمستخدم نفسه. افحص captureSource وvisualState وnote: إذا كانت mostlyBlank=true فالصفحة الظاهرة بيضاء/فارغة فعلًا، وإذا كان consoleCaptured=false فلا تدّع عدم وجود أخطاء console. استخدمها بعد أي تغيير مرئي.', {}, []),
  tool('discover_tools', 'اعرض مجموعات أدوات Build والأدوات المتاحة فيها دون تفعيلها.', {}, []),
  tool('enable_tool_group', 'فعّل مجموعة أدوات لهذا التشغيل فقط؛ تصبح أدواتها متاحة من الجولة التالية.', { group: enumString(['preview', 'web', 'pdf', 'mcp', 'subagents']) }, ['group']),
  tool('analyze_file', 'حلل ملف TypeScript/JavaScript باستخدام Compiler API واعرض: imports, exports, functions, classes, interfaces, types, والعلاقات بينها. أدق بكثير من search_symbols.', { path: str('مسار الملف') }, ['path']),
  tool('find_references', 'ابحث عن جميع المراجع (الاستدعاءات, الاستيرادات, الأنواع) لرمز معين في المشروع كاملاً. يُعيد التعريف وجميع مواقع الاستخدام.', { symbol: str('اسم الرمز'), path: str('ملف البداية اختياري') }, ['symbol']),
  tool('dependency_graph', 'اعرض خريطة اعتماديات ملف معين: من يستورد منه ومن يستورده. مفيد لفهم تأثير التعديلات.', { path: str('المسار') }, ['path']),
  tool('remember_project', 'احفظ معلومة مهمة عن المشروع للمستقبل. ستُحفظ في الذاكرة طويلة المدى وستظهر في جلسات لاحقة.', { category: enumString(['file_purpose', 'decision', 'convention', 'error_fix', 'architecture', 'workflow']), key: nonEmptyString('عنوان مختصر (حتى 200 حرف)'), value: nonEmptyString('المعلومة التفصيلية') }, ['category', 'key', 'value']),
  tool('recall_project', 'استرجع معلومات محفوظة عن المشروع من الذاكرة طويلة المدى.', { category: enumString(['file_purpose', 'decision', 'convention', 'error_fix', 'architecture', 'workflow']), query: str('كلمة بحث اختيارية') }, []),
  tool('read_pdf', 'اقرأ ملف PDF واستخرج نصه الكامل. مفيد لوثائق وأوراق بحثية وتقارير.', { path: str('مسار ملف PDF') }, ['path'])
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
  fullPowerShell?: boolean
  /** Full-permission sessions may use the host shell without workspace sandboxing. */
  unrestrictedShell?: boolean
  recordMutation?(receipt: Omit<MutationReceipt, 'workspaceRevision'>): void
  signal: AbortSignal
  maxOutputChars?: number
  trackProcess?(child: import('child_process').ChildProcess): void
  deadlineAt?: number
  mcp?: McpToolExecutor
  readStoredMessage?(id: string): Promise<StoredMessageView | undefined>
  loadSkill?(name: string): Promise<{ name: string; description: string; content: string } | undefined>
  todos?: { get(): Promise<Todo[]>; set(items: Array<{ content: string; status?: Todo['status']; priority?: Todo['priority'] }>): Promise<Todo[]> }
  runSubagent?(input: { prompt: string; description: string; subagentName?: string }, signal: AbortSignal): Promise<{ ok: boolean; summary: string; error?: string; steps: number }>
  runSubagentBatch?(tasks: Array<{ prompt: string; description: string; subagentName?: string }>, signal: AbortSignal): Promise<Array<{ ok: boolean; description: string; summary: string; error?: string; steps: number }>>
  runCommand?(name: string, argumentsText?: string): Promise<{ ok: boolean; output?: string; error?: string }>
  deferAutoCommit?(action: string, paths: string[]): void
  pushUndo?(entry: { path: string; oldContent: string }): void
  popUndo?(): { path: string; oldContent: string } | undefined
  /** Code intelligence indexer for the current workspace */
  indexer?: ProjectIndexer
  /** Long-term project memory */
  memory?: ProjectMemory
  /** جلب محتوى ملف عند الحاجة (Just-in-Time retrieval) */
  fetchFileOnDemand?(filePath: string): Promise<string | null>
  /** Tavily API key for web search */
  tavilyApiKey?: string
  /** التقاط لقطة + console من خادم المعاينة (Build فقط) */
  capturePreview?: () => Promise<import('./preview-capture').PreviewCapture | null>
  startPreview?(signal?: AbortSignal): Promise<DevServerState>
  stopPreview?(): Promise<DevServerState>
  getPreviewState?(): DevServerState
  onPreviewState?(state: DevServerState): void
  discoverTools?(): Record<string, readonly string[]>
  enableToolGroup?(group: string): Promise<{ enabled: string; tools: string[] }>
}

export interface ToolPolicy {
  mutating: boolean
  destructive?: boolean
}

const MUTATING_TOOL_NAMES = ['write_file', 'edit_file', 'edit_files_bulk', 'edit_file_undo', 'patch_file', 'create_directory', 'run_powershell', 'shell', 'git_commit', 'git_revert', 'git_revert_step', 'git_add', 'git_fetch', 'git_pull', 'git_push', 'git_checkpoint', 'git_isolate_branch', 'delete_file', 'move_file', 'append_file', 'git_restore', 'git_checkout', 'git_reset'] as const
const DESTRUCTIVE_TOOL_NAMES = ['delete_file', 'git_restore', 'git_checkout', 'git_reset', 'git_revert', 'git_revert_step'] as const

export const TOOL_POLICIES: Readonly<Record<string, ToolPolicy>> = Object.freeze(Object.fromEntries([
  ...MUTATING_TOOL_NAMES.map((name) => [name, { mutating: true }] as const),
  ...DESTRUCTIVE_TOOL_NAMES.map((name) => [name, { mutating: true, destructive: true }] as const),
]))

export function isToolMutating(name: string): boolean { return TOOL_POLICIES[name]?.mutating === true }

function mutationInputPaths(name: string, input: Record<string, unknown>): string[] {
  if (name === 'edit_files_bulk') {
    try {
      const edits = typeof input.edits === 'string' ? JSON.parse(input.edits) : input.edits
      return Array.isArray(edits) ? edits.flatMap((edit) => edit && typeof edit === 'object' && typeof edit.path === 'string' ? [edit.path] : []) : []
    } catch { return [] }
  }
  if (name === 'move_file') return [input.from, input.to].filter((value): value is string => typeof value === 'string')
  return typeof input.path === 'string' ? [input.path] : []
}

function protectedPathSegment(value: string): string | undefined {
  const protectedPaths = new Set(['.git', '.env', '.env.local', '.env.production', 'node_modules', '.ssh', '.aws', 'credentials', 'provider.json'])
  return value.replace(/\\/g, '/').split('/').map((segment) => segment.toLowerCase()).find((segment) => protectedPaths.has(segment))
}

export async function executeTool(name: string, input: Record<string, unknown>, context: ToolContext): Promise<string> {
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) return failure('DEADLINE_EXCEEDED', 'انتهى الوقت المتاح للجولة الحالية.')
  const unrestrictedShell = (name === 'shell' || name === 'run_powershell') && context.session.permissionMode === 'full' && context.unrestrictedShell === true
  if (name === 'shell' || name === 'run_powershell') {
    const rawCommand = typeof input.command === 'string' ? input.command : undefined
    if (rawCommand !== undefined) {
      if (!unrestrictedShell) {
        const controlCharacterError = rejectUnsafeCommandCharacters(rawCommand)
        if (controlCharacterError) return failure('INVALID_COMMAND', `${controlCharacterError} rawCommand=${limitedCommand(rawCommand)}`)
        const normalized = normalizeShellCommand(rawCommand)
        if (normalized.error) return failure('INVALID_COMMAND', `${normalized.error} rawCommand=${JSON.stringify(rawCommand)}`)
        input = { ...input, command: normalized.command, rawCommand }
      }
    }
  }
  const mutating = isToolMutating(name)
  if (context.session.agentMode === 'plan' && mutating) return failure('PLAN_MODE', 'وضع Plan لا يسمح بالتعديل أو تنفيذ الأوامر.')
  if (context.session.permissionMode === 'read-only' && mutating) return failure('READ_ONLY', 'وضع القراءة فقط لا يسمح بالتعديل أو تنفيذ الأوامر.')
  const destructive = TOOL_POLICIES[name]?.destructive === true

  const root = await canonicalWorkspace(context.session.workspace)
  // ─── حماية المسارات الحساسة ───────────────────────────────────────
  const protectedPaths = new Set(['.git', '.env', '.env.local', '.env.production', 'node_modules', '.ssh', '.aws', 'credentials', 'provider.json'])
  if (mutating) {
    for (const targetPath of mutationInputPaths(name, input)) {
      const segments = targetPath.replace(/\\/g, '/').split('/').map((segment) => segment.toLowerCase())
      if (segments.some((seg) => protectedPaths.has(seg))) {
        const protectedItem = segments.find((seg) => protectedPaths.has(seg))
        const suggestions: Record<string, string> = {
          '.env': 'لإنشاء .env، استخدم shell بأمر: Set-Content -Path .env -Value "KEY=VALUE" -Encoding UTF8 بدون BOM',
          '.env.local': 'لإنشاء .env.local، استخدم shell بأمر: Set-Content',
          '.git': 'لا يمكنك تعديل .git يدوياً — استخدم أوامر git عبر shell',
          'node_modules': 'لا تحذف node_modules يدوياً — استخدم shell بأمر: Remove-Item node_modules -Recurse',
          '.ssh': 'ملفات SSH محمية لأسباب أمنية — لا يمكن تعديلها',
          '.aws': 'ملفات AWS محمية لأسباب أمنية — لا يمكن تعديلها',
          'credentials': 'ملفات الاعتماد محمية — لا يمكن تعديلها',
          'provider.json': 'ملف المزوّد محمي — قم بتعديله من الإعدادات'
        }
        const suggestion = (protectedItem ? suggestions[protectedItem] : null) || 'استخدم shell بأمر مناسب对此 الملف.'
        return failure('PROTECTED_PATH', `المسار "${targetPath}" محمي (${protectedItem}).\n💡 الحل: ${suggestion}`)
      }
    }
  }
  if (name.startsWith('mcp_') || name.startsWith('tavily_')) {
    if (context.session.agentMode === 'plan') return failure('PLAN_MODE', 'وضع Plan لا يسمح باستدعاء أدوات MCP لأنها قد تعدل خارج المشروع.')
    if (!context.mcp) return failure('MCP_UNAVAILABLE', 'مدير MCP غير متاح.')
    if (context.session.permissionMode === 'ask' && !await context.approve(`السماح بأداة MCP ${name}؟`, JSON.stringify({ tool: name, input }, null, 2), true)) return failure('APPROVAL_DENIED', 'رفض المستخدم تنفيذ أداة MCP.')
    return context.mcp.call(name, input, context.signal, context.session.workspace)
  }
  const targetInput = name === 'read_files' && typeof input.paths === 'string' ? '.' : name === 'move_file' && typeof input.from === 'string' ? input.from : typeof input.path === 'string' ? input.path : typeof input.cwd === 'string' ? input.cwd : '.'
  let target: ResolvedPath
  try {
    target = unrestrictedShell
      ? await resolveUnrestrictedDirectory(typeof input.cwd === 'string' ? input.cwd : root.canonical)
      : name === 'web_fetch' || name === 'web_search' ? { absolute: root.canonical, relative: '.' } : name === 'write_file' || name === 'create_directory' || name === 'append_file' ? await resolveCreatable(root, targetInput) : await resolveExisting(root, targetInput)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const suggestion = name === 'read_file' || name === 'edit_file'
        ? '💡 استخدم glob_files أو list_directory لاكتشاف الملفات المتاحة في المشروع.'
        : '💡 تأكد من صحة المسار أو أنشئ الملف أولاً باستخدام write_file.'
      return failure('FILE_NOT_FOUND', `الملف غير موجود: ${targetInput}\n${suggestion}`)
    }
    throw error
  }
  const sensitive = isSensitiveInput(name, input, target.relative)
  const shell = name === 'run_powershell'
  const criticalShell = shell && isCriticalCommand(String(input.command ?? ''))
  const web = name === 'web_fetch' || name === 'web_search' || name === 'web_research'
  const criticalGit = name === 'git_commit' || name === 'git_revert'
  const needsApproval = context.session.permissionMode === 'ask' && (sensitive || shell || web || criticalGit || destructive || mutating || name === 'task' || name === 'task_parallel')
  if (needsApproval) {
    const preview = await buildApprovalPreview(name, input, target, sensitive)
    if (!await context.approve(`السماح بأداة ${name}؟`, preview.detail, criticalShell || shell || criticalGit || sensitive, preview.rememberKey)) return failure('APPROVAL_DENIED', 'رفض المستخدم تنفيذ الأداة.')
    if (preview.verify) await preview.verify()
    if (name === 'write_file' || name === 'create_directory' || name === 'append_file') await resolveCreatable(root, targetInput)
    else if (name !== 'move_file') await resolveExisting(root, targetInput)
  }

  // ─── Timeout خاص لكل أداة قراءة تمشي مجلدات ──────────────────────
  const toolTimeout = TOOLS_WITH_TIMEOUT.has(name) ? createToolTimeoutSignal(context.signal) : null
  const toolSignal = toolTimeout?.signal ?? context.signal
  try {
  switch (name) {
    case 'read_file': return readTextFile(target.absolute, target.relative, number(input.offset, 1, 1), number(input.limit, MAX_READ_LINES, 1, MAX_READ_LINES))
    case 'read_files': return readFiles(root.canonical, target.absolute, pathList(input.paths) ?? optionalString(input.path), optionalString(input.include), optionalString(input.cursor), number(input.max_files, 10, 1, 100), context.maxOutputChars ?? 300_000, toolSignal)
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
      const subagentName = optionalString(input.subagentName)
      if (prompt.length > 100_000) return failure('INVALID_TASK_INPUT', 'prompt أطول من الحد المسموح (100000 حرف).')
      const signal = context.signal
      const subagent = await context.runSubagent({ prompt, description, subagentName: subagentName ?? undefined }, signal)
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
      const tasks = parsed.slice(0, 3).map((item) => ({ prompt: typeof item.prompt === 'string' ? item.prompt.slice(0, 100_000) : '', description: typeof item.description === 'string' ? item.description.slice(0, 200) : 'وكيل فرعي', subagentName: typeof item.subagentName === 'string' ? item.subagentName : undefined }))
      if (!tasks.length || tasks.some((task) => !task.prompt.trim())) return failure('INVALID_TASKS_INPUT', 'كل مهمة تتطلب prompt نصيًا.')
      const results = await context.runSubagentBatch(tasks, context.signal)
      return success({ count: results.length, results })
    }
    case 'todo_write': {
      if (!context.todos) return failure('TODOS_UNAVAILABLE', 'أداة todo_write غير متاحة في هذا السياق.')
      let parsed: Array<Record<string, unknown>>
      const rawItems = input.items
      if (Array.isArray(rawItems)) {
        parsed = rawItems
      } else {
        const raw = requiredString(rawItems, 'items')
        try { parsed = JSON.parse(raw); if (!Array.isArray(parsed)) throw new Error() } catch { return failure('INVALID_TODO_INPUT', 'items يجب أن تكون مصفوفة JSON صالحة.') }
      }
      const items: Array<{ content: string; status?: Todo['status']; priority?: Todo['priority'] }> = parsed.slice(0, 100).map((item) => { const status = item.status === 'completed' || item.status === 'in_progress' || item.status === 'cancelled' ? item.status as Todo['status'] : undefined; const priority = item.priority === 'high' || item.priority === 'low' ? item.priority as Todo['priority'] : undefined; return { content: typeof item.content === 'string' ? item.content.slice(0, 500) : '', status, priority } })
      if (items.some((item) => !item.content.trim())) return failure('INVALID_TODO_INPUT', 'كل مهمة تتطلب content نصيًا.')
      const todos = await context.todos.set(items)
      return success({ count: todos.length, todos })
    }
    case 'todo_read': {
      if (!context.todos) return failure('TODOS_UNAVAILABLE', 'أداة todo_read غير متاحة في هذا السياق.')
      const todos = await context.todos.get()
      return success({ count: todos.length, todos })
    }
    case 'discover_tools': {
      if (!context.discoverTools) return failure('BUILD_ONLY', 'اكتشاف مجموعات الأدوات متاح في Build المخصص فقط.')
      return success({ groups: context.discoverTools() })
    }
    case 'enable_tool_group': {
      if (!context.enableToolGroup) return failure('BUILD_ONLY', 'تفعيل مجموعات الأدوات متاح في Build المخصص فقط.')
      try { return success(await context.enableToolGroup(requiredString(input.group, 'group'))) }
      catch (error) { return failure('INVALID_TOOL_GROUP', error instanceof Error ? error.message : String(error)) }
    }
    case 'run_command': {
      if (!context.runCommand) return failure('COMMAND_UNAVAILABLE', 'أداة run_command غير متاحة في هذا السياق.')
      const result = await context.runCommand(requiredString(input.name, 'name'), typeof input.arguments === 'string' ? input.arguments : undefined)
      if (!result.ok) return failure('COMMAND_FAILED', result.error ?? 'فشل تنفيذ الأمر')
      return success({ name: input.name, output: result.output })
    }
    case 'count_lines': return countLines(target.absolute, target.relative, optionalString(input.include), toolSignal)
    case 'list_directory': return listDirectory(target.absolute, target.relative, number(input.limit, 500, 1, 1000))
    case 'glob_files': return globFiles(target.absolute, root.canonical, requiredString(input.pattern, 'pattern'), number(input.limit, 1000, 1, MAX_GLOB_RESULTS), toolSignal)
    case 'search_files': return searchFiles(target.absolute, root.canonical, requiredString(input.pattern, 'pattern'), optionalString(input.include), Boolean(input.fixed_strings), Boolean(input.case_sensitive), number(input.limit, MAX_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS), toolSignal)
    case 'search_symbols': return searchSymbols(target.absolute, root.canonical, requiredString(input.query, 'query'), number(input.limit, MAX_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS), toolSignal, context.indexer)
    case 'write_file': { const output = await writeFileAtomic(target.absolute, target.relative, extractContent(input)); invalidateFileCache(target.absolute); context.recordMutation?.({ effects: [{ kind: 'write', path: target.relative }] }); return withAutoCommit(await withSyntaxCheck(output, [target.absolute]), await maybeAutoCommit(context, root.canonical, 'write_file', [target.relative])) }
    case 'edit_file': { const oldContent = await fs.readFile(target.absolute, 'utf8'); const output = await editFile(target.absolute, target.relative, requiredString(input.old_string, 'old_string'), requiredString(input.new_string, 'new_string')); context.pushUndo?.({ path: target.relative, oldContent }); invalidateFileCache(target.absolute); context.recordMutation?.({ effects: [{ kind: 'edit', path: target.relative }] }); return withAutoCommit(await withSyntaxCheck(output, [target.absolute]), await maybeAutoCommit(context, root.canonical, 'edit_file', [target.relative])) }
    case 'edit_files_bulk': {
      // تنفيذ تعديلات متعددة على عدة ملفات في استدعاء واحد
      let edits: Array<{ path: string; old_string: string; new_string: string }>
      try {
        const raw = input.edits
        edits = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : []
      } catch {
        return failure('INVALID_EDITS_INPUT', 'edits يجب أن تكون مصفوفة JSON صالحة.')
      }
      if (!edits.length || edits.length > 20) {
        return failure('INVALID_EDITS_INPUT', `edits يجب أن تحتوي على 1-20 تعديل. العدد الحالي: ${edits.length}`)
      }
      const prepared: Array<{ target: ResolvedPath; before: string; after: string; addedLines: number; removedLines: number }> = []
      const seen = new Set<string>()
      try {
        for (const edit of edits) {
          if (!edit.path || !edit.old_string) throw new Error('كل تعديل يتطلب path و old_string')
          const editTarget = await resolveExisting(root, edit.path)
          const key = process.platform === 'win32' ? editTarget.absolute.toLowerCase() : editTarget.absolute
          if (seen.has(key)) throw new Error(`هدف مكرر في الدفعة: ${editTarget.relative}`)
          seen.add(key)
          const before = await fs.readFile(editTarget.absolute, 'utf8')
          const applied = applyEdit(before, edit.old_string, edit.new_string ?? '')
          const stats = diffPreview(before, applied.content)
          prepared.push({ target: editTarget, before, after: applied.content, addedLines: stats.addedLines, removedLines: stats.removedLines })
        }
      } catch (error) {
        return failure('BULK_PREFLIGHT_FAILED', `لم يكتب أي ملف: ${error instanceof Error ? error.message : String(error)}`)
      }
      try { await commitBulkFiles(prepared) }
      catch (error) { return failure('BULK_COMMIT_FAILED', `فشل تثبيت الدفعة وتمت محاولة الاسترجاع: ${error instanceof Error ? error.message : String(error)}`) }
      const editedPaths = prepared.map((item) => item.target.relative)
      for (const item of prepared) { invalidateFileCache(item.target.absolute); context.pushUndo?.({ path: item.target.relative, oldContent: item.before }) }
      context.deferAutoCommit?.('edit_file_bulk', editedPaths)
      context.recordMutation?.({ effects: editedPaths.map((path) => ({ kind: 'edit' as const, path })) })
      return withSyntaxCheck(success({
        total: edits.length,
        succeeded: edits.length,
        failed: 0,
        addedLines: prepared.reduce((total, item) => total + item.addedLines, 0),
        removedLines: prepared.reduce((total, item) => total + item.removedLines, 0),
        results: prepared.map((item) => ({ path: item.target.relative, ok: true, addedLines: item.addedLines, removedLines: item.removedLines })),
        deferred: true,
      }), prepared.map((item) => item.target.absolute))
    }
    case 'patch_file': { const oldContent = await fs.readFile(target.absolute, 'utf8'); const patchesRaw = typeof input.patches === 'string' ? input.patches : JSON.stringify(Array.isArray(input.patches) ? input.patches : []); const output = await patchFile(target.absolute, target.relative, patchesRaw); context.pushUndo?.({ path: target.relative, oldContent }); invalidateFileCache(target.absolute); context.recordMutation?.({ effects: [{ kind: 'edit', path: target.relative }] }); return withAutoCommit(await withSyntaxCheck(output, [target.absolute]), await maybeAutoCommit(context, root.canonical, 'patch_file', [target.relative])) }
     case 'edit_file_undo': { if (!context.popUndo) return failure('UNDO_UNAVAILABLE', 'خاصية الإرجاع غير متاحة في هذا السياق.'); const entry = context.popUndo(); if (!entry) return failure('NOTHING_TO_UNDO', 'لا توجد تعديلات سابقة يمكن إرجاعها.'); const protectedItem = protectedPathSegment(entry.path); if (protectedItem) { context.pushUndo?.(entry); return failure('PROTECTED_PATH', `المسار "${entry.path}" محمي (${protectedItem}).`) } const filePath = await resolveCreatable(root, entry.path); await writeFileAtomic(filePath.absolute, filePath.relative, entry.oldContent); invalidateFileCache(filePath.absolute); context.recordMutation?.({ effects: [{ kind: 'edit', path: filePath.relative }] }); return success({ path: entry.path, restored: true, characters: entry.oldContent.length }) }
    case 'create_directory': { await fs.mkdir(target.absolute, { recursive: true }); context.recordMutation?.({ effects: [{ kind: 'create-directory', path: target.relative }] }); return success({ path: target.relative, created: true }) }
    case 'get_file_info': return fileInfo(target.absolute, target.relative)
    case 'web_fetch': return webFetch(requiredString(input.url, 'url'), number(input.max_bytes, 200_000, 1_000, 500_000), context.signal, context.deadlineAt)
    case 'web_search': return webSearch(requiredString(input.query, 'query'), number(input.max_results, 5, 1, 10), context.signal, context.deadlineAt, context.tavilyApiKey)
    case 'web_research': return webResearch(requiredString(input.query, 'query'), number(input.max_results, 5, 1, 8), number(input.fetch_pages, 2, 0, 4), context.signal, context.deadlineAt, context.tavilyApiKey)
    case 'preview_screenshot': {
      if (!context.capturePreview) return failure('PREVIEW_UNAVAILABLE', 'التقاط المعاينة غير متاح في هذه الجلسة.')
      const capture = await context.capturePreview()
      if (!capture) return failure('PREVIEW_NOT_RUNNING', 'المعاينة غير مشغّلة الآن. شغّلها أولًا عبر start_preview ثم التقط اللقطة.')
      return success(capture)
    }
    case 'git_status': return gitStatus(target.absolute, context.signal, context.trackProcess, context.deadlineAt)
    case 'git_diff': return gitDiff(target.absolute, Boolean(input.staged), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_log': return gitLog(target.absolute, number(input.limit, 10, 1, 50), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_commit': return gitCommit(target.absolute, requiredString(input.message, 'message'), Boolean(input.all), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_revert': return gitRevert(target.absolute, requiredString(input.commit, 'commit'), context.signal, context.trackProcess, context.deadlineAt)
    case 'git_revert_step': return gitRevertStep(target.absolute, context.signal, context.trackProcess, context.deadlineAt)
    case 'delete_file': { const output = await deleteFile(target.absolute, target.relative); invalidateFileCache(target.absolute); context.recordMutation?.({ effects: [{ kind: 'delete', path: target.relative }] }); return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, 'delete_file', [target.relative])) }
    case 'move_file': { const destination = await resolveCreatable(root, requiredString(input.to, 'to')); const output = await moveFile(root.canonical, requiredString(input.from, 'from'), requiredString(input.to, 'to')); invalidateFileCache(target.absolute); invalidateFileCache(destination.absolute); context.recordMutation?.({ effects: [{ kind: 'move', from: target.relative, path: destination.relative }] }); return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, 'move_file', [target.relative, destination.relative])) }
    case 'append_file': { const output = await appendFile(target.absolute, target.relative, extractContent(input)); invalidateFileCache(target.absolute); context.recordMutation?.({ effects: [{ kind: 'write', path: target.relative }] }); return withAutoCommit(await withSyntaxCheck(output, [target.absolute]), await maybeAutoCommit(context, root.canonical, 'append_file', [target.relative])) }
    case 'tree': return projectTree(target.absolute, root.canonical, number(input.max_entries, 1000, 1, 2000), toolSignal)
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
        const result = await runPowerShell(requiredString(input.command, 'command'), root.canonical, target.absolute, context.signal, remaining, context.trackProcess, context.fullPowerShell, unrestrictedShell)
      return success(result)
    }
    case 'shell': {
      if (!context.session.id) return failure('SHELL_UNAVAILABLE', 'الـ shell الدائم يتطلب sessionId صالحًا.')
      const requestedTimeout = number(input.timeout_ms, 30_000, 1_000, 600_000)
      const remaining = context.deadlineAt === undefined ? requestedTimeout : Math.max(1_000, Math.min(requestedTimeout, context.deadlineAt - Date.now()))
      let shellInstance = persistentShells.get(context.session.id)
        if (!shellInstance || shellInstance.fullPowerShell !== Boolean(context.fullPowerShell) || shellInstance.unrestricted !== unrestrictedShell || !shellInstance.child || shellInstance.child.killed || shellInstance.child.exitCode !== null) {
          shellInstance?.close()
          shellInstance = new PersistentShell(root.canonical, context.fullPowerShell, unrestrictedShell)
        persistentShells.set(context.session.id, shellInstance)
      }
      const result = await shellInstance.run(requiredString(input.command, 'command'), remaining, context.signal)
      return success({ ...result, persistent: true })
    }
    case 'start_preview': {
      if (!context.startPreview) return failure('PREVIEW_UNAVAILABLE', 'تشغيل المعاينة غير متاح في هذه الجلسة.')
      // Q1/Q13: لا نبدأ تشغيلًا جديدًا إذا كان الخادم يعمل أو قيد التشغيل — نرجع الحالة فورًا
      // بدل حجب جولة الوكيل حتى 345 ثانية (تثبيت اعتماديات). الحالة "قيد التشغيل" تُصفَّر
      // تلقائيًا عند اكتمال البدء (عبر onPreviewState أدناه).
      const current = context.getPreviewState?.()
      if (current?.running) return success({ ...current, note: 'الخادم يعمل بالفعل.' })
      if (current?.previewStarting) return success({ ...current, note: 'الخادم قيد التشغيل — انتظر ظهور الرابط.' })
      context.onPreviewState?.({ running: false, previewStarting: true })
      // Q2: نمرر signal الإلغاء ليقاطع البدء فورًا عند إلغاء التشغيل، ونربط الحالة الفعلية
      // لتصل للواجهة حتى لو انتهت مهلة الأداة (البدء يستمر في الخلفية).
      const started = context.startPreview(context.signal)
      void started.then((state) => context.onPreviewState?.(state)).catch((error) => context.onPreviewState?.({ running: false, error: error instanceof Error ? error.message : 'فشل تشغيل المعاينة' }))
      // Q1: مهلة الأداة — لا نحجب الجولة أكثر من 90 ثانية؛ نرجع "ما زال يجهز" ونكمل العمل.
      const PREVIEW_TOOL_TIMEOUT_MS = 90_000
      const state = await Promise.race([started, new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), PREVIEW_TOOL_TIMEOUT_MS))])
      if (!state) return success({ running: false, previewStarting: true, note: 'ما زال الخادم يجهز (تثبيت اعتماديات أو بدء بطيء). سيظهر الرابط تلقائيًا.' })
      return success(state)
    }
    case 'stop_preview': {
      if (!context.stopPreview) return failure('PREVIEW_UNAVAILABLE', 'إيقاف المعاينة غير متاح في هذه الجلسة.')
      const state = await context.stopPreview()
      context.onPreviewState?.(state)
      return success(state)
    }
    case 'preview_status': {
      if (!context.getPreviewState) return failure('PREVIEW_UNAVAILABLE', 'حالة المعاينة غير متاحة في هذه الجلسة.')
      const state = context.getPreviewState()
      // إضافة معلومات تفصيلية عن المحتوى إذا كان الخادم يعمل
      if (state.running && state.url) {
        try {
          // محاولة جلب محتوى الصفحة لفهم ما يراه المستخدم
          const response = await fetch(state.url, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]), redirect: 'follow' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const html = await response.text()
          // استخراج النصوص والعناصر المرئية
          const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || 'بدون عنوان'
          const bodyText = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                              .replace(/<[^>]+>/g, ' ')
                              .replace(/\s+/g, ' ')
                              .trim()
                              .slice(0, 1000)
          const hasImages = /<img[^>]+>/i.test(html)
          const hasForms = /<form[^>]+>/i.test(html) || /<input[^>]+>/i.test(html)
          const hasButtons = /<button[^>]+>/i.test(html)
          const hasCSS = /<link[^>]+rel=["']stylesheet["']/i.test(html) || /<style/i.test(html)
          const hasJS = /<script[^>]+src=/i.test(html)
          return success({
            ...state,
            diagnosticsKind: 'raw-html',
            caveat: 'مشتق من استجابة HTML الخام؛ لا يمثل DOM بعد hydration أو تنفيذ JavaScript.',
            pageTitle: title,
            extractedText: bodyText,
            rawMarkupSignals: { images: hasImages, forms: hasForms, buttons: hasButtons, css: hasCSS, js: hasJS },
            contentLength: html.length,
            contentSummary: `الصفحة تحتوي على: ${hasImages ? 'صور، ' : ''}${hasForms ? 'نماذج، ' : ''}${hasButtons ? 'أزرار، ' : ''}${hasCSS ? 'CSS، ' : ''}${hasJS ? 'JavaScript' : ''}`
          })
        } catch (error) {
          return success({ ...state, contentError: `تعذر قراءة المحتوى: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
      return success(state)
    }
    case 'get_page_content': {
      if (!context.getPreviewState) return failure('PREVIEW_UNAVAILABLE', 'حالة المعاينة غير متاحة في هذه الجلسة.')
      const previewState = context.getPreviewState()
      if (!previewState.running || !previewState.url) return failure('PREVIEW_NOT_RUNNING', 'المعاينة غير تعمل حالياً. شغّلها أولاً باستخدام start_preview.')
      try {
        const response = await fetch(previewState.url, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]), redirect: 'follow' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const html = await response.text()
        // استخراج معلومات تفصيلية عن الصفحة
        const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || 'بدون عنوان'
        const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] || ''
        // استخراج النصوص المرئية
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
        const bodyHtml = bodyMatch?.[1] || html
        const visibleText = bodyHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                   .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                   .replace(/<[^>]+>/g, '\n')
                                   .replace(/\n\s*\n/g, '\n')
                                   .trim()
                                   .slice(0, 2000)
        // استخراج العناصر
        const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m => `H${m[1]}: ${(m[2] || '').replace(/<[^>]+>/g, '').trim()}`).slice(0, 10)
        const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({ href: m[1] || '', text: (m[2] || '').replace(/<[^>]+>/g, '').trim() })).filter(l => l.text).slice(0, 10)
        const images = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?/gi)].map(m => ({ src: m[1] || '', alt: m[2] || '' })).slice(0, 10)
        const buttons = [...html.matchAll(/<(?:button|input[^>]+type=["'](?:button|submit)["'])[^>]*>([\s\S]*?)<\/(?:button|input)/gi)].map(m => (m[1] || '').replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 10)
        // تحليل CSS
        const hasExternalCSS = /<link[^>]+rel=["']stylesheet["']/i.test(html)
        const hasInlineCSS = /<style/i.test(html)
        const cssFiles = [...html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)].map(m => m[1])
        // تحليل JS
        const hasExternalJS = /<script[^>]+src=/i.test(html)
        const jsFiles = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)].map(m => m[1])
        return success({
          url: previewState.url,
          diagnosticsKind: 'raw-html',
          caveat: 'تحليل محدود لاستجابة HTML الخام؛ لا يمثل DOM بعد hydration أو تنفيذ JavaScript.',
          title,
          metaDescription: metaDesc,
          visibleText,
          headings,
          links,
          images,
          buttons,
          css: { external: hasExternalCSS, inline: hasInlineCSS, files: cssFiles },
          js: { external: hasExternalJS, files: jsFiles },
          htmlSize: html.length,
          summary: `الصفحة "${title}" تحتوي على: ${headings.length} عنوان، ${links.length} رابط، ${images.length} صورة، ${buttons.length} زر، CSS: ${cssFiles.length} ملفات، JS: ${jsFiles.length} ملفات`
        })
      } catch (error) {
        return failure('FETCH_FAILED', `تعذر جلب محتوى الصفحة: ${error instanceof Error ? error.message : String(error)}\n💡 تحقق من أن الخادم يعمل بشكل صحيح.`)
      }
    }
    case 'analyze_file': {
      if (!context.indexer) return failure('INDEXER_UNAVAILABLE', 'محرك فهم الكود غير متاح.')
      const filePath = requiredString(input.path, 'path')
      const resolved = await resolveExisting(root, filePath)
      const analysis = await context.indexer.analyzeFile(resolved.absolute)
      if (!analysis) return failure('ANALYSIS_FAILED', `تعذر تحليل الملف: ${filePath}`)
      return success({
        path: analysis.path,
        totalLines: analysis.totalLines,
        exports: analysis.exports,
        imports: analysis.imports.map((imp) => ({ from: imp.moduleSpecifier, names: imp.namedBindings ?? (imp.defaultImport ? [imp.defaultImport] : []) })),
        symbols: analysis.symbols.map((sym) => ({ name: sym.name, kind: sym.kind, line: sym.line, exported: sym.isExported, doc: sym.documentation.slice(0, 200) })),
        classes: analysis.classes.map((cls) => ({ name: cls.name, extends: cls.extends, methods: cls.methods, properties: cls.properties })),
        functions: analysis.functions.map((fn) => ({ name: fn.name, params: fn.parameters.slice(0, 200), async: fn.isAsync })),
        interfaces: analysis.interfaces.map((iface) => ({ name: iface.name, properties: iface.properties, methods: iface.methods })),
      })
    }
    case 'find_references': {
      if (!context.indexer) return failure('INDEXER_UNAVAILABLE', 'محرك فهم الكود غير متاح.')
      const symbolName = requiredString(input.symbol, 'symbol')
      const startFile = optionalString(input.path)
      const refs = await context.indexer.findReferences(symbolName, startFile)
      return success({
        symbol: refs.symbol,
        definition: refs.definition ? { file: refs.definition.file, line: refs.definition.line, kind: refs.definition.kind } : null,
        referenceCount: refs.references.length,
        references: refs.references.slice(0, 100),
      })
    }
    case 'dependency_graph': {
      if (!context.indexer) return failure('INDEXER_UNAVAILABLE', 'محرك فهم الكود غير متاح.')
      const depPath = requiredString(input.path, 'path')
      const resolvedDep = await resolveExisting(root, depPath)
      const deps = await context.indexer.getDependencies(resolvedDep.absolute)
      if (!deps) return failure('DEPENDENCY_NOT_FOUND', `لا توجد بيانات اعتماديات للملف: ${depPath}`)
      return success({
        file: deps.file,
        imports: deps.imports.map((imp) => ({ from: imp.moduleSpecifier, names: imp.namedBindings ?? [] })),
        importedBy: deps.importedBy,
      })
    }
    case 'remember_project': {
      if (!context.memory) return failure('MEMORY_UNAVAILABLE', 'نظام الذاكرة غير متاح.')
      const category = requiredString(input.category, 'category') as MemoryCategory
      const memKey = requiredString(input.key, 'key')
      const memValue = requiredString(input.value, 'value')
      const validCategories = ['file_purpose', 'decision', 'convention', 'error_fix', 'architecture', 'workflow']
      if (!validCategories.includes(category)) return failure('INVALID_CATEGORY', `التصنيف غير صالح. الأنواع المتاحة: ${validCategories.join(', ')}`)
      const entry = context.memory.save(context.session.workspace, category, memKey, memValue)
      return success({ saved: true, id: entry.id, category: entry.category, key: entry.key })
    }
    case 'recall_project': {
      if (!context.memory) return failure('MEMORY_UNAVAILABLE', 'نظام الذاكرة غير متاح.')
      const recCategory = optionalString(input.category) as MemoryCategory | undefined
      const recQuery = optionalString(input.query)
      const validCategories: MemoryCategory[] = ['file_purpose', 'decision', 'convention', 'error_fix', 'architecture', 'workflow']
      if (recCategory && !validCategories.includes(recCategory)) return failure('INVALID_CATEGORY', `التصنيف غير صالح. الأنواع المتاحة: ${validCategories.join(', ')}`)
      const entries = context.memory.getByWorkspace(context.session.workspace, recCategory, recQuery)
      return success({
        count: entries.length,
        entries: entries.map((e) => ({ category: e.category, key: e.key, value: e.value.slice(0, 500), confidence: e.confidence, accessCount: e.accessCount })),
      })
    }
    case 'read_pdf': {
      const pdfPath = requiredString(input.path, 'path')
      const resolvedPdf = await resolveExisting(root, pdfPath)
      try {
        const pdfParse = (await import('pdf-parse')).default
        const buffer = await fs.readFile(resolvedPdf.absolute)
        const data = await pdfParse(buffer)
        return success({ path: resolvedPdf.relative, pages: data.numpages, text: data.text.slice(0, 500_000), truncated: data.text.length > 500_000 })
      } catch (error) {
        return failure('PDF_PARSE_FAILED', `فشل قراءة PDF: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    default: throw new Error(`أداة غير معروفة: ${name}`)
  }
  } catch (error) {
    // إذا انتهت المهلة الفرعية للأداة، أعد نتيجة جزئية مع تحذير
    if (toolTimeout && !context.signal.aborted && isAbortError(error)) {
      return failure('TOOL_TIMEOUT', `أداة ${name} تجاوزت المهلة (${TOOL_TIMEOUT_MS / 1000} ثانية). جرّب تحديد مسار أضيق أو استخدام include لتضييق النطاق.`)
    }
    throw error
  } finally {
    toolTimeout?.clear()
  }
}

export async function runPowerShell(command: string, workspaceRoot: string, cwd: string, signal?: AbortSignal, timeoutMs = 30_000, trackProcess?: (child: import('child_process').ChildProcess) => void, fullPowerShell = false, unrestricted = false): Promise<{ output: string; exitCode: number; timedOut: boolean; truncated: boolean; durationMs: number }> {
  if (!unrestricted) {
    const controlCharacterError = rejectUnsafeCommandCharacters(command)
    if (controlCharacterError) throw new Error(`رفض الأمر: ${controlCharacterError}\n💡 تأكد من عدم وجود أحرف خاصة غير مسموحة في الأمر.`)
    const normalized = normalizeShellCommand(command)
    if (normalized.error) throw new Error(`رفض الأمر: ${normalized.error}\n💡 استخدم صيغة صحيحة مثل: shell: أو run_powershell:`)
    command = normalized.command
    const policyError = validateSandboxCommand(command, workspaceRoot, cwd)
    if (policyError) throw new Error(`رفض الأمر في وضع العزل: ${policyError}\n💡 في وضع العزل، بعض الأوامر محظورة لأسباب أمنية. جرب أمرًا مختلفًا.`)
    await validateSandboxCommandAsync(command, workspaceRoot, cwd)
  }
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
     const languageMode = fullPowerShell ? 'FullLanguage' : 'ConstrainedLanguage'
     const shellCommand = `$ExecutionContext.SessionState.LanguageMode = '${languageMode}'; Set-Location -LiteralPath '${escapePowerShellLiteral(cwd)}'; & { ${command} }`
    const env = safeEnvironment()
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', shellCommand], { cwd, windowsHide: true, env })
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
      // taskkill أولًا لقتل الشجرة كاملة بينما العملية الأم حية، ثم kill() كاحتياط
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => {})
      killer.unref()
      child.kill()
    }
    const timeout = setTimeout(() => { timedOut = true; killTree() }, timeoutMs)
    const abort = (): void => {
      if (settled) return
      killTree()
      settled = true
      cleanup()
      reject(new DOMException('تم إلغاء الأمر', 'AbortError'))
    }
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
    function cleanup(): void { 
      clearTimeout(timeout); 
      signal?.removeEventListener('abort', abort); 
      child.stdout.removeListener('data', append); 
      child.stderr.removeListener('data', append);
      // تحسين تنظيف الموارد: التأكد من إنهاء العملية
      try { child.kill() } catch {}
    }
  })
}

const POWERSHELL_ALLOWED_COMMANDS = new Set(['Add-Content', 'Copy-Item', 'Get-ChildItem', 'Get-Command', 'Get-Content', 'Get-Location', 'Get-Item', 'Get-Process', 'Get-Date', 'Measure-Object', 'Move-Item', 'New-Item', 'Pop-Location', 'Push-Location', 'Remove-Item', 'Rename-Item', 'Resolve-Path', 'Select-Object', 'Select-String', 'Set-Content', 'Set-Location', 'Split-Path', 'Test-Path', 'Write-Error', 'Write-Output', 'Write-Verbose', 'Write-Warning', 'Write-Host', 'Where-Object', 'ForEach-Object', 'Sort-Object', 'Compare-Object', 'Group-Object', 'Tee-Object', 'Out-File', 'Out-String', 'Get-Unique', 'Format-Table', 'Format-List', 'Format-Custom', 'if', 'else', 'elseif', 'foreach', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'throw', 'return', 'break', 'continue', 'function', 'class', 'enum', 'using', 'Import-Module', 'Get-Help', 'Get-Alias', 'Set-Alias', 'git', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'py', 'dotnet', 'cargo', 'go', 'java', 'mvn', 'gradle', 'gradlew', 'tsc', 'jest', 'pytest', 'where', 'echo', 'type', 'dir', 'findstr', 'rg', 'cat', 'head', 'tail', 'wc', 'grep', 'sed', 'awk', 'ls', 'pwd', 'cd', 'mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod', 'Expand-Archive', 'Compress-Archive', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Start-Process', 'Stop-Process', 'Get-Service', 'Start-Service', 'Stop-Service', 'Restart-Service', 'Get-Content', 'Set-Location', 'Push-Location', 'Pop-Location', 'Get-ChildItem', 'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Test-Path', 'Split-Path', 'Join-Path', 'Resolve-Path', 'Get-Item', 'Set-Item', 'Clear-Item', 'Get-Content', 'Set-Content', 'Add-Content', 'Clear-Content', 'Get-Date', 'Set-Date', 'Get-EventLog', 'Get-History', 'Clear-History', 'Get-Host', 'Get-UICulture', 'Get-UTCDate', 'Get-Variable', 'Set-Variable', 'Remove-Variable', 'Clear-Variable', 'New-Variable', 'Get-Alias', 'Set-Alias', 'New-Alias', 'Remove-Alias', 'Import-Module', 'Remove-Module', 'Get-Module', 'Export-ModuleMember', 'Get-Command', 'Get-Help', 'Get-Member', 'Get-TypeData', 'Remove-TypeData', 'Update-TypeData', 'Get-PSDrive', 'New-PSDrive', 'Remove-PSDrive', 'Get-PSProvider', 'New-PSDrive', 'Get-PSSnapin', 'Add-PSSnapin', 'Remove-PSSnapin', 'Get-Process', 'Start-Process', 'Stop-Process', 'Debug-Process', 'Get-Process', 'Start-Process', 'Stop-Process', 'Wait-Process', 'Get-Service', 'Start-Service', 'Stop-Service', 'Restart-Service', 'New-Service', 'Remove-Service', 'Get-WmiObject', 'Get-CimInstance', 'Invoke-CimMethod', 'New-CimInstance', 'Remove-CimInstance', 'Set-CimInstance', 'Get-NetAdapter', 'Get-NetIPAddress', 'Get-DnsClientServerAddress', 'Set-DnsClientServerAddress', 'Test-NetConnection', 'Test-Connection', 'Test-Path', 'curl', 'wget', 'docker', 'docker-compose', 'make', 'cmake', 'cargo', 'rustc', 'gcc', 'g++', 'javac', 'javaw', 'ant', 'msbuild', 'devenv', 'nuget', 'dotnet', 'winget', 'choco', 'scoop', 'brew', 'apt', 'yum', 'dnf', 'pacman', 'zypper', 'snap', 'flatpak', 'pip', 'pip3', 'conda', 'poetry', 'pipenv', 'virtualenv', 'venv', 'rbenv', 'nvm', 'fnm', 'volta', 'asdf', 'pyenv', 'goenv', 'jenv', 'sdkman', 'rvm', 'chruby', 'heroku', 'vercel', 'netlify', 'firebase', 'aws', 'az', 'gcloud', 'kubectl', 'helm', 'terraform', 'ansible', 'vagrant', 'packer', 'consul', 'vault', 'nomad', 'boundary', 'waypoint', 'powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'fish', 'sh', 'csh', 'tcsh', 'ksh'])

export function normalizeShellCommand(rawCommand: string): { command: string; rawCommand: string; error?: undefined } | { command: string; rawCommand: string; error: string } {
  const prefix = /^(?:\d+=)?(?:shell:|run_powershell:)/.exec(rawCommand)?.[0]
  if (prefix) return { command: rawCommand.slice(prefix.length), rawCommand }
  if (/^[^\s;|&]+:/.test(rawCommand) || /^=/.test(rawCommand)) return { command: rawCommand, rawCommand, error: 'بادئة الأمر غير معروفة أو فارغة؛ المسموح shell: وrun_powershell: مع رقم اختياري فقط.' }
  return { command: rawCommand, rawCommand }
}

const UNSAFE_COMMAND_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function limitedCommand(command: string): string { return JSON.stringify(command.slice(0, 240)) }

function rejectUnsafeCommandCharacters(command: string): string | undefined {
  const match = UNSAFE_COMMAND_CONTROL_CHARACTERS.exec(command)
  if (!match) return undefined
  const codePoint = match[0].codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? '????'
  return `محرف تحكم غير مسموح به (U+${codePoint}) قبل تطبيع الأمر.`
}

export function validateSandboxCommand(command: string, workspaceRoot: string, cwd: string): string | undefined {
  const controlCharacterError = rejectUnsafeCommandCharacters(command)
  if (controlCharacterError) return `${controlCharacterError} normalizedCommand=${limitedCommand(command)} rawCommand=${limitedCommand(command)}`
  const normalized = normalizeShellCommand(command)
  if (normalized.error) return `${normalized.error} rawCommand=${JSON.stringify(normalized.rawCommand)}`
  const value = normalized.command.trim()
  if (!value) return 'الأمر فارغ.'
  // حظر PowerShell المتداخل (بما في ذلك -c shorthand) و cmd/bash/pwsh
  if (/(?:-EncodedCommand|-e\b|FromBase64String|Add-Type|Reflection|Start-Process|Invoke-Expression|Invoke-Command|powershell(?:\.exe)?\s+-|pwsh\s+-|cmd\s+\/[cdk]\s+|bash\s+)/i.test(value)) return 'تشغيل كود أو PowerShell/cmd متداخل غير مسموح.'
  if (/(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|curl(?:\.exe)?\b|wget(?:\.exe)?\b|ssh(?:\.exe)?\b|scp(?:\.exe)?\b|netsh\b|New-PSSession)/i.test(value)) return 'أوامر الشبكة والاتصالات الخارجية غير مسموحة داخل العزل.'
  // حظر Remove-Item مع -Recurse و -Force بأي ترتيب
  if (/(?:^|[;&|])\s*(?:Remove-Item(?=[\s\S]*\b-Recurse\b)(?=[\s\S]*\b-Force\b)|Format-Volume|Clear-Disk|diskpart|reg\s+(?:add|delete)|schtasks|Set-MpPreference)/i.test(value)) return 'الأمر قد يسبب حذفًا أو تغييرًا خارج نطاق المشروع.'
  if (/(?:^|[\s\\/])\.\.(?:[\\/]|$)/.test(value)) return 'المسارات النسبية إلى الأب غير مسموحة.'
  if (/\\\\/.test(value) || /(?:^|[\s"'(])(?:[A-Za-z][\w.-]*::|(?:HKLM|HKCU|HKCR|HKU|Env|Alias|Cert|Variable|Function|Registry|WSMan|FileSystem):[\\/])/i.test(value)) return 'مسارات UNC وPowerShell provider غير مسموحة.'
  const commands = splitSandboxCommands(value)
  const absolutePaths = value.match(/[A-Za-z]:[\\/][^\s"'`;&|]*/g) ?? []
  if (!isContainedPath(path.resolve(cwd), path.resolve(workspaceRoot))) return 'مجلد التشغيل خارج مساحة العمل غير مسموح.'
  const allowExternalDiagnostic = isAllowedDiagnosticTestPath(value, commands, absolutePaths)
  for (const candidate of absolutePaths) if (!isContainedPath(path.resolve(candidate), path.resolve(workspaceRoot)) && !allowExternalDiagnostic) return 'المسار المطلق خارج مساحة العمل غير مسموح.'
  for (const part of commands) {
    const name = /^\s*(?:[&|]\s*)?(["']?[^\s"']+["']?)/.exec(part)?.[1]?.replace(/^(["'])(.*)\1$/, '$2')
    if (!name) return 'تعذر التحقق من اسم الأمر.'
    const basename = name.split(/[\\/]/).pop() ?? name
    const normalized = basename.replace(/\.(?:exe|cmd|bat|com)$/i, '')
    if (normalized.toLowerCase() === 'cd') {
      if (!parseLiteralLocation(part)) return 'أمر cd يجب أن يستخدم مسارًا حرفيًا واحدًا داخل مساحة العمل.'
      continue
    }
    if (normalized.toLowerCase() === 'set-location' && !parseLiteralLocation(part)) return 'أمر Set-Location يجب أن يستخدم مسارًا حرفيًا واحدًا داخل مساحة العمل.'
    if (normalized.toLowerCase() === 'test-path' && !parseLiteralTestPath(part)) return 'أمر Test-Path يجب أن يستخدم مسارًا حرفيًا واحدًا.'
    if (!POWERSHELL_ALLOWED_COMMANDS.has(normalized) && !POWERSHELL_ALLOWED_COMMANDS.has(`${normalized[0]?.toUpperCase() ?? ''}${normalized.slice(1)}`)) return `الأمر "${normalized}" غير مسموح. استخدم أمرًا مدعومًا مثل: npm, node, git, mkdir, echo, dir, ls, أو PowerShell cmdlets.`
  }
  return undefined
}

/*
function parseLiteralLocationBroken(part: string): string | undefined {
  const match = /^\s*(?:[&|]\s*)?(?:cd|Set-Location)\s+([\s\S]+?)\s*$/i.exec(part)
  if (!match) return undefined
  const raw = match[1]?.trim()
  if (!raw) return undefined
  if (!raw || /[$`]||
  if (raw.startsWith("'") || raw.startsWith('"')) {
    const quote = raw[0] as string
    if (!raw.endsWith(quote) || raw.length < 2 || raw.slice(1, -1).includes(quote)) return undefined
    const value = raw.slice(1, -1)
    return value && !/[<>]/.test(value) ? value : undefined
  }
  return /\s/.test(raw) ? undefined : raw
}
*/

function parseLiteralLocation(part: string): string | undefined {
  const match = /^\s*(?:[&|]\s*)?(?:cd|Set-Location)\s+([\s\S]+?)\s*$/i.exec(part)
  if (!match) return undefined
  const raw = match[1]?.trim()
  if (!raw) return undefined
  if (!raw || /[$`]|[\r\n;&|*?\[\]\u0000-\u001f]/.test(raw) || /\b(?:-LiteralPath|-Path)\b/i.test(raw)) return undefined
  if (raw.startsWith("'") || raw.startsWith('"')) {
    const quote = raw[0] as string
    if (!raw.endsWith(quote) || raw.length < 2 || raw.slice(1, -1).includes(quote)) return undefined
    const value = raw.slice(1, -1)
    return value && !/[<>]/.test(value) ? value : undefined
  }
  return /\s/.test(raw) ? undefined : raw
}

function parseLiteralTestPath(part: string): string | undefined {
  const match = /^\s*Test-Path(?:\s+-LiteralPath)?\s+([\s\S]+?)\s*$/i.exec(part)
  if (!match) return undefined
  const raw = match[1]?.trim()
  if (!raw || /[$`]|[\r\n;&|*?\[\]<>\u0000-\u001f]/.test(raw)) return undefined
  if (raw.startsWith("'") || raw.startsWith('"')) {
    const quote = raw[0] as string
    if (!raw.endsWith(quote) || raw.length < 2 || raw.slice(1, -1).includes(quote)) return undefined
    const value = raw.slice(1, -1)
    return value && !/[$`]|[\r\n;&|*?\[\]<>\u0000-\u001f]/.test(value) ? value : undefined
  }
  return /\s/.test(raw) ? undefined : raw
}

function isLocalDrivePath(value: string): boolean { return /^[A-Za-z]:[\\/]/.test(value) }

function isAllowedDiagnosticTestPath(value: string, commands: string[], absolutePaths: string[]): boolean {
  if (commands.length !== 1 || absolutePaths.length !== 1 || /[<>;&|]/.test(value)) return false
  const literal = parseLiteralTestPath(commands[0]!)
  if (!literal || !isLocalDrivePath(literal)) return false
  const profile = process.env.USERPROFILE?.trim()
  if (!profile || !isLocalDrivePath(profile)) return false
  return isContainedPath(path.resolve(literal), path.resolve(profile, '.gradle', 'jdks'))
}

function isContainedPath(candidate: string, workspace: string): boolean {
  const normalizedCandidate = process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate)
  const normalizedWorkspace = process.platform === 'win32' ? path.resolve(workspace).toLowerCase() : path.resolve(workspace)
  const relative = path.relative(normalizedWorkspace, normalizedCandidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

async function validateSandboxCommandAsync(command: string, workspaceRoot: string, cwd: string): Promise<void> {
  const workspace = await fs.realpath(workspaceRoot)
  const executionCwd = await fs.realpath(cwd)
  if (!isContainedPath(executionCwd, workspace)) throw new Error('مجلد التشغيل خارج مساحة العمل أو يهرب عبر symlink/junction.')
  const commands = splitSandboxCommands(command)
  const absolutePaths = command.match(/[A-Za-z]:[\\/][^\s"'`;&|]*/g) ?? []
  const allowExternalDiagnostic = isAllowedDiagnosticTestPath(command, commands, absolutePaths)
  for (const literal of literalCommandPaths(command)) {
    if (allowExternalDiagnostic && path.isAbsolute(literal)) continue
    const requested = path.isAbsolute(literal) ? literal : path.resolve(executionCwd, literal)
    let ancestor = requested
    while (true) {
      try { await fs.lstat(ancestor); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const parent = path.dirname(ancestor)
        if (parent === ancestor) break
        ancestor = parent
      }
    }
    const canonical = await fs.realpath(ancestor)
    if (!isContainedPath(canonical, workspace)) throw new Error('مسار الأمر خارج مساحة العمل أو يهرب عبر symlink/junction.')
  }
  for (const part of commands) {
    const location = parseLiteralLocation(part)
    if (!location) continue
    const requested = path.isAbsolute(location) ? location : path.resolve(executionCwd, location)
    let canonical: string
    try { canonical = await fs.realpath(requested) } catch { throw new Error('مسار cd/Set-Location غير موجود أو غير قابل للتحقق.') }
    if (!isContainedPath(canonical, workspace)) throw new Error('مسار cd/Set-Location خارج مساحة العمل أو يهرب عبر symlink/junction.')
    const info = await fs.stat(canonical)
    if (!info.isDirectory()) throw new Error('مسار cd/Set-Location ليس مجلدًا.')
  }
}

function literalCommandPaths(command: string): string[] {
  const values = new Set<string>()
  for (const match of command.matchAll(/(["'])([^"'\r\n]+)\1/g)) {
    const value = match[2]?.trim()
    if (value && (path.isAbsolute(value) || /[\\/]/.test(value))) values.add(value)
  }
  for (const match of command.matchAll(/(?:^|\s)([^\s"'`;&|]*[\\/][^\s"'`;&|]*)/g)) {
    const value = match[1]?.trim()
    if (value && !value.startsWith('-')) values.add(value)
  }
  return [...values]
}

export function splitSandboxCommands(value: string): string[] {
  const commands: string[] = []
  let start = 0
  let quote: 'single' | 'double' | null = null
  let braceDepth = 0
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '`') { index++; continue }
    if (char === "'" && quote !== 'double') { quote = quote === 'single' ? null : 'single'; continue }
    if (char === '"' && quote !== 'single') { quote = quote === 'double' ? null : 'double'; continue }
    if (!quote) {
      if (char === '{') { braceDepth++; continue }
      if (char === '}') { braceDepth = Math.max(0, braceDepth - 1); continue }
    }
    if (!quote && braceDepth === 0 && (char === ';' || char === '|' || char === '\r' || char === '\n')) {
      const part = value.slice(start, index).trim()
      if (part) commands.push(part)
      start = index + 1
    }
    if (!quote && braceDepth === 0 && char === '&') {
      const prev = index > 0 ? value[index - 1] : ''
      const next = index + 1 < value.length ? value[index + 1] : ''
      if (prev === '>' || next === '>' || next === '&') {
        continue
      }
      const part = value.slice(start, index).trim()
      if (part) commands.push(part)
      start = index + 1
    }
  }
  const tail = value.slice(start).trim()
  if (tail) commands.push(tail)
  return commands
}

function escapePowerShellLiteral(value: string): string { return value.replaceAll("'", "''") }

class PersistentShell {
  child: import('child_process').ChildProcess | null = null
  cwd: string
  waiter: ((raw: string) => void) | null = null
  out: string[] = []
  err: string[] = []
  outBytes = 0
  errBytes = 0
  truncatedOut = false
  truncatedErr = false
  markerN = 0
  collecting = false
  initialized = false
  initError: Error | null = null
  currentMarker: string | null = null

  constructor(readonly workspace: string, readonly fullPowerShell = false, readonly unrestricted = false) { this.cwd = workspace }

  private spawn(): import('child_process').ChildProcess {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const childEnv = safeEnvironment()
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], { cwd: this.workspace, windowsHide: true, env: childEnv })
    if (child.stdin) child.stdin.setDefaultEncoding('utf8')
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      const out = createInterface({ input: child.stdout })
      out.on('line', (line: string) => this.onLine(line))
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      const er = createInterface({ input: child.stderr })
      er.on('line', (line: string) => { if (this.collecting) { if (this.errBytes < MAX_OUTPUT_BYTES) { this.err.push(line); this.errBytes += Buffer.byteLength(line) + 1 } else if (!this.truncatedErr) { this.err.push('[تم اقتصار stderr]'); this.truncatedErr = true } } })
    }
    child.once('exit', () => { if (this.child === child) this.child = null })
    return child
  }

  private writeRaw(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin ?? null
      if (!stdin) { reject(new Error('الـ shell الدائم مغلق')); return }
      stdin.write(text, 'utf8', (err) => err ? reject(err) : resolve())
    })
  }

  private async ensure(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null && !this.initError && this.initialized) return
    this.initialized = false
    this.initError = null
    this.child = this.spawn()
    try {
       const languageMode = this.fullPowerShell ? 'FullLanguage' : 'ConstrainedLanguage'
       const initCmd = `$LASTEXITCODE = 0; $ExecutionContext.SessionState.LanguageMode = '${languageMode}'; Set-Location -LiteralPath '${escapePowerShellLiteral(this.workspace)}'\n`
      await this.writeRaw(initCmd)
      this.initialized = true
    } catch (error) {
      this.initError = error instanceof Error ? error : new Error(String(error))
      throw this.initError
    }
  }

  private onLine(line: string): void {
    // التحقق من الـ marker مع nonce عشوائي لمنع التزوير
    const match = this.currentMarker && line.startsWith(this.currentMarker) ? /^(__CODE_AGENT_END_[a-f0-9-]+__):(-?\d+):(.*)$/.exec(line) : null
    if (match) {
      const waiter = this.waiter
      this.waiter = null
      this.collecting = false
      if (waiter) waiter(line)
      return
    }
    if (this.collecting) {
      if (this.outBytes < READ_OUTPUT_BYTES) { this.out.push(line); this.outBytes += Buffer.byteLength(line) + 1 }
      else if (!this.truncatedOut) { this.out.push('[تم اقتصار باقي إخراج الأمر]'); this.truncatedOut = true }
    }
  }

  async run(command: string, timeoutMs: number, signal: AbortSignal): Promise<{ output: string; exitCode: number; cwd: string; timedOut: boolean; truncated: boolean }> {
    if (!this.unrestricted) {
      const normalized = normalizeShellCommand(command)
      if (normalized.error) throw new Error(`رفض الأمر: ${normalized.error} rawCommand=${JSON.stringify(command)}`)
      command = normalized.command
      const policyError = validateSandboxCommand(command, this.workspace, this.cwd)
      if (policyError) throw new Error(`رفض الأمر في وضع العزل: ${policyError}`)
      await validateSandboxCommandAsync(command, this.workspace, this.cwd)
    }
    await this.ensure()
    if (this.waiter) throw new Error('shell الدائم مشغول بأمر آخر')
    // أعد الفحص بعد التهيئة كدفاع إضافي ضد تغير cwd أثناء الانتظار.
    if (!this.unrestricted) {
      const recheckError = validateSandboxCommand(command, this.workspace, this.cwd)
      if (recheckError) throw new Error(`رفض الأمر في وضع العزل: ${recheckError}`)
      await validateSandboxCommandAsync(command, this.workspace, this.cwd)
    }

    const id = ++this.markerN
    const marker = `__CODE_AGENT_END_${id}-${randomUUID().slice(0, 8)}__`
    this.currentMarker = marker
    const wrapped = `${command}\nWrite-Output "${marker}:$($LASTEXITCODE):$((Get-Location).Path)"\n`

    this.out = []
    this.err = []
    this.outBytes = 0
    this.errBytes = 0
    this.truncatedOut = false
    this.truncatedErr = false
    this.collecting = true

    let resolved = false
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish({ timedOut: true }), Math.min(Math.max(1_000, timeoutMs), 600_000))
      const onAbort = (): void => finish({ aborted: true })
      signal.addEventListener('abort', onAbort, { once: true })
      const finish = (extra: { timedOut?: boolean; aborted?: boolean } = {}): void => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (extra.timedOut || extra.aborted) this.close()
        this.waiter = null
        this.collecting = false
        const output = this.out.join('\n')
        const errText = this.err.join('\n')
        const combined = errText ? `${output}${output && !output.endsWith('\n') ? '\n' : ''}[stderr]\n${errText}` : output
        resolve({ output: extra.aborted ? `${combined}\n[أُلغي shell الدائم]` : extra.timedOut ? `${combined}\n[انتهت مهلة shell الدائم]` : combined, exitCode: -1, cwd: this.cwd, timedOut: Boolean(extra.timedOut), truncated: this.truncatedOut })
      }
      this.waiter = (raw: string) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const match = this.currentMarker && raw.startsWith(this.currentMarker) ? /^(__CODE_AGENT_END_[a-f0-9-]+__):(-?\d+):(.*)$/.exec(raw) : null
        if (match) {
          const exitCode = Number(match[2])
           const reportedCwd = match[3] || this.cwd
           void (async () => {
             let canonicalCwd: string | undefined
             try {
               const resolved = await fs.realpath(reportedCwd)
               if (path.isAbsolute(resolved) && isContainedPath(resolved, await fs.realpath(this.workspace))) canonicalCwd = resolved
             } catch { /* keep the last verified cwd */ }
             if (canonicalCwd) this.cwd = canonicalCwd
             const output = this.out.join('\n')
             const errText = this.err.join('\n')
             const combined = errText ? `${output}${output && !output.endsWith('\n') ? '\n' : ''}[stderr]\n${errText}` : output
             resolve({ output: combined, exitCode, cwd: this.cwd, timedOut: false, truncated: this.truncatedOut })
           })()
           return
        }
        resolve({ output: this.out.join('\n'), exitCode: -1, cwd: this.cwd, timedOut: false, truncated: this.truncatedOut })
      }
      void this.writeRaw(wrapped).catch((error) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.waiter = null
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  close(): void {
    try { this.child?.stdin?.end() } catch {}
    if (this.child?.pid && !this.child.killed) {
      // اقتل الشجرة كاملة حتى لا تبقى أوامر فرعية يتيمة (node/git...) تعلق العملية
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => {})
      killer.unref()
      try { this.child.kill() } catch {}
    }
    // تحسين تنظيف الموارد: التأكد من إنهاء جميع الموارد
    if (this.child) {
      try { this.child.removeAllListeners() } catch {}
      this.child = null
    }
    this.initialized = false
    this.waiter = null
  }
}

const persistentShells = new Map<string, PersistentShell>()

export function closePersistentShell(sessionId: string): void {
  const shell = persistentShells.get(sessionId)
  if (!shell) return
  shell.close()
  persistentShells.delete(sessionId)
}

export function closeAllPersistentShells(): void {
  for (const shell of persistentShells.values()) shell.close()
  persistentShells.clear()
}

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

async function resolveUnrestrictedDirectory(input: string): Promise<ResolvedPath> {
  const canonical = await fs.realpath(path.resolve(input))
  const stat = await fs.stat(canonical)
  if (!stat.isDirectory()) throw new Error('مجلد التشغيل ليس مجلدًا')
  return { absolute: canonical, relative: canonical }
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
  const normalizedRoot = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)
  const normalizedTarget = process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target)
  const relative = path.relative(normalizedRoot, normalizedTarget)
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
        if (outputBytes + size <= READ_OUTPUT_BYTES) { lines.push(rendered); outputBytes += size } else outputTruncated = true
      }
    }
    if (streamError && !binary) throw streamError
    if (binary) throw new Error('الملف ثنائي وليس نصيًا')
    return { totalLines, bytes: stat.size, lines, outputTruncated }
  } finally { try { reader.close() } catch {}; try { stream.destroy() } catch {} }
}

async function readTextFile(filePath: string, relative: string, offset: number, limit: number): Promise<string> {
  // كاش: إذا طلب الملف كاملًا (أول 5000 سطر افتراضيًا) والمحتوى في الكاش
  if (offset === 1 && limit >= MAX_READ_LINES) {
    const cached = await getCachedFile(filePath)
    if (cached) {
      // الملف لم يتغير — أعد المحتوى مع علامة الكاش
      const lines = cached.content.split(/\r?\n/)
      if (lines.at(-1) === '') lines.pop()
      const rendered: string[] = []
      const maxLines = Math.min(lines.length, MAX_READ_LINES)
      for (let i = 0; i < maxLines; i++) {
        rendered.push(`${i + 1}: ${lines[i]}`)
      }
      return success({
        path: relative, totalLines: lines.length, bytes: cached.size,
        range: { start: maxLines ? 1 : null, end: maxLines || null, requestedLimit: limit },
        truncated: maxLines < lines.length,
        lines: rendered,
        cached: true,
        sha256: cached.sha256.slice(0, 16),
      })
    }
  }
  const result = await scanLines(filePath, offset, limit)
  // حفظ في الكاش إذا طلب الملف كاملًا
  if (offset === 1 && limit >= MAX_READ_LINES) {
    try {
      const fullContent = await fs.readFile(filePath, 'utf8')
      await setCachedFile(filePath, fullContent)
    } catch { /* file too large or binary */ }
  }
  return success({ path: relative, totalLines: result.totalLines, bytes: result.bytes, range: { start: result.lines.length ? offset : null, end: result.lines.length ? offset + result.lines.length - 1 : null, requestedLimit: limit }, truncated: result.outputTruncated || offset + result.lines.length <= result.totalLines, lines: result.lines })
}

async function readFiles(root: string, directory: string, pathsValue: string | undefined, include: string | undefined, cursorValue: string | undefined, maxFiles: number, maxOutputChars: number, signal: AbortSignal): Promise<string> {
  const candidates: Array<{ absolute: string; relative: string }> = []
  if (pathsValue) {
    const paths = [...new Set(pathsValue.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
    for (const input of paths) {
      signal.throwIfAborted()
      try {
        const canonical = await fs.realpath(path.resolve(root, input))
        assertInside(root, canonical)
        if ((await fs.stat(canonical)).isFile()) candidates.push({ absolute: canonical, relative: relativePath(root, canonical) })
      } catch (error) {
        // تجاهل المسارات غير الموجودة — لا تمنع باقي الملفات
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
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
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try { stat = await fs.stat(candidate.absolute) } catch {
      // الملف اختفى — انتقل لل التالي
      fileIndex++; lineIndex = 0; characterIndex = 0; continue
    }
    if (stat.size > 5_000_000) { fileIndex++; lineIndex = 0; characterIndex = 0; continue }
    // كاش: استخدم المحتوى المخزن إذا لم يتغير
    let text: string
    let fromCache = false
    const cached = await getCachedFile(candidate.absolute)
    if (cached) {
      text = cached.content
      fromCache = true
    } else {
      try {
        text = await fs.readFile(candidate.absolute, 'utf8')
      } catch {
        // الملف اختفى أثناء القراءة — انتقل لل التالي
        fileIndex++; lineIndex = 0; characterIndex = 0; continue
      }
      // حفظ في الكاش للاستخدام المستقبلي
      try { await setCachedFile(candidate.absolute, text) } catch { /* ignore cache errors */ }
    }
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
    files.push({ path: candidate.relative, totalLines: rawLines.length, bytes: stat.size, range: { start: startLine, end: Math.min(rawLines.length, lineIndex + (characterIndex ? 1 : 0)), startCharacter, endCharacter: characterIndex }, complete: lineIndex >= rawLines.length, content: rendered.join('\n'), ...(fromCache ? { cached: true } : {}) })
    if (lineIndex < rawLines.length) break
    fileIndex++; lineIndex = 0; characterIndex = 0; processedFiles++
    if (usedChars >= maxOutputChars) break
  }
  const nextCursor = fileIndex < candidates.length ? `${fileIndex}:${lineIndex}:${characterIndex}` : null
  return success({ totalFiles: candidates.length, cursor: cursorValue ?? '0:0:0', filesRead: files.length, nextCursor, complete: nextCursor === null, files })
}

async function countLines(filePath: string, relative: string, include: string | undefined, signal: AbortSignal): Promise<string> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try { stat = await fs.stat(filePath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failure('FILE_NOT_FOUND', `الملف غير موجود: ${relative}`)
    throw error
  }
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
  let entries: import('node:fs').Dirent[]
  try { entries = await fs.readdir(directory, { withFileTypes: true }) as import('node:fs').Dirent[] } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true // المجلد اختفى أثناء المسح — تجاهل بصمت
    throw error
  }
  for (const entry of entries) {
    signal.throwIfAborted()
    if (entry.isSymbolicLink() || isIgnoredEntry(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    try {
      if (entry.isDirectory()) { if (!await walkFiles(absolute, root, signal, onFile)) return false }
      else if (entry.isFile() && !await onFile(absolute, relativePath(root, absolute))) return false
    } catch (error) {
      // الملف/المجلد اختفى بين readdir والاستدعاء — تجاهل بصمت
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'EPERM') continue
      throw error
    }
  }
  return true
}
function isIgnoredEntry(name: string): boolean {
  const lower = name.toLowerCase()
  return ['node_modules', '.git', 'out', 'dist', 'build', 'coverage', '.next', '.cache', '.vite'].includes(lower) || lower.startsWith('release-') || lower.startsWith('dist-v') || lower.startsWith('win-unpacked') || lower.endsWith('.tmp')
}

async function globFiles(directory: string, root: string, pattern: string, limit: number, signal: AbortSignal): Promise<string> {
  const matcher = globRegex(pattern)
  const ignored = await gitignorePatterns(root)
  const files: string[] = []
  const completed = await walkFiles(directory, root, signal, async (_absolute, relative) => { if (!isGitignored(relative, ignored) && matcher.test(relative)) files.push(relative); return files.length < limit })
  return success({ pattern, count: files.length, truncated: !completed, files })
}

async function searchFiles(directory: string, root: string, pattern: string, include: string | undefined, fixed: boolean, caseSensitive: boolean, limit: number, signal: AbortSignal): Promise<string> {
  let normalizedPattern = pattern
  let extraFlags = ''
  const pcrePrefix = /^\(\?([imsu]+)\)/.exec(normalizedPattern)
  if (pcrePrefix?.[1]) {
    const pcreFlags = pcrePrefix[1]
    normalizedPattern = normalizedPattern.slice(pcrePrefix[0].length)
    if (pcreFlags.includes('i')) extraFlags += 'i'
    if (pcreFlags.includes('m')) extraFlags += 'm'
    if (pcreFlags.includes('s')) extraFlags += 's'
  }
  const ripgrep = await searchFilesWithRipgrep(directory, root, normalizedPattern, include, fixed, caseSensitive, limit, signal)
  if (ripgrep) return ripgrep
  let matcher: RegExp
  try { matcher = new RegExp(fixed ? escapeRegex(normalizedPattern) : normalizedPattern, `${caseSensitive ? 'g' : 'gi'}${extraFlags}`) } catch (error) { return failure('INVALID_REGEX', `تعبير البحث غير صالح: ${error instanceof Error ? error.message : String(error)}`) }
  const includeMatcher = include ? globRegex(include) : null
  const ignored = await gitignorePatterns(root)
  const matches: Array<{ path: string; line: number; column: number; text: string }> = []
  let skippedBinary = 0
  const searchFile = async (absolute: string, relative: string): Promise<boolean> => {
    if (isGitignored(relative, ignored)) return true
    if (includeMatcher && !includeMatcher.test(relative) && !includeMatcher.test(path.basename(relative))) return true
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try { stat = await fs.stat(absolute) } catch { return true } // ملف اختفى — تجاهل
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
  let dirStat: Awaited<ReturnType<typeof fs.stat>>
  try { dirStat = await fs.stat(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failure('FILE_NOT_FOUND', `المجلد غير موجود: ${relativePath(root, directory)}`)
    throw error
  }
  const completed = dirStat.isFile() ? await searchFile(directory, relativePath(root, directory)) : await walkFiles(directory, root, signal, searchFile)
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
      const relative = path.relative(root, event.data.path.text).replaceAll('\\', '/')
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
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

async function searchSymbols(directory: string, root: string, query: string, limit: number, signal: AbortSignal, indexer?: ProjectIndexer): Promise<string> {
  const lower = query.trim().toLowerCase()
  if (!lower) throw new Error('query لا يمكن أن يكون فارغًا')
  const symbols: Array<{ path: string; line: number; kind: string; name: string }> = []

  // ─── مسار ذكي: استخدم index الموجود في الذاكرة بدل قراءة كل ملفات المشروع ───
  // ProjectIndexer يحفظ كل الرموز في index.symbols (Map<string, SymbolInfo[]>).
  // البحث مباشرة من الفهرس أسرع 10-100 مرة ولا يقرأ أي ملف.
  if (indexer) {
    try {
      const index = await Promise.race([
        indexer.getIndex(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1_000)),
      ])
      // اجمع الرموز المطابقة من جميع الملفات في الفهرس
      for (const [symbolName, infos] of index.symbols) {
        if (!symbolName.toLowerCase().includes(lower)) continue
        for (const info of infos) {
          // فلترة حسب النوع: أسقط imports/exports (هم ليسوا "definitions")
          if (info.kind === 'import' || info.kind === 'export') continue
          symbols.push({ path: info.file, line: info.line, kind: info.kind, name: info.name.slice(0, 120) })
          if (symbols.length >= limit) break
        }
        if (symbols.length >= limit) break
      }
      return success({ query: query.trim(), count: symbols.length, truncated: false, symbols, source: 'index' })
    } catch { /* fall through to walk-based scan */ }
  }

  // مسار احتياطي: read & scan (للحالات التي لا يوجد فيها indexer)
  const ignored = await gitignorePatterns(root)
  const completed = await walkFiles(directory, root, signal, async (absolute, relative) => {
    if (isGitignored(relative, ignored)) return true
    const ext = path.extname(absolute).toLowerCase()
    if (!SYMBOL_EXTENSIONS.has(ext)) return true
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try { stat = await fs.stat(absolute) } catch { return true } // ملف اختفى — تجاهل
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
  return success({ query: query.trim(), count: symbols.length, truncated: !completed, symbols, source: 'walk' })
}

const SYNTAX_CHECK_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'])

/**
 * يضيف أخطاء الصياغة الفعلية (parse diagnostics) إلى نتيجة كتابة/تعديل ناجحة
 * حتى يراها النموذج ويصلحها في نفس الجولة بدل انتظار التحقق النهائي.
 * تفشل بصمت دائمًا — لا تعطل عملية كتابة ناجحة أبدًا.
 */
async function withSyntaxCheck(output: string, absPaths: string[]): Promise<string> {
  try {
    const errors: string[] = []
    for (const absPath of absPaths) {
      if (!SYNTAX_CHECK_EXTENSIONS.has(path.extname(absPath).toLowerCase())) continue
      const result = await syntaxDiagnostics(absPath)
      if (!result.ok) errors.push(...result.errors)
      if (errors.length >= 8) break
    }
    if (!errors.length) return output
    const parsed = JSON.parse(output) as { ok?: boolean; data?: Record<string, unknown> }
    if (parsed?.ok && parsed.data && typeof parsed.data === 'object') {
      parsed.data.syntaxCheck = { ok: false, errors, note: 'Syntax errors were introduced by this edit. Fix them now before continuing.' }
      return JSON.stringify(parsed, null, 2)
    }
    return output
  } catch { return output }
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
  const fullDiff = diffPreview(previous ?? '', content)
  const diff = isSensitive(relative) ? { ...fullDiff, text: '[محتوى ملف حساس محجوب]', truncated: false } : fullDiff
  return success({ path: relative, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), addedLines: diff.addedLines, removedLines: diff.removedLines, diff: diff.text, diffTruncated: diff.truncated })
}

async function editFile(target: string, relative: string, oldString: string, newString: string): Promise<string> {
  if (!oldString) throw new Error(`${EDIT_FILE_ERRORS.EMPTY_OLD_STRING.message}. ${EDIT_FILE_ERRORS.EMPTY_OLD_STRING.suggestion}`)
  const content = await fs.readFile(target, 'utf8')
  const applied = applyEdit(content, oldString, newString)
  await writeFileAtomic(target, relative, applied.content)
  const fullDiff = diffPreview(content, applied.content)
  const diff = isSensitive(relative) ? { ...fullDiff, text: '[محتوى ملف حساس محجوب]', truncated: false } : fullDiff
  return success({ path: relative, changed: true, startLine: applied.startLine, removedLines: diff.removedLines, addedLines: diff.addedLines, diff: diff.text, diffTruncated: diff.truncated, totalLines: applied.content.split('\n').length })
}

function applyEdit(content: string, oldString: string, newString: string): { content: string; startLine: number; removedLines: number; addedLines: number } {
  if (!oldString) throw new Error(EDIT_FILE_ERRORS.EMPTY_OLD_STRING.message)
  let matchStart = content.indexOf(oldString)
  let matchEnd = matchStart === -1 ? -1 : matchStart + oldString.length
  if (matchStart !== -1) {
    const exactCount = countOccurrences(content, oldString)
    if (exactCount > 1) throw new Error(`${EDIT_FILE_ERRORS.MULTIPLE_MATCHES.message} (${exactCount} مرات). ${EDIT_FILE_ERRORS.MULTIPLE_MATCHES.suggestion}`)
  } else {
    const range = findLineEndingMatch(content, oldString)
    if (range) { matchStart = range.start; matchEnd = range.end }
  }
  if (matchStart === -1 || matchEnd === -1) throw new Error(`${EDIT_FILE_ERRORS.NO_MATCH.message}. ${EDIT_FILE_ERRORS.NO_MATCH.suggestion}`)
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
  const fullDiff = diffPreview(content, applied.content)
  const diff = isSensitive(relative) ? { ...fullDiff, text: '[محتوى ملف حساس محجوب]', truncated: false } : fullDiff
  return success({ path: relative, patchesApplied: applied.applied.length, applied: applied.applied, addedLines: diff.addedLines, removedLines: diff.removedLines, totalLines: applied.content.split('\n').length, diff: diff.text, diffTruncated: diff.truncated })
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

function diffPreview(before: string, after: string): { text: string; truncated: boolean; addedLines: number; removedLines: number } {
  const oldLines = before === '' ? [] : before.split(/\r\n|\n|\r/)
  const newLines = after === '' ? [] : after.split(/\r\n|\n|\r/)
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
  return { text, truncated, addedLines: changedNew.length, removedLines: changedOld.length }
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
  if (name === 'run_powershell') return { detail: JSON.stringify({ tool: name, cwd: target.relative, command: input.command, rawCommand: input.rawCommand ?? input.command, timeoutMs: input.timeout_ms ?? 30_000 }, null, 2) }
  if (name === 'shell') return { detail: JSON.stringify({ tool: name, mode: 'persistent shell', command: input.command, rawCommand: input.rawCommand ?? input.command, timeoutMs: input.timeout_ms ?? 30_000 }, null, 2) }
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
    payload = extractContent(input)
    next = payload
  } else if (name === 'edit_file') {
    const applied = applyEdit(current ?? '', requiredString(input.old_string, 'old_string'), String(input.new_string ?? ''))
    payload = String(input.new_string ?? '')
    next = applied.content
  } else if (name === 'patch_file') {
    const patchesRaw = typeof input.patches === 'string' ? input.patches : JSON.stringify(Array.isArray(input.patches) ? input.patches : [])
    try { const applied = applyPatches(current ?? '', patchesRaw); payload = patchesRaw; next = applied.content } catch (error) { payload = patchesRaw; next = current ?? '' }
  } else if (name === 'append_file') {
    payload = extractContent(input)
    next = current ? `${current}${current.endsWith('\n') ? '' : '\n'}${payload}` : payload
  }
  const nextHash = hashText(next)
  const preview = sensitive ? { text: '[محتوى ملف حساس محجوب]', truncated: false } : diffPreview(current ?? '', next)
  const detail = JSON.stringify({ tool: name, target: target.relative, currentExists: current !== undefined, currentSha256: currentHash, newSha256: nextHash, contentBytes: Buffer.byteLength(next), diff: preview.text, diffTruncated: preview.truncated }, null, 2)
  const key = sensitive ? undefined : operationKey(name, target.relative, `${currentHash}:${hashText(payload)}`)
  return { detail, rememberKey: key, verify: async () => { const now = await readOptionalText(target.absolute); if (hashText(now) !== currentHash) throw new Error('تغير الملف بعد عرض المعاينة؛ أعد قراءة الملف واطلب العملية من جديد.') } }
}

const WEB_FETCH_TIMEOUT_MS = 30_000

/** جلب صفحة HTTPS عامة كنص — يُستخدم من web_fetch وweb_research معًا */
async function fetchPublicText(value: string, maxBytes: number, signal: AbortSignal, timeoutMs: number, deadlineAt?: number): Promise<{ url: string; contentType: string; bytes: number; truncated: boolean; text: string }> {
  const MAX_REDIRECTS = 2
  const remaining = deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, deadlineAt - Date.now())
  if (remaining <= 0) throw new Error('انتهى الوقت المتاح لجلب صفحة الويب')
  const controller = new AbortController()
  const fetchSignal = AbortSignal.any([signal, controller.signal])
  const fetchDeadlineAt = Date.now() + remaining
  const timeout = setTimeout(() => controller.abort(new Error('انتهت مهلة جلب صفحة الويب')), remaining)
  let url = new URL(value)
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password || isBlockedHost(url.hostname)) throw new Error('يسمح فقط بروابط HTTPS العامة دون بيانات دخول')
      let response: PublicHttpsResponse
      try {
        response = await requestPublicHttps(url, maxBytes, fetchSignal, fetchDeadlineAt)
      } catch (error) {
        if (controller.signal.aborted && !signal.aborted) throw new Error(`انتهت مهلة جلب صفحة الويب بعد ${Math.ceil(remaining / 1000)} ثانية`)
        if (!(error instanceof Error) || !(error as { redirectStatus?: number }).redirectStatus) throw error
        const location = String((error as { headers?: Record<string, string | string[] | undefined> }).headers?.['location'] ?? '')
        if (!location) throw new Error(`إعادة توجيه بلا وجهة من ${url.toString()}`)
        url = new URL(location, url)
        continue
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`فشل جلب الصفحة (${response.status})`)
      if (!/(?:text|json|xml|javascript)/i.test(response.contentType)) throw new Error(`نوع المحتوى غير مدعوم: ${response.contentType}`)
      const rawContent = response.body.toString('utf8')
      const text = /html/i.test(response.contentType) ? htmlToText(rawContent) : rawContent
      return { url: url.toString(), contentType: response.contentType, bytes: response.body.length, truncated: response.truncated, text }
    }
    throw new Error(`أكثر من ${MAX_REDIRECTS} إعادة توجيه متتالية؛ أوقف الجلب.`)
  } finally {
    clearTimeout(timeout)
  }
}

async function webFetch(value: string, maxBytes: number, signal: AbortSignal, deadlineAt?: number): Promise<string> {
  const page = await fetchPublicText(value, maxBytes, signal, WEB_FETCH_TIMEOUT_MS, deadlineAt)
  return success({ url: page.url, contentType: page.contentType, bytes: page.bytes, truncated: page.truncated, content: page.text })
}

// ─── Search Error Classification ────────────────────────────────────────
type SearchErrorKind = 'transient' | 'permanent' | 'unknown'
export function classifySearchError(error: unknown): SearchErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|ETIMEOUT|ECONNRESET|ECONNREFUSED|socket hang up|abort|cancel/i.test(message)) return 'transient'
  if (/\b429\b|\b503\b|\b502\b|\b504\b|rate.?limit|throttl/i.test(message)) return 'transient'
  if (/\b401\b|\b403\b|\b404\b|unauthorized|forbidden|not found|invalid.*key/i.test(message)) return 'permanent'
  if (/DNS lookup فشل|blocked address/i.test(message)) return 'permanent'
  return 'unknown'
}

// ─── Tavily Circuit Breaker ─────────────────────────────────────────────
export const tavilyCircuit = { consecutiveFailures: 0, openUntil: 0 }
export function tavilyAvailable(): boolean {
  if (tavilyCircuit.consecutiveFailures < 3) return true
  if (Date.now() > tavilyCircuit.openUntil) { tavilyCircuit.consecutiveFailures = 0; return true }
  return false
}
export function recordTavilyResult(success: boolean): void {
  if (success) { tavilyCircuit.consecutiveFailures = 0; return }
  tavilyCircuit.consecutiveFailures++
  if (tavilyCircuit.consecutiveFailures >= 3) tavilyCircuit.openUntil = Date.now() + 5 * 60_000
}

// ─── Bounded LRU Search Cache ───────────────────────────────────────────
const webSearchCache = new Map<string, { at: number; results: Array<{ title: string; url: string; snippet: string }> }>()
const WEB_SEARCH_CACHE_MAX = 50
const WEB_SEARCH_CACHE_MS = 10 * 60_000
const WEB_SEARCH_TIMEOUT_MS = 12_000
const WEB_SEARCH_COLLECTION_MS = 1_200

function getCachedSearch(cacheKey: string): Array<{ title: string; url: string; snippet: string }> | undefined {
  const cached = webSearchCache.get(cacheKey)
  if (!cached) return undefined
  if (Date.now() - cached.at > WEB_SEARCH_CACHE_MS) { webSearchCache.delete(cacheKey); return undefined }
  webSearchCache.delete(cacheKey)
  webSearchCache.set(cacheKey, cached)
  return cached.results
}

function setCachedSearch(cacheKey: string, results: Array<{ title: string; url: string; snippet: string }>): void {
  if (webSearchCache.size >= WEB_SEARCH_CACHE_MAX) {
    const first = webSearchCache.keys().next().value
    if (first) webSearchCache.delete(first)
  }
  webSearchCache.set(cacheKey, { at: Date.now(), results })
}

// ─── Arabic/Latin Normalization ─────────────────────────────────────────
export function normalizeSearchText(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[\u0610-\u061A\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0611\u0612\u0613\u0614\u064B-\u065F\u0670]/g, '')
    .replace(/[\u064E\u0650\u0652]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[\u0621\u0622\u0623\u0625]/g, '\u0627')
    .replace(/[\u0649]/g, '\u064A')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Provider Telemetry ─────────────────────────────────────────────────
export interface ProviderOutcome {
  provider: string
  status: 'success' | 'empty' | 'error' | 'timeout' | 'skipped' | 'unknown'
  attempts: number
  resultCount: number
  durationMs: number
  errorKind?: SearchErrorKind
  error?: string
}

interface SearchHit { title: string; url: string; snippet: string; provider?: string }
interface WebSearchProviderResult { provider: string; results: Array<{ title: string; url: string; snippet: string }>; answer?: string }

async function webSearch(query: string, maxResults: number, signal: AbortSignal, deadlineAt?: number, tavilyApiKey?: string): Promise<string> {
  const trimmed = query.trim()
  if (!trimmed) throw new Error('query لا يمكن أن يكون فارغًا')
  const cacheKey = `${normalizeSearchText(trimmed).slice(0, 300)}:${maxResults}`
  const cached = getCachedSearch(cacheKey)
  if (cached) return success({ query: trimmed, provider: 'cache', durationMs: 0, results: cached.slice(0, maxResults) })
  if (signal.aborted) throw new DOMException('تم إلغاء البحث', 'AbortError')

  const remaining = deadlineAt === undefined ? WEB_SEARCH_TIMEOUT_MS : Math.min(WEB_SEARCH_TIMEOUT_MS, deadlineAt - Date.now())
  if (remaining <= 0) throw new Error('انتهى الوقت المتاح للبحث بالويب')
  const startedAt = Date.now()
  const controller = new AbortController()
  const searchSignal = AbortSignal.any([signal, controller.signal])
  let timeout: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`انتهت مهلة البحث المشتركة بعد ${Math.ceil(remaining / 1000)} ثانية`)
      controller.abort(error)
      reject(error)
    }, remaining)
  })
  // امتصاص الرفض إن سبقه مزود — لا unhandled rejection في سجلات التطبيق
  timeoutPromise.catch(() => {})
  const errors: string[] = []
  const successfulResults: WebSearchProviderResult[] = []
  const providerOutcomes: ProviderOutcome[] = []

  const runProvider = async (provider: string, search: () => Promise<Array<{ title: string; url: string; snippet: string }> | { results: Array<{ title: string; url: string; snippet: string }>; answer?: string }>): Promise<WebSearchProviderResult> => {
    const providerStart = Date.now()
    let attempts = 0
    let lastError: unknown
    const maxAttempts = 2
    while (attempts < maxAttempts) {
      attempts++
      try {
        const raw = await search()
        const normalized = Array.isArray(raw) ? { results: raw } : raw
        // الإجابة الجاهزة (Tavily) تُحفظ حتى لو صُفيت كل النتائج — المعلومة الأدق
        const answer = normalized.answer?.trim() || undefined
        const results = normalized.results.filter((result) => isRelevantSearchResult(trimmed, result))
        if (!results.length && !answer) throw new Error('لم يُرجع نتائج قابلة للاستخدام')
        const result: WebSearchProviderResult = { provider, results, answer }
        successfulResults.push(result)
        providerOutcomes.push({ provider, status: 'success', attempts, resultCount: results.length, durationMs: Date.now() - providerStart })
        return result
      } catch (error) {
        lastError = error
        if (signal.aborted) throw new DOMException('تم إلغاء البحث', 'AbortError')
        const kind = classifySearchError(error)
        if (kind === 'permanent' || attempts >= maxAttempts) {
          const message = error instanceof Error ? error.message : String(error)
          errors.push(`${provider}: ${message}`)
          providerOutcomes.push({ provider, status: kind === 'permanent' ? 'error' : 'unknown', attempts, resultCount: 0, durationMs: Date.now() - providerStart, errorKind: kind, error: message.slice(0, 200) })
          throw error
        }
        // transient: brief abort-aware delay before retry
        try { await Promise.race([new Promise<void>((r) => setTimeout(r, 500)), new Promise<void>((_, rej) => { const onAbort = (): void => rej(new DOMException('تم إلغاء البحث', 'AbortError')); searchSignal.addEventListener('abort', onAbort, { once: true }); setTimeout(() => searchSignal.removeEventListener('abort', onAbort), 600) })]) } catch { if (signal.aborted) throw new DOMException('تم إلغاء البحث', 'AbortError') }
      }
    }
    // Should not reach here, but satisfy TypeScript
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown')
    providerOutcomes.push({ provider, status: 'error', attempts, resultCount: 0, durationMs: Date.now() - providerStart, errorKind: classifySearchError(lastError), error: message.slice(0, 200) })
    throw lastError instanceof Error ? lastError : new Error(message)
  }

  // مزودات مستقرة فقط: أزيل Bing RSS (أوقفت Bing المسار) وGoogle HTML (حجب دائم للـ scraping).
  // DuckDuckGo بنسختيه + Mojeek + Wikipedia دائمًا، وTavily في المقدمة عند توفر مفتاح صالح.
  const providers: Array<Promise<WebSearchProviderResult>> = [
    runProvider('DuckDuckGo', () => searchDuckDuckGo(trimmed, maxResults, searchSignal, deadlineAt)),
    runProvider('DuckDuckGo Instant', () => searchDuckDuckGoInstant(trimmed, maxResults, searchSignal, deadlineAt)),
    runProvider('Mojeek', () => searchMojeek(trimmed, maxResults, searchSignal, deadlineAt)),
    runProvider('Wikipedia', () => searchWikipedia(trimmed, maxResults, searchSignal, deadlineAt)),
  ]
  if (tavilyApiKey && tavilyAvailable()) providers.unshift(runProvider('Tavily', () => searchTavily(trimmed, maxResults, searchSignal, deadlineAt, tavilyApiKey)))

  try {
    const first = await Promise.race([Promise.any(providers), timeoutPromise])
    const collectionMs = Math.min(WEB_SEARCH_COLLECTION_MS, Math.max(0, remaining - (Date.now() - startedAt)))
    if (collectionMs > 0) await Promise.race([Promise.allSettled(providers), new Promise<void>((resolve) => setTimeout(resolve, collectionMs))])
    const completed = successfulResults.length ? successfulResults : [first]
    // نمرر اسم المزود مع كل نتيجة حتى تُطبق أوزان المزودات فعليًا في الترتيب
    const tagged: SearchHit[] = completed.flatMap((item) => item.results.map((result) => ({ ...result, provider: item.provider })))
    const results = rankSearchResults(trimmed, tagged).slice(0, maxResults)
    const answer = completed.find((item) => item.answer)?.answer
    setCachedSearch(cacheKey, results)
    recordTavilyResult(providerOutcomes.some((o) => o.provider === 'Tavily' && o.status === 'success'))
    return success({ query: trimmed, provider: [...new Set(completed.map((item) => item.provider))].join(', '), durationMs: Date.now() - startedAt, ...(answer ? { answer } : {}), results, providerOutcomes })
  } catch {
    if (signal.aborted) throw new DOMException('تم إلغاء البحث', 'AbortError')
    recordTavilyResult(providerOutcomes.some((o) => o.provider === 'Tavily' && o.status === 'success'))
    const timedOut = controller.signal.aborted
    throw new Error(`${timedOut ? `انتهت مهلة البحث بعد ${Math.ceil(remaining / 1000)} ثانية` : 'فشلت جميع مزودات البحث'}.\n${errors.join('\n')}`)
  } finally {
    if (timeout) clearTimeout(timeout)
    controller.abort()
  }
}

/**
 * بحث معمّق: يبحث ثم يفتح أفضل النتائج ويعيد نصوصها الفعلية.
 * يعالج مشكلة "نتائج البحث السيئة/غير الدقيقة" عبر إعطاء النموذج المحتوى الحقيقي
 * للصفحات (وليس مقتطفات قصيرة فقط) ليقرأها ويستشهد بها مباشرة.
 */
const WEB_RESEARCH_TOTAL_BUDGET_MS = 45_000
const WEB_RESEARCH_PAGE_TIMEOUT_MS = 18_000

async function webResearch(query: string, maxResults: number, fetchPages: number, signal: AbortSignal, deadlineAt?: number, tavilyApiKey?: string): Promise<string> {
  const startedAt = Date.now()
  // ميزانية صارمة لكل الأداة — لا تعليق مهما كان وضع الشبكة
  const hardDeadline = Math.min(deadlineAt ?? Number.POSITIVE_INFINITY, startedAt + WEB_RESEARCH_TOTAL_BUDGET_MS)

  // 1) البحث الأولي (يستفيد من كل المزودات + إجابة Tavily)
  let searchPayload: {
    ok?: boolean
    data?: { answer?: string; results?: Array<{ title: string; url: string; snippet: string; provider?: string }> }
    error?: { message?: string }
  }
  try {
    searchPayload = JSON.parse(await webSearch(query, Math.max(maxResults, 3), signal, hardDeadline, tavilyApiKey))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (signal.aborted) throw new DOMException('تم إلغاء البحث', 'AbortError')
    return createToolError('SEARCH_FAILED', `فشل البحث الأولي: ${message.slice(0, 400)}`, 'جرّب web_search بكلمات أقصر أو بالإنجليزية، ثم web_fetch لرابط محدد. إن كان لديك مفتاح Tavily في الإعدادات فسيحسن النتائج كثيرًا.')
  }
  if (searchPayload.ok !== true) return JSON.stringify(searchPayload, null, 2)
  const answer = searchPayload.data?.answer
  const candidates = searchPayload.data?.results ?? []
  const chosen = candidates.slice(0, Math.min(fetchPages, 3))

  // 2) فتح أفضل الصفحات بالتوازي وقراءة نصها الفعلي — بمهلة صفحة صارمة
  type ResearchPage = { url: string; title?: string; text?: string; truncated?: boolean; error?: string }
  const pages: ResearchPage[] = await Promise.all(chosen.map(async (result): Promise<ResearchPage> => {
    const pageBudget = Math.min(WEB_RESEARCH_PAGE_TIMEOUT_MS, hardDeadline - Date.now() - 1_500)
    if (pageBudget < 3_000) return { url: result.url, error: 'انتهت ميزانية البحث قبل قراءة الصفحة' }
    try {
      const page = await fetchPublicText(result.url, 250_000, signal, pageBudget, hardDeadline)
      return { url: page.url, title: result.title, text: page.text, truncated: page.truncated }
    } catch (error) {
      return { url: result.url, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }
    }
  }))

  const readable = pages.filter((page): page is ResearchPage & { text: string } => typeof page.text === 'string')
  const sources = readable.map((page) => ({
    url: page.url,
    title: page.title,
    truncated: page.truncated ?? false,
    // نص طويل يكفي للاستشهاد الدقيق دون تفجير السياق
    content: page.text.slice(0, 12_000),
  }))
  const failed = pages.filter((page): page is ResearchPage & { error: string } => typeof page.error === 'string')

  if (!sources.length && !answer) {
    return JSON.stringify({
      ok: false,
      error: { code: 'RESEARCH_NO_CONTENT', message: `لم أتمكن من قراءة أي صفحة من نتائج البحث.${failed.length ? `\nأسباب: ${failed.map((f) => `${f.url}: ${f.error}`).join(' | ')}` : ''}`, suggestion: 'جرّب web_search بكلمات مختلفة ثم web_fetch لرابط محدد.' },
    }, null, 2)
  }

  return success({
    query,
    durationMs: Date.now() - startedAt,
    ...(answer ? { answer } : {}),
    sources,
    ...(failed.length ? { skipped: failed.map((f) => ({ url: f.url, error: f.error })) } : {}),
    otherResults: candidates.slice(chosen.length, maxResults).map(({ title, url, snippet }) => ({ title, url, snippet })),
  })
}

export function rankSearchResults(query: string, results: SearchHit[]): SearchHit[] {
  const normalizedQuery = normalizeSearchText(query)
  const terms = [...new Set(normalizedQuery.match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
  const fullPhrase = normalizedQuery

  // Canonicalize URLs and dedup
  const seen = new Set<string>()
  const deduped: Array<SearchHit & { hostname: string }> = []
  for (const result of results) {
    let canonical: string
    try { canonical = new URL(result.url).hostname.toLowerCase() + new URL(result.url).pathname.replace(/\/+$/, '') } catch { canonical = result.url.replace(/\/$/, '').toLowerCase() }
    const hostKey = `${canonical}`
    if (seen.has(hostKey)) continue
    seen.add(hostKey)
    let hostname = ''
    try { hostname = new URL(result.url).hostname.toLowerCase() } catch { hostname = '' }
    deduped.push({ ...result, hostname })
  }

  // أوزان المزودات — تُطبق حسب المزود الفعلي لكل نتيجة (كانت تُطبق سابقًا للجميع عشوائيًا)
  const providerWeights: Record<string, number> = { 'Tavily': 1.0, 'Wikipedia': 0.7, 'DuckDuckGo': 0.6, 'DuckDuckGo Instant': 0.55, 'Mojeek': 0.5 }

  // Per-hostname cap
  const hostCounts = new Map<string, number>()
  const HOST_CAP = 2

  return deduped
    .map((result, index) => {
      const normalizedTitle = normalizeSearchText(result.title)
      const normalizedSnippet = normalizeSearchText(result.snippet)
      const normalizedUrl = normalizeSearchText(decodeURIComponentSafe(result.url))
      const normalizedHaystack = `${normalizedTitle} ${normalizedSnippet} ${normalizedUrl}`

      // Title score
      const titleScore = terms.reduce((score, term) => score + (normalizedTitle.includes(term) ? 3 : 0), 0)
      // Snippet score
      const snippetScore = terms.reduce((score, term) => score + (normalizedSnippet.includes(term) ? 1 : 0), 0)
      // URL score
      const urlScore = terms.reduce((score, term) => score + (normalizedUrl.includes(term) ? 1 : 0), 0)
      // Full phrase bonus
      const phraseScore = normalizedHaystack.includes(fullPhrase) ? 5 : 0

      const relevanceScore = (titleScore + snippetScore + urlScore) * 10 + phraseScore

      // Provider bonus — وزن المزود الحقيقي للنتيجة، وفقط للمقتطفات الغنية
      const weight = result.provider ? providerWeights[result.provider] ?? 0 : 0
      const providerBonus = result.snippet.length > 50 ? weight * 3 : 0

      const rawScore = relevanceScore + providerBonus - index * 0.1
      return { result, score: rawScore, hostname: result.hostname }
    })
    .filter((item) => {
      const count = hostCounts.get(item.hostname) ?? 0
      if (count >= HOST_CAP) return false
      hostCounts.set(item.hostname, count + 1)
      return true
    })
    .sort((a, b) => b.score - a.score)
    .map(({ result }) => { const { hostname: _hostname, ...rest } = result; return rest })
}

export function isRelevantSearchResult(query: string, result: { title: string; url: string; snippet: string }): boolean {
  const normalizedQuery = normalizeSearchText(query)
  const terms = normalizedQuery.match(/[\p{L}\p{N}]{2,}/gu) ?? []
  if (!terms.length) return true
  const haystack = normalizeSearchText(`${result.title} ${result.snippet} ${decodeURIComponentSafe(result.url)}`)
  return terms.some((term) => haystack.includes(term))
}

function decodeURIComponentSafe(value: string): string { try { return decodeURIComponent(value) } catch { return value } }

async function searchDuckDuckGo(query: string, maxResults: number, signal: AbortSignal, deadlineAt?: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  // النسخة الخفيفة أولًا: GET مستقر بلا صفحات تحدي/توجيه، ثم الكاملة احتياطًا
  try {
    const lite = await searchDuckDuckGoLite(query, maxResults, signal, deadlineAt)
    if (lite.length) return lite
  } catch { /* نجرّب النسخة الكاملة */ }
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

/** Mojeek — فهرس بحث مستقل بواجهة HTML ثابتة، مصدر إضافي خارج منظومة Google/Bing/DDG */
async function searchMojeek(query: string, maxResults: number, signal: AbortSignal, deadlineAt?: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = new URL('https://www.mojeek.com/search')
  url.searchParams.set('q', query.slice(0, 500))
  const response = await requestPublicHttps(url, 1_000_000, signal, deadlineAt)
  if (response.status < 200 || response.status >= 300) throw new Error(`فشل بحث Mojeek (${response.status})`)
  const html = response.body.toString('utf8')
  const listMatch = /<ul[^>]*class="[^"]*results-list[^"]*"[^>]*>([\s\S]*?)<\/ul>/i.exec(html)
  const blockHtml = listMatch?.[1] ?? html
  const results: Array<{ title: string; url: string; snippet: string }> = []
  for (const item of blockHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const link = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(item[1] ?? '')
    if (!link) continue
    const rawUrl = link[1] ?? ''
    if (!/^https:\/\//i.test(rawUrl)) continue
    const title = htmlToText(link[2] ?? '').trim()
    if (!title) continue
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(item[1] ?? '')
    results.push({ title: title.slice(0, 300), url: rawUrl, snippet: htmlToText(snippetMatch?.[1] ?? '').slice(0, 500) })
    if (results.length >= maxResults) break
  }
  return results
}

async function searchDuckDuckGoLite(query: string, maxResults: number, signal: AbortSignal, deadlineAt?: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = new URL('https://lite.duckduckgo.com/lite/')
  url.searchParams.set('q', query.slice(0, 500))
  const response = await requestPublicHttps(url, 1_000_000, signal, deadlineAt)
  if (response.status < 200 || response.status >= 300) throw new Error(`فشل البحث الخفيف (${response.status})`)
  const html = response.body.toString('utf8')
  const results: Array<{ title: string; url: string; snippet: string }> = []
  // روابط النتائج في lite تحمل uddg أيضًا عبر /l/?uddg=
  const linkMatcher = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetMatcher = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi
  const snippets = [...html.matchAll(snippetMatcher)].map((match) => htmlToText(match[1] ?? '').slice(0, 500))
  let snippetIndex = 0
  for (const match of html.matchAll(linkMatcher)) {
    const rawUrl = decodeRedirectUrl(match[1] ?? '')
    if (!/^https:\/\//i.test(rawUrl)) continue
    const title = htmlToText(match[2] ?? '').trim()
    if (!title) continue
    results.push({ title: title.slice(0, 300), url: rawUrl, snippet: snippets[snippetIndex++] ?? '' })
    if (results.length >= maxResults) break
  }
  return results
}

/** DuckDuckGo Instant Answer API — JSON مستقر لا يعتمد على scraping */
async function searchDuckDuckGoInstant(query: string, maxResults: number, signal: AbortSignal, deadlineAt?: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = new URL('https://api.duckduckgo.com/')
  url.searchParams.set('q', query.slice(0, 500))
  url.searchParams.set('format', 'json')
  url.searchParams.set('no_html', '1')
  url.searchParams.set('skip_disambig', '1')
  const response = await requestPublicHttps(url, 500_000, signal, deadlineAt)
  if (response.status < 200 || response.status >= 300) throw new Error(`فشل البحث الفوري (${response.status})`)
  const parsed = JSON.parse(response.body.toString('utf8')) as {
    AbstractText?: string; Abstract?: string; AbstractURL?: string; Heading?: string
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
  }
  const results: Array<{ title: string; url: string; snippet: string }> = []
  if (parsed.AbstractText && parsed.AbstractURL) {
    results.push({ title: (parsed.Heading || parsed.Abstract || query).slice(0, 300), url: parsed.AbstractURL, snippet: parsed.AbstractText.slice(0, 500) })
  }
  for (const topic of parsed.RelatedTopics ?? []) {
    if (results.length >= maxResults) break
    const items = topic.Text && topic.FirstURL ? [topic] : topic.Topics ?? []
    for (const item of items) {
      if (results.length >= maxResults) break
      if (!item.Text || !item.FirstURL || !/^https:\/\//i.test(item.FirstURL)) continue
      results.push({ title: item.Text.slice(0, 80), url: item.FirstURL, snippet: item.Text.slice(0, 500) })
    }
  }
  return results
}

async function searchWikipedia(query: string, maxResults: number, signal: AbortSignal, deadlineAt?: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const language = /[\u0600-\u06ff]/.test(query) ? 'ar' : 'en'
  const url = new URL(`https://${language}.wikipedia.org/w/api.php`)
  url.searchParams.set('action', 'query')
  url.searchParams.set('generator', 'search')
  url.searchParams.set('gsrsearch', query.slice(0, 300))
  url.searchParams.set('gsrlimit', String(Math.min(maxResults, 10)))
  url.searchParams.set('prop', 'extracts|info')
  url.searchParams.set('exintro', '1')
  url.searchParams.set('explaintext', '1')
  url.searchParams.set('inprop', 'url')
  url.searchParams.set('format', 'json')
  url.searchParams.set('origin', '*')
  const response = await requestPublicHttps(url, 1_000_000, signal, deadlineAt)
  if (response.status < 200 || response.status >= 300) throw new Error(`فشل بحث Wikipedia (${response.status})`)
  const parsed = JSON.parse(response.body.toString('utf8')) as { query?: { pages?: Record<string, { title?: string; extract?: string; fullurl?: string; index?: number }> } }
  return Object.values(parsed.query?.pages ?? {}).sort((a, b) => (a.index ?? 999) - (b.index ?? 999)).map((page) => ({ title: page.title ?? '', url: page.fullurl ?? '', snippet: (page.extract ?? '').slice(0, 500) })).filter((result) => result.title && /^https:\/\//i.test(result.url)).slice(0, maxResults)
}

async function searchTavily(query: string, maxResults: number, signal: AbortSignal, deadlineAt: number | undefined, apiKey: string): Promise<{ results: Array<{ title: string; url: string; snippet: string }>; answer?: string }> {
  const remaining = deadlineAt === undefined ? 15_000 : Math.min(15_000, deadlineAt - Date.now())
  if (remaining <= 0) throw new Error('انتهى الوقت المتاح لطلب Tavily')
  // advanced + include_answer: يعيد إجابة مركبة من المصادر — أدق من مقتطفات وحدها
  const bodyStr = JSON.stringify({ query: query.slice(0, 500), max_results: Math.min(maxResults, 10), search_depth: 'advanced', include_answer: true })
  const bodyBuf = Buffer.from(bodyStr, 'utf8')
  const url = new URL('https://api.tavily.com/search')
  const addresses = await boundedDnsLookup(url.hostname, signal, Math.min(DNS_LOOKUP_TIMEOUT_MS, Math.max(1_000, remaining)))
  if (signal.aborted) throw new DOMException('تم إلغاء طلب Tavily', 'AbortError')
  if (addresses.some((item) => isBlockedAddress(item.address))) throw new Error('Tavily DNS resolved to a blocked address')
  const selected = addresses[0]!
  return new Promise((resolve, reject) => {
    let settled = false
    const chunks: Buffer[] = []
    let bytes = 0
    const maxBytes = 500_000
    let timeout: NodeJS.Timeout
    const cleanup = (): void => { clearTimeout(timeout); signal.removeEventListener('abort', abort) }
    const fail = (error: Error): void => { if (settled) return; settled = true; cleanup(); reject(error) }
    const request = httpsRequest({ host: selected.address, hostname: url.hostname, port: 443, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}`, 'content-length': bodyBuf.length }, servername: url.hostname }, (response) => {
      const status = response.statusCode ?? 0
      if (status === 401) { response.resume(); fail(new Error('مفتاح Tavily غير صالح')); return }
      if (status !== 200) { response.resume(); fail(new Error(`Tavily: ${status}`)); return }
      const finish = (): void => {
        if (settled) return; settled = true; cleanup()
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { results?: Array<{ title?: string; url?: string; content?: string }>; answer?: string }
          const results = (parsed.results ?? []).map((r) => ({ title: (r.title ?? '').slice(0, 300), url: r.url ?? '', snippet: (r.content ?? '').slice(0, 500) })).filter((r) => /^https:\/\//i.test(r.url)).slice(0, maxResults)
          const answer = typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim().slice(0, 2_000) : undefined
          resolve({ results, answer })
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))) }
      }
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        const available = maxBytes - bytes
        // نفس إصلاح web_fetch: إنهاء الوعد صراحة عند الاكتفاء بدل الاعتماد على أحداث destroy
        if (available <= 0) { response.destroy(); finish(); return }
        chunks.push(chunk.subarray(0, available)); bytes += Math.min(chunk.length, available)
        if (chunk.length > available) { response.destroy(); finish() }
      })
      response.on('end', finish)
      response.on('error', finish)
      response.on('close', finish)
    })
    const abort = (): void => { request.destroy(new DOMException('تم إلغاء طلب Tavily', 'AbortError')) }
    timeout = setTimeout(() => request.destroy(new Error('انتهت مهلة طلب Tavily')), remaining)
    signal.addEventListener('abort', abort, { once: true })
    request.on('error', fail)
    request.write(bodyBuf)
    request.end()
  })
}

interface PublicHttpsResponse { status: number; contentType: string; headers: Record<string, string | string[] | undefined>; body: Buffer; truncated: boolean }

const DNS_LOOKUP_TIMEOUT_MS = 8_000

/**
 * DNS محصّن: مهلة صارمة + إلغاء + تفضيل IPv4.
 * dns.lookup بلا مهلة كان يجمّد خيوط libuv الأربعة عند بطء/فقدان خادم DNS
 * فيعلق التطبيق كله (كل عمليات الملفات تمر بنفس المجمع).
 */
async function boundedDnsLookup(hostname: string, signal: AbortSignal, timeoutMs = DNS_LOOKUP_TIMEOUT_MS): Promise<Array<{ address: string; family: number }>> {
  if (signal.aborted) throw new DOMException('تم إلغاء طلب الويب', 'AbortError')
  let timer: NodeJS.Timeout | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(new DOMException('تم إلغاء طلب الويب', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`انتهت مهلة DNS لـ ${hostname} (${Math.round(timeoutMs / 1000)}ث)`)), timeoutMs)
  })
  try {
    const addresses = await Promise.race([lookup(hostname, { all: true }), abortPromise, timeoutPromise])
    if (!addresses.length) throw new Error(`DNS لم يعد عناوين لـ ${hostname}`)
    // IPv4 أولًا: مسارات IPv6 المكسورة شائعة وتعليق الاتصال حتى المهلة
    return [...addresses].sort((a, b) => a.family - b.family)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function requestPublicHttps(url: URL, maxBytes: number, signal: AbortSignal, deadlineAt?: number): Promise<PublicHttpsResponse> {
  if (signal.aborted) throw new DOMException('تم إلغاء طلب الويب', 'AbortError')
  const remaining = deadlineAt === undefined ? 30_000 : deadlineAt - Date.now()
  if (remaining <= 0) throw new Error('انتهى الوقت المتاح لطلب الويب')
  // ─── DNS lookup بمهلة صارمة وإلغاء فوري ───
  const dnsBudget = Math.min(DNS_LOOKUP_TIMEOUT_MS, Math.max(1_000, remaining))
  const addresses = await boundedDnsLookup(url.hostname, signal, dnsBudget)
  if (signal.aborted) throw new DOMException('تم إلغاء طلب الويب', 'AbortError')
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
    const request = httpsRequest({ host: selected.address, hostname: url.hostname, port: 443, path: url.pathname + url.search, method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }, servername: url.hostname }, (response) => {
      const status = response.statusCode ?? 0
      const contentType = String(response.headers['content-type'] ?? '')
      if (status >= 300 && status < 400) { const headers = response.headers as Record<string, string | string[] | undefined>; response.resume(); fail(Object.assign(new Error('REDIRECT'), { redirectStatus: status, headers })); return }
      const finish = (): void => { if (settled) return; settled = true; cleanup(); resolve({ status, contentType, headers: response.headers as Record<string, string | string[] | undefined>, body: Buffer.concat(chunks), truncated }) }
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        const available = maxBytes - bytes
        // حرج: عند الاكتفاء نُنهي الوعد مباشرة — destroy() وحده لا يطلق end/error
        // في Node الحديثة فكان الوعد يبقى معلقًا للأبد (تعليق web_fetch/web_research).
        if (available <= 0) { truncated = true; response.destroy(); finish(); return }
        chunks.push(chunk.subarray(0, available)); bytes += Math.min(chunk.length, available)
        if (chunk.length > available) { truncated = true; response.destroy(); finish(); return }
      })
      response.on('end', finish)
      response.on('error', (error) => truncated ? finish() : fail(error))
      // شبكة أمان: close ينطلق دائمًا عند تدمير البث لأي سبب
      response.on('close', finish)
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
  if (!message.trim()) throw new Error('رسالة commit لا يمكن أن تكون فارغة.\n💡 اكتب رسالة وصفية للتغييرات التي قمت بها.')
  if (all) await runGit(['add', '--all'], cwd, signal, trackProcess, deadlineAt)
  return success({ output: await runGit(['-c', 'user.name=Code Agent', '-c', 'user.email=rahma@local', 'commit', '--message', message.slice(0, 500)], cwd, signal, trackProcess, deadlineAt) })
}

async function gitRevert(cwd: string, commit: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  const hash = commit.trim()
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('commit يجب أن يكون hash صالحًا من 7 إلى 40 خانة.\n💡 استخدم git_log لرؤية قائمة الـ commits المتاحة.')
  const output = await runGit(['-c', 'user.name=Code Agent', '-c', 'user.email=rahma@local', 'revert', '--no-edit', hash], cwd, signal, trackProcess, deadlineAt)
  const revertCommit = (await runGit(['rev-parse', 'HEAD'], cwd, signal, trackProcess, deadlineAt)).trim()
  return success({ reverted: hash, revertCommit, output })
}

async function gitRevertStep(cwd: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  const head = (await runGit(['rev-parse', 'HEAD'], cwd, signal, trackProcess, deadlineAt)).trim()
  const headMessage = (await runGit(['log', '-1', '--pretty=%s'], cwd, signal, trackProcess, deadlineAt)).replace(/^\uFEFF/, '').trim()
  if (!headMessage.startsWith('تلقائي [')) throw new Error('آخر commit ليس تلقائيًا (gitAutoCommit)؛ استخدم git_revert مع hash محدد.')
  const output = await runGit(['-c', 'user.name=Code Agent', '-c', 'user.email=rahma@local', 'revert', '--no-edit', head], cwd, signal, trackProcess, deadlineAt)
  const revertCommit = (await runGit(['rev-parse', 'HEAD'], cwd, signal, trackProcess, deadlineAt)).trim()
  return success({ revertedStep: head, revertCommit, revertedMessage: headMessage, output })
}

async function deleteFile(target: string, relative: string): Promise<string> {
  const stat = await fs.lstat(target)
  if (stat.isDirectory()) throw new Error('delete_file يحذف الملفات فقط؛ لا يحذف المجلدات.\n💡 لحذف مجلد، استخدم shell بأمرRemove-Item -Recurse.')
  if (stat.isSymbolicLink()) throw new Error('لا يسمح بحذف روابط رمزية عبر delete_file.\n💡 لحذف الروابط الرمزية، استخدم shell بأمر Remove-Item.')
  await fs.rm(target, { force: false })
  return success({ path: relative, deleted: true })
}

async function moveFile(root: string, fromInput: string, toInput: string): Promise<string> {
  const source = await resolveExisting({ canonical: root }, fromInput)
  const sourceStat = await fs.lstat(source.absolute)
  if (sourceStat.isDirectory()) throw new Error('move_file ينقل الملفات فقط؛ لا ينقل المجلدات.\n💡 لنقل مجلد، استخدم shell بأمر Move-Item.')
  if (sourceStat.isSymbolicLink()) throw new Error('لا يسمح بنقل روابط رمزية عبر move_file.\n💡 لنقل الروابط الرمزية، استخدم shell.')
  const destination = await resolveCreatable({ canonical: root }, toInput)
  if (sameFilesystemPath(source.absolute, destination.absolute)) throw new Error('المصدر والوجهة متطابقان.\n💡 تأكد من أن المسارين مختلفين.')
  const existing = await fs.lstat(destination.absolute).catch(() => null)
  if (existing) throw new Error(`الوجهة موجودة بالفعل: ${destination.relative}\n💡 استخدم اسماً مختلفاً أو احذف الملف الوجهة أولاً.`)
  await fs.mkdir(path.dirname(destination.absolute), { recursive: true })
  await fs.rename(source.absolute, destination.absolute)
  return success({ from: source.relative, to: destination.relative, moved: true })
}

async function appendFile(target: string, relative: string, content: string): Promise<string> {
  if (!content) throw new Error('content لا يمكن أن يكون فارغًا')
  const previous = await readOptionalText(target)
  const next = previous ? `${previous}${previous.endsWith('\n') ? '' : '\n'}${content}` : content
  await writeFileAtomic(target, relative, next)
  const stats = diffPreview(previous ?? '', next)
  return success({ path: relative, appendedBytes: Buffer.byteLength(content), totalBytes: Buffer.byteLength(next), addedLines: stats.addedLines, removedLines: stats.removedLines })
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

async function gitShow(cwd: string, spec: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> { const value = safeGitValue(spec, 'spec'); return success({ output: await runGit(['show', '--no-ext-diff', '--unified=3', value.slice(0, 500)], cwd, signal, trackProcess, deadlineAt) }) }

async function gitAdd(cwd: string, files: string, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  const paths = [...new Set(files.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
  if (!paths.length) throw new Error('files لا يمكن أن يكون فارغًا')
  return success({ output: await runGit(['add', '--', ...paths.slice(0, 100)], cwd, signal, trackProcess, deadlineAt) })
}

async function gitFetch(cwd: string, remote: string | undefined, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  return success({ output: await runGit(['fetch', '--prune', ...(remote ? [safeGitValue(remote, 'remote')] : [])], cwd, signal, trackProcess, deadlineAt) })
}

async function gitPull(cwd: string, remote: string | undefined, branch: string | undefined, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  return success({ output: await runGit(['pull', ...(remote ? [safeGitValue(remote, 'remote')] : []), ...(branch ? [safeGitValue(branch, 'branch')] : [])], cwd, signal, trackProcess, deadlineAt) })
}

async function gitPush(cwd: string, remote: string | undefined, branch: string | undefined, signal: AbortSignal, trackProcess?: (child: import('child_process').ChildProcess) => void, deadlineAt?: number): Promise<string> {
  return success({ output: await runGit(['push', ...(remote ? [safeGitValue(remote, 'remote')] : []), ...(branch ? [safeGitValue(branch, 'branch')] : [])], cwd, signal, trackProcess, deadlineAt) })
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
  return success({ output: await runGit(['checkout', safeGitValue(branch, 'branch').slice(0, 500)], cwd, signal, trackProcess, deadlineAt) })
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
    await runGitQuiet(['-c', 'user.name=Code Agent', '-c', 'user.email=rahma@local', 'commit', '--only', '--message', `تلقائي [${action}] ${paths.join(', ')}`.slice(0, 200), '--', ...paths], repoRoot, gitOptions)
    return { enabled: true, committed: true, commit: (await runGitQuiet(['rev-parse', 'HEAD'], repoRoot, gitOptions)).trim(), paths }
  } catch (error) { return { enabled: true, committed: false, paths, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) } }
}

export function withAutoCommit(output: string, gitAutoCommit: AutoCommitResult | undefined): string {
  if (!gitAutoCommit) return output
  try { const parsed = JSON.parse(output) as { ok?: boolean; data?: unknown }; if (parsed.ok && parsed.data && typeof parsed.data === 'object') return success({ ...(parsed.data as Record<string, unknown>), gitAutoCommit }) } catch {}
  return output
}

async function commitBulkFiles(items: Array<{ target: ResolvedPath; before: string; after: string }>): Promise<void> {
  const staged: Array<{ item: typeof items[number]; temporary: string; backup: string; committed: boolean }> = []
  try {
    for (const item of items) {
      const temporary = `${item.target.absolute}.r-code-${randomBytes(8).toString('hex')}.tmp`
      const backup = `${item.target.absolute}.r-code-${randomBytes(8).toString('hex')}.bak`
      const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try { await handle.writeFile(item.after, 'utf8'); await handle.sync() } finally { await handle.close() }
      staged.push({ item, temporary, backup, committed: false })
    }
    for (const entry of staged) {
      await fs.rename(entry.item.target.absolute, entry.backup)
      try { await fs.rename(entry.temporary, entry.item.target.absolute); entry.committed = true }
      catch (error) { await fs.rename(entry.backup, entry.item.target.absolute); throw error }
    }
    await Promise.all(staged.map((entry) => fs.rm(entry.backup, { force: true })))
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      await fs.rm(entry.temporary, { force: true }).catch(() => {})
      if (entry.committed) {
        await fs.rm(entry.item.target.absolute, { force: true }).catch(() => {})
        await fs.rename(entry.backup, entry.item.target.absolute).catch(() => {})
      }
    }
    throw error
  }
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
    await runGitQuiet(['-c', 'user.name=Code Agent', '-c', 'user.email=rahma@local', 'commit', '--allow-empty', '--message', 'بداية المشروع: قاعدة أولية'], root.canonical, { timeoutMs: 120_000 })
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
export function htmlToText(value: string): string {
  // Non-HTML passthrough
  if (!/<[a-z]/i.test(value)) return value
  // Strip comments, scripts, styles, noscript, svg, template + interactive boilerplate
  let cleaned = value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(form|iframe|button|select|dialog)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<input[^>]*>/gi, ' ')
  // Try semantic extraction: article, main, role=main
  const semanticTags = [
    { open: /<article[^>]*>/i, close: /<\/article>/i },
    { open: /<main[^>]*>/i, close: /<\/main>/i },
    { open: /<div[^>]*role=["']main["'][^>]*>/i, close: /<\/div>/i },
  ]
  let semanticContent = ''
  for (const tag of semanticTags) {
    const openMatch = tag.open.exec(cleaned)
    if (!openMatch) continue
    const startIdx = openMatch.index
    const rest = cleaned.slice(startIdx + openMatch[0].length)
    const closeMatch = tag.close.exec(rest)
    if (closeMatch) {
      semanticContent = rest.slice(0, closeMatch.index)
      break
    }
  }
  // Fallback: use full cleaned HTML
  if (!semanticContent || semanticContent.length < 100) semanticContent = cleaned
  // Remove nav/footer/header/aside from semantic content
  const cleaned2 = semanticContent
    .replace(/<(nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, '')
  // Convert block elements to newlines; headings keep a marker for structure
  let result = cleaned2
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, '\n## ')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|main|blockquote|pre|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  result = decodeHtmlEntities(result)
  result = result.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
  // إزالة الأسطر المكررة المتتالية (قوائم تنقل مكررة في القوالب)
  const lines = result.split('\n')
  const deduped: string[] = []
  for (const line of lines) {
    const trimmedLine = line.trim()
    if (trimmedLine && deduped.length && deduped[deduped.length - 1]!.trim() === trimmedLine) continue
    deduped.push(line)
  }
  return deduped.join('\n')
}
function decodeHtmlEntities(value: string): string { const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }; return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => { if (entity[0] === '#') { const hex = entity[1]?.toLowerCase() === 'x'; const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10); return Number.isFinite(code) ? String.fromCodePoint(code) : ' ' } return named[entity.toLowerCase()] ?? ' ' }) }

function isSensitive(value: string): boolean { const normalized = value.replaceAll('\\', '/'); return /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|ed25519)|credentials|auth\.json|provider\.json|kubeconfig)(?:$|\/)/i.test(normalized) || /(?:^|\/)(?:\.ssh|\.aws|\.azure)(?:\/|$)/i.test(normalized) }
function isCriticalCommand(command: string): boolean { return /(?:Remove-Item\s+.*(?:-Recurse|-Force)|Format-Volume|Clear-Disk|Stop-Computer|Restart-Computer|Set-MpPreference|reg(?:\.exe)?\s+delete|diskpart|bcdedit|cipher\s+\/w|taskkill\s+.*\/f)/i.test(command) }
function safeEnvironment(): NodeJS.ProcessEnv {
  // Filter PATH to only include safe system directories
  const rawPath = process.env.PATH ?? ''
  const safePath = rawPath.split(';').filter((entry) => {
    const lower = entry.toLowerCase().trim()
    if (!lower) return false
    // Allow Windows system dirs, user profile, and common dev tools
    return lower.startsWith('c:\\windows') || lower.startsWith('c:\\program files') ||
      lower.includes('\\nodejs') || lower.includes('\\npm') || lower.includes('\\pnpm') ||
      lower.includes('\\yarn') || lower.includes('\\python') || lower.includes('\\go\\') ||
      lower.includes('\\cargo') || lower.includes('\\rustup') || lower.includes('\\java') ||
      lower.includes('\\.cargo\\bin') || lower.includes('\\.local\\bin') ||
      lower.includes('\\git\\') || lower.includes('\\usr\\local') || lower.includes('\\usr\\bin')
  }).join(';')
  return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: safePath || rawPath, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT }
}
function success(data: unknown): string { return JSON.stringify({ ok: true, data }, null, 2) }
function failure(code: string, message: string): string { return JSON.stringify({ ok: false, error: { code, message } }, null, 2) }
function requiredString(value: unknown, field: string): string { if (typeof value !== 'string') throw new Error(`${field} يجب أن يكون نصًا`); return value }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function pathList(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').join('\n') || undefined
  return undefined
}
function extractContent(input: Record<string, unknown>): string {
  const raw = input.content ?? input.text ?? input.data ?? input.body ?? input.value
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')
  if (raw !== undefined && raw !== null) return String(raw)
  throw new Error('الحقل المطلوب مفقود: content — أرسل المحتوى في حقل content')
}
function number(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number { const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback; return Math.min(max, Math.max(min, parsed)) }
function globRegex(pattern: string): RegExp { let source = '^'; for (let i = 0; i < pattern.length; i++) { const char = pattern[i]!; if (char === '*') { if (pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?' } else source += '.*' } else source += '[^/]*' } else if (char === '?') source += '[^/]' ; else source += escapeRegex(char) } return new RegExp(`${source}$`, 'i') }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition { return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } } }
function str(description: string): Record<string, unknown> { return { type: 'string', description } }
function nonEmptyString(description: string): Record<string, unknown> { return { type: 'string', description, minLength: 1 } }
function enumString(values: string[]): Record<string, unknown> { return { type: 'string', enum: values } }
function stringOrArray(description: string): Record<string, unknown> { return { description, anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }
function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> { return { type: 'object', properties, required, additionalProperties: false } }
function arr(description: string, items: Record<string, unknown> = {}, minItems?: number, maxItems?: number): Record<string, unknown> { return { type: 'array', description, items, ...(minItems !== undefined ? { minItems } : {}), ...(maxItems !== undefined ? { maxItems } : {}) } }
function bool(description: string): Record<string, unknown> { return { type: 'boolean', description } }
function integer(description: string, minimum: number, maximum?: number): Record<string, unknown> { return { type: 'integer', description, minimum, ...(maximum ? { maximum } : {}) } }

function sameFilesystemPath(first: string, second: string): boolean {
  const a = path.resolve(first)
  const b = path.resolve(second)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function safeGitValue(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('-') || /[\r\n\0]/.test(trimmed)) throw new Error(`${field} غير صالح`)
  return trimmed
}
