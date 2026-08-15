export type PermissionMode = 'ask' | 'full' | 'read-only'
export type AgentMode = 'build' | 'plan'
export type ApiStyle = 'chat' | 'responses' | 'anthropic'

export interface ModelUsage {
  input: number
  output: number
  total?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

export interface UsageSummary {
  requests: number
  input: number
  output: number
  total: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  estimatedInput: number
  cost: number
  lastAt?: number
}

export interface ProviderConfig {
  name: string
  baseUrl: string
  apiPath: string
  apiStyle: ApiStyle
  model: string
  contextWindow: number
  maxOutputTokens: number
  apiKey: string
  /** مستوى التفكير: 'low' (سريع/افتراضي) | 'medium' (متوازن) | 'high' (عميق) */
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export type ProviderSettings = Omit<ProviderConfig, 'apiKey'> & { hasApiKey: boolean }
export interface ProviderUpdate { model: string; apiKey?: string; contextWindow?: number }

// ─── Custom Providers ─────────────────────────────────────────────────
export interface CustomModel {
  id: string
  modelId: string
  contextWindow: number
  maxOutputTokens: number
  enabled: boolean
}

export interface CustomProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  apiStyle: ApiStyle
  models: CustomModel[]
  createdAt: number
  updatedAt: number
}

export type CustomProviderSettings = Omit<CustomProvider, 'apiKey'> & { hasApiKey: boolean }

export interface CustomProviderUpdate {
  name: string
  baseUrl: string
  apiKey?: string
  apiStyle: ApiStyle
  models: Array<{
    modelId: string
    contextWindow: number
    maxOutputTokens: number
  }>
}

export interface CustomModelTestResult {
  success: boolean
  modelId: string
  error?: string
  latency?: number
}

export interface Attachment {
  name: string
  mimeType: string
  data: string
  size: number
}

export interface Session {
  id: string
  title: string
  workspace: string
  permissionMode: PermissionMode
  agentMode: AgentMode
  planApproved?: boolean
  gitTracked: boolean
  systemPrompt: string
  todos: Todo[]
  parentSessionId?: string
  createdAt: number
  updatedAt: number
}

export interface Subagent {
  id: string
  name: string
  description: string
  color: string
  model: string
  systemPrompt: string
  allowedTools: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

// ─── Checkpoints ──────────────────────────────────────────────────────
export interface Checkpoint {
  id: string
  sessionId: string
  label: string
  messageSnapshot: string // JSON array of messages at this point
  filesChanged: string[]  // list of files modified by agent
  createdAt: number
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export type MutationEffect =
  | { kind: 'write' | 'edit' | 'delete' | 'create-directory'; path: string }
  | { kind: 'move'; from: string; path: string }

export interface MutationReceipt {
  workspaceRevision: number
  effects: MutationEffect[]
  partial?: boolean
}

export interface ToolCallRecord {
  id: string
  name: string
  input: Record<string, unknown>
  todoId?: string | null
  output?: string
  status: 'running' | 'completed' | 'error' | 'denied'
  step?: number
  startedAt?: number
  completedAt?: number
  mutation?: MutationReceipt
}

export interface Message {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  reasoning?: string
  toolCallId?: string
  toolName?: string
  toolCalls?: ToolCallRecord[]
  usage?: ModelUsage
  attachments?: Attachment[]
  createdAt: number
  sequence?: number
  interrupted?: boolean
}

export interface SessionRunState {
  sessionId: string
  runId?: string
  state: 'idle' | 'running' | 'awaiting_approval' | 'cancelling' | 'failed'
  status: string
  error?: string
  pendingApprovals?: ApprovalRequest[]
}
export interface AgentRunState { sessionId: string; runId: string; status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled'; step: number; startedAt: number; updatedAt: number; error?: string }

export interface AuditEvent {
  id: string
  sessionId?: string
  category: 'agent' | 'tool' | 'approval' | 'security'
  action: string
  detail: string
  outcome: 'started' | 'allowed' | 'denied' | 'completed' | 'failed' | 'cancelled'
  createdAt: number
}

export interface Todo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
  createdAt: number
  updatedAt: number
}

export interface TreeEntry {
  name: string
  path: string
  directory: boolean
  size: number
}

export interface ApprovalRequest {
  id: string
  sessionId: string
  runId?: string
  title: string
  detail: string
  risk: 'normal' | 'critical'
  canRemember?: boolean
}

export interface SubagentEvent {
  id: string
  runId?: string
  description: string
  state: 'running' | 'completed' | 'failed'
  step: number
  tool?: string
  summary?: string
  error?: string
}

export interface AgentEvent {
  sessionId: string
  runId?: string
  type: 'run:start' | 'status' | 'message' | 'tool' | 'error' | 'context' | 'stream' | 'todo' | 'subagent' | 'preview'
  text?: string
  message?: Message
  tool?: ToolCallRecord
  todos?: Todo[]
  subagent?: SubagentEvent
  preview?: DevServerState
  context?: { estimatedTokens: number; compacted: boolean; contextWindow: number }
  stream?: { id: string; delta: string; state: 'start' | 'delta' | 'done' | 'discard'; reasoning?: boolean }
  usage?: { delta: ModelUsage; estimated: boolean; total: UsageSummary }
}

export interface CustomPrompt {
  id: string
  title: string
  content: string
  createdAt: number
}

export interface AppApi {
  diagnostics: { runtimeMarker(): Promise<RuntimeMarker> }
  updates: { check(): Promise<{ status: 'available' | 'none' | 'dev' | 'error'; version?: string; message?: string }>; install(): Promise<void> }
  sessions: {
    list(): Promise<Session[]>
    create(input: { title?: string; workspace: string; initGit?: boolean }): Promise<Session>
    update(id: string, patch: Partial<Pick<Session, 'title' | 'permissionMode' | 'agentMode'>>): Promise<Session>
    remove(id: string): Promise<void>
    clearAll(): Promise<number>
    messages(id: string): Promise<Message[]>
    usage(id: string): Promise<UsageSummary>
    subagents(id: string): Promise<SubagentEvent[]>
    setPrompt(id: string, prompt: string): Promise<Session>
    approvePlan(id: string): Promise<Session>
    setTodos(id: string, items: Array<{ content: string; status?: Todo['status']; priority?: Todo['priority'] }>): Promise<Todo[]>
    run(id: string): Promise<AgentRunState | undefined>
    checkpoints(id: string): Promise<Checkpoint[]>
    restoreCheckpoint(id: string, checkpointId: string, mode: 'all' | 'chat' | 'code'): Promise<void>
  }
  agent: { send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>; resume(sessionId: string): Promise<void>; cancel(sessionId: string): Promise<void>; states(): Promise<SessionRunState[]> }
  buildAgent: { send(projectId: string, text: string, attachments?: Attachment[], modelOverride?: string): Promise<{ queued: boolean }>; cancel(projectId: string): Promise<void>; resume(projectId: string): Promise<void>; states(): Promise<SessionRunState[]> }
  buildProjects: {
    list(): Promise<BuildProject[]>
    save(input: { name: string; path: string; template: string; filesCount: number; totalLines: number }): Promise<BuildProject>
    remove(id: string): Promise<void>
    open(id: string): Promise<BuildProjectOpenPayload>
    clearChat(projectId: string): Promise<void>
  }
  provider: { get(): Promise<ProviderSettings>; save(update: ProviderUpdate): Promise<ProviderSettings>; test(update: ProviderUpdate): Promise<string>; clear(): Promise<ProviderSettings> }
  customProviders: {
    list(): Promise<CustomProviderSettings[]>
    save(input: CustomProviderUpdate & { id?: string }): Promise<CustomProviderSettings>
    remove(id: string): Promise<void>
    testModel(providerId: string, modelId: string): Promise<CustomModelTestResult>
    testNewModel(input: { baseUrl: string; apiKey?: string; apiStyle: ApiStyle; modelId: string }): Promise<CustomModelTestResult>
    getModelConfig(providerId: string, modelId: string): Promise<ProviderConfig | null>
  }
  tavily: { get(): Promise<{ hasApiKey: boolean }>; save(update: { apiKey: string }): Promise<{ hasApiKey: boolean }>; clear(): Promise<{ hasApiKey: boolean }> }
  files: { chooseFolder(): Promise<string | null>; list(sessionId: string, path?: string): Promise<TreeEntry[]>; read(sessionId: string, path: string): Promise<string>; readAsBase64(sessionId: string, path: string): Promise<Attachment> }
  approval: { answer(id: string, allowed: boolean, remember?: boolean): Promise<void> }
  buildApproval: { answer(id: string, allowed: boolean, remember?: boolean): Promise<void> }
  audit: { list(limit?: number): Promise<AuditEvent[]> }
  clipboard: { writeText(text: string): Promise<void> }
  prompts: {
    list(): Promise<CustomPrompt[]>
    add(title: string, content: string): Promise<CustomPrompt>
    remove(id: string): Promise<void>
  }
  subagents: {
    list(): Promise<Subagent[]>
    create(input: Omit<Subagent, 'id' | 'createdAt' | 'updatedAt'>): Promise<Subagent>
    update(id: string, input: Partial<Omit<Subagent, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Subagent>
    remove(id: string): Promise<void>
  }
  	events: { onAgent(callback: (event: AgentEvent) => void): () => void; onApproval(callback: (request: ApprovalRequest) => void): () => void; onBuildAgent(callback: (event: AgentEvent) => void): () => void; onBuildApproval(callback: (request: ApprovalRequest) => void): () => void }
	  scaffold: {
	    templates(): Promise<TemplateInfo[]>
	    create(input: { template: string; projectName: string; targetDir: string; description?: string }): Promise<ScaffoldResult>
	  }
	  devserver: {
  	    start(projectId: string): Promise<DevServerState>
  	    stop(projectId: string): Promise<DevServerState>
  	    status(projectId: string): Promise<DevServerState>
  	    installDeps(projectId: string): Promise<{ ok: boolean; output: string; requiresInstall?: boolean }>
	  }
	  deploy: {
  	    githubPages(input: { projectId: string; token: string; repoUrl: string; branch?: string }): Promise<DeployState>
  	    status(projectId: string): Promise<DeployState>
	  }
	  build: {
  	    readFiles(projectId: string): Promise<BuildFileScanResult>
  	    readFileContent(projectId: string, relativePath: string): Promise<string>
  	    getStats(projectId: string): Promise<BuildStats>
	  }
	}

export interface RuntimeMarker {
  marker: string
  version: string
  policyRevision: string
  channel: 'dev' | 'packaged'
  appPath: string
  mainDir: string
}

// ─── Build → Preview → Share ───────────────────────────────────────────

export interface TemplateInfo {
  id: string
  name: string
  description: string
  icon: string
  tags: string[]
  defaultPort: number
}

export interface ScaffoldResult {
  ok: boolean
  projectPath?: string
  projectName?: string
  templateId?: string
  filesCount?: number
  totalLines?: number
  error?: string
}

export interface BuildProject {
  id: string
  name: string
  path: string
  template: string
  filesCount: number
  totalLines: number
  chatSessionId: string
  createdAt: number
  status: 'ready' | 'installing' | 'running' | 'error'
}

export interface BuildProjectOpenPayload {
  project: BuildProject
  session: Session
  messages: Message[]
  usage: UsageSummary
  subagents: SubagentEvent[]
  checkpoints: Checkpoint[]
  todos?: Todo[]
  run?: BuildRunInfo | null
}

export interface BuildRunInfo extends AgentRunState {
  active: boolean
  resumable: boolean
}

export interface DevServerState {
  running: boolean
  url?: string
  port?: number
  projectId?: string
  projectPath?: string
  requiresInstall?: boolean
  startedAt?: number
  error?: string
  previewStarting?: boolean
}

export interface DeployState {
  status: 'idle' | 'building' | 'deploying' | 'success' | 'failed'
  projectId?: string
  buildSucceeded?: boolean
  pushSucceeded?: boolean
  pagesStatus?: 'unknown' | 'pending' | 'available' | 'failed'
  artifactDir?: string
  url?: string
  error?: string
  startedAt?: number
}

export interface DeployConfig {
  token: string
  repoUrl: string
  branch?: string
}

export interface ProjectFile {
  name: string
  path: string
  relativePath: string
  size: number
  lines: number
  language: string
}

export interface BuildFileScanResult {
  files: ProjectFile[]
  totalBytes: number
  truncated: boolean
}

export interface BuildStats {
  files: number
  lines: number
  size: number
  truncated: boolean
}
