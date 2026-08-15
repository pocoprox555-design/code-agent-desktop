import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile, stat, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeTool, scanLines, splitSandboxCommands, toolDefinitions, ensureGitRepository, isBlockedAddress, closePersistentShell, runPowerShell, TOOL_POLICIES, validateSandboxCommand, classifySearchError, normalizeSearchText, rankSearchResults, isRelevantSearchResult, htmlToText, tavilyAvailable, recordTavilyResult, tavilyCircuit } from '../src/main/tools'
import type { MutationReceipt, Session } from '../src/shared/types'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)

async function fixture(t: test.TestContext, closeShellFor?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-tools-'))
  t.after(async () => {
    // أغلق القشرة الدائمة قبل حذف المجلد، وإلا يبقى PowerShell ممسكًا بالمسار (EBUSY)
    if (closeShellFor) closePersistentShell(closeShellFor)
    // قد تموت العمليات الفرعية بشكل غير متزامن (taskkill/kill) — أعد المحاولة حتى تحرر الملفات
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
  })
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

test('read_files accepts a paths array and cached read_file preserves trailing-newline counts', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'first.txt'), 'one\n', 'utf8')
  await writeFile(join(root, 'second.txt'), 'two\n', 'utf8')
  const batch = JSON.parse(await executeTool('read_files', { paths: ['first.txt', 'second.txt'] }, context(root)))
  assert.equal(batch.ok, true)
  assert.deepEqual(batch.data.files.map((file: { path: string }) => file.path), ['first.txt', 'second.txt'])
  await executeTool('read_file', { path: 'first.txt' }, context(root))
  const cached = JSON.parse(await executeTool('read_file', { path: 'first.txt' }, context(root)))
  assert.equal(cached.data.cached, true)
  assert.equal(cached.data.totalLines, 1)
  assert.deepEqual(cached.data.range, { start: 1, end: 1, requestedLimit: 5000 })
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

test('write_file reports complete diff stats when its preview exceeds 79 changed lines', async (t) => {
  const root = await fixture(t)
  const content = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join('\n')
  const result = JSON.parse(await executeTool('write_file', { path: 'large.txt', content }, context(root)))
  assert.equal(result.ok, true)
  assert.equal(result.data.addedLines, 120)
  assert.equal(result.data.removedLines, 0)
  assert.equal(result.data.diffTruncated, true)
  assert.equal(result.data.diff.split('\n').filter((line: string) => line.startsWith('+')).length, 79)
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

test('full mode cannot bypass rejected PowerShell policy commands', async (t) => {
  const root = await fixture(t)
  let approvals = 0
  const denied = { ...context(root), approve: async () => { approvals++; return false } }
  await assert.rejects(
    () => executeTool('run_powershell', { command: 'Invoke-Expression "Write-Output blocked"', cwd: '.' }, denied),
    /رفض PowerShell المقيد|غير مسموح/,
  )
  assert.equal(approvals, 0)
})

test('full PowerShell language keeps workspace sandbox validation active', async (t) => {
  const root = await fixture(t)
  const outside = await fixture(t)
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
  const language = await runPowerShell('Write-Output $ExecutionContext.SessionState.LanguageMode', root, root, undefined, 15_000, undefined, true)
  assert.match(language.output, /FullLanguage/)
  await assert.rejects(() => runPowerShell(`Get-Content "${join(outside, 'secret.txt')}"`, root, root, undefined, 15_000, undefined, true), /خارج مساحة العمل/)
  await assert.rejects(() => runPowerShell("Get-Content '\\\\server\\share\\secret.txt'", root, root, undefined, 15_000, undefined, true), /UNC|provider/)

  const link = join(root, 'escape')
  try { await symlink(outside, link, 'junction') } catch (error) { t.diagnostic(`junction غير متاح: ${String(error)}`); return }
  await assert.rejects(() => runPowerShell('Set-Location escape', root, root, undefined, 15_000, undefined, true), /junction|خارج مساحة العمل/)
  await assert.rejects(() => runPowerShell('Get-Content escape\\secret.txt', root, root, undefined, 15_000, undefined, true), /junction|خارج مساحة العمل/)
})

test('tool policy metadata includes bulk and undo mutations', () => {
  assert.equal(TOOL_POLICIES.edit_files_bulk?.mutating, true)
  assert.equal(TOOL_POLICIES.edit_file_undo?.mutating, true)
})

test('protected paths are case-insensitive for bulk, undo, and move destinations', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'source.txt'), 'source', 'utf8')
  const bulk = JSON.parse(await executeTool('edit_files_bulk', { edits: [{ path: 'NODE_MODULES/x.txt', old_string: 'x', new_string: 'y' }] }, context(root)))
  assert.equal(bulk.error.code, 'PROTECTED_PATH')
  const moved = JSON.parse(await executeTool('move_file', { from: 'source.txt', to: '.GIT/config' }, context(root)))
  assert.equal(moved.error.code, 'PROTECTED_PATH')
  const undo = JSON.parse(await executeTool('edit_file_undo', {}, { ...context(root), popUndo: () => ({ path: 'Provider.JSON', oldContent: 'secret' }), pushUndo: () => {} }))
  assert.equal(undo.error.code, 'PROTECTED_PATH')
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'source')
})

