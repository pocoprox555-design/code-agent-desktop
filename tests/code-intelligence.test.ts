import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectIndexer } from '../src/main/code-intelligence'

test('ProjectIndexer shares in-flight builds and sees creates inside the scan TTL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-index-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  const indexer = new ProjectIndexer(root)
  const [first, second] = await Promise.all([indexer.getIndex(), indexer.getIndex()])
  assert.equal(first, second)
  await writeFile(join(root, 'src', 'created.ts'), 'export const created = 1\n', 'utf8')
  indexer.invalidate({ workspaceRevision: 1, effects: [{ kind: 'write', path: 'src/created.ts' }] })
  const rebuilt = await indexer.getIndex()
  assert.ok(rebuilt.files.has('src/created.ts'))
})

test('dependency lookup accepts both relative and absolute paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r-code-deps-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'a.ts'), 'export const a = 1\n', 'utf8')
  const indexer = new ProjectIndexer(root)
  assert.deepEqual(await indexer.getDependencies('a.ts'), await indexer.getDependencies(join(root, 'a.ts')))
})
