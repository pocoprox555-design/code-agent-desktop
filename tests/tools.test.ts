import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile, stat, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeTool, scanLines, toolDefinitions, ensureGitRepository, isBlockedAddress } from '../src/main/tools'
import type { Session } from '../src/shared/types'

const exec = promisify(execFile)

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function session(workspace: string, mode: Session['permissionMode'] = 'full'): Session {
  return { id: '00000000-0000-4000-8000-000000000000', title: 'test', workspace, permissionMode: mode, agentMode: 'build', gitTracked: false, createdAt: 0, updatedAt: 0 }
}

function context(workspace: string) {
  return { session: session(workspace), signal: new AbortController().signal, approve: async () => true }
}

test('counts empty files and trailing newlines correctly', async (t) => {
  const root = await fixture(t)
  const cases = new Map([['empty.txt', ['', 0]], ['one.txt', ['a', 1]], ['trailing.txt', ['a\n', 1]], ['blank.txt', ['a\n\n', 2]], ['crlf.txt', ['a\r\nb\r\n', 2]]])
  for (const [name, [content, expected]] of cases) {
    const file = join(root, name)
    await writeFile(file, String(content), 'utf8')
    assert.equal((await scanLines(file)).totalLines, expected)
  }
})

test('scanLines rejects binary files cleanly without an uncaught stream error', async (t) => {
  const root = await fixture(t)
  const binary = join(root, 'binary.bin')
  await writeFile(binary, Buffer.from([0x00, 0x01, 0x02, 0xff]))
  await assert.rejects(() => scanLines(binary), /ثنائي/)
  await assert.rejects(() => executeTool('read_file', { path: 'binary.bin' }, context(root)), /ثنائي/)
})

test('read_file returns accurate line numbers, range and total', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'sample.txt'), 'first\nsecond\nthird\nfourth\n', 'utf8')
  const output = JSON.parse(await executeTool('read_file', { path: 'sample.txt', offset: 2, limit: 2 }, context(root)))
  assert.equal(output.ok, true)
  assert.equal(output.data.totalLines, 4)
  assert.deepEqual(output.data.range, { start: 2, end: 3, requestedLimit: 2 })
  assert.deepEqual(output.data.lines, ['2: second', '3: third'])
})

test('read_file reads up to 2000 lines by default', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'large.txt'), Array.from({ length: 1781 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf8')
  const result = JSON.parse(await executeTool('read_file', { path: 'large.txt' }, context(root)))
  assert.equal(result.data.range.end, 1781)
  assert.equal(result.data.totalLines, 1781)
})

test('count_lines returns metadata without file content', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'sample.ts'), 'a\nb\nc', 'utf8')
  const output = JSON.parse(await executeTool('count_lines', { path: 'sample.ts' }, context(root)))
  assert.equal(output.data.totalLines, 3)
  assert.equal(output.data.path, 'sample.ts')
})

test('glob and search return file and line locations', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'const alpha = 1\nconst beta = alpha\n', 'utf8')
  await writeFile(join(root, 'src', 'b.js'), 'alpha', 'utf8')
  const glob = JSON.parse(await executeTool('glob_files', { pattern: '**/*.ts' }, context(root)))
  assert.deepEqual(glob.data.files, ['src/a.ts'])
  const search = JSON.parse(await executeTool('search_files', { pattern: 'beta', include: '**/*.ts', fixed_strings: true }, context(root)))
  assert.equal(search.data.matches[0].path, 'src/a.ts')
  assert.equal(search.data.matches[0].line, 2)
  assert.equal(search.data.matches[0].column, 7)
})

test('search respects workspace gitignore rules', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'ignored'))
  await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8')
  await writeFile(join(root, 'ignored', 'secret.ts'), 'needle\n', 'utf8')
  await writeFile(join(root, 'visible.ts'), 'needle\n', 'utf8')
  const result = JSON.parse(await executeTool('search_files', { pattern: 'needle', fixed_strings: true }, context(root)))
  assert.deepEqual(result.data.matches.map((item: { path: string }) => item.path), ['visible.ts'])
})