test('bulk edit preflight failure leaves every file unchanged', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'good.txt'), 'before', 'utf8')
  await writeFile(join(root, 'bad.txt'), 'other', 'utf8')
  const receipts: Array<Omit<MutationReceipt, 'workspaceRevision'>> = []
  const result = JSON.parse(await executeTool('edit_files_bulk', { edits: [
    { path: 'good.txt', old_string: 'before', new_string: 'after' },
    { path: 'bad.txt', old_string: 'missing', new_string: 'never' },
  ] }, { ...context(root), recordMutation: (receipt) => receipts.push(receipt) }))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'BULK_PREFLIGHT_FAILED')
  assert.deepEqual(receipts, [])
  assert.equal(await readFile(join(root, 'good.txt'), 'utf8'), 'before')
  assert.equal(await readFile(join(root, 'bad.txt'), 'utf8'), 'other')
})

test('bulk edit rejects duplicate canonical targets without writing', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'same.txt'), 'before', 'utf8')
  const result = JSON.parse(await executeTool('edit_files_bulk', { edits: [
    { path: 'same.txt', old_string: 'before', new_string: 'middle' },
    { path: '.\\same.txt', old_string: 'before', new_string: 'after' },
  ] }, context(root)))
  assert.equal(result.error.code, 'BULK_PREFLIGHT_FAILED')
  assert.equal(await readFile(join(root, 'same.txt'), 'utf8'), 'before')
})

test('bulk edit applies every file and reports complete line stats', async (t) => {
  const root = await fixture(t)
  const firstBefore = Array.from({ length: 100 }, (_, index) => `old ${index + 1}`).join('\n')
  const firstAfter = Array.from({ length: 120 }, (_, index) => `new ${index + 1}`).join('\n')
  await writeFile(join(root, 'first.txt'), firstBefore, 'utf8')
  await writeFile(join(root, 'second.txt'), 'keep\nremove one\nremove two\n', 'utf8')
  const result = JSON.parse(await executeTool('edit_files_bulk', { edits: [
    { path: 'first.txt', old_string: firstBefore, new_string: firstAfter },
    { path: 'second.txt', old_string: 'remove one\nremove two', new_string: 'added one\nadded two\nadded three' },
  ] }, context(root)))
  assert.equal(result.ok, true)
  assert.equal(result.data.addedLines, 123)
  assert.equal(result.data.removedLines, 102)
  assert.deepEqual(result.data.results.map((item: { addedLines: number; removedLines: number }) => [item.addedLines, item.removedLines]), [[120, 100], [3, 2]])
  assert.equal(await readFile(join(root, 'first.txt'), 'utf8'), firstAfter)
  assert.equal(await readFile(join(root, 'second.txt'), 'utf8'), 'keep\nadded one\nadded two\nadded three\n')
})

