/**
 * Zustand Store — Session State (P1-02)
 * يحل محل: sessions, activeId, views, runState, cancelledRunIds في App.tsx
 */
import { create } from 'zustand'
import type { AgentRunState, Message, Session, SessionRunState, SubagentEvent, Todo, UsageSummary } from '../../../shared/types'

export type Phase = 'initializing' | 'loading' | 'idle' | 'running' | 'awaiting_approval' | 'stopping' | 'failed' | 'interrupted'

export interface SessionView {
  messages: Message[]
  streamingId: string | null
  phase: Phase
  status: string
  error: string | null
  runId: string | null
  todos: Todo[]
  subagents: SubagentEvent[]
  context: { estimatedTokens: number; compacted: boolean; contextWindow: number }
  usage: UsageSummary
}

const emptyUsage: UsageSummary = { requests: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimatedInput: 0, cost: 0 }

export const emptyView: SessionView = {
  messages: [], streamingId: null, phase: 'idle', status: '', error: null, runId: null,
  todos: [], subagents: [], context: { estimatedTokens: 0, compacted: false, contextWindow: 0 }, usage: emptyUsage,
}

export function upsertMessage(messages: Message[], next: Message): Message[] {
  const index = messages.findIndex((m) => m.id === next.id)
  if (index >= 0) return messages.map((m, i) => i === index ? next : m)
  return [...messages, next]
}

export function upsertSubagent(subagents: SubagentEvent[], next: SubagentEvent): SubagentEvent[] {
  const index = subagents.findIndex((s) => s.id === next.id)
  if (index >= 0) return subagents.map((s, i) => i === index ? next : s)
  return [...subagents, next]
}

export function mergeMessages(dbMessages: Message[], liveMessages: Message[]): Message[] {
  const ids = new Set(liveMessages.map((m) => m.id))
  return [...dbMessages.filter((m) => !ids.has(m.id)), ...liveMessages]
    .sort((a, b) => a.createdAt - b.createdAt)
}

interface SessionState {
  sessions: Session[]
  activeId: string | null
  views: Record<string, SessionView>
  runState: AgentRunState | undefined
  cancelledRunIds: Set<string>

  setSessions: (sessions: Session[] | ((prev: Session[]) => Session[])) => void
  setActiveId: (id: string | null) => void
  updateView: (sessionId: string, updater: (current: SessionView) => SessionView) => void
  setViews: (views: Record<string, SessionView> | ((prev: Record<string, SessionView>) => Record<string, SessionView>)) => void
  setRunState: (state: AgentRunState | undefined) => void
  addCancelledRunId: (runId: string) => void
  applyStates: (states: SessionRunState[]) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeId: null,
  views: {},
  runState: undefined,
  cancelledRunIds: new Set<string>(),

  setSessions: (sessions) => set((s) => ({
    sessions: typeof sessions === 'function' ? sessions(s.sessions) : sessions,
  })),

  setActiveId: (id) => set({ activeId: id }),

  updateView: (sessionId, updater) => set((s) => ({
    views: { ...s.views, [sessionId]: updater(s.views[sessionId] ?? emptyView) },
  })),

  setViews: (views) => set((s) => ({
    views: typeof views === 'function' ? views(s.views) : views,
  })),

  setRunState: (state) => set({ runState: state }),

  addCancelledRunId: (runId) => set((s) => {
    const next = new Set(s.cancelledRunIds)
    next.add(runId)
    return { cancelledRunIds: next }
  }),

  applyStates: (states) => {
    const s = get()
    for (const state of states) {
      s.updateView(state.sessionId, (current) => ({
        ...current,
        runId: state.runId ?? current.runId,
        phase: state.state === 'idle' ? 'idle'
          : state.state === 'failed' ? 'failed'
          : state.state === 'cancelling' ? 'stopping'
          : state.state === 'awaiting_approval' ? 'awaiting_approval'
          : 'running',
        status: state.status,
        error: state.error ?? current.error,
      }))
    }
  },
}))
