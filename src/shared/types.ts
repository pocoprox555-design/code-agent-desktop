export type PermissionMode = 'ask' | 'full'
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
}

export type ProviderSettings = Omit<ProviderConfig, 'apiKey'> & { hasApiKey: boolean }
export interface ProviderUpdate { model: string; apiKey?: string; contextWindow?: number }

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
  createdAt: number
  updatedAt: number
}

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'

export interface ToolCallRecord {
  id: string
  name: string
  input: Record<string, unknown>
  output?: string
  status: 'running' | 'completed' | 'error' | 'denied'
  step?: number
  startedAt?: number
  completedAt?: number
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
  type: 'status' | 'message' | 'tool' | 'error' | 'context' | 'stream' | 'todo' | 'subagent'
  text?: string
  message?: Message
  tool?: ToolCallRecord
  todos?: Todo[]
  subagent?: SubagentEvent
  context?: { estimatedTokens: number; compacted: boolean; contextWindow: number }
  stream?: { id: string; delta: string; state: 'start' | 'delta' | 'done'; reasoning?: boolean }
  usage?: { delta: ModelUsage; estimated: boolean; total: UsageSummary }
}

export interface AppApi {
  sessions: {
    list(): Promise<Session[]>
    create(input: { title?: string; workspace: string; initGit?: boolean }): Promise<Session>
    update(id: string, patch: Partial<Pick<Session, 'title' | 'permissionMode' | 'agentMode'>>): Promise<Session>
    remove(id: string): Promise<void>
    messages(id: string): Promise<Message[]>
    usage(id: string): Promise<UsageSummary>
    subagents(id: string): Promise<SubagentEvent[]>
    setPrompt(id: string, prompt: string): Promise<Session>
    approvePlan(id: string): Promise<Session>
    setTodos(id: string, items: Array<{ content: string; status?: Todo['status']; priority?: Todo['priority'] }>): Promise<Todo[]>
    run(id: string): Promise<AgentRunState | undefined>
  }
  agent: { send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>; resume(sessionId: string): Promise<void>; cancel(sessionId: string): Promise<void>; states(): Promise<SessionRunState[]> }
  provider: { get(): Promise<ProviderSettings>; save(update: ProviderUpdate): Promise<ProviderSettings>; test(update: ProviderUpdate): Promise<string>; clear(): Promise<ProviderSettings> }
  files: { chooseFolder(): Promise<string | null>; list(sessionId: string, path?: string): Promise<TreeEntry[]>; read(sessionId: string, path: string): Promise<string>; readAsBase64(sessionId: string, path: string): Promise<Attachment> }
  approval: { answer(id: string, allowed: boolean, remember?: boolean): Promise<void> }
  audit: { list(limit?: number): Promise<AuditEvent[]> }
  clipboard: { writeText(text: string): Promise<void> }
  events: { onAgent(callback: (event: AgentEvent) => void): () => void; onApproval(callback: (request: ApprovalRequest) => void): () => void }
}
