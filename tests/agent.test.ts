import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WebContents } from 'electron'
import { AppDatabase } from '../src/main/database'
import { AgentRunner, forceCompactForOverflow, projectToolInput, smartCompressForContinuation } from '../src/main/agent'
import type { AgentEvent, ProviderConfig } from '../src/shared/types'
import type { ProviderStore } from '../src/main/provider-store'
import type { requestModel } from '../src/main/provider'
import { MAIN_CHAT_PROFILE, type AgentProfile } from '../src/main/agent-profile'

function testProvider(): ProviderStore {
  const config: ProviderConfig = { name: 'test', baseUrl: 'https://example.test/', apiPath: 'chat/completions', apiStyle: 'chat', model: 'gpt-5.6-luna', contextWindow: 128_000, maxOutputTokens: 2_048, apiKey: 'test-key' }
  return { get: () => config } as unknown as ProviderStore
}

async function databasePath(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'app.db')
}

async function waitForRunToFinish(runner: AgentRunner): Promise<void> {
  for (let attempt = 0; attempt < 600 && runner.states().length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runner.states().length, 0)
}

test('overflow compaction does not mutate original messages or nested tool calls', () => {
  const messages = [{ role: 'assistant' as const, content: 'reply', tool_calls: [{ id: 'call', type: 'function' as const, function: { name: 'write_file', arguments: 'x'.repeat(3_000) } }], providerPayload: [{ type: 'function_call', arguments: 'secret' }] }]
  const original = structuredClone(messages)
  forceCompactForOverflow(messages)
  assert.deepEqual(messages, original)
})

test('continuation compression keeps one assistant unit and one result per tool call', () => {
  const messages = [
    { role: 'assistant' as const, content: 'x'.repeat(2_000), tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"x"}' } }], providerPayload: [{ type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"x"}' }] },
    { role: 'tool' as const, content: 'result', tool_call_id: 'call-1' },
    { role: 'user' as const, content: 'next' },
    { role: 'assistant' as const, content: 'reply' },
    { role: 'user' as const, content: 'continue' },
    { role: 'assistant' as const, content: 'more' },
    { role: 'user' as const, content: 'final' },
  ]
  const compressed = smartCompressForContinuation(messages, 100)
  assert.equal(compressed.filter((message) => message.tool_calls?.some((call) => call.id === 'call-1')).length, 1)
  assert.equal(compressed.filter((message) => message.role === 'tool' && message.tool_call_id === 'call-1').length, 1)
})

test('tool input projection receipts large write variants without mutating originals', () => {
  const content = 'secret'.repeat(1_000)
  const bulk = { edits: [{ path: 'a.ts', old_string: content, new_string: content }] }
  const projected = projectToolInput('edit_files_bulk', bulk)
  assert.equal((bulk.edits[0] as Record<string, unknown>).old_string, content)
  assert.doesNotMatch(JSON.stringify(projected), /secretsecret/)
  assert.match(JSON.stringify(projectToolInput('append_file', { path: 'a.ts', content })), /sha256/)
  assert.match(JSON.stringify(projectToolInput('patch_file', { path: 'a.ts', patches: [{ new_lines: content }] })), /reference/)
})

function approvalModel(command: string): typeof requestModel {
  let calls = 0
  return async () => {
    calls++
    if (calls === 1) return { text: 'سأنفذ الأمر', toolCalls: [{ id: 'approval-tool', name: 'run_powershell', arguments: JSON.stringify({ command, cwd: '.' }) }], finishReason: 'stop', usage: { input: 10, output: 4 } }
    return { text: 'اكتمل التنفيذ', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }
  }
}