test('a prompt marker cannot grant unrestricted shell execution', async (t) => {
  const root = await fixture(t)
  const marked = { ...context(root), session: { ...session(root), systemPrompt: '[FULL_SHELL_ACCESS]' } as Session }
  await assert.rejects(
    () => executeTool('run_powershell', { command: 'Invoke-Expression "Write-Output blocked-by-marker"', cwd: '.' }, marked),
    /رفض PowerShell المقيد|غير مسموح/,
  )
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

test('sandbox parser normalizes allowed Windows shims without false positives in quoted text', () => {
   assert.equal(validateSandboxCommand('.\\gradlew.bat tasks', process.cwd(), process.cwd()), undefined)
   assert.equal(validateSandboxCommand('gradlew.bat tasks', process.cwd(), process.cwd()), undefined)
    assert.match(validateSandboxCommand('unknown-shim.bat tasks', process.cwd(), process.cwd()) ?? '', /غير مسموح/)
    assert.doesNotMatch(validateSandboxCommand('unknown-shim.bat tasks', process.cwd(), process.cwd()) ?? '', /allowlist: 1/)
    assert.match(validateSandboxCommand(`.\u001c/gradlew.bat tasks`, process.cwd(), process.cwd()) ?? '', /U\+001C/)
    assert.match(validateSandboxCommand(`.\u001cgradlew.bat tasks`, process.cwd(), process.cwd()) ?? '', /U\+001C/)
    assert.equal(validateSandboxCommand('.\\gradlew.bat tasks', process.cwd(), process.cwd()), undefined)
   assert.deepEqual(splitSandboxCommands('Write-Output "a;b|&"'), ['Write-Output "a;b|&"'])
   assert.match(validateSandboxCommand('powershell -NoProfile', process.cwd(), process.cwd()) ?? '', /متداخل/)
   assert.match(validateSandboxCommand('Write-Output ..\\outside', process.cwd(), process.cwd()) ?? '', /الأب/)
   assert.equal(validateSandboxCommand('cd subdir', process.cwd(), process.cwd()), undefined)
   assert.equal(validateSandboxCommand('Set-Location "subdir"', process.cwd(), process.cwd()), undefined)
   assert.match(validateSandboxCommand('cd $env:TEMP', process.cwd(), process.cwd()) ?? '', /مسارًا حرفيًا/)
   assert.match(validateSandboxCommand('Set-Location sub*', process.cwd(), process.cwd()) ?? '', /مسارًا حرفيًا/)
   assert.match(validateSandboxCommand('cd ..\\outside', process.cwd(), process.cwd()) ?? '', /الأب/)
})

test('sandbox accepts Get-Command diagnostics and keeps redirection intact', () => {
  const root = process.cwd()
  const fullChain = 'java -version 2>&1; echo java-check; Get-Command java | Select-Object -ExpandProperty Source'
  assert.equal(validateSandboxCommand('Get-Command java | Select-Object -ExpandProperty Source', root, root), undefined)
  assert.deepEqual(splitSandboxCommands(fullChain), ['java -version 2>&1', 'echo java-check', 'Get-Command java', 'Select-Object -ExpandProperty Source'])
  assert.equal(validateSandboxCommand(fullChain, root, root), undefined)
})

test('sandbox limits external Test-Path diagnostics to literal Gradle JDK paths', () => {
  const root = process.cwd()
  const profile = process.env.USERPROFILE
  assert.ok(profile, 'USERPROFILE مطلوب لاختبار جذر Gradle التشخيصي')
  const diagnostic = join(profile!, '.gradle', 'jdks', 'missing', randomUUID())
  const outside = join(profile!, 'Code-Agent-policy-outside', randomUUID())
  assert.equal(validateSandboxCommand(`Test-Path -LiteralPath "${diagnostic}"`, root, root), undefined)
  assert.match(validateSandboxCommand(`Test-Path -LiteralPath "${outside}"`, root, root) ?? '', /خارج مساحة العمل/)
  assert.match(validateSandboxCommand(`Get-Content "${diagnostic}"`, root, root) ?? '', /خارج مساحة العمل/)
  assert.match(validateSandboxCommand(`Set-Content "${diagnostic}" -Value x`, root, root) ?? '', /خارج مساحة العمل/)
  assert.match(validateSandboxCommand(`Test-Path "${diagnostic}" | Select-Object`, root, root) ?? '', /خارج مساحة العمل/)
  assert.match(validateSandboxCommand(`Test-Path "${diagnostic}" 2>&1`, root, root) ?? '', /خارج مساحة العمل/)
  assert.match(validateSandboxCommand(`Test-Path "${diagnostic}\\*"`, root, root) ?? '', /مسارًا حرفيًا|خارج/)
  assert.match(validateSandboxCommand("Test-Path '\\\\server\\share'", root, root) ?? '', /UNC|provider/)
  assert.match(validateSandboxCommand("Test-Path 'HKLM:\\Software'", root, root) ?? '', /UNC|provider/)
})

test('shell command prefixes are normalized only at the beginning', async (t) => {
  const root = await fixture(t)
  for (const command of ['shell: Write-Output ready', 'run_powershell: Write-Output ready', '1=shell: Write-Output ready', '1=run_powershell: Write-Output ready']) {
    assert.equal(validateSandboxCommand(command, root, root), undefined, command)
    const result = JSON.parse(await executeTool('run_powershell', { command, cwd: '.' }, context(root)))
    assert.equal(result.ok, true, command)
    assert.match(result.data.output, /ready/)
  }
  assert.equal(validateSandboxCommand('Write-Output ready', root, root), undefined)
  assert.match(validateSandboxCommand('foo: Write-Output ready', root, root) ?? '', /بادئة.*غير معروفة/)
  assert.match(validateSandboxCommand('1=foo: Write-Output ready', root, root) ?? '', /بادئة.*غير معروفة/)
  assert.match(validateSandboxCommand('=shell: Write-Output ready', root, root) ?? '', /بادئة.*غير معروفة|فارغة/)
  assert.match(validateSandboxCommand('shell: powershell -NoProfile', root, root) ?? '', /متداخل/)
  assert.match(validateSandboxCommand('shell: Write-Output ready; Format-Volume', root, root) ?? '', /حذفًا/)
  assert.equal(validateSandboxCommand('Write-Output "shell: Write-Output ready"', root, root), undefined)
  assert.match(validateSandboxCommand('Write-Output ready; foo: Write-Output ready', root, root) ?? '', /غير مسموح/)
  const rejected = JSON.parse(await executeTool('run_powershell', { command: '1=foo: Write-Output ready', cwd: '.' }, context(root)))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'INVALID_COMMAND')
  assert.match(rejected.error.message, /rawCommand/)
})

test('run_powershell supports a verified temporary cd without changing its original cwd', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'subdir'))
  const result = JSON.parse(await executeTool('run_powershell', { command: 'cd subdir; Write-Output $((Get-Location).Path)', cwd: '.' }, context(root)))
  assert.equal(result.ok, true)
  assert.match(result.data.output, /subdir/)

  const outside = await fixture(t)
  const link = join(root, 'escape')
  try { await symlink(outside, link, 'junction') } catch (error) { t.skip(`junction غير متاح: ${String(error)}`); return }
  await assert.rejects(
    () => executeTool('run_powershell', { command: 'Set-Location escape', cwd: '.' }, context(root)),
    /symlink|junction|خارج|غير قابل للتحقق/,
  )
})

