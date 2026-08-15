import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DeployManager, isSafeGitRef, parseGitHubRepo } from '../src/main/deploy'

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-deploy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('GitHub deploy validates HTTPS repo and branch refs', () => {
  assert.deepEqual(parseGitHubRepo('https://github.com/owner/site.git'), { owner: 'owner', repo: 'site' })
  assert.equal(parseGitHubRepo('http://github.com/owner/site'), null)
  assert.equal(parseGitHubRepo('https://github.com/owner/site?token=secret'), null)
  assert.equal(parseGitHubRepo('https://github.com/owner/site/extra'), null)
  assert.equal(isSafeGitRef('gh-pages'), true)
  assert.equal(isSafeGitRef('../main'), false)
  assert.equal(isSafeGitRef('bad ref'), false)
})

test('deploy build failure prevents publisher and never exposes the token', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "process.exit(1)"' } }), 'utf8')
  const manager = new DeployManager()
  const result = await manager.deploy({ projectId: 'project-1', projectPath: root, token: 'secret-token', repoUrl: 'https://github.com/owner/site' })
  assert.equal(result.status, 'failed')
  assert.equal(result.buildSucceeded, false)
  assert.doesNotMatch(result.error ?? '', /secret-token/)
  assert.equal(manager.status('project-1').status, 'failed')
})

test('deploy publishes only a production artifact and separates Pages availability', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: "node -e \"require('fs').mkdirSync('dist')\"" } }), 'utf8')
  let published: { artifact: string; repo: string; branch: string; token: string } | undefined
  const manager = new DeployManager({ publisher: async (artifact, repo, branch, token) => { published = { artifact, repo, branch, token } } })
  const result = await manager.deploy({ projectId: 'project-2', projectPath: root, token: 'secret-token', repoUrl: 'https://github.com/owner/site', branch: 'gh-pages' })
  assert.equal(result.status, 'success')
  assert.equal(result.buildSucceeded, true)
  assert.equal(result.pushSucceeded, true)
  assert.equal(result.pagesStatus, 'pending')
  assert.equal(result.url, 'https://owner.github.io/site/')
  assert.equal(published?.artifact, join(root, 'dist'))
  assert.equal(published?.repo, 'https://github.com/owner/site')
  assert.equal(published?.token, 'secret-token')
})

test('deploy rejects a successful build without a known artifact', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"' } }), 'utf8')
  let published = false
  const manager = new DeployManager({ publisher: async () => { published = true } })
  const result = await manager.deploy({ projectId: 'project-3', projectPath: root, token: 'token', repoUrl: 'https://github.com/owner/site' })
  assert.equal(result.status, 'failed')
  assert.equal(result.buildSucceeded, true)
  assert.equal(published, false)
})
