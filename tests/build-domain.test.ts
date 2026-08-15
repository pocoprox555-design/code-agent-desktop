import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WebContents } from 'electron'
import { AppDatabase } from '../src/main/database'
import { AgentRunner } from '../src/main/agent'
import { BUILD_SYSTEM_PROMPT, BuildDomain, cleanupLegacyBuildSessions } from '../src/main/build-domain'
import { McpManager } from '../src/main/mcp'
import type { AgentEvent, ProviderConfig } from '../src/shared/types'
import type { ProviderStore } from '../src/main/provider-store'
import type { requestModel } from '../src/main/provider'
import { buildOutputTokenBudget, buildToolPolicy, DEDICATED_BUILD_PROFILE, MAIN_CHAT_PROFILE } from '../src/main/agent-profile'

const BUILD_MARKER = '[FULL_SHELL_ACCESS]\nأنت وكيل بناء متخصص. صلاحياتك كاملة على هذا المشروع. عدّل الملفات مباشرة، شغّل الأوامر، ثبّت الحزم، ابنِ وشغّل الخادم. لا تسأل عن أي صلاحية.'

test('agent profiles explicitly separate main chat from dedicated Build', () => {
  assert.equal(MAIN_CHAT_PROFILE.dedicatedBuild, false)
  assert.equal(MAIN_CHAT_PROFILE.bypassApprovals, false)
  assert.equal(DEDICATED_BUILD_PROFILE.dedicatedBuild, true)
  assert.equal(DEDICATED_BUILD_PROFILE.bypassApprovals, true)
  assert.equal(DEDICATED_BUILD_PROFILE.fullPowerShellLanguage, true)
  assert.notEqual(DEDICATED_BUILD_PROFILE.approvalChannel, DEDICATED_BUILD_PROFILE.eventChannel)
})

test('Build tool policy enables capability groups by default and gates only MCP on explicit signals', () => {
  const local = buildToolPolicy('اصلح TypeScript محليا', { preview: true, subagents: true })
  assert.equal(local.localToolsAlwaysAvailable, true)
  // بلا بوابات تخمين على كلام المستخدم: web/pdf/preview/subagents متاحة دائمًا حسب القدرات
  for (const group of ['core', 'web', 'pdf', 'preview', 'subagents'] as const) assert.ok(local.groups.has(group))
  assert.equal(local.groups.has('mcp'), false)
  const expanded = buildToolPolicy('استخدم MCP مع الخادم', { preview: false, subagents: false })
  assert.ok(expanded.groups.has('mcp'))
  assert.equal(expanded.groups.has('preview'), false)
  assert.equal(expanded.groups.has('subagents'), false)
  // عقد البرومبت: توجيه edit_files_bulk + قاعدة اللغة + تخصص Build
  assert.match(BUILD_SYSTEM_PROMPT, /Prefer edit_files_bulk/)
  assert.match(BUILD_SYSTEM_PROMPT, /same language as the user's latest message/)
  assert.match(BUILD_SYSTEM_PROMPT, /dedicated Build agent/)
})

test('adaptive output budget applies the 32K floor for Build only and grows after length', () => {
  // الشات الرئيسي أو الجولة النهائية: القيمة المضبوطة كما هي
  assert.equal(buildOutputTokenBudget(10_000, 128_000, false), 10_000)
  assert.equal(buildOutputTokenBudget(10_000, 128_000, true, true), 10_000)
  // سقف مضبوط أدنى من الحد الأدنى: يبقى محكومًا بالسقف المضبوط
  assert.equal(buildOutputTokenBudget(10_000, 128_000, true), 10_000)
  // نافذة صغيرة مع سقف كبير: الحد الأدنى 32K يرفع الميزانية الأولية (كانت 12.5K)
  const floored = buildOutputTokenBudget(100_000, 200_000, true)
  assert.equal(floored, 32_768)
  assert.ok(buildOutputTokenBudget(100_000, 200_000, true, false, 1) > floored)
})

function testProvider(): ProviderStore {
  const config: ProviderConfig = { name: 'test', baseUrl: 'https://example.test/', apiPath: 'chat/completions', apiStyle: 'chat', model: 'gpt-5.6-luna', contextWindow: 128_000, maxOutputTokens: 2_048, apiKey: 'test-key' }
  return { get: () => config, getForModel: (model: string) => ({ ...config, model }) } as unknown as ProviderStore
}

async function tempDirs(t: test.TestContext): Promise<{ root: string; userData: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const userData = join(root, 'user-data')
  const projectDir = join(root, 'project')
  await mkdir(userData)
  await mkdir(projectDir)
  return { root, userData, projectDir }
}

function makeDomain(userData: string, providers: ProviderStore = testProvider(), getWebContents: () => WebContents | null = () => null, modelRequest?: typeof requestModel): BuildDomain {
  return new BuildDomain({ userData, providers, mcp: new McpManager(), getWebContents, modelRequest })
}

const immediateModel: typeof requestModel = async () => ({ text: 'رد البناء', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } })

