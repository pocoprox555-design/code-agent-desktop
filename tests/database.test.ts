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

test('agent mode toggles freely between plan and build without approval', async (t) => {
  const path = await databasePath(t)
  const db = new AppDatabase(path)
  const session = db.createSession(process.cwd())
  assert.equal(session.agentMode, 'build')
  // دخول Plan ثم الخروج منه فورًا لا يُحاصَر ويُسمح بإعادة Build.
  const planned = db.updateSession(session.id, { agentMode: 'plan' })
  assert.equal(planned.agentMode, 'plan')
  const backToBuild = db.updateSession(planned.id, { agentMode: 'build' })
  assert.equal(backToBuild.agentMode, 'build')
  assert.equal(backToBuild.planApproved, false)
  db.close()
})

test('approvePlan builds the plan then allows switching to build', async (t) => {
  const path = await databasePath(t)
  const db = new AppDatabase(path)
  const session = db.createSession(process.cwd())
  const planned = db.updateSession(session.id, { agentMode: 'plan' })
  const approved = db.approvePlan(planned.id)
  assert.equal(approved.planApproved, true)
  const built = db.updateSession(approved.id, { agentMode: 'build' })
  assert.equal(built.agentMode, 'build')
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

test('persists todoId in tool call JSON and accepts legacy calls', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  db.addMessage({ sessionId: session.id, role: 'assistant', content: '', toolCalls: [
    { id: 'with-todo', name: 'read_file', input: {}, todoId: 'todo-1', status: 'running' },
    { id: 'without-todo', name: 'read_file', input: {}, status: 'running' },
  ] })
  db.repairIncompleteToolCalls()
  const calls = db.listMessages(session.id)[0]?.toolCalls
  assert.equal(calls?.[0]?.todoId, 'todo-1')
  assert.equal(calls?.[1]?.todoId, undefined)
  db.close()
})

test('todo updates preserve the id when content remains the same', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  const first = db.setTodos(session.id, [{ content: 'ثابت', status: 'pending' }])[0]!
  const second = db.setTodos(session.id, [{ content: 'ثابت', status: 'completed' }])[0]!
  assert.equal(second.id, first.id)
  assert.equal(second.status, 'completed')
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
  assert.equal(db.updateSession('s', { permissionMode: 'read-only' }).permissionMode, 'read-only')
  assert.equal(db.getSession('s').permissionMode, 'read-only')
  const raw = new DatabaseSync(path)
   assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 21)
  raw.close()
  db.close()
})

test('rebuilds an old sessions table with a stale sessions_legacy leftover', async (t) => {
  // يحاكي القاعدة التي كانت تسبّب "no such table: main.sessions_legacy":
  // CHECK قديم بدون read-only + نسخة 18 + بقايا sessions_legacy من محاولة فاشلة.
  const path = await databasePath(t)
  const legacy = new DatabaseSync(path)
  legacy.exec(`PRAGMA user_version=18;
    CREATE TABLE sessions_legacy (id TEXT PRIMARY KEY, stale TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace TEXT NOT NULL,permission_mode TEXT NOT NULL DEFAULT 'ask' CHECK(permission_mode IN ('ask','full')),agent_mode TEXT NOT NULL DEFAULT 'build' CHECK(agent_mode IN ('build','plan')),summary TEXT NOT NULL DEFAULT '',summary_sequence INTEGER NOT NULL DEFAULT 0,next_message_sequence INTEGER NOT NULL DEFAULT 1,git_tracked INTEGER NOT NULL DEFAULT 0,system_prompt TEXT NOT NULL DEFAULT '',todos TEXT NOT NULL DEFAULT '[]',plan_approved INTEGER NOT NULL DEFAULT 0,parent_session_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('s','قديمة','C:\\','ask','build','',0,1,0,'', '[]', 0, NULL, 1, 1);`)
  legacy.close()
  const db = new AppDatabase(path)
  const session = db.getSession('s')
  assert.equal(session.title, 'قديمة')
  assert.equal(session.permissionMode, 'ask')
  // الجدول الجديد يقبل read-only ولا توجد بقايا الجداول المؤقتة
  assert.equal(db.updateSession('s', { permissionMode: 'read-only' }).permissionMode, 'read-only')
  const raw = new DatabaseSync(path)
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions_legacy'").get(), undefined)
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions_new'").get(), undefined)
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 21)
  raw.close()
  db.close()
})

