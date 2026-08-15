import type { ProviderConfig } from '../shared/types'
import type { ModelUsage } from '../shared/types'
import { apiPathFor } from '../shared/models'

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'cancelled' | 'error' | 'unknown'
export interface ModelToolCall { id: string; name: string; arguments: string }
export interface ModelReply { text: string; reasoning?: string; toolCalls: ModelToolCall[]; finishReason: FinishReason; usage?: ModelUsage; providerPayload?: unknown[] }
export interface ModelInput { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | Array<Record<string, unknown>>; tool_call_id?: string; name?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; providerPayload?: unknown[]; messageId?: string; cacheAnchor?: boolean }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number; retries?: number; maxOutputTokens?: number; maxResponseBytes?: number; onTextDelta?: (delta: string) => void; onReasoningDelta?: (delta: string) => void; onToolCallStart?: (id: string, name: string) => void; onToolCallDelta?: (id: string, delta: string) => void; onToolCallDone?: (id: string, name: string, args: string) => void; deadlineAt?: number; concurrencyKey?: string; onRetry?: (attempt: number, delayMs: number) => void; onResponseStarted?: () => void }
export class ContextOverflowError extends Error {}
export class DeadlineExceededError extends Error {}
export class ProviderTimeoutError extends Error {}
export class ProviderResponseTooLargeError extends Error {}

// تحسين إدارة الطلبات المتزامنة لتقليل استهلاك الموارد
const MAX_CONCURRENT_MODEL_REQUESTS = 4
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
interface RequestSlotEntry { signal?: AbortSignal; deadlineAt?: number; resolve(): void; reject(error: Error): void; abort(): void; timer?: NodeJS.Timeout; settled: boolean }
interface RequestSlotState { active: number; queue: RequestSlotEntry[] }
const requestSlots = new Map<string, RequestSlotState>()

export async function requestModel(config: ProviderConfig, messages: ModelInput[], tools: ToolDefinition[], options: RequestOptions | AbortSignal = {}): Promise<ModelReply> {
  const normalized = options instanceof AbortSignal ? { signal: options } : options
  const retries = normalized.retries ?? 2
  let lastError: unknown
  let outputStarted = false
  const requestOptions: RequestOptions = normalized.onTextDelta ? { ...normalized, onTextDelta: (delta: string) => { outputStarted = true; normalized.onTextDelta?.(delta) } } : normalized
  const key = normalized.concurrencyKey ?? 'global'
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      assertDeadline(normalized.deadlineAt)
      await acquireModelRequestSlot(key, normalized.signal, normalized.deadlineAt)
      try { return await requestOnce(config, messages, tools, requestOptions) }
      finally { releaseModelRequestSlot(key) }
    }
    catch (error) {
      lastError = error
      if (normalized.signal?.aborted || outputStarted || attempt === retries || !retryable(error)) throw friendlyProviderError(error)
      const remaining = normalized.deadlineAt === undefined ? Number.POSITIVE_INFINITY : normalized.deadlineAt - Date.now()
      if (remaining <= 1_000) throw new DeadlineExceededError('انتهى الوقت المتاح لطلب المزود')
      const wait = Math.min(retryDelay(error, attempt), remaining - 1_000)
      normalized.onRetry?.(attempt + 1, wait)
      await delay(wait, normalized.signal, normalized.deadlineAt)
    }
  }
  throw lastError
}

// ═══════════════════════════════════════════════════════════════════════
// Custom Provider Retry: 5s → 10s → 15s → 20s → 25s → 30s (max 60s)
// ═══════════════════════════════════════════════════════════════════════
const CUSTOM_RETRY_DELAYS = [5_000, 10_000, 15_000, 20_000, 25_000, 30_000]
const CUSTOM_RETRY_MAX_ELAPSED = 60_000

export async function requestModelWithCustomRetry(config: ProviderConfig, messages: ModelInput[], tools: ToolDefinition[], options: RequestOptions | AbortSignal = {}): Promise<ModelReply> {
  const normalized = options instanceof AbortSignal ? { signal: options } : options
  const startTime = Date.now()
  let lastError: unknown
  let outputStarted = false
  const requestOptions: RequestOptions = normalized.onTextDelta ? { ...normalized, onTextDelta: (delta: string) => { outputStarted = true; normalized.onTextDelta?.(delta) } } : normalized
  const key = normalized.concurrencyKey ?? 'global'

  for (let attempt = 0; attempt < CUSTOM_RETRY_DELAYS.length; attempt++) {
    const elapsed = Date.now() - startTime
    if (elapsed >= CUSTOM_RETRY_MAX_ELAPSED) break
    try {
      assertDeadline(normalized.deadlineAt)
      await acquireModelRequestSlot(key, normalized.signal, normalized.deadlineAt)
      try { return await requestOnce(config, messages, tools, requestOptions) }
      finally { releaseModelRequestSlot(key) }
    } catch (error) {
      lastError = error
      if (normalized.signal?.aborted || outputStarted || !retryable(error)) throw friendlyProviderError(error)
      const remaining = normalized.deadlineAt === undefined ? Number.POSITIVE_INFINITY : normalized.deadlineAt - Date.now()
      if (remaining <= 1_000) throw new DeadlineExceededError('انتهى الوقت المتاح لطلب المزود')
      const delayMs = Math.min(CUSTOM_RETRY_DELAYS[attempt] ?? 30_000, CUSTOM_RETRY_MAX_ELAPSED - elapsed, remaining - 1_000)
      normalized.onRetry?.(attempt + 1, delayMs)
      await delay(delayMs, normalized.signal, normalized.deadlineAt)
    }
  }
  throw friendlyProviderError(lastError)
}

