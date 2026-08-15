import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'

async function databasePath(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-subagent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'app.db')
}

test('subagent CRUD works correctly', async (t) => {
  const db = new AppDatabase(await databasePath(t))

  const created = db.createSubagent({ name: 'test-agent', description: 'test desc', color: '#ff0000', model: 'gpt-4', systemPrompt: 'be helpful', allowedTools: '*', enabled: true })
  assert.equal(created.name, 'test-agent')
  assert.ok(created.id)

  const fetched = db.getSubagent(created.id)
  assert.ok(fetched)
  assert.equal(fetched.name, 'test-agent')

  const list = db.listSubagents()
  assert.equal(list.length, 1)

  const updated = db.updateSubagent(created.id, { name: 'updated-agent', enabled: false })
  assert.equal(updated.name, 'updated-agent')
  assert.equal(updated.enabled, false)

  db.removeSubagent(created.id)
  assert.equal(db.getSubagent(created.id), null)
  assert.equal(db.listSubagents().length, 0)

  db.close()
})