test('search_files accepts a specific file path', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'MainActivity.java'), 'class MainActivity {\n  void checkout() {}\n}\n', 'utf8')
  const result = JSON.parse(await executeTool('search_files', { path: 'MainActivity.java', pattern: 'checkout', fixed_strings: true }, context(root)))
  assert.equal(result.ok, true)
  assert.equal(result.data.count, 1)
  assert.equal(result.data.matches[0].path, 'MainActivity.java')
  assert.equal(result.data.matches[0].line, 2)
})

test('rejects lexical and junction escapes even in full mode', async (t) => {
  const root = await fixture(t)
  const outside = await fixture(t)
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
  await assert.rejects(() => executeTool('read_file', { path: join(outside, 'secret.txt') }, context(root)), /خارج مساحة العمل/)
  const link = join(root, 'linked')
  try { await symlink(outside, link, 'junction') } catch (error) { t.skip(`junction غير متاح: ${String(error)}`); return }
  await assert.rejects(() => executeTool('read_file', { path: join(link, 'secret.txt') }, context(root)), /خارج مساحة العمل/)
})

test('plan mode refuses mutations before approval', async (t) => {
  const root = await fixture(t)
  const plan = { ...context(root), session: { ...session(root), agentMode: 'plan' as const } }
  const result = JSON.parse(await executeTool('write_file', { path: 'new.txt', content: 'x' }, plan))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PLAN_MODE')
})

test('write and edit replace existing files atomically on Windows', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'target.txt'), 'old value', 'utf8')
  const written = JSON.parse(await executeTool('write_file', { path: 'target.txt', content: 'first value' }, context(root)))
  assert.equal(written.ok, true)
  const edited = JSON.parse(await executeTool('edit_file', { path: 'target.txt', old_string: 'first', new_string: 'second' }, context(root)))
  assert.equal(edited.ok, true)
  const result = JSON.parse(await executeTool('read_file', { path: 'target.txt' }, context(root)))
  assert.deepEqual(result.data.lines, ['1: second value'])
})

test('full mode runs PowerShell without requesting approval', async (t) => {
  const root = await fixture(t)
  let approvals = 0
  const denied = { ...context(root), approve: async () => { approvals++; return false } }
  const result = JSON.parse(await executeTool('run_powershell', { command: 'Write-Output full-access', cwd: '.' }, denied))
  assert.equal(result.ok, true)
  assert.match(result.data.output, /full-access/)
  assert.equal(approvals, 0)
})

test('PowerShell accepts Windows command shims and aborts promptly', async (t) => {
  const root = await fixture(t)
  const result = JSON.parse(await executeTool('run_powershell', { command: 'node.cmd --version', cwd: '.' }, context(root)))
  assert.equal(result.ok, true)
  const controller = new AbortController()
  const pending = executeTool('run_powershell', { command: 'node --eval "setTimeout(() => {}, 60000)"', cwd: '.', timeout_ms: 600000 }, { ...context(root), signal: controller.signal })
  const rejection = assert.rejects(pending, /إلغاء الأمر|AbortError/)
  await new Promise((resolve) => setTimeout(resolve, 100))
  controller.abort()
  await rejection
})

test('ask mode shows a bounded diff before editing a file', async (t) => {
  const root = await fixture(t)
  const file = join(root, 'target.txt')
  await writeFile(file, 'before\nkeep\n', 'utf8')
  let detail = ''
  const asking = { ...context(root), session: session(root, 'ask'), approve: async (_title: string, value: string) => { detail = value; return false } }
  const result = JSON.parse(await executeTool('edit_file', { path: 'target.txt', old_string: 'before', new_string: 'after' }, asking))
  assert.equal(result.ok, false)
  assert.match(detail, /-before/)
  assert.match(detail, /\+after/)
  assert.equal(await (await import('node:fs/promises')).readFile(file, 'utf8'), 'before\nkeep\n')
})

