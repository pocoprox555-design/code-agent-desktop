import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { AppDatabase } from '../src/main/database'

async function databasePath(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-db-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'app.db')
}

test('messages use deterministic per-session sequences', async (t) => {
  const path = await databasePath(t)
  const db = new AppDatabase(path)
  const session = db.createSession(process.cwd())
  const first = db.addMessage({ sessionId: session.id, role: 'user', content: 'one', createdAt: 100 })
  const second = db.addMessage({ sessionId: session.id, role: 'assistant', content: 'two', createdAt: 100 })
  assert.equal(first.sequence, 1)
  assert.equal(second.sequence, 2)
  assert.deepEqual(db.listMessages(session.id).map((message) => message.content), ['one', 'two'])
  db.close()
})

test('repairs interrupted tool calls without rerunning them', async (t) => {
  const path = await databasePath(t)
  const db = new AppDatabase(path)
  const session = db.createSession(process.cwd())
  db.addMessage({ sessionId: session.id, role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'write_file', input: { path: 'x' }, status: 'running' }] })
  db.repairIncompleteToolCalls()
  const messages = db.listMessages(session.id)
  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.toolCalls?.[0]?.status, 'error')
  assert.equal(messages[1]?.role, 'tool')
  assert.match(messages[1]?.content ?? '', /لن يعاد تشغيلها/)
  db.close()
})

test('migrates legacy databases and clears summaries without watermarks', async (t) => {
  const path = await databasePath(t)
  const legacy = new DatabaseSync(path)
  legacy.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace TEXT NOT NULL,permission_mode TEXT NOT NULL DEFAULT 'ask',agent_mode TEXT NOT NULL DEFAULT 'build',summary TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,tool_call_id TEXT,tool_name TEXT,tool_calls TEXT,created_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('s','legacy','C:\\','ask','build','old summary',1,1);
    INSERT INTO messages VALUES ('b','s','assistant','second',NULL,NULL,NULL,10);
    INSERT INTO messages VALUES ('a','s','user','first',NULL,NULL,NULL,10);`)
  legacy.close()
  const db = new AppDatabase(path)
  assert.deepEqual(db.listMessages('s').map((message) => message.content), ['first', 'second'])
  assert.deepEqual(db.getSummary('s'), { text: '', throughSequence: 0 })
  const raw = new DatabaseSync(path)
   assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12)
  raw.close()
  db.close()
})

test('persists and updates subagent events for replay', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  db.saveSubagentEvent(session.id, 'run-1', { id: 'sub-1', runId: 'run-1', description: 'فحص المشروع', state: 'running', step: 1 })
  db.saveSubagentEvent(session.id, 'run-1', { id: 'sub-1', runId: 'run-1', description: 'فحص المشروع', state: 'completed', step: 2, summary: 'تم الفحص.' })
  assert.deepEqual(db.listSubagentEvents(session.id), [{ id: 'sub-1', runId: 'run-1', description: 'فحص المشروع', state: 'completed', step: 2, summary: 'تم الفحص.' }])
  db.close()
})

test('stores and retrieves audit events', async (t) => {
  const path = await databasePath(t)
  const db = new AppDatabase(path)
  const event = db.addAudit({ category: 'security', action: 'test', detail: 'detail', outcome: 'completed' })
  assert.equal(db.listAudit()[0]?.id, event.id)
  db.close()
})

test('records usage idempotently and aggregates known and estimated requests', async (t) => {
  const path = await databasePath(t)
  const db = new AppDatabase(path)
  const session = db.createSession(process.cwd())
  db.recordUsage({ sessionId: session.id, requestId: 'request-1', purpose: 'agent', model: 'test', apiStyle: 'chat', usage: { input: 100, output: 25, cacheRead: 10 } })
  db.recordUsage({ sessionId: session.id, requestId: 'request-1', purpose: 'agent', model: 'test', apiStyle: 'chat', usage: { input: 999, output: 999 } })
  db.recordUsage({ sessionId: session.id, requestId: 'request-2', purpose: 'compaction', model: 'test', apiStyle: 'chat', estimatedInputTokens: 80 })
  assert.deepEqual(db.getUsageSummary(session.id), { requests: 2, input: 100, output: 25, total: 125, cacheRead: 10, cacheWrite: 0, reasoning: 0, estimatedInput: 80, cost: 0, lastAt: db.getUsageSummary(session.id).lastAt })
  db.close()
})

test('stores git tracking flag on sessions', async (t) => {
  const path = await databasePath(t)
  const db = new AppDatabase(path)
  const plain = db.createSession(process.cwd())
  const tracked = db.createSession(process.cwd(), 'tracked', true)
  assert.equal(plain.gitTracked, false)
  assert.equal(tracked.gitTracked, true)
  assert.equal(db.getSession(tracked.id).gitTracked, true)
  assert.equal(db.getSession(plain.id).gitTracked, false)
  db.close()
})

test('persists agent run progress and marks abandoned runs interrupted', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  db.startAgentRun(session.id, 'run-1', 100)
  db.updateAgentRun(session.id, 'run-1', 7)
  assert.equal(db.getAgentRun(session.id)?.step, 7)
  db.markRunningRunsInterrupted()
  assert.equal(db.getAgentRun(session.id)?.status, 'interrupted')
  db.finishAgentRun(session.id, 'run-1', 'completed')
  assert.equal(db.getAgentRun(session.id)?.status, 'completed')
  db.close()
})

test('ignores malformed stored message JSON without breaking startup repair', async (t) => {
  const path = await databasePath(t)
  let db = new AppDatabase(path)
  const session = db.createSession(process.cwd())
  const message = db.addMessage({ sessionId: session.id, role: 'assistant', content: 'safe' })
  db.close()
  const raw = new DatabaseSync(path)
  raw.prepare('UPDATE messages SET tool_calls=?,provider_payload=?,usage=? WHERE id=?').run('{}', '{"bad":true}', '"bad"', message.id)
  raw.close()
  db = new AppDatabase(path)
  assert.doesNotThrow(() => db.repairIncompleteToolCalls())
  const stored = db.listStoredMessages(session.id)[0]
  assert.equal(stored?.toolCalls, undefined)
  assert.equal(stored?.providerPayload, undefined)
  assert.equal(stored?.usage, undefined)
  db.close()
})
