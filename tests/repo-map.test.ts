import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRepoMap, repoMapToString, generateRepoMapString } from '../src/main/repo-map'
import type { ProjectIndex } from '../src/main/code-intelligence'

function createMockIndex(): ProjectIndex {
  const files = new Map()
  files.set('src/main.ts', {
    path: 'src/main.ts',
    totalLines: 100,
    symbols: [
      { name: 'App', kind: 'class', file: 'src/main.ts', line: 1, endLine: 50, isExported: true, isDefault: false, documentation: 'Main app class' },
      { name: 'helper', kind: 'function', file: 'src/main.ts', line: 52, endLine: 60, isExported: true, isDefault: false, documentation: '' },
    ],
    imports: [{ moduleSpecifier: './utils', file: 'src/main.ts', line: 1 }],
    exports: ['App', 'helper'],
    classes: [{ name: 'App', methods: ['run', 'stop'], properties: ['name'] }],
    functions: [{ name: 'helper', parameters: 'x: number', isAsync: false }],
    interfaces: [],
  })
  files.set('src/utils.ts', {
    path: 'src/utils.ts',
    totalLines: 50,
    symbols: [
      { name: 'formatDate', kind: 'function', file: 'src/utils.ts', line: 1, endLine: 10, isExported: true, isDefault: false, documentation: 'Format date helper' },
    ],
    imports: [],
    exports: ['formatDate'],
    classes: [],
    functions: [{ name: 'formatDate', parameters: 'date: Date', isAsync: false }],
    interfaces: [],
  })

  const symbols = new Map()
  symbols.set('App', [{ name: 'App', kind: 'class', file: 'src/main.ts', line: 1, endLine: 50, isExported: true, isDefault: false, documentation: 'Main app class' }])
  symbols.set('helper', [{ name: 'helper', kind: 'function', file: 'src/main.ts', line: 52, endLine: 60, isExported: true, isDefault: false, documentation: '' }])
  symbols.set('formatDate', [{ name: 'formatDate', kind: 'function', file: 'src/utils.ts', line: 1, endLine: 10, isExported: true, isDefault: false, documentation: 'Format date helper' }])

  const dependencyGraph = new Map()
  dependencyGraph.set('src/main.ts', {
    file: 'src/main.ts',
    imports: [{ moduleSpecifier: './utils', file: 'src/main.ts', line: 1 }],
    exportedBy: [],
    importedBy: [],
  })
  dependencyGraph.set('src/utils.ts', {
    file: 'src/utils.ts',
    imports: [],
    exportedBy: [{ from: 'src/main.ts', symbols: ['formatDate'] }],
    importedBy: [],
  })

  return { workspace: '/test', files, symbols, dependencyGraph, builtAt: Date.now() }
}

describe('RepoMap', () => {
  it('builds repo map from index', () => {
    const index = createMockIndex()
    const repoMap = buildRepoMap(index)
    assert.equal(repoMap.totalFiles, 2)
    assert.equal(repoMap.totalSymbols, 3)
    assert.ok(repoMap.entries.length > 0)
  })

  it('prioritizes entry files', () => {
    const index = createMockIndex()
    const repoMap = buildRepoMap(index)
    const firstFile = repoMap.entries[0]?.file
    assert.ok(firstFile === 'src/main.ts' || firstFile === 'src/utils.ts')
  })

  it('converts to string', () => {
    const index = createMockIndex()
    const repoMap = buildRepoMap(index)
    const str = repoMapToString(repoMap)
    assert.ok(str.includes('Project map'))
    assert.ok(str.includes('src/main.ts'))
  })

  it('generates complete string', () => {
    const index = createMockIndex()
    const str = generateRepoMapString(index)
    assert.ok(str.length > 0)
    assert.ok(str.includes('files'))
  })

  it('handles empty index', () => {
    const index: ProjectIndex = {
      workspace: '/test',
      files: new Map(),
      symbols: new Map(),
      dependencyGraph: new Map(),
      builtAt: Date.now(),
    }
    const str = generateRepoMapString(index)
    assert.equal(str, '')
  })

  it('keeps the character budget line-safe and prioritizes task files', () => {
    const index = createMockIndex()
    const str = generateRepoMapString(index, ['src/utils.ts'])
    assert.ok(str.indexOf('src/utils.ts') < str.indexOf('src/main.ts'))
    assert.ok(str.length < 4_100)
    assert.ok(!str.includes('\uFFFD'))
  })
})