test('ask mode still requires approval for dangerous tools', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'keep.txt'), 'keep', 'utf8')
  let approvals = 0
  const asking = { ...context(root), session: session(root, 'ask'), approve: async () => { approvals++; return false } }
  const removed = JSON.parse(await executeTool('delete_file', { path: 'keep.txt' }, asking))
  const shell = JSON.parse(await executeTool('run_powershell', { command: 'Write-Output blocked', cwd: '.' }, asking))
  assert.equal(removed.error.code, 'APPROVAL_DENIED')
  assert.equal(shell.error.code, 'APPROVAL_DENIED')
  assert.equal(approvals, 2)
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep')
})

test('MCP approvals follow ask and full permission modes', async (t) => {
  const root = await fixture(t)
  let calls = 0; let approvals = 0
  const mcp = { call: async () => { calls++; return '{"ok":true}' } }
  const asking = { ...context(root), session: session(root, 'ask'), mcp, approve: async () => { approvals++; return false } }
  const denied = JSON.parse(await executeTool('mcp_test_action', {}, asking))
  assert.equal(denied.error.code, 'APPROVAL_DENIED')
  assert.equal(calls, 0)
  const full = { ...context(root), mcp, approve: async () => { approvals++; return false } }
  assert.equal(JSON.parse(await executeTool('mcp_test_action', {}, full)).ok, true)
  assert.equal(calls, 1)
  assert.equal(approvals, 1)
})

test('edit_file refuses ambiguous matches with multiple occurrences', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'dup.txt'), 'value\nvalue\n', 'utf8')
  await assert.rejects(() => executeTool('edit_file', { path: 'dup.txt', old_string: 'value', new_string: 'changed' }, context(root)), /أكثر تحديدًا/)
})

test('edit_file is exposed to the model with the implementation schema', () => {
  const definition = toolDefinitions.find((item) => item.function.name === 'edit_file')
  assert.ok(definition)
  assert.deepEqual(definition.function.parameters.required, ['path', 'old_string', 'new_string'])
  assert.equal(definition.function.parameters.additionalProperties, false)
})

test('edit_file maps CRLF match boundaries without corrupting adjacent code', async (t) => {
  const root = await fixture(t)
  const file = join(root, 'crlf.java')
  await writeFile(file, 'void first() {\r\n    keep();\r\n}\r\n\r\nvoid second() {\r\n    old();\r\n}\r\n', 'utf8')
  await executeTool('edit_file', { path: 'crlf.java', old_string: 'void second() {\n    old();\n}', new_string: 'void second() {\n    updated();\n}' }, context(root))
  assert.equal(await readFile(file, 'utf8'), 'void first() {\r\n    keep();\r\n}\r\n\r\nvoid second() {\r\n    updated();\r\n}\r\n')
})

test('edit_file rejects whitespace-fuzzy matches instead of editing an unsafe range', async (t) => {
  const root = await fixture(t)
  const file = join(root, 'tabs.java')
  await writeFile(file, 'void value() {\n\told();\n}\n', 'utf8')
  await assert.rejects(() => executeTool('edit_file', { path: 'tabs.java', old_string: 'void value() {\n  old();\n}', new_string: 'changed' }, context(root)), /تطابق آمن/)
  assert.equal(await readFile(file, 'utf8'), 'void value() {\n\told();\n}\n')
})

test('glob_files ignores build artifact directories like release-*', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'release-rahma-test'))
  await writeFile(join(root, 'release-rahma-test', 'x.txt'), 'x', 'utf8')
  await mkdir(join(root, 'dist-v0.2'))
  await writeFile(join(root, 'dist-v0.2', 'y.txt'), 'y', 'utf8')
  await writeFile(join(root, 'src.txt'), 'z', 'utf8')
  const glob = JSON.parse(await executeTool('glob_files', { pattern: '**/*.txt' }, context(root)))
  assert.deepEqual(glob.data.files, ['src.txt'])
})

test('delete_file removes a single file and refuses directories', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'remove.txt'), 'x', 'utf8')
  await mkdir(join(root, 'folder'))
  const removed = JSON.parse(await executeTool('delete_file', { path: 'remove.txt' }, context(root)))
  assert.equal(removed.ok, true)
  assert.equal(removed.data.deleted, true)
  await assert.rejects(() => executeTool('delete_file', { path: 'folder' }, context(root)), /الملفات فقط/)
  await assert.rejects(() => stat(join(root, 'remove.txt')))
})

