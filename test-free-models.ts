import { OpenAI } from 'openai'

// ═══════════════════════════════════════════════════════════════
// اختبار النماذج المجانية من OpenCode Zen
// ═══════════════════════════════════════════════════════════════

// ⚠️ النماذج المجانية تحتاج مفتاح API مجاني
// سجّل في: https://opencode.ai/auth
// ثم أضف المفتاح هنا:

const API_KEY = process.env.OPENCODE_API_KEY || 'YOUR_API_KEY_HERE'

const FREE_MODELS = [
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free' },
  { id: 'hy3-free', name: 'Hy3 Free' },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 Free' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free' },
  { id: 'big-pickle', name: 'Big Pickle' },
]

async function testFreeModel(modelId: string, modelName: string) {
  console.log(`\n🧪 اختبار: ${modelName} (${modelId})`)
  console.log('─'.repeat(50))

  if (API_KEY === 'YOUR_API_KEY_HERE') {
    console.log('❌ لم تضف مفتاح API!')
    console.log('📝 الخطوات:')
    console.log('   1. اذهب إلى: https://opencode.ai/auth')
    console.log('   2. سجّل بـ GitHub أو Google')
    console.log('   3. انسخ المفتاح من لوحة التحكم')
    console.log('   4. أضفه في متغير البيئة OPENCODE_API_KEY')
    console.log('   5. أو عدّل المفتاح في ملف test-free-models.ts')
    return { success: false, model: modelId, error: 'No API key' }
  }

  try {
    const client = new OpenAI({
      apiKey: API_KEY,
      baseURL: 'https://opencode.ai/zen/v1',
    })

    const startTime = Date.now()

    const response = await client.chat.completions.create({
      model: modelId,
      messages: [
        { role: 'system', content: 'أنت مساعد مفيد. أجب بإيجاز.' },
        { role: 'user', content: 'اكتب hello world بلغة Python' },
      ],
      max_tokens: 200,
      temperature: 0.7,
    })

    const elapsed = Date.now() - startTime
    const content = response.choices[0]?.message?.content || 'لا يوجد محتوى'
    const usage = response.usage

    console.log(`✅ نجح! (${elapsed}ms)`)
    console.log(`📝 الرد:\n${content}`)
    console.log(`📊 الاستخدام: ${usage?.total_tokens || '?'} توكن`)

    return { success: true, model: modelId, elapsed, content }
  } catch (error: any) {
    console.log(`❌ فشل: ${error.message}`)
    return { success: false, model: modelId, error: error.message }
  }
}

async function testAllFreeModels() {
  console.log('🚀 بدء اختبار جميع النماذج المجانية')
  console.log('═'.repeat(50))

  if (API_KEY === 'YOUR_API_KEY_HERE') {
    console.log('\n⚠️  لا يوجد مفتاح API!')
    console.log('\n📝 للحصول على مفتاح مجاني:')
    console.log('   1. اذهب إلى: https://opencode.ai/auth')
    console.log('   2. سجّل بـ GitHub أو Google')
    console.log('   3. أضف $20 رصيد (اختياري للنماذج المجانية)')
    console.log('   4. انسخ المفتاح')
    console.log('   5. شغّل: set OPENCODE_API_KEY=your-key-here')
    console.log('   6. ثم شغّل الاختبار مرة أخرى')
    return
  }

  const results = []

  for (const model of FREE_MODELS) {
    const result = await testFreeModel(model.id, model.name)
    results.push(result)
  }

  // ملخص النتائج
  console.log('\n\n📊 ملخص النتائج')
  console.log('═'.repeat(50))

  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  console.log(`✅ نجح: ${successful.length}/${results.length}`)
  console.log(`❌ فشل: ${failed.length}/${results.length}`)

  if (successful.length > 0) {
    console.log('\nالنماذج الناجحة:')
    for (const r of successful) {
      console.log(`  - ${r.model} (${r.elapsed}ms)`)
    }
  }

  if (failed.length > 0) {
    console.log('\nالنماذج الفاشلة:')
    for (const r of failed) {
      console.log(`  - ${r.model}: ${r.error}`)
    }
  }
}

// تشغيل الاختبار
testAllFreeModels().catch(console.error)