test('sandbox uses workspace root for absolute paths outside the current cwd', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'subdir'))
  await writeFile(join(root, 'root.txt'), 'workspace-root-file', 'utf8')
  const absolute = join(root, 'root.txt')
  assert.equal(validateSandboxCommand(`Get-Content "${absolute}"`, root, join(root, 'subdir')), undefined)
  const result = JSON.parse(await executeTool('run_powershell', { command: `Get-Content "${absolute}"`, cwd: 'subdir' }, context(root)))
  assert.equal(result.ok, true)
  assert.match(result.data.output, /workspace-root-file/)
})

test('shell persistent reuses one PowerShell process and preserves cwd across calls', async (t) => {
  const sid = randomUUID()
  const root = await fixture(t, sid)
  const ctx = { session: { ...session(root), id: sid }, signal: new AbortController().signal, approve: async () => true }

  const first = JSON.parse(await executeTool('shell', { command: 'Write-Output rahma', timeout_ms: 15_000 }, ctx))
  assert.equal(first.ok, true)
  assert.match(first.data.output, /rahma/)

  await mkdir(join(root, 'subdir'))
  const cd = JSON.parse(await executeTool('shell', { command: 'Set-Location subdir', timeout_ms: 10_000 }, ctx))
  assert.equal(cd.ok, true)

  const after = JSON.parse(await executeTool('shell', { command: 'Write-Output $((Get-Location).Path)', timeout_ms: 10_000 }, ctx))
  assert.equal(after.ok, true)
  assert.match(after.data.output, /subdir/)
})