test('full mode deletes files without requesting approval', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'keep.txt'), 'keep', 'utf8')
  let approvals = 0
  const denied = { ...context(root), approve: async () => { approvals++; return false } }
  const result = JSON.parse(await executeTool('delete_file', { path: 'keep.txt' }, denied))
  assert.equal(result.ok, true)
  assert.equal(approvals, 0)
  await assert.rejects(() => stat(join(root, 'keep.txt')), /ENOENT/)
})

test('move_file moves files inside workspace and rejects outside destinations', async (t) => {
  const root = await fixture(t)
  const outside = await fixture(t)
  await writeFile(join(root, 'source.txt'), 'content', 'utf8')
  await mkdir(join(root, 'sub'))
  const moved = JSON.parse(await executeTool('move_file', { from: 'source.txt', to: 'sub/renamed.txt' }, context(root)))
  assert.equal(moved.ok, true)
  assert.equal(moved.data.from, 'source.txt')
  assert.equal(moved.data.to, 'sub/renamed.txt')
  assert.equal(await readFile(join(root, 'sub', 'renamed.txt'), 'utf8'), 'content')
  await assert.rejects(() => executeTool('move_file', { from: 'sub/renamed.txt', to: join(outside, 'x.txt') }, context(root)), /خارج مساحة العمل/)
})

test('append_file appends preserving existing content', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'log.txt'), 'first', 'utf8')
  const appended = JSON.parse(await executeTool('append_file', { path: 'log.txt', content: 'second' }, context(root)))
  assert.equal(appended.ok, true)
  assert.equal(await readFile(join(root, 'log.txt'), 'utf8'), 'first\nsecond')
  const created = JSON.parse(await executeTool('append_file', { path: 'new.txt', content: 'solo' }, context(root)))
  assert.equal(created.ok, true)
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'solo')
})

test('append_file creates new files in ask mode after approval', async (t) => {
  const root = await fixture(t)
  let detail = ''
  const asking = { ...context(root), session: session(root, 'ask'), approve: async (_title: string, value: string) => { detail = value; return true } }
  const created = JSON.parse(await executeTool('append_file', { path: 'brand-new.txt', content: 'hello' }, asking))
  assert.equal(created.ok, true)
  assert.match(detail, /\+hello/)
  assert.equal(await readFile(join(root, 'brand-new.txt'), 'utf8'), 'hello')
})

test('tree lists structure ignoring build artifacts', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'x', 'utf8')
  await mkdir(join(root, 'release-x'))
  await writeFile(join(root, 'release-x', 'b.txt'), 'y', 'utf8')
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'node_modules', 'c.js'), 'z', 'utf8')
  const tree = JSON.parse(await executeTool('tree', {}, context(root)))
  assert.equal(tree.ok, true)
  const paths = tree.data.entries.map((item: { path: string }) => item.path)
  assert.ok(paths.includes('src'))
  assert.ok(paths.includes('src/a.ts'))
  assert.ok(!paths.some((p: string) => p.includes('release-x')))
  assert.ok(!paths.some((p: string) => p.includes('node_modules')))
})

test('git_commit is exposed and full mode does not request approval', async (t) => {
  const definition = toolDefinitions.find((item) => item.function.name === 'git_commit')
  assert.ok(definition, 'git_commit يجب أن تكون معرّفة في toolDefinitions')
  assert.deepEqual(definition!.function.parameters.required, ['message'])
  assert.equal((definition!.function.parameters.properties as Record<string, { type?: string }>).message?.type, 'string')
  assert.equal((definition!.function.parameters.properties as Record<string, { type?: string }>).all?.type, 'boolean')

  const root = await fixture(t)
  try { await ensureGitRepository(root) } catch { t.skip('git غير متاح في هذه البيئة'); return }
  await writeFile(join(root, 'commit.txt'), 'value', 'utf8')
  let approvals = 0
  const denied = { ...context(root), approve: async () => { approvals++; return false } }
  const result = JSON.parse(await executeTool('git_commit', { message: 'test', all: true }, denied))
  assert.equal(result.ok, true)
  assert.equal(approvals, 0)
})

