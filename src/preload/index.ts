import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, AppApi, ApprovalRequest, Attachment, ProviderUpdate, CustomProviderUpdate, ApiStyle } from '../shared/types'

const api: AppApi = {
  diagnostics: { runtimeMarker: () => ipcRenderer.invoke('diagnostics:runtimeMarker') },
  updates: { check: () => ipcRenderer.invoke('app:update:check'), install: () => ipcRenderer.invoke('app:update:install') },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (input) => ipcRenderer.invoke('sessions:create', input),
    update: (id, patch) => ipcRenderer.invoke('sessions:update', id, patch),
    remove: (id) => ipcRenderer.invoke('sessions:remove', id),
    clearAll: () => ipcRenderer.invoke('sessions:clearAll'),
    messages: (id) => ipcRenderer.invoke('sessions:messages', id),
    usage: (id) => ipcRenderer.invoke('sessions:usage', id),
    subagents: (id) => ipcRenderer.invoke('sessions:subagents', id),
    setPrompt: (id, prompt) => ipcRenderer.invoke('sessions:setPrompt', id, prompt),
    approvePlan: (id) => ipcRenderer.invoke('sessions:approvePlan', id),
    setTodos: (id, items) => ipcRenderer.invoke('sessions:setTodos', id, items)
    ,run: (id) => ipcRenderer.invoke('sessions:run', id)
    ,checkpoints: (id) => ipcRenderer.invoke('sessions:checkpoints', id)
    ,restoreCheckpoint: (id, checkpointId, mode) => ipcRenderer.invoke('sessions:restoreCheckpoint', id, checkpointId, mode)
  },
  agent: {
    send: (id, text, attachments?: Attachment[]) => ipcRenderer.invoke('agent:send', id, text, attachments),
    resume: (id) => ipcRenderer.invoke('agent:resume', id),
    cancel: (id) => ipcRenderer.invoke('agent:cancel', id),
    states: () => ipcRenderer.invoke('agent:states')
  },
  buildAgent: {
    send: (id, text, attachments?, modelOverride?) => ipcRenderer.invoke('build:agent:send', id, text, attachments, modelOverride),
    cancel: (id) => ipcRenderer.invoke('build:agent:cancel', id),
    resume: (id) => ipcRenderer.invoke('build:agent:resume', id),
    states: () => ipcRenderer.invoke('build:agent:states')
  },
  buildProjects: {
    list: () => ipcRenderer.invoke('build:projects:list'),
    save: (input) => ipcRenderer.invoke('build:projects:save', input),
    remove: (id) => ipcRenderer.invoke('build:projects:remove', id),
    open: (id) => ipcRenderer.invoke('build:projects:open', id),
    clearChat: (id) => ipcRenderer.invoke('build:projects:clearChat', id),
  },
  provider: { get: () => ipcRenderer.invoke('provider:get'), save: (update: ProviderUpdate) => ipcRenderer.invoke('provider:save', update), test: (update: ProviderUpdate) => ipcRenderer.invoke('provider:test', update), clear: () => ipcRenderer.invoke('provider:clear') },
  customProviders: {
    list: () => ipcRenderer.invoke('customProviders:list'),
    save: (input: CustomProviderUpdate & { id?: string }) => ipcRenderer.invoke('customProviders:save', input),
    remove: (id: string) => ipcRenderer.invoke('customProviders:remove', id),
    testModel: (providerId: string, modelId: string) => ipcRenderer.invoke('customProviders:testModel', providerId, modelId),
    testNewModel: (input: { baseUrl: string; apiKey?: string; apiStyle: ApiStyle; modelId: string }) => ipcRenderer.invoke('customProviders:testNewModel', input),
    getModelConfig: (providerId: string, modelId: string) => ipcRenderer.invoke('customProviders:getModelConfig', providerId, modelId),
  },
  tavily: {
    get: () => ipcRenderer.invoke('tavily:get'),
    save: (update: { apiKey: string }) => ipcRenderer.invoke('tavily:save', update),
    clear: () => ipcRenderer.invoke('tavily:clear'),
  },
  files: {
    chooseFolder: () => ipcRenderer.invoke('files:chooseFolder'),
    list: (id, path) => ipcRenderer.invoke('files:list', id, path),
    read: (id, path) => ipcRenderer.invoke('files:read', id, path),
    readAsBase64: (id, path) => ipcRenderer.invoke('files:readAsBase64', id, path)
  },
  approval: { answer: (id, allowed, remember) => ipcRenderer.invoke('approval:answer', id, allowed, remember) },
  buildApproval: { answer: (id, allowed, remember) => ipcRenderer.invoke('build:approval:answer', id, allowed, remember) },
  audit: { list: (limit) => ipcRenderer.invoke('audit:list', limit) },
  clipboard: { writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text) },
  prompts: {
    list: () => ipcRenderer.invoke('prompts:list'),
    add: (title: string, content: string) => ipcRenderer.invoke('prompts:add', title, content),
    remove: (id: string) => ipcRenderer.invoke('prompts:remove', id),
  },
  subagents: {
    list: () => ipcRenderer.invoke('subagents:list'),
    create: (input) => ipcRenderer.invoke('subagents:create', input),
    update: (id: string, input) => ipcRenderer.invoke('subagents:update', id, input),
    remove: (id: string) => ipcRenderer.invoke('subagents:remove', id),
  },
	  events: {
	    onAgent: (callback) => { const listener = (_: unknown, event: AgentEvent) => callback(event); ipcRenderer.on('agent:event', listener); return () => ipcRenderer.removeListener('agent:event', listener) },
	    onApproval: (callback) => { const listener = (_: unknown, request: ApprovalRequest) => callback(request); ipcRenderer.on('approval:request', listener); return () => ipcRenderer.removeListener('approval:request', listener) },
	    onBuildAgent: (callback) => { const listener = (_: unknown, event: AgentEvent) => callback(event); ipcRenderer.on('build:event', listener); return () => ipcRenderer.removeListener('build:event', listener) },
	    onBuildApproval: (callback) => { const listener = (_: unknown, request: ApprovalRequest) => callback(request); ipcRenderer.on('build:approval', listener); return () => ipcRenderer.removeListener('build:approval', listener) },
	    onUpdateAvailable: (callback) => { const listener = (_: unknown, info: { version: string }) => callback(info); ipcRenderer.on('update:available', listener); return () => ipcRenderer.removeListener('update:available', listener) }
	  },
	  scaffold: {
	    templates: () => ipcRenderer.invoke('scaffold:templates'),
	    create: (input: Parameters<AppApi['scaffold']['create']>[0]) => ipcRenderer.invoke('scaffold:create', input),
	  },
	  devserver: {
	    start: (projectId: string) => ipcRenderer.invoke('devserver:start', projectId),
	    stop: (projectId: string) => ipcRenderer.invoke('devserver:stop', projectId),
	    status: (projectId: string) => ipcRenderer.invoke('devserver:status', projectId),
	    installDeps: (projectId: string) => ipcRenderer.invoke('devserver:installDeps', projectId),
	  },
	  deploy: {
	    githubPages: (input: Parameters<AppApi['deploy']['githubPages']>[0]) => ipcRenderer.invoke('deploy:githubPages', input),
	    status: (projectId: string) => ipcRenderer.invoke('deploy:status', projectId),
	  },
	  build: {
	    readFiles: (projectId: string) => ipcRenderer.invoke('build:readFiles', projectId),
	    readFileContent: (projectId: string, relativePath: string) => ipcRenderer.invoke('build:readFileContent', projectId, relativePath),
	    getStats: (projectId: string) => ipcRenderer.invoke('build:getStats', projectId),
	  },
	}

contextBridge.exposeInMainWorld('rCode', api)