async function startApprovalRun(t: test.TestContext, decision: 'allow' | 'deny' | 'cancel') {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  const runner = new AgentRunner(db, testProvider(), () => null, approvalModel('Write-Output approval-regression'))
  await runner.send(session.id, 'اختبر الموافقة')
  for (let attempt = 0; attempt < 200 && !runner.states()[0]?.pendingApprovals?.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  const request = runner.states()[0]?.pendingApprovals?.[0]
  assert.ok(request)
  if (decision === 'allow') runner.answerApproval(request.id, true)
  else if (decision === 'deny') runner.answerApproval(request.id, false)
  else runner.cancel(session.id)
  await waitForRunToFinish(runner)
  return { db, runner, session }
}

function toolMessages(db: AppDatabase, sessionId: string): string[] { return db.listMessages(sessionId).filter((message) => message.role === 'tool').map((message) => message.content) }

function capturingWebContents(): { contents: WebContents; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const contents = { isDestroyed: () => false, send: (channel: string, payload: AgentEvent): void => { if (channel === 'agent:event') events.push(payload) } }
  return { contents: contents as unknown as WebContents, events }
}

test('AgentRunner approval allows the real PowerShell tool to execute', async (t) => {
  const { db, runner, session } = await startApprovalRun(t, 'allow')
  assert.match(toolMessages(db, session.id).join('\n'), /approval-regression/)
  await runner.shutdown(); db.close()
})

test('AgentRunner approval denial returns APPROVAL_DENIED', async (t) => {
  const { db, runner, session } = await startApprovalRun(t, 'deny')
  assert.match(toolMessages(db, session.id).join('\n'), /APPROVAL_DENIED/)
  await runner.shutdown(); db.close()
})

test('approval bypass comes from the profile, not the approval channel name', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  const profile: AgentProfile = { ...MAIN_CHAT_PROFILE, bypassApprovals: true, approvalChannel: 'approval:request' }
  const runner = new AgentRunner(db, testProvider(), () => null, approvalModel('Write-Output profile-bypass'), undefined, 'agent:event', 'approval:request', undefined, undefined, undefined, undefined, profile)
  await runner.send(session.id, 'اختبر profile')
  await waitForRunToFinish(runner)
  assert.match(toolMessages(db, session.id).join('\n'), /profile-bypass/)
  await runner.shutdown(); db.close()
})

