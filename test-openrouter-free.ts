import { OpenAI } from 'openai'

// ═══════════════════════════════════════════════════════════════
// اختبار النماذج المجانية من OpenRouter
// هذه النماذج مجانية بالكامل بدون شروط
// ═══════════════════════════════════════════════════════════════

// مفتاح OpenRouter المجاني من: https://openrouter.ai/keys
const API_KEY = process.env.OPENROUTER_API_KEY || 'YOUR_OPENROUTER_KEY_HERE'

const FREE_MODELS = [
  { id: 'deepseek/deepseek-chat:free', name: 'DeepSeek Chat (مجاني)' },
  { id: 'mistralai/mistral-7b-instruct:free', name: 'Mistral 7B (مجاني)' },
  { id: 'meta-llama/llama-3.1-8b-instruct:free', name: 'Llama 3.1 8B (مجاني)' },
  { id: 'qwen/qwen-2-7b-instruct:free', name: 'Qwen 2 7B (مجاني)' },
  { id: 'google/gemma-2-9b-it:free', name: 'Gemma 2 9B (مجاني)' },
]

async function testFreeModel(modelId: string, modelName: string) {
  console.log(`\n🧪 اختبار: ${modelName}`)
  console.log('─'.repeat(50))

  if (API_KEY === 'YOUR_OPENROUTER_KEY_HERE') {
    console.log('❌ لم تضف مفتاح OpenRouter!')
    console.log('📝 الخطوات:')
    console.log('   1. اذهب إلى: https://openrouter.ai/keys')
    console.log('   2. سجّل مجاناً')
    console.log('   3. أنشئ مفتاح مجاني')
    console.log('   4. أضفه في متغير البيئة OPENROUTER_API_KEY')
    return { success: false, model: modelId, error: 'No API key' }
  }

  try {
    const client = new OpenAI({
      apiKey: API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })

    const startTime = Date.now()

    const response = await client.chat.completions.create({
      model: modelId,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Reply briefly.' },
        { role: 'user', content: 'Write hello world in Python' },
      ],
      max_tokens: 200,
      temperature: 0.7,
    })

    const elapsed = Date.now() - startTime
    const content = response.choices[0]?.message?.content || 'No content'
    const usage = response.usage

    console.log(`✅ Success! (${elapsed}ms)`)
    console.log(`📝 Response:\n${content}`)
    console.log(`📊 Usage: ${usage?.total_tokens || '?'} tokens`)

    return { success: true, model: modelId, elapsed, content }
  } catch (error: any) {
    console.log(`❌ Failed: ${error.message}`)
    return { success: false, model: modelId, error: error.message }
  }
}

async function testAllFreeModels() {
  console.log('🚀 Testing Free Models from OpenRouter')
  console.log('═'.repeat(50))

  if (API_KEY === 'YOUR_OPENROUTER_KEY_HERE') {
    console.log('\n⚠️  No API Key!')
    console.log('\n📝 How to get a free key:')
    console.log('   1. Go to: https://openrouter.ai/keys')
    console.log('   2. Sign up for free')
    console.log('   3. Create a free API key')
    console.log('   4. Run: set OPENROUTER_API_KEY=your-key-here')
    console.log('   5. Then run this test again')
    return
  }

  const results = []

  for (const model of FREE_MODELS) {
    const result = await testFreeModel(model.id, model.name)
    results.push(result)
  }

  // Summary
  console.log('\n\n📊 Summary')
  console.log('═'.repeat(50))

  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  console.log(`✅ Success: ${successful.length}/${results.length}`)
  console.log(`❌ Failed: ${failed.length}/${results.length}`)

  if (successful.length > 0) {
    console.log('\nSuccessful models:')
    for (const r of successful) {
      console.log(`  - ${r.model} (${r.elapsed}ms)`)
    }
  }

  if (failed.length > 0) {
    console.log('\nFailed models:')
    for (const r of failed) {
      console.log(`  - ${r.model}: ${r.error}`)
    }
  }
}

// Run test
testAllFreeModels().catch(console.error)
