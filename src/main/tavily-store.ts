import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs'

export class TavilyStore {
  constructor(private path: string) {}

  getKey(): string {
    if (!existsSync(this.path)) return ''
    try {
      const stored = JSON.parse(readFileSync(this.path, 'utf8')) as { encryptedKey?: string }
      if (stored.encryptedKey && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64'))
      }
      return ''
    } catch { return '' }
  }

  saveKey(apiKey: string): void {
    if (!apiKey.trim()) { this.clearKey(); return }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('تشفير Windows DPAPI غير متاح في هذه الجلسة')
    const encryptedKey = safeStorage.encryptString(apiKey.trim()).toString('base64')
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ encryptedKey }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
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
  }

  clearKey(): void { rmSync(this.path, { force: true }) }
}