test('parallel tools publish a fast completion while a slower tool is still waiting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-parallel-status-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await (await import('node:fs/promises')).writeFile(join(root, 'fast.txt'), 'ready', 'utf8')
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(root)
  const captured = capturingWebContents()
  let calls = 0
  const model: typeof requestModel = async () => ++calls === 1
    ? { text: 'سأقرأ وأجلب', toolCalls: [
      { id: 'fast-read', name: 'read_file', arguments: JSON.stringify({ path: 'fast.txt' }) },
      { id: 'waiting-fetch', name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.com/' }) },
    ], finishReason: 'tool_calls', usage: { input: 1, output: 1 } }
    : { text: 'اكتمل', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  const runner = new AgentRunner(db, testProvider(), () => captured.contents, model)

  await runner.send(session.id, 'اختبر الحالة المتوازية')
  for (let attempt = 0; attempt < 200 && !runner.states()[0]?.pendingApprovals?.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  const approval = runner.states()[0]?.pendingApprovals?.[0]
  assert.ok(approval)
  for (let attempt = 0; attempt < 200 && captured.events.filter((event) => event.type === 'tool' && event.tool?.id === 'fast-read').length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(captured.events.filter((event) => event.type === 'tool' && event.tool?.id === 'fast-read').length, 2)
  const storedFast = db.listMessages(session.id).flatMap((message) => message.toolCalls ?? []).find((tool) => tool.id === 'fast-read')
  assert.equal(storedFast?.status, 'completed')
  assert.equal(runner.states()[0]?.pendingApprovals?.[0]?.id, approval.id)

  runner.answerApproval(approval.id, false)
  await waitForRunToFinish(runner)
  await runner.shutdown(); db.close()
})

test('successful agent file mutations persist a typed mutation receipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-receipt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(root)
  db.updateSession(session.id, { permissionMode: 'full' })
  let calls = 0
  const model: typeof requestModel = async () => ++calls === 1
    ? { text: 'سأكتب', toolCalls: [{ id: 'receipt-write', name: 'write_file', arguments: JSON.stringify({ path: 'made.txt', content: 'made' }) }], finishReason: 'stop', usage: { input: 10, output: 4 } }
    : { text: 'اكتمل', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }
  const runner = new AgentRunner(db, testProvider(), () => null, model)
  await runner.send(session.id, 'اكتب الملف')
  await waitForRunToFinish(runner)
  const record = db.listMessages(session.id).flatMap((message) => message.toolCalls ?? []).find((tool) => tool.id === 'receipt-write')
  assert.deepEqual(record?.mutation?.effects, [{ kind: 'write', path: 'made.txt' }])
  assert.equal(record?.mutation?.workspaceRevision, 1)
  assert.doesNotMatch(record?.output ?? '', /"mutation"/)
  await runner.shutdown(); db.close()
})

test('Build sends historical write_file calls back to the model with real content, not contentReceipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-write-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(root)
  db.updateSession(session.id, { permissionMode: 'full' })
  let calls = 0
  const model: typeof requestModel = async (_config, messages) => {
    calls++
    if (calls === 1) return { text: 'سأكتب', toolCalls: [{ id: 'history-write', name: 'write_file', arguments: JSON.stringify({ path: 'history.txt', content: 'real historical content' }) }], finishReason: 'tool_calls', usage: { input: 1, output: 1 } }
    const historical = messages.flatMap((message) => message.tool_calls ?? []).find((call) => call.id === 'history-write')
    assert.ok(historical)
    assert.deepEqual(JSON.parse(historical.function.arguments), { path: 'history.txt', content: 'real historical content' })
    assert.doesNotMatch(historical.function.arguments, /contentReceipt/)
    return { text: 'اكتمل', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  }
  const profile: AgentProfile = { ...MAIN_CHAT_PROFILE, dedicatedBuild: true, bypassApprovals: true }
  const runner = new AgentRunner(db, testProvider(), () => null, model, undefined, 'agent:event', 'approval:request', undefined, undefined, undefined, undefined, profile)
  await runner.send(session.id, 'اكتب الملف')
  await waitForRunToFinish(runner)
  assert.equal(await readFile(join(root, 'history.txt'), 'utf8'), 'real historical content')
  await runner.shutdown(); db.close()
})

test('Build corrects a contentReceipt write without repeating the internal receipt payload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-write-correction-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(root)
  db.updateSession(session.id, { permissionMode: 'full' })
  let calls = 0
  const model: typeof requestModel = async (_config, messages) => {
    calls++
    if (calls === 1) return { text: '', toolCalls: [{ id: 'bad-receipt', name: 'write_file', arguments: JSON.stringify({ path: 'fixed.txt', contentReceipt: { bytes: 5000, sha256: 'do-not-repeat-this-hash', persistedAtPath: 'fixed.txt' } }) }], finishReason: 'tool_calls', usage: { input: 1, output: 1 } }
    const correction = messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n')
    assert.match(correction, /contentReceipt بيانات عرض داخلية/)
    assert.doesNotMatch(correction, /do-not-repeat-this-hash/)
    if (calls === 2) return { text: '', toolCalls: [{ id: 'fixed-write', name: 'write_file', arguments: JSON.stringify({ path: 'fixed.txt', content: 'complete content' }) }], finishReason: 'tool_calls', usage: { input: 1, output: 1 } }
    return { text: 'اكتمل', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  }
  const profile: AgentProfile = { ...MAIN_CHAT_PROFILE, dedicatedBuild: true, bypassApprovals: true }
  const runner = new AgentRunner(db, testProvider(), () => null, model, undefined, 'agent:event', 'approval:request', undefined, undefined, undefined, undefined, profile)
  await runner.send(session.id, 'اكتب الملف')
  await waitForRunToFinish(runner)
  assert.equal(calls, 3)
  assert.equal(await readFile(join(root, 'fixed.txt'), 'utf8'), 'complete content')
  await runner.shutdown(); db.close()
})

test('tool output containing an ok false string is still classified by its JSON envelope', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-output-envelope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await (await import('node:fs/promises')).writeFile(join(root, 'sample.json'), '{"nested":{"ok": false}}', 'utf8')
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(root)
  let calls = 0
  const model: typeof requestModel = async () => ++calls === 1
    ? { text: 'سأقرأ', toolCalls: [{ id: 'read-envelope', name: 'read_file', arguments: JSON.stringify({ path: 'sample.json' }) }], finishReason: 'tool_calls', usage: { input: 1, output: 1 } }
    : { text: 'اكتمل', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  const runner = new AgentRunner(db, testProvider(), () => null, model)
  await runner.send(session.id, 'اقرأ الملف')
  await waitForRunToFinish(runner)
  const record = db.listMessages(session.id).flatMap((message) => message.toolCalls ?? []).find((tool) => tool.id === 'read-envelope')
  assert.equal(record?.status, 'completed')
  assert.match(record?.output ?? '', /\\"ok\\": false/)
  await runner.shutdown(); db.close()
})

test('Build validates nested bulk inputs and normalizes common camelCase fields before execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-nested-validation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await (await import('node:fs/promises')).writeFile(join(root, 'a.txt'), 'before', 'utf8')
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(root)
  db.updateSession(session.id, { permissionMode: 'full' })
  let calls = 0
  const model: typeof requestModel = async (_config, messages) => {
    calls++
    if (calls === 1) return { text: '', toolCalls: [{ id: 'bad-bulk', name: 'edit_files_bulk', arguments: JSON.stringify({ edits: [{ path: 'a.txt', newString: 'after' }] }) }], finishReason: 'tool_calls', usage: { input: 1, output: 1 } }
    if (calls === 2) {
      const correction = messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n')
      assert.match(correction, /edits\[0\]\.old_string/)
      return { text: '', toolCalls: [{ id: 'fixed-bulk', name: 'edit_files_bulk', arguments: JSON.stringify({ edits: [{ path: 'a.txt', oldString: 'before', newString: 'after' }] }) }], finishReason: 'tool_calls', usage: { input: 1, output: 1 } }
    }
    return { text: 'اكتمل', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  }
  const profile: AgentProfile = { ...MAIN_CHAT_PROFILE, dedicatedBuild: true, bypassApprovals: true }
  const runner = new AgentRunner(db, testProvider(), () => null, model, undefined, 'agent:event', 'approval:request', undefined, undefined, undefined, undefined, profile)
  await runner.send(session.id, 'عدل الملف')
  await waitForRunToFinish(runner)
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'after')
  assert.equal(db.listMessages(session.id).flatMap((message) => message.toolCalls ?? []).some((tool) => tool.id === 'bad-bulk'), false)
  await runner.shutdown(); db.close()
})

test('cancelling an approval does not execute the tool', async (t) => {
  const { db, runner, session } = await startApprovalRun(t, 'cancel')
  const outputs = toolMessages(db, session.id).join('\n')
  assert.match(outputs, /ABORTED|AbortError/)
  assert.doesNotMatch(outputs, /approval-regression/)
  await runner.shutdown(); db.close()
})

test('AgentRunner accepts the complete Java diagnostics command without a Get-Command policy rejection', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  db.updateSession(session.id, { permissionMode: 'full' })
  let calls = 0
  const model: typeof requestModel = async () => {
    calls++
    if (calls === 1) return { text: 'سأفحص Java', toolCalls: [{ id: 'java-diagnostics', name: 'run_powershell', arguments: JSON.stringify({ command: 'java -version 2>&1; echo java-check; Get-Command java | Select-Object -ExpandProperty Source', cwd: '.' }) }], finishReason: 'stop', usage: { input: 10, output: 4 } }
    return { text: 'اكتمل الفحص', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }
  }
  const runner = new AgentRunner(db, testProvider(), () => null, model)
  await runner.send(session.id, 'افحص Java')
  await waitForRunToFinish(runner)
  const outputs = toolMessages(db, session.id).join('\n')
  assert.doesNotMatch(outputs, /الأمر غير مسموح|رفض PowerShell المقيد/)
  await runner.shutdown(); db.close()
})

