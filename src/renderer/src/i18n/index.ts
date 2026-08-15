/**
 * i18n Configuration (P1-03)
 * يدعم العربية (افتراضي) والإنجليزية مع RTL/LTR تلقائي
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

// النصوص العربية — المفاتيح الافتراضية (إذا لم يجد الترجمة، يعرض المفتاح نفسه)
const ar = {
  app: {
    title: 'Code Agent',
    tagline: 'وكيلك البرمجي المحلي · جاهز للعمل',
    subtitle: 'اجعل <0>عملك البرمجي</0> أسرع وأسهل',
    description: 'حلّل مشروعك، اكتب كودًا نظيفًا، نفّذ أدوات آمنة، وراجع الملفات — كل ذلك من محادثة واحدة.',
  },
  sidebar: {
    newTask: 'مهمة جديدة',
    openProject: 'فتح مشروع',
    search: 'بحث',
    projects: 'المشاريع والجلسات',
    files: 'ملفات المشروع',
    loadingFiles: 'جارٍ تحميل ملفات المشروع...',
    agents: 'الوكلاء',
    settings: 'الإعدادات',
    ready: 'جاهز',
    required: 'مطلوب',
    version: 'نسخة التطبيق',
    deleteAll: 'حذف جميع المحادثات',
    deleteConfirm: 'حذف جميع المحادثات ({{count}}) نهائيًا؟ لا يمكن التراجع.',
    deleteSession: 'حذف المحادثة "{{title}}" نهائيًا؟ لا يمكن التراجع.',
  },
  topbar: {
    plan: 'خطة العمل',
    build: 'Build',
    plan_mode: 'Plan',
    askMode: 'اسألني',
    fullAccess: 'وصول كامل',
    gitOn: 'Git مفعّل',
    gitOff: 'Git مققل',
    promptSaved: 'Prompt محفوظ',
    deleteChat: 'حذف المحادثة',
  },
  composer: {
    placeholder: 'أرسل رسالة... Shift+Enter لسطر جديد | الصق صورة من الحافظة',
    placeholderRunning: 'اكتب رسالة وستصل في الجولة التالية...',
    placeholderStopping: 'جارٍ إيقاف التنفيذ...',
    lines: 'سطر',
    context: 'السياق',
    contextEstimated: '{{pct}}% تقريبي',
    contextUnknown: 'السياق غير محسوب',
    input: 'إدخال',
    output: 'إخراج',
    compacted: 'تم تلخيص السياق',
    send: 'إرسال',
    attach: 'إرفاق ملف',
    systemPrompt: 'تعليمات النظام (Prompt) — تحفظ تلقائيًا وتبقى فعّالة طوال الجلسة',
    systemPromptPlaceholder: 'مثال: لا تحذف أي ملف إلا بعد التأكيد. استخدم Git في كل تعديل. اكتب تعليقات بالعربية...',
    chooseFolder: 'اختر مجلد المشروع للبدء',
  },
  message: {
    thinking: 'يجهز الرد',
    thought: 'Thought',
    copied: 'تم النسخ',
    copy: 'نسخ',
    edit: 'تعديل الرسالة',
    regenerate: 'إعادة توليد',
    interrupted: 'تم الإيقاف',
    incomplete: 'رد غير مكتمل بسبب فشل المزود',
  },
  tool: {
    running: 'الأمر يعمل... لم يصل إخراج بعد',
    completed: 'تم التنفيذ بنجاح',
    cancelled: 'تم الإلغاء',
    denied: 'تم رفض العملية',
    failed: 'تعذر إكمال الأداة',
    undo: 'تم إرجاع آخر تعديل',
    undoing: 'جاري الإرجاع...',
    undoFailed: 'فشل الإرجاع',
    restored: 'تم استعادة المحتوى كما كان بالضبط',
    fetching: 'جاري جلب البيانات من الويب...',
    fetchFailed: 'فشل الاتصال بالموقع',
    searchResults: 'نتائج البحث',
    truncated: 'مقتطع',
  },
  approval: {
    title: 'طلب موافقة',
    position: 'طلب {{current}} من {{total}}',
    allow: 'السماح',
    deny: 'رفض',
    remember: 'تذكر القرار لبقية الجلسة',
  },
  errors: {
    apiKeyRequired: 'أضف مفتاح API من الإعدادات أولًا',
    generic: 'حدث خطأ غير معروف',
    runtime: 'فشل التنفيذ',
  },
  quickPrompts: {
    analyze: 'حلل بنية هذا المشروع',
    countLines: 'احسب أسطر المشروع واشرح أهم الملفات',
    review: 'راجع المشروع واكتشف الأخطاء ثم أصلحها',
  },
  session: {
    newChat: 'محادثة جديدة',
    interrupted: 'توقف التشغيل السابق عند الجولة {{step}}.',
    resume: 'استئناف التنفيذ',
    jumpLatest: 'أحدث الرسائل',
  },
  plan: {
    title: 'خطة العمل',
    currentStep: 'الخطوة الحالية',
    approve: 'اعتماد الخطة والانتقال إلى Build',
  },
  subagents: {
    running: 'وكيل فرعي يعمل...',
    completed: 'وكيل فرعي مكتمل',
    failed: 'وكيل فرعي فشل',
  },
}

const en: typeof ar = {
  app: {
    title: 'Code Agent',
    tagline: 'Your Local Coding Agent · Ready to Work',
    subtitle: 'Make your <0>coding work</0> faster and easier',
    description: 'Analyze your project, write clean code, execute safe tools, and review files — all from one conversation.',
  },
  sidebar: {
    newTask: 'New Task',
    openProject: 'Open Project',
    search: 'Search',
    projects: 'Projects & Sessions',
    files: 'Project Files',
    loadingFiles: 'Loading project files...',
    agents: 'Agents',
    settings: 'Settings',
    ready: 'Ready',
    required: 'Required',
    version: 'App Version',
    deleteAll: 'Delete All Sessions',
    deleteConfirm: 'Delete all sessions ({{count}}) permanently? This cannot be undone.',
    deleteSession: 'Delete session "{{title}}" permanently? This cannot be undone.',
  },
  topbar: {
    plan: 'Plan',
    build: 'Build',
    plan_mode: 'Plan',
    askMode: 'Ask Me',
    fullAccess: 'Full Access',
    gitOn: 'Git On',
    gitOff: 'Git Off',
    promptSaved: 'Prompt Saved',
    deleteChat: 'Delete Chat',
  },
  composer: {
    placeholder: 'Send a message... Shift+Enter for new line | Paste image from clipboard',
    placeholderRunning: 'Type a message and it will arrive in the next round...',
    placeholderStopping: 'Stopping execution...',
    lines: 'lines',
    context: 'Context',
    contextEstimated: '~{{pct}}%',
    contextUnknown: 'Context unknown',
    input: 'Input',
    output: 'Output',
    compacted: 'Context compacted',
    send: 'Send',
    attach: 'Attach file',
    systemPrompt: 'System Instructions (Prompt) — saved automatically and active throughout the session',
    systemPromptPlaceholder: 'Example: Do not delete files without confirmation. Use Git for every edit. Write comments in English...',
    chooseFolder: 'Choose project folder to start',
  },
  message: {
    thinking: 'Preparing response',
    thought: 'Thought',
    copied: 'Copied',
    copy: 'Copy',
    edit: 'Edit message',
    regenerate: 'Regenerate',
    interrupted: 'Stopped',
    incomplete: 'Incomplete response due to provider failure',
  },
  tool: {
    running: 'Working... no output yet',
    completed: 'Completed successfully',
    cancelled: 'Cancelled',
    denied: 'Operation denied',
    failed: 'Tool failed',
    undo: 'Last edit undone',
    undoing: 'Undoing...',
    undoFailed: 'Undo failed',
    restored: 'Content restored exactly as before',
    fetching: 'Fetching data from web...',
    fetchFailed: 'Failed to connect to website',
    searchResults: 'Search Results',
    truncated: 'truncated',
  },
  approval: {
    title: 'Approval Request',
    position: 'Request {{current}} of {{total}}',
    allow: 'Allow',
    deny: 'Deny',
    remember: 'Remember decision for this session',
  },
  errors: {
    apiKeyRequired: 'Add an API Key in settings first',
    generic: 'An unknown error occurred',
    runtime: 'Execution failed',
  },
  quickPrompts: {
    analyze: 'Analyze this project structure',
    countLines: 'Count project lines and explain key files',
    review: 'Review the project, find bugs, and fix them',
  },
  session: {
    newChat: 'New Chat',
    interrupted: 'Previous run stopped at step {{step}}.',
    resume: 'Resume execution',
    jumpLatest: 'Latest messages',
  },
  plan: {
    title: 'Work Plan',
    currentStep: 'Current step',
    approve: 'Approve plan and switch to Build',
  },
  subagents: {
    running: 'Subagent working...',
    completed: 'Subagent completed',
    failed: 'Subagent failed',
  },
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { ar: { translation: ar }, en: { translation: en } },
    fallbackLng: 'ar',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  })

// مزامنة اتجاه الصفحة مع اللغة
i18n.on('languageChanged', (lng) => {
  document.documentElement.dir = i18n.dir(lng)
  document.documentElement.lang = lng
})

export default i18n