export function estimateModelRequestTokens(_config: ProviderConfig, messages: ModelInput[], tools: ToolDefinition[], _maxOutputTokens?: number): number {
  let total = 0
  for (const message of messages) {
    let content: string
    if (typeof message.content === 'string') {
      content = message.content
    } else {
      // الصور/الفيديو تُحاسب بالتوكن ككتلة بصرية (~1200) لا بحجم base64 النصي —
      // وإلا تفجّر التقدير وضُغط السياق مبكرًا عند حقن لقطات المعاينة.
      let mediaBlocks = 0
      for (const block of message.content) {
        if (block && typeof block === 'object' && (block.type === 'image' || block.type === 'video')) mediaBlocks++
      }
      total += mediaBlocks * 1_200
      content = JSON.stringify(message.content, (_key, value) => typeof value === 'string' && value.length > 4_096 ? '[media-data]' : value)
    }
    total += estimateSerializedTokens(content) + 30
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        total += estimateSerializedTokens(call.function.name + call.function.arguments) + 50
      }
    }
  }
  total += tools.length * 180 + 400
  return Math.max(1, total)
}

function estimateSerializedTokens(value: string): number {
  // Provider tokenizers differ by model and API style. Use a deliberately
  // conservative UTF-8 estimate instead of treating one tokenizer as truth.
  // Cached by content hash: history and system content repeat across rounds,
  // so re-hashing replaces re-serializing/re-measuring every step.
  const key = `${value.length}:${(djb2(value) >>> 0).toString(36)}`
  const cached = estimateTokenCache.get(key)
  if (cached !== undefined) { estimateTokenCache.delete(key); estimateTokenCache.set(key, cached); return cached }
  const tokens = Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 2.5))
  if (estimateTokenCache.size >= ESTIMATE_TOKEN_CACHE_MAX) estimateTokenCache.delete(estimateTokenCache.keys().next().value!)
  estimateTokenCache.set(key, tokens)
  return tokens
}

const estimateTokenCache = new Map<string, number>()
const ESTIMATE_TOKEN_CACHE_MAX = 1_000
function djb2(value: string): number {
  let hash = 5381
  for (let index = 0; index < value.length; index++) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  return hash
}

function acquireModelRequestSlot(key: string, signal?: AbortSignal, deadlineAt?: number): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('تم إلغاء طلب المزود', 'AbortError'))
  assertDeadline(deadlineAt)
  const state = requestSlots.get(key) ?? { active: 0, queue: [] }
  requestSlots.set(key, state)
  if (state.active < MAX_CONCURRENT_MODEL_REQUESTS) { state.active++; return Promise.resolve() }
  return new Promise((resolve, reject) => {
    const entry: RequestSlotEntry = { signal, deadlineAt, resolve, reject, abort: (): void => {}, settled: false }
    const remove = (error: Error): void => { if (entry.settled) return; entry.settled = true; const index = state.queue.indexOf(entry); if (index >= 0) state.queue.splice(index, 1); if (entry.timer) clearTimeout(entry.timer); signal?.removeEventListener('abort', entry.abort); reject(error) }
    entry.abort = (): void => remove(new DOMException('تم إلغاء طلب المزود', 'AbortError'))
    signal?.addEventListener('abort', entry.abort, { once: true })
    if (deadlineAt !== undefined) entry.timer = setTimeout(() => remove(new DeadlineExceededError('انتهى انتظار دور طلب المزود')), Math.max(1, deadlineAt - Date.now()))
    state.queue.push(entry)
  })
}

function releaseModelRequestSlot(key: string): void {
  const state = requestSlots.get(key)
  if (!state) return
  state.active = Math.max(0, state.active - 1)
  while (state.queue.length && state.active < MAX_CONCURRENT_MODEL_REQUESTS) {
    const next = state.queue.shift()!
    if (next.settled) continue
    if (next.signal?.aborted) { next.abort(); continue }
    if (next.deadlineAt !== undefined && next.deadlineAt <= Date.now()) { next.abort(); continue }
    next.settled = true
    if (next.timer) clearTimeout(next.timer)
    next.signal?.removeEventListener('abort', next.abort)
    state.active++
    next.resolve()
  }
  if (state.active === 0 && state.queue.length === 0) requestSlots.delete(key)
}

