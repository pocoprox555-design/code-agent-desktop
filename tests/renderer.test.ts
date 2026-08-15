import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { App, ExecutionStage, ToolCard, ToolResultRenderer, decideRunAdoption, groupConversation, parseToolEnvelope, selectApproval } from '../src/renderer/src/App'
import type { AgentEvent, ApprovalRequest, Message } from '../src/shared/types'

function renderAtWidth(width: number): string {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: width } })
  try { return renderToStaticMarkup(createElement(App)) }
  finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') }
}

test('renderer starts with the sidebar open on desktop', () => {
  const html = renderAtWidth(1200)
  assert.match(html, /id="app-sidebar"/)
  assert.doesNotMatch(html, /aria-label="فتح الشريط الجانبي"/)
})

test('renderer starts with the sidebar closed on narrow screens', () => {
  const html = renderAtWidth(600)
  assert.doesNotMatch(html, /id="app-sidebar"/)
  assert.match(html, /aria-label="فتح الشريط الجانبي"/)
})

test('execution trace groups contiguous tool rounds and preserves message order', () => {
  const messages: Message[] = [
    { id: 'user-1', sessionId: 'session-1', role: 'user', content: 'حلل المشروع', createdAt: 1, sequence: 1 },
    { id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: 'أقرأ الملفات', createdAt: 2, sequence: 2, toolCalls: [{ id: 'tool-1', name: 'read_file', input: { path: 'src/main.ts' }, status: 'completed', step: 1 }, { id: 'tool-1b', name: 'list_directory', input: { path: 'src' }, status: 'completed', step: 1 }] },
    { id: 'tool-message-1', sessionId: 'session-1', role: 'tool', content: '{}', createdAt: 3, sequence: 3, toolCallId: 'tool-1', toolName: 'read_file' },
    { id: 'assistant-2', sessionId: 'session-1', role: 'assistant', content: 'أعدل الملف', createdAt: 4, sequence: 4, toolCalls: [{ id: 'tool-2', name: 'edit_file', input: { path: 'src/main.ts' }, status: 'completed', step: 2 }] },
    { id: 'tool-message-2', sessionId: 'session-1', role: 'tool', content: '{}', createdAt: 5, sequence: 5, toolCallId: 'tool-2', toolName: 'edit_file' },
    { id: 'assistant-3', sessionId: 'session-1', role: 'assistant', content: 'اكتمل الجزء الأول', createdAt: 6, sequence: 6 },
    { id: 'assistant-4', sessionId: 'session-1', role: 'assistant', content: 'أتحقق الآن', createdAt: 7, sequence: 7, toolCalls: [{ id: 'tool-3', name: 'run_command', input: { command: 'npm test' }, status: 'completed', step: 3 }] },
    { id: 'tool-message-3', sessionId: 'session-1', role: 'tool', content: '{}', createdAt: 8, sequence: 8, toolCallId: 'tool-3', toolName: 'run_command' },
    { id: 'assistant-5', sessionId: 'session-1', role: 'assistant', content: 'اكتمل العمل', createdAt: 9, sequence: 9 },
  ]
  const items = groupConversation(messages)
  // Messages with content+toolCalls: content becomes message, tools become execution
  // Messages with content only: message
  const kinds = items.map((item) => item.kind)
  const executionIds = items.filter((item) => item.kind === 'execution').map((item) => item.id)
  const executionMessages = items.filter((item) => item.kind === 'execution').map((item) => item.messages.map((m) => m.id))
  assert.equal(kinds.filter((k) => k === 'message').length, 6)
  assert.equal(kinds.filter((k) => k === 'execution').length, 3)
  assert.deepEqual(executionIds, ['execution-assistant-1', 'execution-assistant-2', 'execution-assistant-4'])
  assert.deepEqual(executionMessages[0], ['assistant-1'])
  assert.deepEqual(executionMessages[1], ['assistant-2'])
  assert.deepEqual(executionMessages[2], ['assistant-4'])
  assert.equal(items.filter((item) => item.kind === 'message').some((item) => item.message.role === 'tool'), false)
})