test('gitTracked sessions auto-commit writes without breaking when git is unavailable', async (t) => {
  const root = await fixture(t)
  const tracked = { ...context(root), session: { ...session(root), gitTracked: true } }
  const result = JSON.parse(await executeTool('write_file', { path: 'auto.txt', content: 'x' }, tracked))
  assert.equal(result.ok, true)
  assert.equal(await readFile(join(root, 'auto.txt'), 'utf8'), 'x')
})

test('auto-commit records edits in a real repository', async (t) => {
  const root = await fixture(t)
  try {
    await ensureGitRepository(root)
    if (!(await stat(join(root, '.git'))).isDirectory()) { t.skip('git غير متاح'); return }
  } catch { t.skip('git غير متاح في هذه البيئة'); return }
  const tracked = { ...context(root), session: { ...session(root), gitTracked: true } }
  const written = JSON.parse(await executeTool('write_file', { path: 'file.txt', content: 'hello' }, tracked))
  assert.equal(written.data.gitAutoCommit.committed, true)
  assert.match(written.data.gitAutoCommit.commit, /^[0-9a-f]{40}$/)
  const log = JSON.parse(await executeTool('git_log', { limit: 5 }, context(root)))
  assert.equal(log.ok, true)
  assert.match(log.data, /تلقائي/)
})

test('git_revert safely undoes an automatic commit', async (t) => {
  const root = await fixture(t)
  try { await ensureGitRepository(root) } catch { t.skip('git غير متاح في هذه البيئة'); return }
  const tracked = { ...context(root), session: { ...session(root), gitTracked: true } }
  const written = JSON.parse(await executeTool('write_file', { path: 'revert-me.txt', content: 'temporary' }, tracked))
  const commit = written.data.gitAutoCommit.commit as string
  let approvals = 0
  const reverted = JSON.parse(await executeTool('git_revert', { commit }, { ...context(root), approve: async () => { approvals++; return false } }))
  assert.equal(reverted.ok, true)
  assert.equal(reverted.data.reverted, commit)
  assert.equal(approvals, 0)
  await assert.rejects(() => stat(join(root, 'revert-me.txt')), /ENOENT/)
})

test('git_revert_step reverses the last automatic commit only', async (t) => {
  const root = await fixture(t)
  try { await ensureGitRepository(root) } catch { t.skip('git غير متاح في هذه البيئة'); return }
  const tracked = { ...context(root), session: { ...session(root), gitTracked: true } }
  await executeTool('write_file', { path: 'step-one.txt', content: 'one' }, tracked)
  await executeTool('write_file', { path: 'step-two.txt', content: 'two' }, tracked)
  const reverted = JSON.parse(await executeTool('git_revert_step', {}, context(root)))
  assert.equal(reverted.ok, true)
  assert.match(reverted.data.revertedMessage, /تلقائي \[write_file\]/)
  await assert.rejects(() => stat(join(root, 'step-two.txt')), /ENOENT/)
  await stat(join(root, 'step-one.txt'))
  await assert.rejects(() => executeTool('git_revert_step', {}, context(root)), /ليس تلقائيًا/)
})

test('auto-commit excludes unrelated working tree changes', async (t) => {
  const root = await fixture(t)
  try { await ensureGitRepository(root) } catch { t.skip('git غير متاح في هذه البيئة'); return }
  await writeFile(join(root, 'unrelated.txt'), 'manual', 'utf8')
  const tracked = { ...context(root), session: { ...session(root), gitTracked: true } }
  await executeTool('write_file', { path: 'agent.txt', content: 'agent' }, tracked)
  const shown = await exec('git.exe', ['show', '--pretty=', '--name-only', 'HEAD'], { cwd: root })
  assert.match(shown.stdout, /agent\.txt/)
  assert.doesNotMatch(shown.stdout, /unrelated\.txt/)
  const status = await exec('git.exe', ['status', '--short'], { cwd: root })
  assert.match(status.stdout, /unrelated\.txt/)
})