/** إلغاء جميع طلبات المزود المعلقة التي تطابق بادئة مفتاح — تستخدم عند إيقاف جلسة */
export function cancelProviderRequestSlots(keyPrefix: string): void {
  for (const [key, state] of requestSlots) {
    if (key.startsWith(keyPrefix)) {
      for (const entry of [...state.queue]) {
        if (!entry.settled) {
          entry.settled = true
          if (entry.timer) clearTimeout(entry.timer)
          entry.signal?.removeEventListener('abort', entry.abort)
          entry.reject(new DOMException('تم إلغاء جلسة المزود', 'AbortError'))
        }
      }
      state.queue.length = 0
    }
  }
}

export async function requestOnce(config: ProviderConfig, messages: ModelInput[], tools: ToolDefinition[], options: RequestOptions): Promise<ModelReply> {
  const apiStyle = config.apiStyle
  const url = new URL(apiPathFor(apiStyle), config.baseUrl).toString()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey) {
    if (apiStyle === 'anthropic') { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01' }
    else headers.authorization = `Bearer ${config.apiKey}`
  }
  const maxOutput = options.maxOutputTokens ?? config.maxOutputTokens
  const buildBody = (withReasoningControl: boolean): Record<string, unknown> => apiStyle === 'chat' ? toChatBody(config, messages, tools, maxOutput, withReasoningControl) : apiStyle === 'responses' ? toResponsesBody(config, messages, tools, maxOutput, withReasoningControl) : toAnthropicBody(config, messages, tools, maxOutput, withReasoningControl)
  let body = buildBody(true)
  if (options.onTextDelta) { body.stream = true; if (apiStyle === 'chat') body.stream_options = { include_usage: true } }
  const controller = new AbortController()
  let timedOut = false
  const remaining = options.deadlineAt === undefined ? Number.POSITIVE_INFINITY : options.deadlineAt - Date.now()
  if (remaining <= 0) throw new DeadlineExceededError('انتهى الوقت المتاح لطلب المزود')
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1, Math.min(options.timeoutMs ?? 90_000, remaining)))
  const abort = (): void => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
     let response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
      if (!response.ok) {
        const raw = await readBoundedBody(response, Math.min(maxResponseBytes, 1_000_000))
        if (isContextOverflow(response.status, raw)) throw new ContextOverflowError(`تجاوز الطلب نافذة سياق المزود: ${raw.slice(0, 1000)}`)
        if (reasoningControlRejected(response.status, raw)) {
          body = buildBody(false)
          if (options.onTextDelta) { body.stream = true; if (apiStyle === 'chat') body.stream_options = { include_usage: true } }
          const retry = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
          if (retry.ok) response = retry
          else throw new ProviderHttpError(retry.status, parseRetryAfter(retry.headers.get('retry-after-ms'), retry.headers.get('retry-after')), `فشل المزود (${retry.status}): ${raw.slice(0, 1000)}`)
        } else throw new ProviderHttpError(response.status, parseRetryAfter(response.headers.get('retry-after-ms'), response.headers.get('retry-after')), `فشل المزود (${response.status}): ${raw.slice(0, 1000)}`)
      }
      options.onResponseStarted?.()
      if (options.onTextDelta) return parseEventStream(response, apiStyle, options.onTextDelta, maxResponseBytes, options.onReasoningDelta, options.onToolCallStart, options.onToolCallDelta, options.onToolCallDone, options.signal)
     const raw = await readBoundedBody(response, maxResponseBytes)
    let data: Record<string, any>
    try { data = JSON.parse(raw) as Record<string, any> } catch { throw new Error('أعاد المزود JSON غير صالح') }
     if (apiStyle === 'chat') return parseChat(data)
     if (apiStyle === 'responses') return parseResponses(data)
    return parseAnthropic(data)
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('تم إلغاء طلب المزود', 'AbortError')
    if (timedOut && options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw new DeadlineExceededError('انتهى الوقت المتاح لطلب المزود')
    if (timedOut) throw new ProviderTimeoutError('انتهت مهلة اتصال المزود')
    throw error
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
}

function reasoningControlRejected(status: number, raw: string): boolean {
  if (status !== 400 && status !== 422) return false
  const value = raw.toLowerCase()
  return /(?:unknown|unrecognized|unsupported|not supported|extra fields|additional.*(?:not|unexpected)|invalid.*(?:parameter|field|argument)|unexpected.*(?:parameter|field|argument)|not permitted|parameter.*not allowed|"thinking".*not|"reasoning_effort".*not|does not support thinking|thinking.*(?:unsupported|not supported))/i.test(value)
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new ProviderResponseTooLargeError(`استجابة المزود أكبر من الحد (${maxBytes} بايت)`)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) throw new ProviderResponseTooLargeError(`استجابة المزود أكبر من الحد (${maxBytes} بايت)`)
      chunks.push(part.value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
  } finally {
    try { await reader.cancel() } catch {}
    reader.releaseLock()
    // تحسين تنظيف الموارد: التأكد من تحرير جميع الموارد
    chunks.length = 0
  }
}