function buildApprovalModel(): typeof requestModel {
  let calls = 0
  return async () => {
    calls++
    if (calls === 1) return { text: 'أحتاج تنفيذ أمر', toolCalls: [{ id: 'build-approval-tool', name: 'run_powershell', arguments: JSON.stringify({ command: 'Write-Output build-approval', cwd: '.' }) }], finishReason: 'stop', usage: { input: 10, output: 4 } }
    return { text: 'اكتمل', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } }
  }
}

async function waitForRunsEmpty(...runners: AgentRunner[]): Promise<void> {
  for (let attempt = 0; attempt < 400 && runners.some((runner) => runner.states().length); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(runners.reduce((total, runner) => total + runner.states().length, 0), 0)
}

function capturingWebContents(): { contents: WebContents; sends: Array<{ channel: string; event: AgentEvent }> } {
  const sends: Array<{ channel: string; event: AgentEvent }> = []
  const contents = { isDestroyed: () => false, send: (channel: string, event: AgentEvent): void => { sends.push({ channel, event }) } }
  return { contents: contents as unknown as WebContents, sends }
}

test('build sessions live only in build.db, never in the main database', async (t) => {
  const { root, userData, projectDir } = await tempDirs(t)
  const main = new AppDatabase(join(root, 'main.db'))
  const domain = makeDomain(userData)
  try {
    assert.equal(main.listSessions().length, 0)
    const project = await domain.projects.save({ name: 'عزل', path: projectDir, template: 'existing', filesCount: 1, totalLines: 2 })
    // بعد الحفظ: قاعدة البناء وحدها تحوي الجلسة
    assert.equal(main.listSessions().length, 0)
    assert.equal(domain.db.listSessions().length, 1)
    assert.equal(project.chatSessionId, domain.db.listSessions()[0]!.id)
    // والعكس: جلسة رئيسية جديدة لا تدخل قاعدة البناء
    const mainSession = main.createSession(projectDir)
    assert.equal(main.listSessions().length, 1)
    assert.equal(domain.db.listSessions().length, 1)
    assert.notEqual(mainSession.id, project.chatSessionId)
    assert.equal(mainSession.systemPrompt, '')
    assert.equal(domain.db.getSession(project.chatSessionId).systemPrompt, BUILD_SYSTEM_PROMPT)
    assert.doesNotMatch(domain.db.getSession(project.chatSessionId).systemPrompt, /FULL_SHELL_ACCESS/)
    assert.equal(domain.db.getSession(project.chatSessionId).permissionMode, 'full')
  } finally {
    await domain.shutdown()
    main.close()
  }
})

test('project round-trip: save, list, open, remove', async (t) => {
  const { userData, projectDir } = await tempDirs(t)
  const domain = makeDomain(userData)
  try {
    const saved = await domain.projects.save({ name: 'رحلة', path: projectDir, template: 'react-vite', filesCount: 3, totalLines: 5 })
    assert.ok(saved.chatSessionId.length > 0)
    const listed = domain.projects.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.id, saved.id)
    assert.equal(listed[0]!.chatSessionId, saved.chatSessionId)

    const payload = domain.projects.open(saved.id)
    assert.equal(payload.project.path, saved.path)
    assert.equal(payload.project.chatSessionId, saved.chatSessionId)
    assert.equal(payload.session.id, saved.chatSessionId)
    assert.equal(payload.session.systemPrompt, BUILD_SYSTEM_PROMPT)
    assert.equal(payload.session.permissionMode, 'full')
    assert.equal(payload.messages.length, 0)
    assert.equal(payload.usage.requests, 0)
    assert.deepEqual(payload.subagents, [])
    assert.deepEqual(payload.checkpoints, [])

    domain.projects.remove(saved.id)
    assert.equal(domain.projects.list().length, 0)
    assert.throws(() => domain.db.getSession(saved.chatSessionId))
    assert.throws(() => domain.projects.open(saved.id))
    assert.ok(domain.db.listAudit(100).some((audit) => audit.action === 'project-removed'))
  } finally {
    await domain.shutdown()
  }
})