test('blocks private IPv4 and IPv6 web destinations', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(isBlockedAddress(address), true, address)
  for (const address of ['93.184.216.34', '2606:4700:4700::1111']) assert.equal(isBlockedAddress(address), false, address)
})

test('todo_write and todo_read persist and update the session plan', async (t) => {
  const root = await fixture(t)
  let todos: Array<{ content: string; status?: string; priority?: string }> = []
  const ctx = { ...context(root), todos: { get: async () => todos.map((item) => ({ id: item.content, content: item.content, status: (item.status ?? 'pending') as 'pending' | 'in_progress' | 'completed' | 'cancelled', priority: (item.priority ?? 'medium') as 'high' | 'medium' | 'low', createdAt: 0, updatedAt: 0 })), set: async (items: Array<{ content: string; status?: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority?: 'high' | 'medium' | 'low' }>) => { todos = items.map((item) => ({ content: item.content, status: item.status, priority: item.priority })); return todos.map((item) => ({ id: item.content, content: item.content, status: item.status ?? 'pending', priority: item.priority ?? 'medium', createdAt: 0, updatedAt: 0 })) } } }
  const written = JSON.parse(await executeTool('todo_write', { items: JSON.stringify([{ content: 'تحليل المشروع', status: 'in_progress', priority: 'high' }, { content: 'تنفيذ التعديل' }]) }, ctx))
  assert.equal(written.ok, true)
  assert.equal(written.data.count, 2)
  const read = JSON.parse(await executeTool('todo_read', {}, ctx))
  assert.equal(read.ok, true)
  assert.equal(read.data.todos[0].content, 'تحليل المشروع')
  assert.equal(read.data.todos[0].status, 'in_progress')
  assert.equal(read.data.todos[1].status, 'pending')
  const invalid = JSON.parse(await executeTool('todo_write', { items: 'not-json' }, ctx))
  assert.equal(invalid.ok, false)
})

test('load_skill reads SKILL.md from workspace skills directories', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, '.skills', 'review'), { recursive: true })
  await writeFile(join(root, '.skills', 'review', 'SKILL.md'), '---\ndescription: review skill\n---\n# Review\nsteps here.', 'utf8')
  const skills = new Map<string, { name: string; description: string; content: string }>()
  skills.set('review', { name: 'review', description: 'review skill', content: '# Review\nsteps here.' })
  const ctx = { ...context(root), loadSkill: async (name: string) => skills.get(name) }
  const result = JSON.parse(await executeTool('load_skill', { name: 'review' }, ctx))
  assert.equal(result.ok, true)
  assert.equal(result.data.name, 'review')
  assert.match(result.data.content, /steps here/)
  const missing = JSON.parse(await executeTool('load_skill', { name: 'nope' }, ctx))
  assert.equal(missing.ok, false)
})

test('search_symbols finds function and class definitions with line numbers', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'calc.ts'), 'export function addNumbers(a: number, b: number): number {\n  return a + b\n}\nexport class Calculator {\n  multiply(): number {\n    return 0\n  }\n}\n', 'utf8')
  await writeFile(join(root, 'src', 'other.py'), 'def helper():\n    return 1\n', 'utf8')
  const result = JSON.parse(await executeTool('search_symbols', { query: 'addNumbers' }, context(root)))
  assert.equal(result.ok, true)
  assert.ok(result.data.symbols.some((symbol: { name: string; kind: string; line: number }) => symbol.name === 'addNumbers' && symbol.kind === 'function' && symbol.line === 1))
  const classResult = JSON.parse(await executeTool('search_symbols', { query: 'Calculator' }, context(root)))
  assert.equal(classResult.ok, true)
  assert.ok(classResult.data.symbols.some((symbol: { name: string; kind: string }) => symbol.name === 'Calculator' && symbol.kind === 'class'))
  const none = JSON.parse(await executeTool('search_symbols', { query: 'NoSuchSymbolXYZ' }, context(root)))
  assert.equal(none.ok, true)
  assert.equal(none.data.count, 0)
})

