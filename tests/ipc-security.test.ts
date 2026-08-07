import test from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedRendererUrl } from '../src/main/ipc-security'

test('renderer URL matching is exact and fail-closed', () => {
  assert.equal(isTrustedRendererUrl('http://localhost:5173/', 'http://localhost:5173'), true)
  assert.equal(isTrustedRendererUrl('http://localhost:5173/other', 'http://localhost:5173/'), false)
  assert.equal(isTrustedRendererUrl('http://localhost:5173/?x=1', 'http://localhost:5173/'), false)
  assert.equal(isTrustedRendererUrl('file:///C:/app/index.html', 'file:///C:/app/index.html'), true)
  assert.equal(isTrustedRendererUrl('file:///C:/other/index.html', 'file:///C:/app/index.html'), false)
  assert.equal(isTrustedRendererUrl('not a url', 'file:///C:/app/index.html'), false)
})