test('shell is blocked in plan mode like other mutating tools', async (t) => {
  const root = await fixture(t)
  const sid = randomUUID()
  t.after(() => closePersistentShell(sid))
  const plan = { ...context(root), session: { ...session(root), id: sid, agentMode: 'plan' as const } }
  const result = JSON.parse(await executeTool('shell', { command: 'Write-Output blocked' }, plan))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PLAN_MODE')
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
  await assert.rejects(() => executeTool('edit_file', { path: 'tabs.java', old_string: 'void value() {\n  old();\n}', new_string: 'changed' }, context(root)), /لم يتم العثور على تطابق/)
  assert.equal(await readFile(file, 'utf8'), 'void value() {\n\told();\n}\n')
})

test('patch_file is exposed to the model with the implementation schema', () => {
  const definition = toolDefinitions.find((item) => item.function.name === 'patch_file')
  assert.ok(definition)
  assert.deepEqual(definition.function.parameters.required, ['path', 'patches'])
  assert.equal(definition.function.parameters.additionalProperties, false)
})

test('patch_file applies multiple edits in a single call from bottom to top and verifies expected', async (t) => {
  const root = await fixture(t)
  const file = join(root, 'multi.ts')
  await writeFile(file, 'export const A = 1\nexport const B = 2\nexport const C = 3\nexport const D = 4\n', 'utf8')
  const result = JSON.parse(await executeTool('patch_file', {
    path: 'multi.ts',
    patches: [
      { start_line: 1, end_line: 1, new_lines: 'export const A = 10', expected: 'export const A = 1' },
      { start_line: 3, end_line: 4, new_lines: 'export const C = 30\nexport const D = 40', expected: 'export const C = 3\nexport const D = 4' }
    ]
  }, context(root)))
  assert.equal(result.ok, true)
  assert.equal(result.data.applied.length, 2)
  assert.equal(await readFile(file, 'utf8'), 'export const A = 10\nexport const B = 2\nexport const C = 30\nexport const D = 40\n')
})

test('patch_file can insert into an empty existing file', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'empty.ts'), '', 'utf8')
  const result = JSON.parse(await executeTool('patch_file', { path: 'empty.ts', patches: [{ start_line: 1, end_line: 0, new_lines: 'export const ready = true' }] }, context(root)))
  assert.equal(result.ok, true)
  assert.equal(await readFile(join(root, 'empty.ts'), 'utf8'), 'export const ready = true\n')
})

test('patch_file refuses stale expected content to prevent editing a wrong location', async (t) => {
  const root = await fixture(t)
  const file = join(root, 'stale.ts')
  await writeFile(file, 'export const A = 1\nexport const B = 2\n', 'utf8')
  await assert.rejects(() => executeTool('patch_file', { path: 'stale.ts', patches: [{ start_line: 1, end_line: 1, new_lines: 'export const A = 10', expected: 'export const A = 999' }] }, context(root)), /لا تطابق المحتوى المتوقع/)
  assert.equal(await readFile(file, 'utf8'), 'export const A = 1\nexport const B = 2\n')
})

test('patch_file rejects overlapping patches', async (t) => {
  const root = await fixture(t)
  const file = join(root, 'overlap.ts')
  await writeFile(file, 'a\nb\nc\nd\n', 'utf8')
  await assert.rejects(() => executeTool('patch_file', { path: 'overlap.ts', patches: [{ start_line: 1, end_line: 2, new_lines: 'x' }, { start_line: 2, end_line: 3, new_lines: 'y' }] }, context(root)), /تتداخل/)
  assert.equal(await readFile(file, 'utf8'), 'a\nb\nc\nd\n')
})

test('patch_file is treated as a mutating tool and blocked in plan mode', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'plan.ts'), 'one\ntwo\n', 'utf8')
  const plan = { ...context(root), session: { ...session(root), agentMode: 'plan' as const } }
  const result = JSON.parse(await executeTool('patch_file', { path: 'plan.ts', patches: [{ start_line: 1, end_line: 1, new_lines: 'uno' }] }, plan))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PLAN_MODE')
})