test('AgentRunner persists policy failures as TOOL_ERROR and failed audit events', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  db.updateSession(session.id, { permissionMode: 'full' })
  let calls = 0
  const model: typeof requestModel = async () => {
    calls++
    if (calls === 1) return { text: 'سأختبر الرفض', toolCalls: [{ id: 'policy-failure', name: 'run_powershell', arguments: JSON.stringify({ command: 'Invoke-Expression "Write-Output blocked"', cwd: '.' }) }], finishReason: 'stop', usage: { input: 10, output: 4 } }
    return { text: 'تم تسجيل الرفض', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }
  }
  const runner = new AgentRunner(db, testProvider(), () => null, model)
  await runner.send(session.id, 'اختبر فشل السياسة')
  await waitForRunToFinish(runner)
  assert.match(toolMessages(db, session.id).join('\n'), /TOOL_ERROR/)
  assert.ok(db.listAudit(100).some((event) => event.action === 'run_powershell' && event.outcome === 'failed'))
  await runner.shutdown(); db.close()
})

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

test('todo auto-completion is isolated by profile', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  db.setTodos(session.id, [
    { content: 'فحص المشروع', status: 'in_progress', priority: 'high' },
    { content: 'إرسال الملخص', status: 'pending', priority: 'medium' },
  ])
  const config: ProviderConfig = { name: 'test', baseUrl: 'https://example.test/', apiPath: 'chat/completions', apiStyle: 'chat', model: 'gpt-5.6-luna', contextWindow: 128_000, maxOutputTokens: 2_048, apiKey: 'test-key' }
  const provider = { get: () => config } as unknown as ProviderStore
  const mainRunner = new AgentRunner(db, provider, () => null, async () => ({ text: 'اكتملت المهمة', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }))

  await mainRunner.send(session.id, 'نفذ المهمة')
  await waitForRunToFinish(mainRunner)
  assert.deepEqual(db.getTodos(session.id).map((todo) => todo.status), ['in_progress', 'pending'])
  const buildProfile: AgentProfile = { ...MAIN_CHAT_PROFILE, autoCompleteTodos: true }
  const runner = new AgentRunner(db, provider, () => null, async () => ({ text: 'اكتملت المهمة', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }), undefined, 'agent:event', 'approval:request', undefined, undefined, undefined, undefined, buildProfile)
  await runner.send(session.id, 'نفذ المهمة في Build')
  await waitForRunToFinish(runner)
  assert.deepEqual(db.getTodos(session.id).map((todo) => todo.status), ['completed', 'completed'])
  await mainRunner.shutdown()
  await runner.shutdown()
  db.close()
})

