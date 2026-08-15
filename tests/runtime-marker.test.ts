import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeMarker, RUNTIME_POLICY_REVISION } from '../src/main/runtime-marker'

test('runtime marker identifies version, channel, and source directories without secrets', () => {
  const marker = createRuntimeMarker({ version: '0.5.0', isPackaged: false, appPath: 'D:/Code-Agent', mainDir: 'D:/Code-Agent/out/main' })
  assert.equal(marker.channel, 'dev')
  assert.equal(marker.version, '0.5.0')
  assert.equal(marker.policyRevision, RUNTIME_POLICY_REVISION)
  assert.equal(marker.marker, `code-agent/0.5.0/dev/${RUNTIME_POLICY_REVISION}/Code-Agent/main`)
  assert.doesNotMatch(marker.marker, /api|key|secret/i)

  const packaged = createRuntimeMarker({ version: '0.5.0', isPackaged: true, appPath: 'D:/Code-Agent/resources/app.asar', mainDir: 'D:/Code-Agent/resources/app.asar/out/main' })
  assert.equal(packaged.channel, 'packaged')
  assert.equal(packaged.policyRevision, RUNTIME_POLICY_REVISION)
  assert.notEqual(packaged.marker, marker.marker)
})