test('build chat persists across a restart of the build domain', async (t) => {
  const { userData, projectDir } = await tempDirs(t)
  let saved: import('../src/shared/types').BuildProject | undefined
  let messagesBefore: string[] = []
  let domain = makeDomain(userData, testProvider(), () => null, immediateModel)
  try {
    saved = await domain.projects.save({ name: 'استمرار', path: projectDir, template: 'existing', filesCount: 1, totalLines: 1 })
    await domain.runner.send(saved.chatSessionId, 'ابنِ الصفحة الرئيسية')
    await waitForRunsEmpty(domain.runner)
    messagesBefore = domain.db.listMessages(saved.chatSessionId).map((message) => message.content)
    assert.ok(messagesBefore.some((content) => content.includes('ابنِ الصفحة الرئيسية')))
    assert.ok(messagesBefore.includes('رد البناء'))
  } finally {
    await domain.shutdown()
  }

  const stalePromptDomain = makeDomain(userData)
  stalePromptDomain.db.setSystemPrompt(saved!.chatSessionId, 'تعليمات بناء قديمة')
  await stalePromptDomain.shutdown()

  // إعادة فتح نفس build.db بعد "إغلاق التطبيق"
  const reopened = makeDomain(userData, testProvider(), () => null, immediateModel)
  try {
    const payload = reopened.projects.open(saved!.id)
    assert.equal(payload.project.id, saved!.id)
    assert.equal(payload.messages.length, messagesBefore.length)
    assert.ok(payload.messages.some((message) => message.role === 'user' && message.content === 'ابنِ الصفحة الرئيسية'))
    assert.ok(payload.messages.some((message) => message.role === 'assistant' && message.content === 'رد البناء'))
    assert.match(payload.session.systemPrompt, /Prefer edit_files_bulk/)
  } finally {
    await reopened.shutdown()
  }
})

test('legacy Build marker is migrated to full permissions without deleting the registered project', async (t) => {
  const { userData, projectDir } = await tempDirs(t)
  const domain = makeDomain(userData)
  try {
    const project = await domain.projects.save({ name: 'قديم', path: projectDir, template: 'existing', filesCount: 0, totalLines: 0 })
    domain.db.setSystemPrompt(project.chatSessionId, BUILD_MARKER)
    domain.db.updateSession(project.chatSessionId, { permissionMode: 'ask' })
    await domain.shutdown()
    const reopened = makeDomain(userData)
    try {
      const session = reopened.db.getSession(project.chatSessionId)
      assert.equal(session.permissionMode, 'full')
      assert.equal(session.systemPrompt, BUILD_SYSTEM_PROMPT)
      assert.equal(reopened.projects.list().length, 1)
    } finally { await reopened.shutdown() }
  } catch (error) {
    try { await domain.shutdown() } catch {}
    throw error
  }
})