test('failed mutations do not advance workspace revision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-revision-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(root)
  db.updateSession(session.id, { permissionMode: 'full' })
  let calls = 0
  const model: typeof requestModel = async () => ++calls === 1
    ? { text: 'تعديل سيفشل', toolCalls: [{ id: 'failed-edit', name: 'edit_file', arguments: JSON.stringify({ path: 'missing.txt', old_string: 'x', new_string: 'y' }) }], finishReason: 'stop', usage: { input: 1, output: 1 } }
    : { text: 'انتهى', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  const runner = new AgentRunner(db, testProvider(), () => null, model)
  await runner.send(session.id, 'اختبر الفشل')
  await waitForRunToFinish(runner)
  const record = db.listMessages(session.id).flatMap((message) => message.toolCalls ?? []).find((tool) => tool.id === 'failed-edit')
  assert.equal(record?.mutation, undefined)
  await runner.shutdown(); db.close()
})

test('auto-preview starts only after a runtime mutation and does not block the next model step', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(root)
  db.updateSession(session.id, { permissionMode: 'full' })
  let previewCalls = 0
  let modelCalls = 0
  let releasePreview!: () => void
  const previewGate = new Promise<void>((resolve) => { releasePreview = resolve })
  const model: typeof requestModel = async () => ++modelCalls === 1
    ? { text: 'سأكتب', toolCalls: [{ id: 'runtime-write', name: 'write_file', arguments: JSON.stringify({ path: 'src/App.tsx', content: 'export default 1' }) }], finishReason: 'stop', usage: { input: 1, output: 1 } }
    : { text: 'انتهى', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  const profile: AgentProfile = { ...MAIN_CHAT_PROFILE, dedicatedBuild: true, autoPreview: true }
  const runner = new AgentRunner(db, testProvider(), () => null, model, undefined, 'agent:event', 'approval:request', async () => { previewCalls++; await previewGate; return { running: true } }, undefined, () => ({ running: false }), undefined, profile)
  await runner.send(session.id, 'عدّل')
  for (let attempt = 0; attempt < 200 && modelCalls < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(modelCalls, 2)
  assert.equal(previewCalls, 1)
  releasePreview()
  await waitForRunToFinish(runner)
  await runner.shutdown(); db.close()
})

test('read-only tool calls never trigger auto-preview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-no-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await (await import('node:fs/promises')).writeFile(join(root, 'App.tsx'), 'export default 1', 'utf8')
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(root)
  let calls = 0
  let previewCalls = 0
  const model: typeof requestModel = async () => ++calls === 1
    ? { text: 'سأقرأ', toolCalls: [{ id: 'read-only', name: 'read_file', arguments: JSON.stringify({ path: 'App.tsx' }) }], finishReason: 'stop', usage: { input: 1, output: 1 } }
    : { text: 'انتهى', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  const profile: AgentProfile = { ...MAIN_CHAT_PROFILE, dedicatedBuild: true, autoPreview: true }
  const runner = new AgentRunner(db, testProvider(), () => null, model, undefined, 'agent:event', 'approval:request', async () => { previewCalls++; return { running: true } }, undefined, () => ({ running: false }), undefined, profile)
  await runner.send(session.id, 'اقرأ فقط')
  await waitForRunToFinish(runner)
  assert.equal(previewCalls, 0)
  await runner.shutdown(); db.close()
})

test('verification cache is reused only for the same workspace revision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-agent-verify-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await (await import('node:fs/promises')).writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }), 'utf8')
  const db = new AppDatabase(await databasePath(t))
  const runner = new AgentRunner(db, testProvider(), () => null)
  const verify = (runner as unknown as { runVerification(workspace: string, revision: number, signal: AbortSignal, files?: string[], deadlineAt?: number): Promise<string | null> }).runVerification.bind(runner)
  const first = await verify(root, 1, new AbortController().signal)
  const cache = (runner as unknown as { verificationCache: Map<string, unknown> }).verificationCache
  assert.equal(cache.size, 1)
  assert.equal(await verify(root, 1, new AbortController().signal), first)
  assert.equal(cache.size, 1)
  await verify(root, 2, new AbortController().signal)
  assert.equal(cache.size, 2)
  await runner.shutdown(); db.close()
})

