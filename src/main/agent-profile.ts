export interface AgentProfile {
  readonly name: 'main-chat' | 'dedicated-build'
  readonly dedicatedBuild: boolean
  readonly bypassApprovals: boolean
  readonly fullPowerShellLanguage: boolean
  readonly eventChannel: string
  readonly approvalChannel: string
  readonly maxSteps: number
  readonly runtimeMs: number
  readonly autoCompleteTodos: boolean
  readonly autoPreview: boolean
  readonly costPolicy: 'protected'
  readonly adaptiveOutputBudget: boolean
}

export type BuildToolGroup = 'core' | 'preview' | 'web' | 'pdf' | 'mcp' | 'subagents'
export interface BuildToolPolicy { readonly groups: ReadonlySet<BuildToolGroup>; readonly localToolsAlwaysAvailable: true }

export const BUILD_TOOL_GROUPS: Readonly<Record<BuildToolGroup, readonly string[]>> = Object.freeze({
  core: ['read_file', 'read_files', 'read_message', 'count_lines', 'list_directory', 'glob_files', 'search_files', 'search_symbols', 'get_file_info', 'tree', 'write_file', 'edit_file', 'edit_files_bulk', 'edit_file_undo', 'patch_file', 'append_file', 'create_directory', 'shell', 'run_powershell', 'todo_read', 'todo_write', 'git_status', 'git_diff', 'git_log', 'analyze_file', 'find_references', 'dependency_graph', 'remember_project', 'recall_project'],
  preview: ['start_preview', 'stop_preview', 'preview_status', 'get_page_content', 'preview_screenshot'], web: ['web_search', 'web_fetch', 'web_research'], pdf: ['read_pdf'], mcp: [], subagents: ['task', 'task_parallel'],
})

export function toolGroupFor(name: string): BuildToolGroup | undefined {
  if (name.startsWith('mcp_')) return 'mcp'
  return (Object.entries(BUILD_TOOL_GROUPS) as Array<[BuildToolGroup, readonly string[]]>).find(([, tools]) => tools.includes(name))?.[0]
}

/** حد أدنى لسقف إخراج Build — يمنع تقزيم كتابة الملفات الكبيرة على نوافذ السياق الصغيرة */
export const BUILD_MIN_OUTPUT_TOKENS = 32_768

export function buildOutputTokenBudget(configured: number, contextWindow: number, dedicatedBuild: boolean, final = false, lengthRetry = 0): number {
  if (!dedicatedBuild || final) return configured
  const initial = Math.min(configured, Math.max(BUILD_MIN_OUTPUT_TOKENS, Math.floor(contextWindow / 16)))
  return Math.min(configured, initial + Math.floor(initial * 0.5) * lengthRetry)
}

/**
 * سياسة أدوات Build — بلا بوابات تخمين على كلام المستخدم:
 * web/preview/pdf/subagents مفعّلة دائمًا (حسب القدرات الفعلية)، وmcp فقط
 * بإشارة صريحة لأنه يشغّل خوادم خارجية لها كلفة. النموذج يختار أدواته بنفسه.
 */
export function buildToolPolicy(prompt: string, capabilities: { preview: boolean; subagents: boolean }): BuildToolPolicy {
  const groups = new Set<BuildToolGroup>(['core', 'web', 'pdf'])
  if (capabilities.preview) groups.add('preview')
  if (capabilities.subagents) groups.add('subagents')
  if (/\bmcp\b|model context protocol|خادم أدوات/i.test(prompt)) groups.add('mcp')
  return { groups, localToolsAlwaysAvailable: true }
}

export const MAIN_CHAT_PROFILE: AgentProfile = {
  name: 'main-chat',
  dedicatedBuild: false,
  bypassApprovals: false,
  fullPowerShellLanguage: false,
  eventChannel: 'agent:event',
  approvalChannel: 'approval:request',
  maxSteps: 500,
  runtimeMs: 30 * 60_000,
  autoCompleteTodos: false,
  autoPreview: false,
  costPolicy: 'protected',
  adaptiveOutputBudget: false,
}

export const DEDICATED_BUILD_PROFILE: AgentProfile = {
  name: 'dedicated-build',
  dedicatedBuild: true,
  bypassApprovals: true,
  fullPowerShellLanguage: true,
  eventChannel: 'build:event',
  approvalChannel: 'build:approval',
  maxSteps: 100,
  runtimeMs: 60 * 60_000,
  autoCompleteTodos: true,
  autoPreview: true,
  costPolicy: 'protected',
  adaptiveOutputBudget: true,
}
