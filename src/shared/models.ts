import type { ApiStyle, ProviderConfig } from './types'

export type Modality = 'text' | 'image' | 'video' | 'pdf'

export interface GoModel {
  id: string
  name: string
  apiStyle: ApiStyle
  contextWindow: number
  contextSource: 'catalog' | 'official-threshold' | 'conservative'
  modalities: Modality[]
}

export const GO_BASE_URL = 'https://opencode.ai/zen/go/v1/'

export const GO_MODELS: GoModel[] = [
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', apiStyle: 'chat', contextWindow: 262_144, contextSource: 'conservative', modalities: ['text', 'image', 'video'] },
  { id: 'kimi-k3', name: 'Kimi K3', apiStyle: 'chat', contextWindow: 1_048_576, contextSource: 'catalog', modalities: ['text', 'image', 'video'] },
  { id: 'mimo-v2.5', name: 'MiMo V2.5', apiStyle: 'chat', contextWindow: 1_000_000, contextSource: 'catalog', modalities: ['text', 'image', 'video'] },
  { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', apiStyle: 'chat', contextWindow: 1_048_576, contextSource: 'catalog', modalities: ['text'] },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', apiStyle: 'anthropic', contextWindow: 204_800, contextSource: 'catalog', modalities: ['text'] },
  { id: 'minimax-m3', name: 'MiniMax M3', apiStyle: 'anthropic', contextWindow: 1_000_000, contextSource: 'catalog', modalities: ['text', 'image', 'video'] },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', apiStyle: 'anthropic', contextWindow: 1_000_000, contextSource: 'catalog', modalities: ['text', 'image', 'video'] },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', apiStyle: 'anthropic', contextWindow: 1_000_000, contextSource: 'catalog', modalities: ['text'] },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', apiStyle: 'anthropic', contextWindow: 1_000_000, contextSource: 'catalog', modalities: ['text', 'image', 'video'] },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', apiStyle: 'anthropic', contextWindow: 1_000_000, contextSource: 'catalog', modalities: ['text', 'image', 'video'] },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', apiStyle: 'chat', contextWindow: 1_000_000, contextSource: 'catalog', modalities: ['text'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', apiStyle: 'chat', contextWindow: 1_000_000, contextSource: 'catalog', modalities: ['text'] },
  { id: 'glm-5.1', name: 'GLM-5.1', apiStyle: 'chat', contextWindow: 202_752, contextSource: 'catalog', modalities: ['text'] },
  { id: 'glm-5.2', name: 'GLM-5.2', apiStyle: 'chat', contextWindow: 1_000_000, contextSource: 'catalog', modalities: ['text'] },
  { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna', apiStyle: 'responses', contextWindow: 1_050_000, contextSource: 'catalog', modalities: ['text', 'pdf'] },
  { id: 'grok-4.5', name: 'Grok 4.5', apiStyle: 'chat', contextWindow: 500_000, contextSource: 'catalog', modalities: ['image'] },
  { id: 'hy3', name: 'Hy3', apiStyle: 'chat', contextWindow: 256_000, contextSource: 'conservative', modalities: ['text'] },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', apiStyle: 'chat', contextWindow: 262_144, contextSource: 'conservative', modalities: ['image'] },
]

export const DEFAULT_GO_MODEL = GO_MODELS[0]!

export interface ModelCost { input: number; output: number; cacheRead: number; cacheWrite: number }

export const GO_MODEL_COSTS: Record<string, ModelCost> = {
  'kimi-k2.7-code': { input: 0.6, output: 2.5, cacheRead: 0.1, cacheWrite: 0.6 },
  'kimi-k3': { input: 0.6, output: 2.5, cacheRead: 0.1, cacheWrite: 0.6 },
  'kimi-k2.6': { input: 0.6, output: 2.5, cacheRead: 0.1, cacheWrite: 0.6 },
  'mimo-v2.5': { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  'mimo-v2.5-pro': { input: 1.2, output: 4.8, cacheRead: 0.3, cacheWrite: 1.2 },
  'minimax-m2.7': { input: 0.2, output: 1.1, cacheRead: 0.05, cacheWrite: 0.2 },
  'minimax-m3': { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 },
  'qwen3.6-plus': { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  'qwen3.7-max': { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  'qwen3.8-max': { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  'deepseek-v4-flash': { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-v4-pro': { input: 1.2, output: 4.8, cacheRead: 0.3, cacheWrite: 1.2 },
  'glm-5.1': { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  'glm-5.2': { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  'gpt-5.6-luna': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'grok-4.5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.0 },
  'hy3': { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
}

export function modelCost(modelId: string): ModelCost | undefined {
  return GO_MODEL_COSTS[modelId]
}

export function calculateCost(modelId: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number | undefined {
  const cost = modelCost(modelId)
  if (!cost) return undefined
  const input = usage.input ?? 0
  const output = usage.output ?? 0
  const cacheRead = usage.cacheRead ?? 0
  const cacheWrite = usage.cacheWrite ?? 0
  const chargedInput = Math.max(0, input - cacheRead)
  return (chargedInput * cost.input + cacheRead * cost.cacheRead + cacheWrite * cost.cacheWrite + output * cost.output) / 1_000_000
}

export function getGoModel(id: string): GoModel {
  return GO_MODELS.find((model) => model.id === id) ?? DEFAULT_GO_MODEL
}

export function goProviderConfig(apiKey = '', modelId = DEFAULT_GO_MODEL.id): ProviderConfig {
  const model = getGoModel(modelId)
  return {
    name: 'OpenCode Go',
    baseUrl: GO_BASE_URL,
    apiPath: apiPathFor(model.apiStyle),
    apiStyle: model.apiStyle,
    model: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: 131_072,
    apiKey
  }
}

export function apiPathFor(style: ApiStyle): string {
  if (style === 'responses') return 'responses'
  if (style === 'anthropic') return 'messages'
  return 'chat/completions'
}

export function modelSupportsModality(modelId: string, modality: Modality): boolean {
  return getGoModel(modelId).modalities.includes(modality)
}
