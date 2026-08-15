import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ProjectMemory } from '../src/main/memory'

test('memory retrieval increments access count and category keys do not collide', () => {
  const db = new DatabaseSync(':memory:')
  const memory = new ProjectMemory(db)
  memory.initTable()
  memory.save('w', 'decision', 'runtime', 'use node')
  memory.save('w', 'error_fix', 'runtime', 'restart process')
  assert.equal(memory.stats('w').total, 2)
  const before = memory.getByKey('w', 'runtime', 'decision')!
  const after = memory.getByKey('w', 'runtime', 'decision')!
  assert.equal(after.accessCount, before.accessCount + 1)
  db.close()
})

test('latest memory save wins even when the contradictory value is shorter', () => {
  const db = new DatabaseSync(':memory:')
  const memory = new ProjectMemory(db)
  memory.initTable()
  const long = 'This is the longer authoritative architecture decision.'
  memory.save('w', 'architecture', 'stack', long)
  memory.save('w', 'architecture', 'stack', 'different but shorter value')
  const current = memory.getByKey('w', 'stack', 'architecture')!
  assert.equal(current.value, 'different but shorter value')
  assert.equal(current.confidence, 0.6)
  assert.ok(current.accessCount >= 3)
  db.close()
})

test('memory decay is applied once per stale interval and lexical context uses task terms', () => {
  const db = new DatabaseSync(':memory:')
  const memory = new ProjectMemory(db)
  memory.initTable()
  const entry = memory.save('w', 'error_fix', 'typescript build', 'Run npm test after fixing compiler errors')
  const stale = Date.now() - 40 * 24 * 60 * 60 * 1000
  db.prepare('UPDATE project_memory SET accessed_at=?, last_decay_at=0 WHERE id=?').run(stale, entry.id)
  const first = memory.buildContextString('w', 'compiler failure in src/app.ts')
  const confidence = Number((db.prepare('SELECT confidence FROM project_memory WHERE id=?').get(entry.id) as { confidence: number }).confidence)
  const second = memory.buildContextString('w', 'compiler failure in src/app.ts')
  const confidenceAgain = Number((db.prepare('SELECT confidence FROM project_memory WHERE id=?').get(entry.id) as { confidence: number }).confidence)
  assert.match(first, /npm test/)
  assert.match(second, /npm test/)
  assert.equal(confidenceAgain, confidence)
  db.close()
})