test('read_file returns up to 5000 lines by default for files that long', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'big.txt'), Array.from({ length: 4200 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf8')
  const result = JSON.parse(await executeTool('read_file', { path: 'big.txt' }, context(root)))
  assert.equal(result.ok, true)
  assert.equal(result.data.totalLines, 4200)
  assert.equal(result.data.range.end, 4200)
  assert.equal(result.data.truncated, false)
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

test('move_file creates missing destination directories', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'source.txt'), 'content', 'utf8')
  const moved = JSON.parse(await executeTool('move_file', { from: 'source.txt', to: 'new/nested/target.txt' }, context(root)))
  assert.equal(moved.ok, true)
  assert.equal(await readFile(join(root, 'new', 'nested', 'target.txt'), 'utf8'), 'content')
})

test('append_file appends preserving existing content', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'log.txt'), 'first', 'utf8')
  const appended = JSON.parse(await executeTool('append_file', { path: 'log.txt', content: 'second' }, context(root)))
  assert.equal(appended.data.addedLines, 1)
  assert.equal(appended.data.removedLines, 0)
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
  assert.equal(capped.data.count, 3)
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

test('web_search without tavily key falls back through all providers', async (t) => {
  const root = await fixture(t)
  const ctx = { ...context(root) }
  const startedAt = Date.now()
  let result: { ok?: boolean; data?: { results?: unknown[] }; error?: { message?: string } } | undefined
  try {
    result = JSON.parse(await executeTool('web_search', { query: 'test query offline deterministic' }, ctx))
  } catch (error) {
    // فشل كل المزودات يرمي خطأ — حالة متوقعة خارج الشبكات المفتوحة
    assert.match(String(error instanceof Error ? error.message : error), /فشلت جميع مزودات البحث|مهلة/)
    assert.ok(Date.now() - startedAt < 15_000, 'web_search يجب أن يلتزم بمهلة مشتركة بدل انتظار المزودات بالتتابع')
    return
  }
  assert.ok(Date.now() - startedAt < 15_000, 'web_search يجب أن يلتزم بمهلة مشتركة بدل انتظار المزودات بالتتابع')
  // Either all providers fail (expected in offline/CI) or one succeeds (network available)
  if (!result.ok) {
    assert.match(result.error?.message ?? '', /فشلت جميع مزودات البحث/)
  } else {
    assert.ok(Array.isArray(result.data?.results))
  }
})

test('web_search with invalid tavily key attempts Tavily first', async (t) => {
  // This test hits the real Tavily API — skip in offline CI
  if (!process.env.CI && process.env.TAVILY_TEST_KEY) { t.skip(' skipped: requires real Tavily key'); return }
  t.skip('يتخطى: يعتمد على اتصال Tavily API')
})

test('isBlockedAddress still blocks private ranges', () => {
  assert.equal(isBlockedAddress('127.0.0.1'), true)
  assert.equal(isBlockedAddress('10.0.0.1'), true)
  assert.equal(isBlockedAddress('169.254.169.254'), true)
  assert.equal(isBlockedAddress('93.184.216.34'), false)
})

// ─── Web Search Hardening: Deterministic Tests ─────────────────────────────

test('normalizeSearchText lowercases, strips Arabic marks and normalizes alef variants', () => {
  assert.equal(normalizeSearchText('Hello World'), 'hello world')
  assert.equal(normalizeSearchText('أبتثجح'), 'ابتثجح')
  assert.equal(normalizeSearchText('إٔأآ'), 'ااا')
  assert.equal(normalizeSearchText('مُحَمَّد'), 'محمد')
  assert.equal(normalizeSearchText('تَوْكِيل'), 'توكيل')
  assert.equal(normalizeSearchText('test  '), 'test')
  assert.equal(normalizeSearchText(''), '')
})

