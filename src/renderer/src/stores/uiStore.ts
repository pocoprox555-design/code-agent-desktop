/**
 * Zustand Store — UI State (P1-02)
 * يحل محل: sidebarOpen, planOpen, settingsOpen, showLatest, subagentsPage, etc.
 */
import { create } from 'zustand'

interface UIState {
  sidebarOpen: boolean
  planOpen: boolean
  planExpanded: boolean
  planUserClosed: boolean
  showLatest: boolean
  settingsOpen: boolean
  subagentsPage: boolean
  projectFilesOpen: boolean
  promptPanelOpen: boolean
  selectionLoading: boolean
  sessionQuery: string
  appError: string | null
  gitPrompt: { workspace: string } | null

  setSidebarOpen: (open: boolean) => void
  setPlanOpen: (open: boolean) => void
  setPlanExpanded: (expanded: boolean) => void
  setPlanUserClosed: (closed: boolean) => void
  setShowLatest: (show: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setSubagentsPage: (page: boolean) => void
  setProjectFilesOpen: (open: boolean) => void
  setPromptPanelOpen: (open: boolean) => void
  setSelectionLoading: (loading: boolean) => void
  setSessionQuery: (query: string) => void
  setAppError: (error: string | null) => void
  setGitPrompt: (prompt: { workspace: string } | null) => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: typeof window !== 'undefined' ? window.innerWidth > 760 : true,
  planOpen: false,
  planExpanded: false,
  planUserClosed: false,
  showLatest: false,
  settingsOpen: false,
  subagentsPage: false,
  projectFilesOpen: false,
  promptPanelOpen: false,
  selectionLoading: false,
  sessionQuery: '',
  appError: null,
  gitPrompt: null,

  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setPlanOpen: (open) => set({ planOpen: open }),
  setPlanExpanded: (expanded) => set({ planExpanded: expanded }),
  setPlanUserClosed: (closed) => set({ planUserClosed: closed }),
  setShowLatest: (show) => set({ showLatest: show }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setSubagentsPage: (page) => set({ subagentsPage: page }),
  setProjectFilesOpen: (open) => set({ projectFilesOpen: open }),
  setPromptPanelOpen: (open) => set({ promptPanelOpen: open }),
  setSelectionLoading: (loading) => set({ selectionLoading: loading }),
  setSessionQuery: (query) => set({ sessionQuery: query }),
  setAppError: (error) => set({ appError: error }),
  setGitPrompt: (prompt) => set({ gitPrompt: prompt }),
}))
