import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { z } from 'zod'
import type { ProviderConfig, ProviderSettings, ProviderUpdate } from '../shared/types'
import { GO_MODELS, goProviderConfig } from '../shared/models'

const modelIds = new Set(GO_MODELS.map((model) => model.id))
const storedSchema = z.object({ model: z.string(), encryptedKey: z.string().max(65_536).optional(), contextWindow: z.number().int().min(32_000).max(2_000_000).optional() }).passthrough()

export class ProviderStore {
  constructor(private path: string) {}

  get(): ProviderConfig {
    if (!existsSync(this.path)) return goProviderConfig()
    try {
      const stored = storedSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      const apiKey = stored.encryptedKey && safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')) : ''
      const config = goProviderConfig(apiKey, modelIds.has(stored.model) ? stored.model : undefined)
      if (stored.contextWindow) config.contextWindow = stored.model === 'kimi-k2.7-code' && stored.contextWindow === 1_000_000 ? 256_000 : stored.contextWindow
      return config
    } catch (error) {
      console.warn('تعذر قراءة إعداد المزود؛ يستخدم الإعداد الافتراضي:', error instanceof Error ? error.message : String(error))
      return goProviderConfig()
    }
  }

  getSettings(): ProviderSettings { return toSettings(this.get()) }

  getForModel(model: string): ProviderConfig {
    const current = this.get()
    if (!modelIds.has(model)) throw new Error('النموذج المحدد غير معروف')
    const config = goProviderConfig(current.apiKey, model)
    if (current.model === model) config.contextWindow = current.contextWindow
    return config
  }

  resolve(update: ProviderUpdate): ProviderConfig {
    const current = this.get()
    if (!modelIds.has(update.model)) throw new Error('النموذج المحدد غير معروف')
    const config = goProviderConfig(update.apiKey?.trim() ? update.apiKey : current.apiKey, update.model)
    if (update.contextWindow) config.contextWindow = Math.min(2_000_000, Math.max(32_000, Math.floor(update.contextWindow)))
    else if (current.model === update.model) config.contextWindow = current.contextWindow
    return config
  }

  save(update: ProviderUpdate): ProviderSettings {
    const normalized = this.resolve(update)
    if (normalized.apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('تشفير Windows DPAPI غير متاح في هذه الجلسة')
    const encryptedKey = normalized.apiKey ? safeStorage.encryptString(normalized.apiKey).toString('base64') : undefined
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ model: normalized.model, contextWindow: normalized.contextWindow, ...(encryptedKey ? { encryptedKey } : {}) }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const backup = `${this.path}.${process.pid}.bak`
    try {
      if (existsSync(this.path)) renameSync(this.path, backup)
      renameSync(temporary, this.path)
      rmSync(backup, { force: true })
    } catch (error) {
      rmSync(temporary, { force: true })
      if (existsSync(backup) && !existsSync(this.path)) renameSync(backup, this.path)
      throw error
    }
    return toSettings(normalized)
  }

  clear(): ProviderSettings {
    rmSync(this.path, { force: true })
    return toSettings(goProviderConfig())
  }
}

function toSettings(config: ProviderConfig): ProviderSettings {
  const { apiKey, ...settings } = config
  return { ...settings, hasApiKey: Boolean(apiKey) }
}