test('execution trace renders one flat stage per assistant tool message regardless of todoId', () => {
  const tool = (id: string, todoId: string | null, step: number) => ({ id, name: 'read_file', input: { path: id }, todoId, status: 'completed' as const, step })
  const messages: Message[] = [
    { id: 'a-1', sessionId: 's', role: 'assistant', content: 'أبدأ', createdAt: 1, sequence: 1, toolCalls: [tool('t-1', 'todo-a', 99)] },
    { id: 'ordinary', sessionId: 's', role: 'assistant', content: 'ملاحظة بين الجولات', createdAt: 2, sequence: 2 },
    { id: 'a-2', sessionId: 's', role: 'assistant', content: 'أتابع', createdAt: 3, sequence: 3, toolCalls: [tool('t-2', 'todo-a', 1)] },
    { id: 'a-3', sessionId: 's', role: 'assistant', content: 'مرحلة أخرى', createdAt: 4, sequence: 4, toolCalls: [tool('t-3', 'todo-b', 1)] },
    { id: 'a-4', sessionId: 's', role: 'assistant', content: 'أداة قديمة', createdAt: 5, sequence: 5, toolCalls: [{ ...tool('t-4', null, 1), todoId: undefined }] },
    { id: 'a-5', sessionId: 's', role: 'assistant', content: 'أداة قديمة أخرى', createdAt: 6, sequence: 6, toolCalls: [{ ...tool('t-5', null, 2), todoId: undefined }] },
  ]

  const items = groupConversation(messages, [{ id: 'todo-a', content: 'المرحلة أ', status: 'in_progress', priority: 'high', createdAt: 1, updatedAt: 1 }])
  const executions = items.filter((item) => item.kind === 'execution')
  // لا تقسيم لمراحل: مقطع مسطّح واحد لكل رسالة أدوات، بالترتيب الزمني
  assert.equal(executions.length, 5)
  assert.deepEqual(executions.map((e) => e.id), ['execution-a-1', 'execution-a-2', 'execution-a-3', 'execution-a-4', 'execution-a-5'])
  assert.deepEqual(executions.map((e) => e.todoId), [null, null, null, null, null])
})

test('execution trace keeps message order and separates tool rounds by plain messages', () => {
  const messages: Message[] = [
    { id: 'one', sessionId: 's', role: 'assistant', content: '', createdAt: 1, sequence: 1, toolCalls: [{ id: 'one-tool', name: 'read_file', input: {}, todoId: 'one', status: 'completed' }] },
    { id: 'two', sessionId: 's', role: 'assistant', content: '', createdAt: 2, sequence: 2, toolCalls: [{ id: 'two-tool', name: 'read_file', input: {}, todoId: 'two', status: 'completed' }] },
    { id: 'legacy', sessionId: 's', role: 'assistant', content: '', createdAt: 3, sequence: 3, toolCalls: [{ id: 'legacy-tool', name: 'read_file', input: {}, status: 'completed' }] },
    { id: 'legacy-message', sessionId: 's', role: 'assistant', content: 'يفصل القديم', createdAt: 4, sequence: 4 },
    { id: 'legacy-2', sessionId: 's', role: 'assistant', content: '', createdAt: 5, sequence: 5, toolCalls: [{ id: 'legacy-tool-2', name: 'read_file', input: {}, status: 'completed' }] },
  ]
  const items = groupConversation(messages)
  assert.deepEqual(items.filter((item) => item.kind === 'execution').map((item) => item.id), ['execution-one', 'execution-two', 'execution-legacy', 'execution-legacy-2'])
  assert.equal(items.filter((item) => item.kind === 'message').length, 1)
})

test('execution stage renders flat tool rows with verb and target name', () => {
  const message: Message = { id: 'stage', sessionId: 's', role: 'assistant', content: '', createdAt: 1, toolCalls: [{ id: 'stage-tool', name: 'read_file', input: { path: 'src/main.ts' }, status: 'completed' }] }
  const html = renderToStaticMarkup(createElement(ExecutionStage, { messages: [message], todoId: 'missing', todos: [] }))
  assert.match(html, /قراءة/)
  assert.match(html, /main\.ts/)
  const edited: Message = { id: 'stage2', sessionId: 's', role: 'assistant', content: '', createdAt: 2, toolCalls: [{ id: 'edit-tool', name: 'edit_file', input: { path: 'src/App.tsx' }, status: 'completed', output: JSON.stringify({ ok: true, data: { diff: '+a\n-b' } }) }] }
  const editHtml = renderToStaticMarkup(createElement(ExecutionStage, { messages: [edited], todoId: null, todos: [] }))
  assert.match(editHtml, /تعديل/)
  assert.match(editHtml, /App\.tsx/)
  assert.match(editHtml, /\+1/)
})

