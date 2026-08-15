import { isAbsolute, resolve } from 'node:path'

export interface ScheduledToolCall { name: string; input: Record<string, unknown> }
export interface ToolStage { parallel: boolean; indexes: number[] }

const PARALLEL_READS = new Set(['read_file', 'read_files', 'read_message', 'count_lines', 'list_directory', 'glob_files', 'search_files', 'search_symbols', 'get_file_info', 'tree', 'analyze_file', 'find_references', 'dependency_graph', 'todo_read', 'web_search', 'web_fetch', 'web_research'])

export function canonicalPathKey(workspace: string, value: string): string {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(workspace, value)
  return absolute.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase('en-US')
}

export function pathsConflict(workspace: string, first: string, second: string): boolean {
  const a = canonicalPathKey(workspace, first)
  const b = canonicalPathKey(workspace, second)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** Writes remain barriers while workspace mutation locking serializes them. */
export function planToolStages(calls: ScheduledToolCall[]): ToolStage[] {
  const stages: ToolStage[] = []
  let reads: number[] = []
  const flushReads = (): void => { if (reads.length) { stages.push({ parallel: reads.length > 1, indexes: reads }); reads = [] } }
  calls.forEach((call, index) => {
    if (PARALLEL_READS.has(call.name)) reads.push(index)
    else { flushReads(); stages.push({ parallel: false, indexes: [index] }) }
  })
  flushReads()
  return stages
}
