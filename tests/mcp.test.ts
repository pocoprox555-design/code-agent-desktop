import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicHttpsUrl } from '../src/main/public-network'

test('remote MCP requires HTTPS and rejects local addresses before connecting', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('http://example.com/mcp'), /HTTPS/)
  await assert.rejects(() => assertPublicHttpsUrl('https://localhost/mcp'), /محلية|خاص/)
  await assert.rejects(() => assertPublicHttpsUrl('https://127.0.0.1/mcp'), /محلية|خاص/)
})

test('remote MCP rejects credentials in URLs', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('https://user:pass@example.com/mcp'), /بيانات اعتماد/)
})
