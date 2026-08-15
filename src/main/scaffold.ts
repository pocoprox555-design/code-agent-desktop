/**
 * نظام توليد المشاريع (Project Scaffolding)
 * ينسخ القوالب المدمجة إلى مجلد المستخدم مع استبدال العناصر النائبة.
 * لا يحتاج إنترنت — القوالب جزء من التطبيق.
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import type { TemplateInfo, ScaffoldResult } from '../shared/types'

/** القوالب المدمجة — أسماؤها ومساراتها وأوصافها */
const TEMPLATES: TemplateInfo[] = [
  {
    id: 'vanilla',
    name: 'موقع بسيط',
    description: 'HTML + CSS + JavaScript خالص — مثالي للمواقع السريعة وصفحات الهبوط.',
    icon: '🌐',
    tags: ['html', 'css', 'js'],
    defaultPort: 5173,
  },
  {
    id: 'react-vite',
    name: 'React + Vite + TypeScript',
    description: 'تطبيق React حديث مع TypeScript و Vite — الأنسب للتطبيقات التفاعلية.',
    icon: '⚛️',
    tags: ['react', 'typescript', 'vite'],
    defaultPort: 5173,
  },
]

/** مسار القوالب داخل التطبيق */
function templatesRoot(): string {
  if (app?.isPackaged) {
    return join(process.resourcesPath, 'templates')
  }
  return join(app?.getAppPath?.() ?? process.cwd(), 'resources', 'templates')
}

/** يسرد القوالب المتاحة */
export async function listTemplates(): Promise<TemplateInfo[]> {
  return TEMPLATES
}

/**
 * ينشئ مشروعًا جديدًا من قالب محدد.
 * ينسخ كل الملفات ويستبدل العناصر النائبة.
 */
export async function createProject(
  template: string,
  projectName: string,
  targetDir: string,
  description?: string,
): Promise<ScaffoldResult> {
  const info = TEMPLATES.find((t) => t.id === template)
  if (!info) return { ok: false, error: `القالب "${template}" غير موجود.` }

  const nameError = validateProjectName(projectName)
  if (nameError) return { ok: false, error: nameError }

  let targetRoot: string
  let created = false
  try {
    targetRoot = await fs.realpath(targetDir)
    if (!(await fs.stat(targetRoot)).isDirectory()) return { ok: false, error: 'مجلد الوجهة غير صالح.' }
  } catch { return { ok: false, error: 'مجلد الوجهة غير موجود.' } }
  const src = join(templatesRoot(), template)
  const dest = join(targetRoot, projectName)

  // التحقق من عدم وجود المجلد
  try {
    await fs.stat(dest)
    return { ok: false, error: `المجلد "${projectName}" موجود مسبقًا. اختر اسمًا آخر.` }
  } catch {
    // المجلد غير موجود — تابع
  }

  try {
    // mkdir is intentionally non-recursive: the checked parent is the only
    // directory this request is allowed to create.
    await fs.mkdir(dest)
    created = true
    const files = await copyTemplate(src, dest, projectName, description ?? `مشروع ${projectName} مبني بـ Code Agent`)
    let totalLines = 0
    for (const file of files) {
      if (/\.(html|css|js|tsx|ts|json)$/i.test(file)) {
        try { totalLines += (await fs.readFile(file, 'utf8')).split(/\r?\n/).length } catch { /* ignore */ }
      }
    }
    return { ok: true, projectPath: dest, projectName, templateId: template, filesCount: files.length, totalLines }
  } catch (error) {
    if (created) {
      try { await fs.rm(dest, { recursive: true, force: true }) } catch { /* cleanup is best effort */ }
    }
    return { ok: false, error: `فشل إنشاء المشروع: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * ينسخ قالبًا مع استبدال {{projectName}} و {{description}} و {{projectSlug}}
 */
async function copyTemplate(
  src: string,
  dest: string,
  projectName: string,
  description: string,
): Promise<string[]> {
  const collected: string[] = []
  const normalizedSlug = projectName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  const projectSlug = normalizedSlug || `project-${createHash('sha256').update(projectName).digest('hex').slice(0, 10)}`

  async function walk(dir: string, targetDir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = join(dir, entry.name)
      const destPath = join(targetDir, entry.name)

      if (entry.isDirectory()) {
        await fs.mkdir(destPath, { recursive: true })
        await walk(srcPath, destPath)
      } else {
        const isTextFile = /\.(html|css|js|jsx|ts|tsx|json|md|txt|xml|svg|yml|yaml|toml)$/i.test(entry.name)
        if (isTextFile) {
          let content = await fs.readFile(srcPath, 'utf8')
          content = content
            .replace(/\{\{projectName\}\}/g, projectName)
            .replace(/\{\{description\}\}/g, description)
            .replace(/\{\{projectSlug\}\}/g, projectSlug)
          await fs.writeFile(destPath, content, 'utf8')
        } else {
          await fs.copyFile(srcPath, destPath)
        }
        collected.push(destPath)
      }
    }
  }

  await walk(src, dest)
  return collected
}

function validateProjectName(value: string): string | null {
  if (!value || value === '.' || value === '..' || isAbsolute(value)) return 'اسم المشروع يجب أن يكون اسم مجلد واحدًا صالحًا.'
  if (/[\\/:]/.test(value) || value.includes('..') || /[\u0000-\u001f]/.test(value)) return 'اسم المشروع لا يجوز أن يحتوي فواصل أو .. أو محارف تحكم.'
  if (/[. ]$/.test(value)) return 'اسم المشروع لا يجوز أن ينتهي بنقطة أو مسافة.'
  const base = value.split('.')[0]?.toUpperCase() ?? ''
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) return 'اسم المشروع محجوز في Windows.'
  return null
}