async function parseEventStream(response: Response, style: 'chat' | 'responses' | 'anthropic', onTextDelta: (delta: string) => void, maxBytes: number, onReasoningDelta?: (delta: string) => void, onToolCallStart?: (id: string, name: string) => void, onToolCallDelta?: (id: string, delta: string) => void, onToolCallDone?: (id: string, name: string, args: string) => void, signal?: AbortSignal): Promise<ModelReply> {
  if (!response.body) throw new Error('المزود لا يدعم بث الاستجابة')
  // ─── إلغاء فوري عند إطلاق الإشارة ───
  // بدون هذا، توقف الإلغاء يستمر في القراءة من البث لأن reader.read() لا يعرف أن يجب أن يتوقف.
  if (signal?.aborted) { try { await response.body.cancel() } catch {} throw new DOMException('تم إلغاء طلب المزود', 'AbortError') }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<{ event: string; data: string }> = []
  let eventName = 'message'
  let dataLines: string[] = []
  const state = makeStreamState()
  let bytes = 0
  const flush = (): void => { if (dataLines.length) events.push({ event: eventName, data: dataLines.join('\n') }); eventName = 'message'; dataLines = [] }
  // ─── فحص الإلغاء في كل مرحلة: قبل القراءة + بعد القراءة + أثناء المعالجة ───
    // هذا يضمن التوقف الفوري عند الإلغاء وليس بعد اكتمال Chunk التالي.
    const checkAbort = (): void => {
      if (signal?.aborted) { try { reader.cancel() } catch {} throw new DOMException('تم إلغاء طلب المزود', 'AbortError') }
    }
    try { while (true) {
      checkAbort()
      const part = await reader.read()
      checkAbort()
      bytes += part.value?.byteLength ?? 0
      if (bytes > maxBytes) throw new ProviderResponseTooLargeError(`بث المزود أكبر من الحد (${maxBytes} بايت)`)
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done })
      const lines = buffer.split(/\r?\n/)
      buffer = part.done ? '' : lines.pop() ?? ''
      for (const line of lines) {
        checkAbort()
        if (!line) { flush(); continue }
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      while (events.length) {
        checkAbort()
        const item = events.shift()!
        if (item.data === '[DONE]') continue
        let data: any
        try { data = JSON.parse(item.data) } catch { continue }
        consumeStreamEvent(style, item.event, data, state, onTextDelta, onReasoningDelta, onToolCallStart, onToolCallDelta, onToolCallDone)
      }
      if (part.done) { flush(); break }
    } } finally { 
      try { await reader.cancel() } catch {}; 
      reader.releaseLock();
      // تحسين تنظيف الموارد: التأكد من تحرير جميع الموارد
      events.length = 0;
      dataLines.length = 0;
      buffer = '';
    }
  while (events.length) { const item = events.shift()!; if (item.data !== '[DONE]') { try { consumeStreamEvent(style, item.event, JSON.parse(item.data), state, onTextDelta, onReasoningDelta, onToolCallStart, onToolCallDelta, onToolCallDone) } catch {} } }
  return finishStream(style, state)
}

interface StreamState { text: string; reasoning: string; finishReason: FinishReason; usage?: ModelUsage; chatCalls: Map<number, { id: string; name: string; arguments: string }>; anthropicCalls: Map<number, { id: string; name: string; arguments: string }>; responseCalls: Map<string, { id: string; name: string; arguments: string }>; responseOutput: unknown[]; startedCalls: Set<string>; completedCalls: Set<string> }
function makeStreamState(): StreamState { return { text: '', reasoning: '', finishReason: 'unknown', chatCalls: new Map(), anthropicCalls: new Map(), responseCalls: new Map(), responseOutput: [], startedCalls: new Set(), completedCalls: new Set() } }

