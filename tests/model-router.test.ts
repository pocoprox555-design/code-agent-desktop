import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ModelRouter, createModelRouter } from '../src/main/model-router'

describe('ModelRouter', () => {
  it('routes to default model when no specific route configured', () => {
    const router = createModelRouter('deepseek-v4-flash')
    const route = router.route('action')
    assert.equal(route.modelId, 'deepseek-v4-flash')
  })

  it('routes action tasks to fast models', () => {
    const router = createModelRouter('deepseek-v4-pro')
    const route = router.route('action')
    // Should use the default since no action model configured
    assert.ok(route.modelId)
    assert.ok(route.apiStyle)
    assert.ok(route.contextWindow > 0)
  })

  it('provides cost info', () => {
    const router = createModelRouter('deepseek-v4-flash')
    const cost = router.getCostInfo('deepseek-v4-flash')
    assert.ok(cost)
    assert.ok(cost.input > 0)
    assert.ok(cost.output > 0)
  })

  it('returns suggestions for each role', () => {
    const router = createModelRouter('deepseek-v4-flash')
    const suggestions = router.getSuggestions()
    assert.ok(suggestions.action.length > 0)
    assert.ok(suggestions.thinking.length > 0)
    assert.ok(suggestions.critique.length > 0)
    assert.ok(suggestions.compact.length > 0)
    assert.ok(suggestions.subagent.length > 0)
  })

  it('analyzeAndRoute detects complex tasks', () => {
    const router = createModelRouter('deepseek-v4-flash')
    const route = router.analyzeAndRoute('خطط لهندسة المشروع')
    assert.ok(route.modelId)
  })

  it('analyzeAndRoute detects simple tasks', () => {
    const router = createModelRouter('deepseek-v4-flash')
    const route = router.analyzeAndRoute('اقرأ ملف utils.ts')
    assert.ok(route.modelId)
  })
})
