import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { CodeReviewer } from '../src/main/review'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('CodeReviewer', () => {
  let tmpDir: string
  let reviewer: CodeReviewer

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-test-'))
    reviewer = new CodeReviewer(tmpDir)
  })

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('detects eval usage as error', async () => {
    const file = path.join(tmpDir, 'bad.ts')
    await fs.writeFile(file, 'eval("alert(1)")\n')
    const issues = await reviewer.reviewFile(file)
    assert.ok(issues.some((i) => i.severity === 'error' && i.category === 'أمان'))
  })

  it('detects console.log as warning', async () => {
    const file = path.join(tmpDir, 'log.ts')
    await fs.writeFile(file, 'console.log("debug")\n')
    const issues = await reviewer.reviewFile(file)
    assert.ok(issues.some((i) => i.severity === 'warning' && i.category === 'جودة'))
  })

  it('detects TODO comments as info', async () => {
    const file = path.join(tmpDir, 'todo.ts')
    await fs.writeFile(file, '// TODO: fix this later\n')
    const issues = await reviewer.reviewFile(file)
    assert.ok(issues.some((i) => i.severity === 'info' && i.category === 'صيانة'))
  })

  it('detects empty catch blocks', async () => {
    const file = path.join(tmpDir, 'catch.ts')
    await fs.writeFile(file, 'try { x() } catch (e) {}\n')
    const issues = await reviewer.reviewFile(file)
    assert.ok(issues.some((i) => i.message.includes('catch فارغ')))
  })

  it('returns empty for clean code', async () => {
    const file = path.join(tmpDir, 'clean.ts')
    await fs.writeFile(file, 'const x = 1\nexport default x\n')
    const issues = await reviewer.reviewFile(file)
    assert.equal(issues.length, 0)
  })

  it('reviews multiple files', async () => {
    const f1 = path.join(tmpDir, 'a.ts')
    const f2 = path.join(tmpDir, 'b.ts')
    await fs.writeFile(f1, 'eval("x")\n')
    await fs.writeFile(f2, 'const y = 1\n')
    const result = await reviewer.reviewFiles([f1, f2])
    assert.equal(result.filesReviewed, 2)
    assert.ok(result.issues.length > 0)
    assert.ok(result.score <= 100)
  })

  it('reviews diff content', async () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
+eval("bad")
+const x = 1
`
    const result = await reviewer.reviewDiff(diff)
    assert.ok(result.issues.length > 0)
    assert.ok(result.score < 100)
  })
})