function consumeStreamEvent(style: 'chat' | 'responses' | 'anthropic', event: string, data: any, state: StreamState, onTextDelta: (delta: string) => void, onReasoningDelta?: (delta: string) => void, onToolCallStart?: (id: string, name: string) => void, onToolCallDelta?: (id: string, args: string) => void, onToolCallDone?: (id: string, name: string, args: string) => void): void {
  if (style === 'chat') {
    const choice = data.choices?.[0]
    const delta = choice?.delta?.content
    if (typeof delta === 'string' && delta) { state.text += delta; onTextDelta(delta) }
    const reasoningDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
    if (typeof reasoningDelta === 'string' && reasoningDelta) { state.reasoning += reasoningDelta; onReasoningDelta?.(reasoningDelta) }
    for (const call of choice?.delta?.tool_calls ?? []) { const index = Number(call.index ?? 0); const current = state.chatCalls.get(index) ?? { id: '', name: '', arguments: '' }; current.id += call.id ?? ''; current.name += call.function?.name ?? ''; current.arguments += call.function?.arguments ?? ''; state.chatCalls.set(index, current)
      notifyToolStart(state, current, onToolCallStart)
      if (call.function?.arguments) onToolCallDelta?.(current.id, call.function.arguments)
    }
    if (choice?.finish_reason) { state.finishReason = mapChatReason(choice.finish_reason); for (const current of state.chatCalls.values()) notifyToolDone(state, current, onToolCallDone) }
     if (data.usage) state.usage = usage(data.usage, 'prompt_tokens', 'completion_tokens')
    return
  }
  if (style === 'anthropic') {
    if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
      const id = String(data.content_block.id ?? '')
      const name = String(data.content_block.name ?? '')
      state.anthropicCalls.set(Number(data.index), { id, name, arguments: '' })
      notifyToolStart(state, { id, name }, onToolCallStart)
    }
    if (data.type === 'content_block_stop') { const current = state.anthropicCalls.get(Number(data.index)); if (current) notifyToolDone(state, current, onToolCallDone) }
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') { const delta = String(data.delta.text ?? ''); state.text += delta; onTextDelta(delta) }
    if (data.type === 'content_block_delta' && data.delta?.type === 'thinking_delta') { const delta = String(data.delta.thinking ?? ''); state.reasoning += delta; onReasoningDelta?.(delta) }
    if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
      const current = state.anthropicCalls.get(Number(data.index))
      if (current) {
        const delta = String(data.delta.partial_json ?? '')
        current.arguments += delta
        onToolCallDelta?.(current.id, delta)
      }
    }
     if (data.type === 'message_start' && data.message?.usage) state.usage = usage(data.message.usage, 'input_tokens', 'output_tokens')
     if (data.type === 'message_delta') { state.finishReason = mapAnthropicReason(data.delta?.stop_reason); if (data.usage) state.usage = mergeUsage(state.usage, usage(data.usage, 'input_tokens', 'output_tokens')) }
    return
  }
  const type = data.type ?? event
  if (type === 'response.output_text.delta') { const delta = String(data.delta ?? ''); state.text += delta; onTextDelta(delta) }
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') { const delta = String(data.delta ?? ''); state.reasoning += delta; onReasoningDelta?.(delta) }
  if (type === 'response.output_item.added' && data.item?.type === 'function_call') { const current = { id: String(data.item.call_id ?? data.item.id ?? ''), name: String(data.item.name ?? ''), arguments: String(data.item.arguments ?? '') }; state.responseCalls.set(String(data.item.call_id ?? data.item.id ?? data.output_index), current); notifyToolStart(state, current, onToolCallStart) }
  if (type === 'response.function_call_arguments.delta') { const key = String(data.call_id ?? data.item_id ?? data.output_index); const current = state.responseCalls.get(key); if (current) { const delta = String(data.delta ?? ''); current.arguments += delta; notifyToolStart(state, current, onToolCallStart); onToolCallDelta?.(current.id, delta) } }
  if (type === 'response.output_item.done' && data.item) { state.responseOutput[Number(data.output_index ?? state.responseOutput.length)] = data.item; if (data.item.type === 'function_call') { const key = String(data.item.call_id ?? data.item.id ?? data.output_index); const current = state.responseCalls.get(key) ?? { id: String(data.item.call_id ?? data.item.id ?? ''), name: String(data.item.name ?? ''), arguments: '' }; current.id ||= String(data.item.call_id ?? data.item.id ?? ''); current.name ||= String(data.item.name ?? ''); current.arguments = String(data.item.arguments ?? current.arguments); state.responseCalls.set(key, current); notifyToolStart(state, current, onToolCallStart); notifyToolDone(state, current, onToolCallDone) } }
  if (type === 'response.completed' && data.response) { state.responseOutput = data.response.output ?? state.responseOutput; state.usage = usage(data.response.usage, 'input_tokens', 'output_tokens'); state.finishReason = state.responseCalls.size ? 'tool_calls' : 'stop' }
  if (type === 'response.incomplete') state.finishReason = data.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'unknown'
  if (type === 'response.failed') state.finishReason = 'error'
}

function notifyToolStart(state: StreamState, call: { id: string; name: string }, callback?: (id: string, name: string) => void): void { if (!call.id || !call.name || state.startedCalls.has(call.id)) return; state.startedCalls.add(call.id); callback?.(call.id, call.name) }
function notifyToolDone(state: StreamState, call: { id: string; name: string; arguments: string }, callback?: (id: string, name: string, args: string) => void): void { notifyToolStart(state, call); if (!call.id || !call.name || state.completedCalls.has(call.id)) return; state.completedCalls.add(call.id); callback?.(call.id, call.name, call.arguments) }

function finishStream(style: 'chat' | 'responses' | 'anthropic', state: StreamState): ModelReply {
  const toolCalls = style === 'chat' ? [...state.chatCalls.values()] : style === 'anthropic' ? [...state.anthropicCalls.values()] : [...state.responseCalls.values()]
  const finishReason = toolCalls.length ? 'tool_calls' : state.finishReason === 'unknown' && state.text ? 'stop' : state.finishReason
  const reply: ModelReply = { text: state.text, reasoning: state.reasoning || undefined, toolCalls, finishReason, usage: state.usage }
  if (style === 'responses') reply.providerPayload = state.responseOutput.filter(Boolean)
  return reply
}