test('run_command executes a workspace command and returns the rendered template', async (t) => {
  const root = await fixture(t)
  const commands = new Map<string, { ok: boolean; output?: string; error?: string }>()
  commands.set('review', { ok: true, output: 'راجع الكود التالي\n$ARGUMENTS\n- افحص الأمان' })
  commands.set('missing', { ok: false, error: 'أمر غير معروف: missing' })
  const ctx = { ...context(root), runCommand: async (name: string, args?: string) => commands.get(name) ?? { ok: false, error: `أمر غير معروف: ${name}` } }
  const result = JSON.parse(await executeTool('run_command', { name: 'review', arguments: 'src/main.ts' }, ctx))
  assert.equal(result.ok, true)
  assert.equal(result.data.name, 'review')
  assert.match(result.data.output, /راجع الكود التالي/)
  const missing = JSON.parse(await executeTool('run_command', { name: 'missing' }, ctx))
  assert.equal(missing.ok, false)
  const unavailable = JSON.parse(await executeTool('run_command', { name: 'x' }, context(root)))
  assert.equal(unavailable.ok, false)
})

test('task_parallel runs multiple subagents and returns combined summaries', async (t) => {
  const root = await fixture(t)
  const ctx = { ...context(root), runSubagentBatch: async (tasks: Array<{ prompt: string; description: string }>) => tasks.map((task, index) => ({ ok: true, description: task.description, summary: `خلاصة ${index + 1}: ${task.prompt.slice(0, 10)}`, steps: 2 })) }
  const result = JSON.parse(await executeTool('task_parallel', { tasks: JSON.stringify([{ prompt: 'افحص وحدة المصادقة', description: 'وحدة المصادقة' }, { prompt: 'افحص وحدة الدفع', description: 'وحدة الدفع' }, { prompt: 'افحص وحدة التقارير', description: 'التقارير' }]) }, ctx))
  assert.equal(result.ok, true)
  assert.equal(result.data.count, 3)
  assert.equal(result.data.results.length, 3)
  assert.match(result.data.results[0].summary, /خلاصة 1/)
  assert.equal(result.data.results[1].description, 'وحدة الدفع')
  const capped = JSON.parse(await executeTool('task_parallel', { tasks: JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ prompt: `مهمة ${i}`, description: `مهمة ${i}` }))) }, ctx))
  assert.equal(capped.ok, true)
  assert.equal(capped.data.count, 5)
  const invalid = JSON.parse(await executeTool('task_parallel', { tasks: 'not-json' }, ctx))
  assert.equal(invalid.ok, false)
  const unavailable = JSON.parse(await executeTool('task_parallel', { tasks: JSON.stringify([{ prompt: 'x', description: 'y' }]) }, context(root)))
  assert.equal(unavailable.ok, false)
})

test('task tool runs a subagent in an isolated context and returns its summary', async (t) => {  const root = await fixture(t)
  const ctx = { ...context(root), runSubagent: async (input: { prompt: string; description: string }) => ({ ok: true, summary: `خلاصة: ${input.prompt.slice(0, 20)}`, steps: 3 }) }
  const result = JSON.parse(await executeTool('task', { prompt: 'افحص ملفات وحدة المصادقة وأعد خلاصة بنيتها', description: 'فحص وحدة المصادقة' }, ctx))
  assert.equal(result.ok, true)
  assert.equal(result.data.steps, 3)
  assert.match(result.data.summary, /خلاصة/)
  const failed = JSON.parse(await executeTool('task', { prompt: 'x', description: 'y' }, { ...context(root), runSubagent: async () => ({ ok: false, summary: '', error: 'فشل داخلي', steps: 0 }) }))
  assert.equal(failed.ok, false)
  assert.match(failed.error.message, /فشل الوكيل الفرعي/)
  const unavailable = JSON.parse(await executeTool('task', { prompt: 'x', description: 'y' }, context(root)))
  assert.equal(unavailable.ok, false)
})
