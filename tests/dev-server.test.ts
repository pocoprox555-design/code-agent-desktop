import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DevServerManager } from '../src/main/dev-server'

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'r-code-devserver-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('dev server does not install implicitly when dependencies are missing', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }), 'utf8')
  const manager = new DevServerManager()
  const state = await manager.start('project-1', root)
  assert.equal(state.running, false)
  assert.equal(state.requiresInstall, true)
  assert.equal(state.projectId, 'project-1')
  await manager.shutdown()
})

test('requests install when node_modules exists but the dev tool is missing (P14)', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }), 'utf8')
  const manager = new DevServerManager()
  const state = await manager.start('project-missing-tool', root)
  assert.equal(state.running, false)
  assert.equal(state.requiresInstall, true)
  await manager.shutdown()
})

test('dev server rejects projects without a declared dev script', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }), 'utf8')
  const manager = new DevServerManager()
  const state = await manager.start('project-2', root)
  assert.equal(state.running, false)
  assert.match(state.error ?? '', /script باسم dev/)
})

test('concurrent starts for one project share the same lifecycle result', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }), 'utf8')
  const manager = new DevServerManager()
  const first = manager.start('project-concurrent', root)
  const second = manager.start('project-concurrent', root)
  assert.equal(await first, await second)
  await manager.shutdown()
})

test('reuses the owned server for repeated starts and restarts it after stop', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }), 'utf8')
  await writeFile(join(root, 'server.js'), [
    "const http = require('node:http')",
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const counterPath = path.join(__dirname, 'starts.txt')",
    "const count = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : 0) + 1",
    "fs.writeFileSync(counterPath, String(count))",
    "const server = http.createServer((_request, response) => response.end('ok'))",
    "server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log(`http://127.0.0.1:${process.env.PORT}`))",
  ].join('\n'), 'utf8')
  const manager = new DevServerManager()

  const first = await manager.start('project-reuse', root)
  const second = await manager.start('project-reuse', root)
  const third = await manager.startWithInstall('project-reuse', root)
  assert.equal(first.running, true)
  assert.equal(second.startedAt, first.startedAt)
  assert.equal(third.startedAt, first.startedAt)
  assert.equal(await readFile(join(root, 'starts.txt'), 'utf8'), '1')

  await manager.stop('project-reuse')
  const restarted = await manager.start('project-reuse', root)
  assert.equal(restarted.running, true)
  assert.notEqual(restarted.startedAt, first.startedAt)
  assert.equal(await readFile(join(root, 'starts.txt'), 'utf8'), '2')
  await manager.shutdown()
})