function toChatBody(config: ProviderConfig, messages: ModelInput[], tools: ToolDefinition[], maxOutput: number, withReasoningControl = true): Record<string, unknown> {
  const reasoningEffort = config.reasoningEffort
  return { model: config.model, messages: normalizeChatMessages(messages), ...(tools.length ? { tools, tool_choice: 'auto' } : {}), temperature: 0, max_tokens: maxOutput, ...(withReasoningControl && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }
}

function normalizeChatMessages(messages: ModelInput[]): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = []
  let pendingToolCalls: string[] = []
  for (const source of messages) {
    const { providerPayload: _, messageId: __, cacheAnchor: ___, ...message } = source
    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of pendingToolCalls) normalized.push({ role: 'tool', tool_call_id: call, content: JSON.stringify({ ok: false, error: { code: 'MISSING_TOOL_RESULT', message: 'لم تُسجّل نتيجة استدعاء الأداة من تشغيل سابق.' } }) })
      pendingToolCalls = message.tool_calls.map((call) => call.id)
      normalized.push({ ...message, content: normalizeChatContent(message.content) })
      continue
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id
      if (!id || !pendingToolCalls.includes(id)) continue
      pendingToolCalls = pendingToolCalls.filter((item) => item !== id)
      normalized.push({ ...message, content: normalizeChatContent(message.content) })
      continue
    }
    for (const call of pendingToolCalls) normalized.push({ role: 'tool', tool_call_id: call, content: JSON.stringify({ ok: false, error: { code: 'MISSING_TOOL_RESULT', message: 'لم تُسجّل نتيجة استدعاء الأداة من تشغيل سابق.' } }) })
    pendingToolCalls = []
    normalized.push({ ...message, content: normalizeChatContent(message.content) })
  }
  for (const call of pendingToolCalls) normalized.push({ role: 'tool', tool_call_id: call, content: JSON.stringify({ ok: false, error: { code: 'MISSING_TOOL_RESULT', message: 'لم تُسجّل نتيجة استدعاء الأداة من تشغيل سابق.' } }) })
  return normalized
}

function normalizeChatContent(content: string | Array<Record<string, unknown>>): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'image' && block.source && typeof block.source === 'object') {
      const source = block.source as Record<string, unknown>
      return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } }
    }
    if (block.type === 'video' && block.source && typeof block.source === 'object') {
      const source = block.source as Record<string, unknown>
      return { type: 'video_url', video_url: { url: `data:${source.media_type};base64,${source.data}` } }
    }
    return block
  })
}

function parseChat(data: Record<string, any>): ModelReply {
  const choice = data.choices?.[0]
  if (!choice?.message) throw new Error('استجابة Chat لا تحتوي رسالة')
  const message = choice.message
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call: any) => ({ id: String(call.id ?? ''), name: String(call.function?.name ?? ''), arguments: String(call.function?.arguments ?? '') })) : []
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : typeof message.reasoning === 'string' ? message.reasoning : undefined
  return { text: textContent(message.content), reasoning, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : mapChatReason(choice.finish_reason), usage: usage(data.usage, 'prompt_tokens', 'completion_tokens') }
}

function toResponsesBody(config: ProviderConfig, messages: ModelInput[], tools: ToolDefinition[], maxOutput: number, withReasoningControl = true): Record<string, unknown> {
  const input: unknown[] = []
  for (const message of messages) {
    if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) })
    else if (message.role === 'assistant' && message.providerPayload?.length) input.push(...message.providerPayload)
    else {
      if (message.content) {
        if (typeof message.content === 'string') input.push({ role: message.role, content: message.content })
        else input.push({ role: message.role, content: message.content })
      }
      for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
    }
  }
  return { model: config.model, input, ...(tools.length ? { tools: tools.map((item) => ({ type: 'function', name: item.function.name, description: item.function.description, parameters: item.function.parameters })) } : {}), max_output_tokens: maxOutput, store: false, ...(withReasoningControl && config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}) }
}

function parseResponses(data: Record<string, any>): ModelReply {
  if (!Array.isArray(data.output)) throw new Error('استجابة Responses لا تحتوي output صالحًا')
  const output = data.output
  const text = typeof data.output_text === 'string' ? data.output_text : output.flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text ?? '').join('')
  const reasoning = output.flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'reasoning').map((part: any) => part.summary?.map((s: any) => s.text ?? '').join('') ?? part.text ?? '').join('') || (typeof data.reasoning_summary_text === 'string' ? data.reasoning_summary_text : undefined)
  const toolCalls = output.filter((item: any) => item.type === 'function_call').map((item: any) => {
    if (!item.call_id) throw new Error('استدعاء Responses بلا call_id')
    return { id: String(item.call_id), name: String(item.name ?? ''), arguments: String(item.arguments ?? '') }
  })
  let finishReason: FinishReason = toolCalls.length ? 'tool_calls' : data.status === 'completed' ? 'stop' : data.status === 'cancelled' ? 'cancelled' : data.status === 'failed' ? 'error' : 'unknown'
  if (data.incomplete_details?.reason === 'max_output_tokens') finishReason = 'length'
  if (data.incomplete_details?.reason === 'content_filter') finishReason = 'content_filter'
  return { text, reasoning, toolCalls, finishReason, providerPayload: output, usage: usage(data.usage, 'input_tokens', 'output_tokens') }
}

