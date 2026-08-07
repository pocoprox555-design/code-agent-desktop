import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, AppApi, ApprovalRequest, Attachment, ProviderUpdate } from '../shared/types'

const api: AppApi = {
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (input) => ipcRenderer.invoke('sessions:create', input),
    update: (id, patch) => ipcRenderer.invoke('sessions:update', id, patch),
    remove: (id) => ipcRenderer.invoke('sessions:remove', id),
    messages: (id) => ipcRenderer.invoke('sessions:messages', id),
    usage: (id) => ipcRenderer.invoke('sessions:usage', id),
    subagents: (id) => ipcRenderer.invoke('sessions:subagents', id),
    setPrompt: (id, prompt) => ipcRenderer.invoke('sessions:setPrompt', id, prompt),
    approvePlan: (id) => ipcRenderer.invoke('sessions:approvePlan', id),
    setTodos: (id, items) => ipcRenderer.invoke('sessions:setTodos', id, items)
    ,run: (id) => ipcRenderer.invoke('sessions:run', id)
  },
  agent: {
    send: (id, text, attachments?: Attachment[]) => ipcRenderer.invoke('agent:send', id, text, attachments),
    resume: (id) => ipcRenderer.invoke('agent:resume', id),
    cancel: (id) => ipcRenderer.invoke('agent:cancel', id),
    states: () => ipcRenderer.invoke('agent:states')
  },
  provider: { get: () => ipcRenderer.invoke('provider:get'), save: (update: ProviderUpdate) => ipcRenderer.invoke('provider:save', update), test: (update: ProviderUpdate) => ipcRenderer.invoke('provider:test', update), clear: () => ipcRenderer.invoke('provider:clear') },
  files: {
    chooseFolder: () => ipcRenderer.invoke('files:chooseFolder'),
    list: (id, path) => ipcRenderer.invoke('files:list', id, path),
    read: (id, path) => ipcRenderer.invoke('files:read', id, path),
    readAsBase64: (id, path) => ipcRenderer.invoke('files:readAsBase64', id, path)
  },
  approval: { answer: (id, allowed, remember) => ipcRenderer.invoke('approval:answer', id, allowed, remember) },
  audit: { list: (limit) => ipcRenderer.invoke('audit:list', limit) },
  clipboard: { writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text) },
  events: {
    onAgent: (callback) => { const listener = (_: unknown, event: AgentEvent) => callback(event); ipcRenderer.on('agent:event', listener); return () => ipcRenderer.removeListener('agent:event', listener) },
    onApproval: (callback) => { const listener = (_: unknown, request: ApprovalRequest) => callback(request); ipcRenderer.on('approval:request', listener); return () => ipcRenderer.removeListener('approval:request', listener) }
  }
}

contextBridge.exposeInMainWorld('rCode', api)