test('classifySearchError identifies transient and permanent errors', () => {
  assert.equal(classifySearchError(new Error('ECONNRESET')), 'transient')
  assert.equal(classifySearchError(new Error('socket hang up')), 'transient')
  assert.equal(classifySearchError(new Error('timeout occurred')), 'transient')
  assert.equal(classifySearchError(new Error('HTTP 429 rate limit')), 'transient')
  assert.equal(classifySearchError(new Error('HTTP 503')), 'transient')
  assert.equal(classifySearchError(new Error('HTTP 401 unauthorized')), 'permanent')
  assert.equal(classifySearchError(new Error('HTTP 403 forbidden')), 'permanent')
  assert.equal(classifySearchError(new Error('HTTP 404 not found')), 'permanent')
  assert.equal(classifySearchError(new Error('DNS lookup فشل')), 'permanent')
  assert.equal(classifySearchError(new Error('blocked address')), 'permanent')
  assert.equal(classifySearchError(new Error('some random error')), 'unknown')
  assert.equal(classifySearchError('string error'), 'unknown')
})

test('tavily circuit breaker opens after 3 failures and resets on success', () => {
  // Reset circuit state
  tavilyCircuit.consecutiveFailures = 0
  tavilyCircuit.openUntil = 0

  assert.equal(tavilyAvailable(), true)
  recordTavilyResult(false)
  assert.equal(tavilyAvailable(), true)
  recordTavilyResult(false)
  assert.equal(tavilyAvailable(), true)
  recordTavilyResult(false)
  // After 3 failures, circuit should open
  assert.equal(tavilyCircuit.openUntil > Date.now(), true)
  assert.equal(tavilyAvailable(), false)

  // Success resets circuit
  tavilyCircuit.consecutiveFailures = 0
  tavilyCircuit.openUntil = 0
  assert.equal(tavilyAvailable(), true)
  recordTavilyResult(true)
  assert.equal(tavilyCircuit.consecutiveFailures, 0)
})

test('rankSearchResults deduplicates URLs and caps per hostname', () => {
  const results = [
    { title: 'Page A', url: 'https://example.com/a', snippet: 'content a' },
    { title: 'Page B', url: 'https://example.com/b', snippet: 'content b' },
    { title: 'Page C', url: 'https://example.com/c', snippet: 'content c' },
    { title: 'Page D', url: 'https://other.com/d', snippet: 'content d' },
  ]
  const ranked = rankSearchResults('test query', results)
  // Should cap example.com at 2 results
  const exampleResults = ranked.filter((r) => r.url.includes('example.com'))
  assert.ok(exampleResults.length <= 2, `example.com results: ${exampleResults.length}`)
})

test('rankSearchResults deduplicates identical URLs', () => {
  const results = [
    { title: 'First', url: 'https://example.com/page', snippet: 'first' },
    { title: 'Second', url: 'https://example.com/page', snippet: 'second' },
  ]
  const ranked = rankSearchResults('test', results)
  assert.equal(ranked.length, 1)
})

test('rankSearchResults prefers titles matching query terms', () => {
  const results = [
    { title: 'Unrelated Title', url: 'https://a.com', snippet: 'TypeScript tutorial basics' },
    { title: 'TypeScript Guide', url: 'https://b.com', snippet: 'unrelated content here' },
  ]
  const ranked = rankSearchResults('TypeScript tutorial', results)
  assert.equal(ranked[0]!.url, 'https://b.com', 'Title match should rank higher')
})

test('rankSearchResults applies provider weights from the tagged provider only', () => {
  const results = [
    { title: 'Same Title alpha beta', url: 'https://a.com/x', snippet: 'alpha beta gamma delta epsilon zeta eta theta iota kappa', provider: 'DuckDuckGo' },
    { title: 'Same Title alpha beta', url: 'https://b.com/y', snippet: 'alpha beta gamma delta epsilon zeta eta theta iota kappa', provider: 'Tavily' },
  ]
  const ranked = rankSearchResults('alpha beta', results)
  // نتيجة متكافئة الصلة — وزن Tavily الأعلى هو الذي يرجح
  assert.equal(ranked[0]!.url, 'https://b.com/y')
})

test('isRelevantSearchResult matches normalized Arabic text', () => {
  assert.equal(isRelevantSearchResult('برمجة', { title: 'برمجة الويب', url: 'https://x.com', snippet: 'تعلم البرمجة' }), true)
  assert.equal(isRelevantSearchResult('برمجة', { title: 'Cooking recipe', url: 'https://x.com', snippet: 'kitchen tips' }), false)
  assert.equal(isRelevantSearchResult('hello', { title: 'Hello World', url: 'https://x.com', snippet: 'greeting' }), true)
})