test('repairs child tables that reference a missing sessions_legacy table', async (t) => {
  const path = await databasePath(t)
  const legacy = new DatabaseSync(path)
  legacy.exec(`PRAGMA foreign_keys=OFF; PRAGMA user_version=18;
    CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace TEXT NOT NULL,permission_mode TEXT NOT NULL DEFAULT 'ask' CHECK(permission_mode IN ('ask','full')),agent_mode TEXT NOT NULL DEFAULT 'build' CHECK(agent_mode IN ('build','plan')),summary TEXT NOT NULL DEFAULT '',summary_sequence INTEGER NOT NULL DEFAULT 0,next_message_sequence INTEGER NOT NULL DEFAULT 1,git_tracked INTEGER NOT NULL DEFAULT 0,system_prompt TEXT NOT NULL DEFAULT '',todos TEXT NOT NULL DEFAULT '[]',plan_approved INTEGER NOT NULL DEFAULT 0,parent_session_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions_legacy(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,tool_call_id TEXT,tool_name TEXT,tool_calls TEXT,provider_payload TEXT,usage TEXT,attachments TEXT,reasoning TEXT,created_at INTEGER NOT NULL);
    CREATE INDEX messages_session_sequence ON messages(session_id, sequence);
    INSERT INTO sessions VALUES ('s','قديمة','C:\\','ask','build','',0,1,0,'','[]',0,NULL,1,1);
    INSERT INTO messages VALUES ('m','s',1,'user','محفوظة',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1);`)
  legacy.close()
  const db = new AppDatabase(path)
  assert.deepEqual(db.listMessages('s').map((message) => message.content), ['محفوظة'])
  db.addMessage({ sessionId: 's', role: 'user', content: 'جديدة' })
  assert.equal(db.listMessages('s').length, 2)
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

test('deleteAllSessions removes all sessions and related data', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const s1 = db.createSession('/tmp', 'session 1', false)
  const s2 = db.createSession('/tmp', 'session 2', false)
  db.addMessage({ id: 'm1', sessionId: s1.id, role: 'user', content: 'hello' })
  db.addMessage({ id: 'm2', sessionId: s2.id, role: 'user', content: 'world' })
  assert.equal(db.listSessions().length, 2)
  const deleted = db.deleteAllSessions()
  assert.equal(deleted, 2)
  assert.equal(db.listSessions().length, 0)
  assert.equal(db.listMessages(s1.id).length, 0)
  assert.equal(db.listMessages(s2.id).length, 0)
  db.close()
})

test('persists structured step metrics without content', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  db.recordStepMetric({ runId: 'run-1', sessionId: session.id, step: 1, discoveryMs: 2, contextMs: 3, modelMs: 4, firstTokenMs: 1, toolMs: 5, totalMs: 14, tools: ['read_file'], model: 'test' })
  assert.deepEqual(db.listStepMetrics(session.id), [{ runId: 'run-1', sessionId: session.id, step: 1, discoveryMs: 2, contextMs: 3, modelMs: 4, firstTokenMs: 1, toolMs: 5, totalMs: 14, tools: ['read_file'], model: 'test', changedFiles: 0, retries: 0 }])
  db.close()
})

test('summary archiving preserves ids and sequences while excluding archived context', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  const first = db.addMessage({ sessionId: session.id, role: 'user', content: 'old' })
  const second = db.addMessage({ sessionId: session.id, role: 'assistant', content: 'answer' })
  const current = db.addMessage({ sessionId: session.id, role: 'user', content: 'current' })
  assert.equal(db.setSummaryAndArchive(session.id, '{"goal":"test"}', second.sequence, 0), true)
  assert.deepEqual(db.listStoredMessages(session.id).map((message) => message.id), [current.id])
  assert.deepEqual(db.listMessages(session.id).map((message) => message.id), [first.id, second.id, current.id])
  assert.equal(db.getStoredMessage(session.id, first.id)?.content, 'old')
  assert.deepEqual(db.listAllStoredMessages(session.id).map((message) => message.sequence), [1, 2, 3])
  db.close()
})

test('failed conditional summary does not archive messages', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  db.addMessage({ sessionId: session.id, role: 'user', content: 'keep' })
  assert.equal(db.setSummaryAndArchive(session.id, 'bad race', 1, 99), false)
  assert.equal(db.listStoredMessages(session.id).length, 1)
  db.close()
})

test('migrates version 19 message tables with an archive flag', async (t) => {
  const path = await databasePath(t)
  const db = new AppDatabase(path)
  const session = db.createSession(process.cwd())
  db.addMessage({ sessionId: session.id, role: 'user', content: 'legacy row' })
  db.close()
  const raw = new DatabaseSync(path)
  assert.ok((raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).some((column) => column.name === 'archived'))
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 21)
  raw.close()
})
