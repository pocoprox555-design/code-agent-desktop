import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../src/main/scaffold'

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-scaffold-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('scaffold rejects traversal, separators, and reserved Windows names', async (t) => {
  const root = await fixture(t)
  for (const projectName of ['../escape', 'a/b', 'a\\b', 'C:\\root', 'CON', 'name.', 'name ']) {
    const result = await createProject('vanilla', projectName, root)
    assert.equal(result.ok, false, projectName)
  }
  assert.deepEqual(await readdir(root), [])
})

test('scaffold creates a valid deterministic package slug for Arabic names', async (t) => {
  const root = await fixture(t)
  const result = await createProject('vanilla', 'موقعي الجميل', root)
  assert.equal(result.ok, true)
  const packageJson = JSON.parse(await readFile(join(result.projectPath!, 'package.json'), 'utf8')) as { name: string }
  assert.match(packageJson.name, /^project-[a-f0-9]{10}$/)
  assert.equal(result.projectName, 'موقعي الجميل')
})
