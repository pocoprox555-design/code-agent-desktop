import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CustomProvider, CustomProviderSettings, CustomProviderUpdate, CustomModel, ApiStyle } from '../shared/types'

const customModelSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  contextWindow: z.number().int().min(32_000).max(2_000_000),
  maxOutputTokens: z.number().int().min(256).max(1_000_000),
  enabled: z.boolean(),
})

const customProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  apiStyle: z.enum(['chat', 'responses', 'anthropic']),
  models: z.array(customModelSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const storedSchema = z.object({
  providers: z.array(customProviderSchema),
}).passthrough()

export class CustomProviderStore {
  constructor(private path: string) {}

  list(): CustomProviderSettings[] {
    const providers = this.loadProviders()
    return providers.map(toSettings)
  }

  save(input: CustomProviderUpdate & { id?: string }): CustomProviderSettings {
    const providers = this.loadProviders()
    const now = Date.now()
    const existing = input.id ? providers.find((p) => p.id === input.id) : undefined

    if (existing) {
      existing.name = input.name
      existing.baseUrl = input.baseUrl
      existing.apiStyle = input.apiStyle
      if (input.apiKey) existing.apiKey = input.apiKey
      existing.updatedAt = now

      existing.models = input.models.map((m) => {
        const existingModel = existing.models.find((em) => em.modelId === m.modelId)
        return {
          id: existingModel?.id ?? randomUUID(),
          modelId: m.modelId,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          enabled: existingModel?.enabled ?? true,
        }
      })
    } else {
      const newProvider: CustomProvider = {
        id: randomUUID(),
        name: input.name,
        baseUrl: input.baseUrl.replace(/\/+$/, ''),
        apiKey: input.apiKey ?? '',
        apiStyle: input.apiStyle,
        models: input.models.map((m) => ({
          id: randomUUID(),
          modelId: m.modelId,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          enabled: true,
        })),
        createdAt: now,
        updatedAt: now,
      }
      providers.push(newProvider)
    }

    this.saveProviders(providers)
    const saved = existing ?? providers.at(-1)!
    return toSettings(saved)
  }

  remove(id: string): void {
    const providers = this.loadProviders().filter((p) => p.id !== id)
    this.saveProviders(providers)
  }

  getConfig(providerId: string, modelId: string): { baseUrl: string; apiKey: string; apiStyle: ApiStyle; model: string; contextWindow: number; maxOutputTokens: number } | null {
    const provider = this.loadProviders().find((p) => p.id === providerId)
    if (!provider) return null
    const model = provider.models.find((m) => m.id === modelId)
    if (!model) return null
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiStyle: provider.apiStyle,
      model: model.modelId,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    }
  }

  private loadProviders(): CustomProvider[] {
    if (!existsSync(this.path)) return []
    try {
      const stored = storedSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      return stored.providers.map((p) => ({
        ...p,
        apiKey: p.apiKey && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(p.apiKey, 'base64'))
          : '',
      }))
    } catch {
      return []
    }
  }

  private saveProviders(providers: CustomProvider[]): void {
    const encrypted = providers.map((p) => ({
      ...p,
      apiKey: p.apiKey && safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(p.apiKey).toString('base64')
        : undefined,
    }))

    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ providers: encrypted }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const backup = `${this.path}.${process.pid}.bak`
    try {
      if (existsSync(this.path)) renameSync(this.path, backup)
      renameSync(temporary, this.path)
      rmSync(backup, { force: true })
    } catch {
      rmSync(temporary, { force: true })
      if (existsSync(this.path) && !existsSync(backup)) renameSync(backup, this.path)
    }
  }
}

function toSettings(provider: CustomProvider): CustomProviderSettings {
  return { ...provider, hasApiKey: Boolean(provider.apiKey) }
}