test('clear chat cancels a run and preserves the Build project and files', async (t) => {
  const { userData, projectDir } = await tempDirs(t)
  const domain = makeDomain(userData, testProvider(), () => null, immediateModel)
  try {
    const project = await domain.projects.save({ name: 'مسح', path: projectDir, template: 'existing', filesCount: 1, totalLines: 1 })
    domain.db.addMessage({ sessionId: project.chatSessionId, role: 'user', content: 'رسالة' })
    domain.db.setTodos(project.chatSessionId, [{ content: 'مرحلة', status: 'in_progress' }])
    domain.db.createCheckpoint(project.chatSessionId, 'قبل', domain.db.listMessages(project.chatSessionId), [])
    domain.db.saveSubagentEvent(project.chatSessionId, 'run-1', { id: 'sub-1', runId: 'run-1', description: 'فحص', state: 'completed', step: 1 })
    domain.db.recordUsage({ sessionId: project.chatSessionId, runId: 'run-1', requestId: 'usage-1', purpose: 'agent', model: 'test', apiStyle: 'chat', usage: { input: 1, output: 1 } })
    await domain.projects.clearChat(project.id)
    assert.deepEqual(domain.db.listMessages(project.chatSessionId), [])
    assert.deepEqual(domain.db.getTodos(project.chatSessionId), [])
    assert.deepEqual(domain.db.listCheckpoints(project.chatSessionId), [])
    assert.deepEqual(domain.db.listSubagentEvents(project.chatSessionId), [])
    assert.equal(domain.db.getAgentRun(project.chatSessionId), undefined)
    assert.equal(domain.db.getUsageSummary(project.chatSessionId).requests, 1)
    assert.equal(domain.projects.list().length, 1)
  } finally { await domain.shutdown() }
})

test('build model override is per-send and never mutates the main provider', async (t) => {
  const { userData, projectDir } = await tempDirs(t)
  const base: ProviderConfig = { name: 'test', baseUrl: 'https://example.test/', apiPath: 'chat/completions', apiStyle: 'chat', model: 'gpt-5.6-luna', contextWindow: 128_000, maxOutputTokens: 2_048, apiKey: 'test-key' }
  const forModelCalls: ProviderConfig[] = []
  const providers = { get: () => base, getForModel: (model: string) => { const config = { ...base, model }; forModelCalls.push(config); return config } } as unknown as ProviderStore
  let captured: ProviderConfig | null = null
  const captureModel: typeof requestModel = async (config) => { captured = config; return { text: 'تم', toolCalls: [], finishReason: 'stop', usage: { input: 10, output: 4 } } }
  const domain = makeDomain(userData, providers, () => null, captureModel)
  try {
    const project = await domain.projects.save({ name: 'تجاوز', path: projectDir, template: 'existing', filesCount: 0, totalLines: 0 })
    await domain.runner.send(project.chatSessionId, 'ابنِ بنموذج آخر', undefined, 'x')
    await waitForRunsEmpty(domain.runner)
    assert.equal(captured?.model, 'x')
    // المزود الرئيسي لم يُكتب ولم يتغير
    assert.equal(providers.get().model, 'gpt-5.6-luna')
    assert.equal(forModelCalls.length, 1)
  } finally {
    await domain.shutdown()
  }
})

test('build runner emits only on build:event; the main runner only on agent:event', async (t) => {
  const { root, userData, projectDir } = await tempDirs(t)
  const buildCapture = capturingWebContents()
  const domain = makeDomain(userData, testProvider(), () => buildCapture.contents, immediateModel)
  const main = new AppDatabase(join(root, 'main.db'))
  const mainCapture = capturingWebContents()
  const mainRunner = new AgentRunner(main, testProvider(), () => mainCapture.contents, immediateModel)
  try {
    const project = await domain.projects.save({ name: 'قنوات', path: projectDir, template: 'existing', filesCount: 0, totalLines: 0 })
    const mainSession = main.createSession(projectDir)
    await domain.runner.send(project.chatSessionId, 'رسالة البناء')
    await mainRunner.send(mainSession.id, 'رسالة رئيسية')
    await waitForRunsEmpty(domain.runner, mainRunner)
    assert.ok(buildCapture.sends.length > 0)
    assert.ok(mainCapture.sends.length > 0)
    assert.ok(buildCapture.sends.every((send) => send.channel === 'build:event'))
    assert.ok(mainCapture.sends.every((send) => send.channel === 'agent:event'))
  } finally {
    await domain.shutdown()
    await mainRunner.shutdown()
    main.close()
  }
})

