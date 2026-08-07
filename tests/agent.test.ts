import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { AgentRunner } from '../src/main/agent'
import type { ProviderConfig } from '../src/shared/types'
import type { ProviderStore } from '../src/main/provider-store'
import type { requestModel } from '../src/main/provider'

async function databasePath(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'app.db')
}

test('accepts and persists multiple queued messages exactly once', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  const config: ProviderConfig = { name: 'test', baseUrl: 'https://example.test/', apiPath: 'chat/completions', apiStyle: 'chat', model: 'gpt-5.6-luna', contextWindow: 128_000, maxOutputTokens: 2_048, apiKey: 'test-key' }
  const provider = { get: () => config } as unknown as ProviderStore
  let releaseFirst!: () => void
  const firstRequest = new Promise<void>((resolve) => { releaseFirst = resolve })
  let calls = 0
  const modelRequest: typeof requestModel = async () => {
    calls++
    if (calls === 1) await firstRequest
    return { text: calls === 1 ? 'الرد الأول' : 'الرد الثاني', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }
  }
  const runner = new AgentRunner(db, provider, () => null, modelRequest)

  await runner.send(session.id, 'الرسالة الأولى')
  await runner.send(session.id, 'الرسالة الثانية')
  assert.deepEqual(db.listMessages(session.id).map((message) => message.content), ['الرسالة الأولى', 'الرسالة الثانية'])

  releaseFirst()
  for (let attempt = 0; attempt < 100 && runner.states().length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runner.states().length, 0)
  assert.deepEqual(db.listMessages(session.id).map((message) => message.content), ['الرسالة الأولى', 'الرسالة الثانية', 'الرد الأول', 'الرد الثاني'])
  assert.equal(db.getUsageSummary(session.id).requests, 2)
  await runner.shutdown()
  db.close()
})
