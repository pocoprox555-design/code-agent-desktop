/**
 * مثال: استخدام النماذج المجانية في تطبيق Electron
 * 
 * هذا الملف يوضح كيفية ربط النماذج المجانية في تطبيقك
 */

import { OpenAI } from 'openai'

// ═══════════════════════════════════════════════════════════════
// 1. إعداد العميل (Client)
// ═══════════════════════════════════════════════════════════════

// للنماذج المجانية من OpenCode Zen
export const opencodeClient = new OpenAI({
  apiKey: process.env.OPENCODE_API_KEY || '', // مفتاحك من opencode.ai
  baseURL: 'https://opencode.ai/zen/v1',
})

// للنماذج المجانية من OpenRouter
export const openrouterClient = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || '', // مفتاحك من openrouter.ai
  baseURL: 'https://openrouter.ai/api/v1',
})

// للنماذج المحلية (Ollama)
export const ollamaClient = new OpenAI({
  apiKey: 'not-needed',
  baseURL: 'http://localhost:11434/v1',
})

// ═══════════════════════════════════════════════════════════════
// 2. دالة موحدة لإرسال الرسائل
// ═══════════════════════════════════════════════════════════════

export type ModelProvider = 'opencode' | 'openrouter' | 'ollama'

export interface ChatOptions {
  provider: ModelProvider
  model: string
  message: string
  systemPrompt?: string
  maxTokens?: number
}

export async function chat(options: ChatOptions): Promise<string> {
  const { provider, model, message, systemPrompt, maxTokens = 500 } = options

  const client =
    provider === 'opencode'
      ? opencodeClient
      : provider === 'openrouter'
        ? openrouterClient
        : ollamaClient

  const messages: Array<{ role: 'system' | 'user'; content: string }> = []

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push({ role: 'user', content: message })

  const response = await client.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.7,
  })

  return response.choices[0]?.message?.content || ''
}

// ═══════════════════════════════════════════════════════════════
// 3. أمثلة استخدام
// ═══════════════════════════════════════════════════════════════

// مثال 1: استخدام نموذج مجاني من OpenCode
export async function exampleOpenCodeFree() {
  const reply = await chat({
    provider: 'opencode',
    model: 'deepseek-v4-flash-free',
    message: 'اكتب دالة Python لحساب المضروب',
    systemPrompt: 'أنت مبرمج خبير. أجب بإيجاز.',
  })
  console.log('OpenCode Free:', reply)
}

// مثال 2: استخدام نموذج مجاني من OpenRouter
export async function exampleOpenRouterFree() {
  const reply = await chat({
    provider: 'openrouter',
    model: 'deepseek/deepseek-chat:free',
    message: 'اكتب hello world بلغة JavaScript',
    systemPrompt: 'You are a helpful coding assistant.',
  })
  console.log('OpenRouter Free:', reply)
}

// مثال 3: استخدام نموذج محلي
export async function exampleLocal() {
  const reply = await chat({
    provider: 'ollama',
    model: 'llama3.2',
    message: 'اشرح لي مفهوم الـ recursion',
  })
  console.log('Local:', reply)
}

// ═══════════════════════════════════════════════════════════════
// 4. قائمة النماذج المجانية المتاحة
// ═══════════════════════════════════════════════════════════════

export const FREE_MODELS_LIST = {
  opencode: [
    { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
    { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free' },
    { id: 'hy3-free', name: 'Hy3 Free' },
    { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 Free' },
    { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free' },
    { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free' },
    { id: 'big-pickle', name: 'Big Pickle' },
  ],
  openrouter: [
    { id: 'deepseek/deepseek-chat:free', name: 'DeepSeek Chat' },
    { id: 'mistralai/mistral-7b-instruct:free', name: 'Mistral 7B' },
    { id: 'meta-llama/llama-3.1-8b-instruct:free', name: 'Llama 3.1 8B' },
    { id: 'qwen/qwen-2-7b-instruct:free', name: 'Qwen 2 7B' },
    { id: 'google/gemma-2-9b-it:free', name: 'Gemma 2 9B' },
  ],
  local: [
    { id: 'llama3.2', name: 'Llama 3.2 (محلي)' },
    { id: 'codellama', name: 'Code Llama (محلي)' },
    { id: 'mistral', name: 'Mistral (محلي)' },
  ],
}