function toolMarkup(name: string, data: unknown): string {
  return renderToStaticMarkup(createElement(ToolResultRenderer, { name, input: {}, output: JSON.stringify({ ok: true, data }) }))
}

test('tool envelope supports success, failure, direct JSON, text, and MCP payloads', () => {
  assert.equal(parseToolEnvelope('{"ok":true,"data":{"value":1}}').ok, true)
  assert.equal(parseToolEnvelope('{"ok":false,"error":{"code":"E","message":"bad"}}').error?.code, 'E')
  assert.equal(parseToolEnvelope('{"value":1}').data && typeof parseToolEnvelope('{"value":1}').data, 'object')
  assert.equal(parseToolEnvelope('plain text').data, 'plain text')
  assert.equal(parseToolEnvelope({ content: [{ type: 'text', text: '{"ok":true,"data":{"value":2}}' }] }).data && (parseToolEnvelope({ content: [{ type: 'text', text: '{"ok":true,"data":{"value":2}}' }] }).data as { value: number }).value, 2)
})

test('specialized tool renderers present structured results without raw JSON as the primary view', () => {
  assert.match(toolMarkup('tree', { entries: [{ name: 'src', path: 'src', directory: true, depth: 0 }], count: 1 }), /src/)
  assert.match(toolMarkup('list_directory', { entries: [{ name: 'a.ts', path: 'a.ts' }] }), /a\.ts/)
  assert.match(toolMarkup('glob_files', { files: ['src/App.tsx'] }), /src\/App\.tsx/)
  assert.match(toolMarkup('search_files', { matches: [{ path: 'a.ts', line: 3, column: 2, text: 'needle' }] }), /needle/)
  assert.match(toolMarkup('search_symbols', { symbols: [{ kind: 'function', name: 'run', path: 'a.ts', line: 4 }] }), /run/)
  assert.match(toolMarkup('read_file', { path: 'a.ts', lines: [{ line: 1, content: 'const x = 1' }], totalLines: 1 }), /const x = 1/)
  assert.match(toolMarkup('read_file', { path: 'a.ts', lines: ['1: const x = 1', '2: return x'], totalLines: 2 }), /1: const x = 1\n2: return x/)
  assert.doesNotMatch(toolMarkup('read_file', { path: 'a.ts', lines: ['1: const x = 1'], totalLines: 1 }), /\|/)
  assert.match(toolMarkup('read_files', { files: [{ path: 'a.ts', content: 'x', bytes: 1, totalLines: 1, complete: true }], nextCursor: 'next' }), /a\.ts/)
  assert.match(toolMarkup('todo_read', { todos: [{ content: 'فحص', status: 'in_progress', priority: 'high' }] }), /فحص/)
  assert.match(toolMarkup('run_powershell', { output: 'npm test', exitCode: 0, duration: 12 }), /npm test/)
  assert.match(toolMarkup('git_diff', { diff: '+added\n-removed' }), /added/)
  assert.match(toolMarkup('get_file_info', { path: 'a.ts', type: 'file', bytes: 100, totalLines: 2 }), /100/)
  assert.match(toolMarkup('analyze_file', { imports: ['react'], functions: ['run'] }), /imports/)
  assert.match(toolMarkup('find_references', { references: [{ path: 'a.ts', line: 1 }] }), /references/)
  assert.match(toolMarkup('dependency_graph', { imports: ['b.ts'], importedBy: [] }), /importedBy/)
  assert.match(toolMarkup('remember_project', { category: 'decision', key: 'style', value: 'RTL' }), /style/)
  assert.match(toolMarkup('unknown_tool', { nested: { value: 1 } }), /nested/)
  assert.doesNotMatch(toolMarkup('glob_files', { files: ['src/App.tsx'] }), /\{\s*"ok"/)
})

test('renderer labels shell commands and running elapsed state', () => {
  const message: Message = { id: 'running', sessionId: 's', role: 'assistant', content: '', createdAt: 1, toolCalls: [{ id: 'shell-1', name: 'shell', input: { command: 'Write-Output ready' }, status: 'running', startedAt: Date.now() - 2_000 }] }
  const html = renderToStaticMarkup(createElement(ToolCard, { tool: message.toolCalls![0], compact: true }))
  assert.match(html, /تشغيل shell/)
  assert.match(html, /الأمر يعمل/)
})

test('tool renderer handles errors, empty success, invalid JSON, and bounded previews', () => {
  const error = renderToStaticMarkup(createElement(ToolResultRenderer, { name: 'read_file', input: {}, output: JSON.stringify({ ok: false, error: { code: 'ENOENT', message: 'missing' } }) }))
  assert.match(error, /ENOENT/)
  assert.match(renderToStaticMarkup(createElement(ToolResultRenderer, { name: 'todo_read', input: {}, output: JSON.stringify({ ok: true, data: {} }) })), /اكتملت الأداة/)
  assert.match(renderToStaticMarkup(createElement(ToolResultRenderer, { name: 'unknown', input: {}, output: 'not json' })), /not json/)
  const entries = Array.from({ length: 60 }, (_, index) => ({ path: `file-${index}.ts` }))
  const preview = toolMarkup('list_directory', { entries })
  assert.match(preview, /عنصر إضافي/)
  assert.match(preview, /عرض النتيجة الأصلية/)
})

function userMessage(runId: string): AgentEvent {
  return { sessionId: 's', runId, type: 'message', message: { id: 'm', sessionId: 's', role: 'user', content: 'x', createdAt: 1 } }
}

test('decideRunAdoption accepts a fresh run:start and adopts its runId in any phase', () => {
  const event: AgentEvent = { sessionId: 's', runId: 'run-2', type: 'run:start' }
  assert.deepEqual(decideRunAdoption(event, 'run-1', 'running'), { accept: true, adoptRunId: 'run-2' })
  assert.deepEqual(decideRunAdoption(event, 'run-1', 'idle'), { accept: true, adoptRunId: 'run-2' })
})

test('decideRunAdoption rejects any message with a different runId', () => {
  const event = userMessage('run-2')
  assert.deepEqual(decideRunAdoption(event, 'run-1', 'running'), { accept: false, adoptRunId: null })
  assert.deepEqual(decideRunAdoption(event, 'run-1', 'idle'), { accept: false, adoptRunId: null })
})

test('decideRunAdoption accepts events sharing the known runId', () => {
  const event = userMessage('run-1')
  assert.deepEqual(decideRunAdoption(event, 'run-1', 'running'), { accept: true, adoptRunId: null })
})

test('decideRunAdoption rejects events without a runId while idle with a known run', () => {
  const event: AgentEvent = { sessionId: 's', type: 'status', text: 'حالة' }
  assert.deepEqual(decideRunAdoption(event, 'run-1', 'idle'), { accept: false, adoptRunId: null })
  assert.deepEqual(decideRunAdoption(event, 'run-1', 'running'), { accept: true, adoptRunId: null })
  assert.deepEqual(decideRunAdoption(event, null, 'idle'), { accept: true, adoptRunId: null })
})

test('decideRunAdoption accepts an idempotent run:start for the current runId', () => {
  const event: AgentEvent = { sessionId: 's', runId: 'run-1', type: 'run:start' }
  assert.deepEqual(decideRunAdoption(event, 'run-1', 'idle'), { accept: true, adoptRunId: 'run-1' })
})

test('approval selection prefers the active session request then falls back to the first request', () => {
  const requests: ApprovalRequest[] = [
    { id: 'a1', sessionId: 'other', title: 'أ', detail: 'د', risk: 'normal' },
    { id: 'a2', sessionId: 'active', title: 'ب', detail: 'د', risk: 'normal' },
  ]
  assert.equal(selectApproval(requests, 'active')?.id, 'a2')
  assert.equal(selectApproval(requests, 'nonexistent')?.id, 'a1')
  assert.equal(selectApproval(requests, null)?.id, 'a1')
  assert.equal(selectApproval([], 'active'), null)
})
