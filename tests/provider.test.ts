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