function toAnthropicBody(config: ProviderConfig, messages: ModelInput[], tools: ToolDefinition[], maxOutput: number, withReasoningControl = true): Record<string, unknown> {
  const systemMessages = messages.filter((message) => message.role === 'system')
  const systemBlocks = systemMessages.map((message) => ({ type: 'text', text: typeof message.content === 'string' ? message.content : message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') } as Record<string, unknown>))
  // ─── Prompt caching: at most 4 breakpoints, all on stable prefix ends ───
  // The agent orders system blocks stable-first (combined prompt, memory,
  // summary) and appends one volatile dynamic block last. cacheAnchor marks
  // the end of the stable prefix, so the expensive prefix stays cache-warm
  // even when the dynamic tail changes every round. The old layout spent a
  // breakpoint on history middle and could emit 5 breakpoints (over the
  // provider limit), and anchored the last system block even when volatile.
  if (systemBlocks.length) {
    let anchor = systemMessages.findIndex((message) => message.cacheAnchor)
    if (anchor === -1) anchor = 0
    systemBlocks[anchor]!.cache_control = { type: 'ephemeral' }
  }
  const toolDefs: Record<string, unknown>[] = tools.length ? tools.map((item) => ({ name: item.function.name, description: item.function.description, input_schema: item.function.parameters } as Record<string, unknown>)) : []
  if (toolDefs.length) toolDefs.at(-1)!.cache_control = { type: 'ephemeral' }
  const output: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'tool') { const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content); output.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content, is_error: content.includes('"ok": false') || content.startsWith('خطأ:') }] }); continue }
    const content: Array<Record<string, unknown>> = []
    if (message.content) {
      if (typeof message.content === 'string') content.push({ type: 'text', text: message.content })
      else {
        for (const block of message.content) {
          if (block.type === 'image' && block.source && typeof block.source === 'object') {
            const source = block.source as Record<string, unknown>
            content.push({ type: 'image', source: { type: 'base64', media_type: source.media_type, data: source.data } })
          } else if (block.type === 'video' && block.source && typeof block.source === 'object') {
            const source = block.source as Record<string, unknown>
            content.push({ type: 'video', source: { type: 'base64', media_type: source.media_type, data: source.data } })
          } else if (block.type === 'text') content.push({ type: 'text', text: block.text ?? '' })
          else content.push(block)
        }
      }
    }
    for (const call of message.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) })
     output.push({ role: message.role as 'user' | 'assistant', content })
  }
  const merged = mergeAnthropicMessages(output)
  // Rolling history breakpoints: end of the previous turn and end of the last
  // message. Next round, the whole prefix up to either point is cache-readable.
  for (const index of [merged.length - 2, merged.length - 1]) {
    const block = merged[index]?.content.at(-1)
    if (block && typeof block === 'object') (block as Record<string, unknown>).cache_control = { type: 'ephemeral' }
  }
  const thinkingBudget = config.reasoningEffort === 'high' ? 16_384 : config.reasoningEffort === 'medium' ? 8_192 : config.reasoningEffort === 'low' ? 4_096 : undefined
  return { model: config.model, ...(systemBlocks.length ? { system: systemBlocks } : {}), messages: merged, ...(toolDefs.length ? { tools: toolDefs } : {}), max_tokens: maxOutput, temperature: 0, ...(withReasoningControl && thinkingBudget ? { thinking: { type: 'enabled', budget_tokens: Math.min(thinkingBudget, Math.max(1_024, maxOutput - 1_024)) } } : {}) }
}

function parseAnthropic(data: Record<string, any>): ModelReply {
  if (!Array.isArray(data.content)) throw new Error('استجابة Anthropic لا تحتوي content صالحًا')
  const toolCalls = data.content.filter((part: any) => part.type === 'tool_use').map((part: any) => ({ id: String(part.id ?? ''), name: String(part.name ?? ''), arguments: JSON.stringify(part.input ?? {}) }))
  const reasoning = data.content.filter((part: any) => part.type === 'thinking').map((part: any) => String(part.thinking ?? '')).join('')
  return { text: data.content.filter((part: any) => part.type === 'text').map((part: any) => part.text ?? '').join(''), reasoning: reasoning || undefined, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : mapAnthropicReason(data.stop_reason), usage: usage(data.usage, 'input_tokens', 'output_tokens') }
}

function mergeAnthropicMessages(messages: Array<{ role: 'user' | 'assistant'; content: unknown }>): Array<{ role: 'user' | 'assistant'; content: unknown[] }> {
  const result: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  for (const message of messages) { const content = Array.isArray(message.content) ? message.content : [message.content]; const previous = result.at(-1); if (previous?.role === message.role) previous.content.push(...content); else result.push({ role: message.role, content: [...content] }) }
  return result
}

