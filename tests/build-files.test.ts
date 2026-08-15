import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getBuildStats, readBuildFileContent, readBuildFiles } from '../src/main/build-files'

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-build-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('Build scanner ignores artifacts, gitignored files, and secrets', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'dist'))
  await mkdir(join(root, 'ignored'))
  await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8')
  await writeFile(join(root, 'src', 'App.tsx'), 'export const App = () => null\n', 'utf8')
  await writeFile(join(root, 'package.json'), '{}', 'utf8')
  await writeFile(join(root, '.env'), 'TOKEN=secret', 'utf8')
  await writeFile(join(root, 'provider.json'), '{}', 'utf8')
  await writeFile(join(root, 'ignored', 'secret.ts'), 'secret', 'utf8')
  await writeFile(join(root, 'dist', 'bundle.js'), 'artifact', 'utf8')

  const scan = await readBuildFiles(root)
  assert.deepEqual(scan.files.map((file) => file.relativePath), ['.gitignore', 'package.json', 'src/App.tsx'])
  assert.equal(scan.truncated, false)
  assert.equal(await readBuildFileContent(root, 'src/App.tsx'), 'export const App = () => null\n')
  await assert.rejects(() => readBuildFileContent(root, '.env'), /غير مسموح/)
  await assert.rejects(() => readBuildFileContent(root, '../outside.ts'), /خارج المشروع/)
  const stats = await getBuildStats(root)
  assert.equal(stats.files, 3)
  assert.equal(stats.lines, 5)
  assert.ok(stats.size > 0)
  assert.equal(stats.truncated, false)
})

test('Build scanner rejects symlink traversal', async (t) => {
  const root = await fixture(t)
  const outside = await fixture(t)
  await writeFile(join(outside, 'secret.ts'), 'secret', 'utf8')
  const link = join(root, 'linked')
  try { await symlink(outside, link, 'junction') } catch (error) { t.skip(`junction غير متاح: ${String(error)}`); return }
  await assert.rejects(() => readBuildFiles(root), /رابطًا رمزيًا/)
  await assert.rejects(() => readBuildFileContent(root, 'linked/secret.ts'), /رابط رمزي/)
})

test('Build scanner reports bounded scans instead of silently growing', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'large.ts'), 'x'.repeat(500_001), 'utf8')
  for (let index = 0; index < 205; index++) await writeFile(join(root, `file-${index}.ts`), 'x', 'utf8')
  const scan = await readBuildFiles(root)
  assert.equal(scan.files.length, 200)
  assert.equal(scan.truncated, true)
})