test('tool group discovery and expansion are isolated to dedicated Build', async (t) => {
  const { root, userData, projectDir } = await tempDirs(t)
  const seenBuildTools: string[][] = []
  let buildCalls = 0
  const buildModel: typeof requestModel = async (_config, _messages, tools) => {
    seenBuildTools.push(tools.map((tool) => tool.function.name))
    buildCalls++
    if (buildCalls === 1) return { text: '', toolCalls: [{ id: 'enable-web', name: 'enable_tool_group', arguments: '{"group":"web"}' }], finishReason: 'tool_calls', usage: { input: 1, output: 1 } }
    return { text: 'تم', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  }
  const domain = makeDomain(userData, testProvider(), () => null, buildModel)
  const main = new AppDatabase(join(root, 'main-tools.db'))
  const seenMainTools: string[][] = []
  const mainRunner = new AgentRunner(main, testProvider(), () => null, async (_config, _messages, tools) => { seenMainTools.push(tools.map((tool) => tool.function.name)); return { text: 'تم', toolCalls: [], finishReason: 'stop' } })
  try {
    const project = await domain.projects.save({ name: 'مجموعات', path: projectDir, template: 'existing', filesCount: 0, totalLines: 0 })
    const mainSession = main.createSession(projectDir)
    await domain.runner.send(project.chatSessionId, 'اصلح TypeScript محليا')
    await mainRunner.send(mainSession.id, 'رسالة رئيسية')
    await waitForRunsEmpty(domain.runner, mainRunner)
    assert.ok(seenBuildTools[0]!.includes('discover_tools'))
    assert.ok(seenBuildTools[0]!.includes('enable_tool_group'))
    assert.ok(seenBuildTools[0]!.includes('edit_files_bulk'))
    // web مفعّلة افتراضيًا في Build من أول جولة (أزيلت البوابة التخمينية)
    assert.ok(seenBuildTools[0]!.includes('web_fetch'))
    assert.ok(seenBuildTools[1]!.includes('web_fetch'))
    assert.ok(!seenMainTools[0]!.includes('discover_tools'))
    assert.ok(!seenMainTools[0]!.includes('enable_tool_group'))
  } finally { await domain.shutdown(); await mainRunner.shutdown(); main.close() }
})

test('an Arabic web request exposes web search tools to Build on the first model call', async (t) => {
  const { userData, projectDir } = await tempDirs(t)
  let seenTools: string[] = []
  const model: typeof requestModel = async (_config, _messages, tools) => {
    seenTools = tools.map((tool) => tool.function.name)
    return { text: 'تم', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  }
  const domain = makeDomain(userData, testProvider(), () => null, model)
  try {
    const project = await domain.projects.save({ name: 'بحث ويب', path: projectDir, template: 'existing', filesCount: 0, totalLines: 0 })
    await domain.runner.send(project.chatSessionId, 'ابحث بالويب عن الأكلات اليمنية')
    await waitForRunsEmpty(domain.runner)
    assert.ok(seenTools.includes('web_search'))
    assert.ok(seenTools.includes('web_fetch'))
  } finally { await domain.shutdown() }
})

test('Build auto-enables a hidden tool group instead of treating it as invalid input', async (t) => {
  const { userData, projectDir } = await tempDirs(t)
  const seenTools: string[][] = []
  let calls = 0
  const model: typeof requestModel = async (_config, _messages, tools) => {
    seenTools.push(tools.map((tool) => tool.function.name))
    calls++
    // mcp هي المجموعة الوحيدة المتبقية خلف بوابة (لها كلفة تشغيل خوادم)
    if (calls === 1) return { text: '', toolCalls: [{ id: 'hidden-mcp', name: 'mcp_demo', arguments: '{}' }], finishReason: 'tool_calls', usage: { input: 1, output: 1 } }
    return { text: 'تم', toolCalls: [], finishReason: 'stop', usage: { input: 1, output: 1 } }
  }
  const domain = makeDomain(userData, testProvider(), () => null, model)
  try {
    const project = await domain.projects.save({ name: 'تفعيل تلقائي', path: projectDir, template: 'existing', filesCount: 0, totalLines: 0 })
    await domain.runner.send(project.chatSessionId, 'جهز معلومات للمشروع')
    await waitForRunsEmpty(domain.runner)
    // أدوات الويب متاحة من أول جولة الآن (أزيلت البوابة التخمينية)
    assert.equal(seenTools[0]!.includes('web_search'), true)
    // استدعاء أداة mcp فعّل المجموعة تلقائيًا وأكمل التشغيل بدل الفشل
    assert.ok(calls >= 2)
    const systemNotes = domain.db.listMessages(project.chatSessionId).filter((message) => message.role === 'system')
    assert.ok(systemNotes.some((message) => message.content.includes('فعّل النظام تلقائيًا')))
    assert.equal(domain.db.getAgentRun(project.chatSessionId)?.status, 'completed')
  } finally { await domain.shutdown() }
})

test('Build full mode executes tools without approval requests', async (t) => {
  const { userData, projectDir } = await tempDirs(t)
  const capture = capturingWebContents()
  const domain = makeDomain(userData, testProvider(), () => capture.contents, buildApprovalModel())
  try {
    const project = await domain.projects.save({ name: 'صلاحيات', path: projectDir, template: 'existing', filesCount: 0, totalLines: 0 })
    await domain.runner.send(project.chatSessionId, 'نفذ أمرًا')
    await waitForRunsEmpty(domain.runner)
    // وضع Build كامل الصلاحيات: لا تصدر أي طلبات موافقة
    assert.equal(capture.sends.filter((send) => send.channel === 'build:approval').length, 0)
    // الأداة نُفذت مباشرة وخرجها محفوظ في السجل
    assert.ok(domain.db.listMessages(project.chatSessionId).some((message) => message.content.includes('build-approval')))
    // السياق يبقى معزولاً في قاعدة البناء ولا يمس الجلسات الرئيسية
    assert.equal(domain.db.getSession(project.chatSessionId).permissionMode, 'full')
  } finally { await domain.shutdown() }
})

test('cleanupLegacyBuildSessions deletes only legacy full-shell sessions with cascade', async (t) => {
  const { root, projectDir } = await tempDirs(t)
  const db = new AppDatabase(join(root, 'main-cleanup.db'))
  const legacy = db.createSession(projectDir)
  db.updateSession(legacy.id, { permissionMode: 'full' })
  db.setSystemPrompt(legacy.id, BUILD_MARKER)
  db.addMessage({ sessionId: legacy.id, role: 'user', content: 'رسالة قديمة' })
  const normal = db.createSession(projectDir)
  db.addMessage({ sessionId: normal.id, role: 'user', content: 'رسالة عادية' })
  const containsMarker = db.createSession(projectDir)
  db.setSystemPrompt(containsMarker.id, 'نص قبل ' + BUILD_MARKER)
  const runner = new AgentRunner(db, testProvider(), () => null, immediateModel)
  try {
    cleanupLegacyBuildSessions(db, runner)
    assert.throws(() => db.getSession(legacy.id))
    assert.equal(db.listMessages(legacy.id).length, 0)
    assert.equal(db.getSession(normal.id).id, normal.id)
    assert.equal(db.listMessages(normal.id).length, 1)
    assert.equal(db.getSession(containsMarker.id).id, containsMarker.id)
    assert.ok(db.listAudit(100).some((audit) => audit.action === 'project-removed'))
  } finally {
    await runner.shutdown()
    db.close()
  }
})
