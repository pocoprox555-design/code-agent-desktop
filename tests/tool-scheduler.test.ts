import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalPathKey, pathsConflict, planToolStages } from '../src/main/tool-scheduler'

test('scheduler parallelizes contiguous reads and preserves mutation barriers', () => {
  assert.deepEqual(planToolStages([
    { name: 'read_file', input: { path: 'a' } }, { name: 'search_files', input: {} },
    { name: 'write_file', input: { path: 'b' } }, { name: 'read_file', input: { path: 'c' } }, { name: 'read_file', input: { path: 'd' } },
    { name: 'shell', input: {} },
  ]), [
    { parallel: true, indexes: [0, 1] }, { parallel: false, indexes: [2] }, { parallel: true, indexes: [3, 4] }, { parallel: false, indexes: [5] },
  ])
})

test('scheduler parallelizes independent web requests', () => {
  assert.deepEqual(planToolStages([
    { name: 'web_search', input: { query: 'Yemeni food' } },
    { name: 'web_fetch', input: { url: 'https://example.com/a' } },
    { name: 'web_fetch', input: { url: 'https://example.com/b' } },
  ]), [{ parallel: true, indexes: [0, 1, 2] }])
})

test('path conflicts are Windows-safe and include parent-child relationships', () => {
  const root = 'C:\\Work'
  assert.equal(canonicalPathKey(root, 'SRC\\App.ts'), canonicalPathKey(root, 'src/app.ts'))
  assert.equal(pathsConflict(root, 'src', 'SRC/App.ts'), true)
  assert.equal(pathsConflict(root, 'src/a.ts', 'src/b.ts'), false)
})