class ProviderHttpError extends Error { constructor(readonly status: number, readonly retryAfterMs: number | undefined, message: string) { super(message) } }
function retryable(error: unknown): boolean { return !(error instanceof ContextOverflowError) && (error instanceof ProviderTimeoutError || error instanceof ProviderHttpError && [408, 409, 429, 500, 502, 503, 504, 529].includes(error.status) || error instanceof TypeError || /(?:terminated|socket|connection.*closed|other side closed)/i.test(error instanceof Error ? error.message : String(error))) }
function friendlyProviderError(error: unknown): unknown { const technical = error instanceof Error ? error.message : String(error); if (/(?:terminated|socket|connection.*closed|other side closed)/i.test(technical)) return new Error(`انقطع اتصال المزود قبل اكتمال الرد بعد إعادة المحاولة. أرسل الرسالة مرة أخرى. (تفاصيل فنية: ${technical.slice(0, 500)})`); return error }
function retryDelay(error: unknown, attempt: number): number { if (error instanceof ProviderHttpError && error.retryAfterMs !== undefined) return Math.min(30_000, error.retryAfterMs); return Math.min(10_000, 500 * 2 ** attempt + Math.random() * 250) }
function parseRetryAfter(milliseconds: string | null, value: string | null): number | undefined { if (milliseconds) { const parsed = Number(milliseconds); if (Number.isFinite(parsed)) return Math.max(0, parsed) } if (!value) return undefined; const seconds = Number(value); if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000); const date = Date.parse(value); return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now()) }
function isContextOverflow(status: number, body: string): boolean { const value = body.toLowerCase(); if (/(?:rate limit|too many requests|throttl)/i.test(value)) return false; return [400, 413, 422].includes(status) && (status === 413 || /(?:prompt is too long|request_too_large|input is too long|exceeds the context window|maximum context length|context_length_exceeded|model_context_window_exceeded|too many tokens|token limit exceeded|reduce the length of the messages|tokens in request more than max tokens allowed)/i.test(value)) }
function delay(ms: number, signal?: AbortSignal, deadlineAt?: number): Promise<void> { return new Promise((resolve, reject) => { const finish = (): void => { cleanup(); resolve() }; const timer = setTimeout(finish, ms); const deadline = deadlineAt === undefined ? undefined : setTimeout(() => { clearTimeout(timer); cleanup(); reject(new DeadlineExceededError('انتهى الوقت المتاح لطلب المزود')) }, Math.max(1, deadlineAt - Date.now())); const abort = (): void => { clearTimeout(timer); if (deadline) clearTimeout(deadline); cleanup(); reject(new DOMException('تم الإلغاء', 'AbortError')) }; const cleanup = (): void => signal?.removeEventListener('abort', abort); signal?.addEventListener('abort', abort, { once: true }) }) }
function mapChatReason(value: unknown): FinishReason { if (value === 'stop') return 'stop'; if (value === 'length') return 'length'; if (value === 'content_filter') return 'content_filter'; if (value === 'tool_calls') return 'tool_calls'; return 'unknown' }
function mapAnthropicReason(value: unknown): FinishReason { if (value === 'end_turn' || value === 'stop_sequence') return 'stop'; if (value === 'max_tokens') return 'length'; if (value === 'refusal') return 'content_filter'; if (value === 'tool_use') return 'tool_calls'; return 'unknown' }
function textContent(value: unknown): string { if (typeof value === 'string') return value; if (Array.isArray(value)) return value.filter((part: any) => part?.type === 'text').map((part: any) => part.text ?? '').join(''); return '' }
function usage(data: any, input: string, output: string): ModelUsage | undefined {
  if (!data) return undefined
  const inputTokens = finiteNumber(data[input])
  const outputTokens = finiteNumber(data[output])
  const cacheRead = finiteNumber(data.cache_read_input_tokens ?? data[input === 'prompt_tokens' ? 'prompt_tokens_details' : 'input_tokens_details']?.cached_tokens)
  const cacheWrite = finiteNumber(data.cache_creation_input_tokens)
  const reasoning = finiteNumber(data.completion_tokens_details?.reasoning_tokens ?? data.output_tokens_details?.reasoning_tokens)
  return { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}), ...(reasoning ? { reasoning } : {}) }
}
function mergeUsage(first: ModelUsage | undefined, second: ModelUsage | undefined): ModelUsage | undefined {
  if (!first) return second
  if (!second) return first
  const input = (first.input ?? 0) + (second.input ?? 0)
  const output = (first.output ?? 0) + (second.output ?? 0)
  const cacheRead = (first.cacheRead ?? 0) + (second.cacheRead ?? 0)
  const cacheWrite = (first.cacheWrite ?? 0) + (second.cacheWrite ?? 0)
  const reasoning = (first.reasoning ?? 0) + (second.reasoning ?? 0)
  return { input, output, total: input + output, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}), ...(reasoning ? { reasoning } : {}) }
}
function finiteNumber(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0 }
function parseArguments(value: string): Record<string, unknown> { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('مدخل الأداة ليس object'); return parsed as Record<string, unknown> }
function assertDeadline(deadlineAt?: number): void { if (deadlineAt !== undefined && deadlineAt <= Date.now()) throw new DeadlineExceededError('انتهى الوقت المتاح لطلب المزود') }
