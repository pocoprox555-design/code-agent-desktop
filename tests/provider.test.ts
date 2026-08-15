import test from 'node:test'
import assert from 'node:assert/strict'
import { requestModel, ProviderResponseTooLargeError } from '../src/main/provider'
import type { ProviderConfig } from '../src/shared/types'

const config: ProviderConfig = { name: 'test', baseUrl: 'https://example.test/', apiPath: 'chat/completions', apiStyle: 'chat', model: 'test', contextWindow: 128_000, maxOutputTokens: 2_048, apiKey: 'key' }

test('rejects provider responses exceeding the byte limit', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(200) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  await assert.rejects(() => requestModel(config, [{ role: 'user', content: 'hi' }], [], { retries: 0, maxResponseBytes: 64 }), ProviderResponseTooLargeError)
})

test('parses valid provider responses within the byte limit', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }), { status: 200 })
  const reply = await requestModel(config, [{ role: 'user', content: 'hi' }], [], { retries: 0, maxResponseBytes: 1024 })
  assert.equal(reply.text, 'ok')
  assert.equal(reply.usage?.total, 3)
})

test('retries terminated streams before any output and hides the raw error', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) throw new TypeError('terminated')
    return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }] }), { status: 200 })
  }
  const reply = await requestModel(config, [{ role: 'user', content: 'hi' }], [], { retries: 1 })
  assert.equal(reply.text, 'recovered')
  assert.equal(calls, 2)
})

test('translates exhausted terminated errors', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => { throw new TypeError('terminated') }
  await assert.rejects(() => requestModel(config, [{ role: 'user', content: 'hi' }], [], { retries: 0 }), /انقطع اتصال المزود/)
})

test('Chat streaming waits for the tool name before start and completes once', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  globalThis.fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const starts: string[] = []; const deltas: string[] = []; const done: string[] = []
  const reply = await requestModel(config, [{ role: 'user', content: 'hi' }], [], { retries: 0, onTextDelta: () => {}, onToolCallStart: (id, name) => starts.push(`${id}:${name}`), onToolCallDelta: (_id, delta) => deltas.push(delta), onToolCallDone: (id) => done.push(id) })
  assert.deepEqual(starts, ['call-1:read_file'])
  assert.deepEqual(done, ['call-1'])
  assert.equal(deltas.length, 1)
  assert.equal(reply.toolCalls[0]?.name, 'read_file')
})

test('Responses streaming emits tool start, argument delta, and done callbacks', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const responsesConfig: ProviderConfig = { ...config, apiStyle: 'responses' }
  const events = [
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-r', name: 'read_file', arguments: '' } }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', call_id: 'call-r', delta: '{"path":"x"}' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-r', name: 'read_file', arguments: '{"path":"x"}' } }],
    ['response.completed', { type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  globalThis.fetch = async () => new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const callbacks: string[] = []
  const reply = await requestModel(responsesConfig, [{ role: 'user', content: 'hi' }], [], { retries: 0, onTextDelta: () => {}, onToolCallStart: () => callbacks.push('start'), onToolCallDelta: () => callbacks.push('delta'), onToolCallDone: () => callbacks.push('done') })
  assert.deepEqual(callbacks, ['start', 'delta', 'done'])
  assert.equal(reply.toolCalls[0]?.arguments, '{"path":"x"}')
})

test('Anthropic streaming preserves one tool call and one callback completion', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const anthropicConfig: ProviderConfig = { ...config, apiStyle: 'anthropic' }
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-a', name: 'read_file' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
  ].map((data) => `data: ${JSON.stringify(data)}\n\n`).join('')
  globalThis.fetch = async () => new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  let completed = 0
  const reply = await requestModel(anthropicConfig, [{ role: 'user', content: 'hi' }], [], { retries: 0, onTextDelta: () => {}, onToolCallDone: () => { completed++ } })
  assert.equal(completed, 1)
  assert.equal(reply.toolCalls.length, 1)
})