test('the first event of any new run is run:start with the same runId', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  const captured = capturingWebContents()
  const runner = new AgentRunner(db, testProvider(), () => captured.contents, async () => ({ text: 'الرد الأول', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }))
  await runner.send(session.id, 'الرسالة الأولى')
  await waitForRunToFinish(runner)
  const events = captured.events
  assert.ok(events.length > 0)
  const first = events[0]!
  assert.equal(first.type, 'run:start')
  const persisted = db.getAgentRun(session.id)
  assert.ok(persisted)
  assert.equal(first.runId, persisted.runId)
  await runner.shutdown()
  db.close()
})

test('a second message after completion starts a new run with its own preceding run:start', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  const captured = capturingWebContents()
  const runner = new AgentRunner(db, testProvider(), () => captured.contents, async () => ({ text: 'رد', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }))
  await runner.send(session.id, 'الأولى')
  await waitForRunToFinish(runner)
  const firstRun = db.getAgentRun(session.id)!.runId
  captured.events.length = 0
  await runner.send(session.id, 'الثانية')
  await waitForRunToFinish(runner)
  const secondRun = db.getAgentRun(session.id)!.runId
  assert.notEqual(secondRun, firstRun)
  const starts = captured.events.filter((event) => event.type === 'run:start')
  assert.equal(starts.length, 1)
  assert.equal(starts[0]!.runId, secondRun)
  const userMessage = captured.events.find((event) => event.type === 'message' && event.message?.role === 'user')
  assert.ok(userMessage)
  assert.equal(userMessage.runId, secondRun)
  await runner.shutdown()
  db.close()
})

test('messages queued during an active run do not emit a fake run:start and keep the same runId', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  const captured = capturingWebContents()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const model: typeof requestModel = async () => {
    calls++
    if (calls === 1) await gate
    return { text: 'رد', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }
  }
  const runner = new AgentRunner(db, testProvider(), () => captured.contents, model)
  await runner.send(session.id, 'الأولى')
  await runner.send(session.id, 'الثانية')
  const runId = db.getAgentRun(session.id)!.runId
  assert.equal(captured.events.filter((event) => event.type === 'run:start').length, 1)
  assert.equal(captured.events.find((event) => event.type === 'run:start')!.runId, runId)
  const queued = captured.events.filter((event) => event.type === 'message' && event.message?.content === 'الثانية')
  assert.equal(queued.length, 1)
  assert.equal(queued[0]!.runId, runId)
  release()
  await waitForRunToFinish(runner)
  assert.equal(captured.events.filter((event) => event.type === 'run:start').length, 1)
  await runner.shutdown()
  db.close()
})

test('rejects a PDF attachment with invalid file bytes before provider execution', async (t) => {
  const db = new AppDatabase(await databasePath(t))
  const session = db.createSession(process.cwd())
  let called = false
  const runner = new AgentRunner(db, testProvider(), () => null, async () => { called = true; return { text: 'no', toolCalls: [], finishReason: 'stop' } })
  await assert.rejects(() => runner.send(session.id, 'اقرأ', [{ name: 'bad.pdf', mimeType: 'application/pdf', data: Buffer.from('not pdf').toString('base64'), size: 7 }]), /ليس ملف PDF صالحا/)
  assert.equal(called, false)
  await runner.shutdown(); db.close()
})
