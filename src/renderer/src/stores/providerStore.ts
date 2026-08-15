/**
 * Zustand Store — Provider State (P1-02)
 * يحل محل: provider state في App.tsx
 */
import { create } from 'zustand'
import type { ProviderSettings } from '../../../shared/types'
import { goProviderConfig } from '../../../shared/models'

const initialConfig = goProviderConfig()
const defaultProvider: ProviderSettings = {
  name: initialConfig.name,
  baseUrl: initialConfig.baseUrl,
  apiPath: initialConfig.apiPath,
  apiStyle: initialConfig.apiStyle,
  model: initialConfig.model,
  contextWindow: initialConfig.contextWindow,
  maxOutputTokens: initialConfig.maxOutputTokens,
  hasApiKey: false,
}

interface ProviderState {
  provider: ProviderSettings
  setProvider: (p: ProviderSettings | ((prev: ProviderSettings) => ProviderSettings)) => void
}

export const useProviderStore = create<ProviderState>((set) => ({
  provider: defaultProvider,
  setProvider: (p) => set((s) => ({
    provider: typeof p === 'function' ? p(s.provider) : p,
  })),
}))

export { defaultProvider }
