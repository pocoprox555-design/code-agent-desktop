/**
 * CLI Mode — وضع سطر الأوامر
 *
 * يتيح تشغيل الوكيل بدون واجهة Electron:
 *   npx tsx src/cli.ts -p "اكتب وحدة اختبار للملف X" --output json
 *
 * المخرجات: JSON منظم للآلات أو نص عادي.
 */

import { AppDatabase } from './main/database'
import { ProviderStore } from './main/provider-store'
import { AgentRunner } from './main/agent'
import { McpManager } from './main/mcp'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// ─── Types ───────────────────────────────────────────────────────────

interface CliOptions {
  prompt: string
  workspace: string
  output: 'json' | 'text'
  model?: string
  permissionMode: 'full' | 'ask'
  agentMode: 'build' | 'plan'
}

interface CliResult {
  sessionId: string
  messages: Array<{ role: string; content: string }>
  usage: { input: number; output: number; total: number }
  cost: number
  duration: number
  error?: string
}

// ─── Argument Parsing ────────────────────────────────────────────────

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    prompt: '',
    workspace: process.cwd(),
    output: 'text',
    permissionMode: 'full',
    agentMode: 'build',
  }

  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!
    switch (arg) {
      case '-p':
      case '--prompt':
        options.prompt = args[++i] ?? ''
        break
      case '-w':
      case '--workspace':
        options.workspace = args[++i] ?? process.cwd()
        break
      case '-o':
      case '--output': {
        const val = args[++i]
        options.output = val === 'json' ? 'json' : 'text'
        break
      }
      case '-m':
      case '--model':
        options.model = args[++i]
        break
      case '--full':
        options.permissionMode = 'full'
        break
      case '--ask':
        options.permissionMode = 'ask'
        break
      case '--plan':
        options.agentMode = 'plan'
        break
      case '--build':
        options.agentMode = 'build'
        break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
    }
  }

  if (!options.prompt) {
    console.error('خطأ: يجب تحديد البرومبت عبر -p أو --prompt')
    printHelp()
    process.exit(1)
  }

  return options
}

function printHelp(): void {
  console.log(`
Code Agent CLI — وكيل برمجة في سطر الأوامر

الاستخدام:
  npx tsx src/cli.ts -p "البرومبت" [خيارات]

الخيارات:
  -p, --prompt <text>     البرومبت المطلوب (إلزامي)
  -w, --workspace <path>  مجلد العمل (افتراضي: المجلد الحالي)
  -o, --output <format>   نوع المخرجات: text أو json (افتراضي: text)
  -m, --model <id>        معرف النموذج
  --full                  وضع التنفيذ الكامل (بدون موافقة)
  --ask                   وضع طلب الموافقة
  --plan                  وضع التخطيط فقط (بدون تعديل)
  --build                 وضع البناء (مع التعديل)
  -h, --help              عرض المساعدة

أمثلة:
  npx tsx src/cli.ts -p "اكتب وحدة اختبار لملف utils.ts"
  npx tsx src/cli.ts -p "حلل بنية المشروع" -o json
  npx tsx src/cli.ts -p "راجع الملفات" --plan -w ./my-project
`)
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv)
  const startTime = Date.now()

  try {
    // إنشاء مجلد العمل
    const agentDir = path.join(options.workspace, '.code-agent')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(agentDir, { recursive: true })

    // إنشاء قاعدة البيانات والتخزين
    const dbPath = path.join(agentDir, 'cli.db')
    const db = new AppDatabase(dbPath)
    const providers = new ProviderStore(path.join(agentDir, 'provider.json'))

    // إنشاء الجلسة
    const session = db.createSession(options.workspace, options.prompt.slice(0, 100), false)
    const sessionId = session.id

    // تطبيق الخيارات على الجلسة
    db.updateSession(sessionId, { permissionMode: options.permissionMode, agentMode: options.agentMode })

    // إنشاء AgentRunner
    const mcp = new McpManager()
    const runner = new AgentRunner(db, providers, () => null, undefined, mcp)

    // تشغيل الوكيل
    await runner.send(sessionId, options.prompt)

    // انتظار اكتمال التشغيل
    await new Promise<void>((resolve) => {
      const check = () => {
        const run = db.getAgentRun(sessionId)
        if (run && (run.status === 'completed' || run.status === 'failed' || run.status === 'interrupted')) {
          resolve()
        } else {
          setTimeout(check, 500)
        }
      }
      // انتظار بدء التشغيل أولاً
      setTimeout(check, 1000)
    })

    const messages = db.listMessages(sessionId)
    const usage = db.getUsageSummary(sessionId)
    const run = db.getAgentRun(sessionId)

    const result: CliResult = {
      sessionId,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      usage: { input: usage.input, output: usage.output, total: usage.total },
      cost: usage.cost,
      duration: Date.now() - startTime,
      error: run?.error,
    }

    // إخراج النتائج
    if (options.output === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log('\n' + '='.repeat(60))
      console.log('📝 نتائج الوكيل:')
      console.log('='.repeat(60))
      for (const msg of result.messages) {
        if (msg.role === 'assistant') {
          console.log('\n' + msg.content)
        }
      }
      console.log('\n' + '-'.repeat(60))
      console.log(`⏱️  المدة: ${(result.duration / 1000).toFixed(1)}s`)
      console.log(`📊 الرموز: ${result.usage.total.toLocaleString()}`)
      console.log(`💰 التكلفة: $${result.cost.toFixed(4)}`)
      if (result.error) console.log(`❌ خطأ: ${result.error}`)
      console.log('='.repeat(60))
    }

    // تنظيف
    await mcp.close()
    db.close()
    process.exit(0)
  } catch (error) {
    console.error('خطأ:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

main()