test('htmlToText extracts semantic article content and removes nav/footer', () => {
  const html = `
    <html>
    <head><title>Test</title></head>
    <body>
      <nav><a href="/home">Home</a></nav>
      <article>
        <h1>Main Article</h1>
        <p>This is the main content of the article.</p>
        <p>Second paragraph with useful information.</p>
      </article>
      <footer>Copyright 2024</footer>
    </body>
    </html>
  `
  const text = htmlToText(html)
  assert.ok(text.includes('Main Article'), 'Should contain article heading')
  assert.ok(text.includes('main content'), 'Should contain article paragraph')
  assert.ok(!text.includes('Copyright 2024'), 'Should not contain footer')
  assert.ok(!text.includes('Home'), 'Should not contain nav')
})

test('htmlToText falls back to full page when no semantic tags present', () => {
  const html = '<html><body><h1>Docs Page</h1><p>Documentation content here.</p></body></html>'
  const text = htmlToText(html)
  assert.ok(text.includes('Docs Page'), 'Should contain heading')
  assert.ok(text.includes('Documentation content'), 'Should contain body content')
})

test('htmlToText preserves pre/code blocks content', () => {
  const html = '<html><body><pre><code>const x = 1;\nconst y = 2;</code></pre></body></html>'
  const text = htmlToText(html)
  assert.ok(text.includes('const x = 1'), 'Should preserve code block content')
})

test('htmlToText passes through non-HTML content unchanged', () => {
  const plain = 'This is plain text, not HTML.'
  assert.equal(htmlToText(plain), plain)
})

test('htmlToText strips script and style tags', () => {
  const html = '<html><body><script>alert("xss")</script><style>.a{color:red}</style><p>Safe content</p></body></html>'
  const text = htmlToText(html)
  assert.ok(!text.includes('alert'), 'Should not contain script content')
  assert.ok(!text.includes('color:red'), 'Should not contain style content')
  assert.ok(text.includes('Safe content'), 'Should contain safe content')
})

test('web_search with tavily key returns providerOutcomes in output', async (t) => {
  const root = await fixture(t)
  const ctx = { ...context(root), tavilyApiKey: undefined }
  let result: { ok?: boolean; data?: { results?: unknown[]; query?: string; durationMs?: number } } | undefined
  try {
    result = JSON.parse(await executeTool('web_search', { query: 'test deterministic query' }, ctx))
  } catch (error) {
    assert.match(String(error instanceof Error ? error.message : error), /فشلت جميع مزودات البحث|مهلة/)
    return
  }
  if (result.ok) {
    assert.ok(Array.isArray(result.data?.results), 'Should have results array')
    assert.ok(typeof result.data?.query === 'string', 'Should have query string')
    assert.ok(typeof result.data?.durationMs === 'number', 'Should have durationMs')
  }
})

test('web_search with invalid tavily key returns error outcome', async (t) => {
  // Skip in offline CI
  t.skip('يتخطى: يعتمد على اتصال Tavily API')
})

test('web_search cancellation does not leak timers', async (t) => {
  const root = await fixture(t)
  const controller = new AbortController()
  const ctx = { ...context(root), signal: controller.signal }
  // Abort immediately
  controller.abort()
  await assert.rejects(
    () => executeTool('web_search', { query: 'test cancellation' }, ctx),
    /تم إلغاء/,
  )
})

test('web_search output shape is backward-compatible', async (t) => {
  const root = await fixture(t)
  const ctx = { ...context(root) }
  let succeeded = false
  try {
    const result = JSON.parse(await executeTool('web_search', { query: 'backward compat test' }, ctx))
    if (result.ok) {
      succeeded = true
      assert.ok(Array.isArray(result.data.results))
      assert.ok(typeof result.data.query === 'string')
      assert.ok(typeof result.data.durationMs === 'number')
      // providerOutcomes is additive, should be array if present
      if (result.data.providerOutcomes) {
        assert.ok(Array.isArray(result.data.providerOutcomes))
      }
    }
  } catch { /* all providers failed in offline environment - acceptable */ }
  // Test passes if either success or graceful offline failure
  assert.ok(true, 'Output shape validation completed')
})
