import { promises as fs } from 'node:fs'
import path from 'node:path'

interface Waiter {
  signal: AbortSignal
  resolve(release: () => void): void
  reject(error: Error): void
  onAbort: () => void
}

export class WorkspaceCoordinator {
  private currentRevision = 0
  private locked = false
  private waiters: Waiter[] = []

  constructor(readonly key: string) {}

  get revision(): number { return this.currentRevision }

  advanceRevision(): number { return ++this.currentRevision }

  async acquireMutation(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new DOMException('تم الإلغاء قبل اكتساب قفل التعديل.', 'AbortError')
    if (!this.locked) {
      this.locked = true
      return this.createRelease()
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new DOMException('تم الإلغاء أثناء انتظار قفل التعديل.', 'AbortError'))
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      while (this.waiters.length) {
        const waiter = this.waiters.shift()!
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        if (waiter.signal.aborted) continue
        waiter.resolve(this.createRelease())
        return
      }
      this.locked = false
    }
  }
}

const coordinators = new Map<string, WorkspaceCoordinator>()

export function normalizedWorkspaceKey(workspace: string): string {
  const resolved = path.resolve(workspace)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export async function canonicalWorkspaceKey(workspace: string): Promise<string> {
  return normalizedWorkspaceKey(await fs.realpath(workspace))
}

export async function getWorkspaceCoordinator(workspace: string): Promise<WorkspaceCoordinator> {
  const key = await canonicalWorkspaceKey(workspace)
  let coordinator = coordinators.get(key)
  if (!coordinator) {
    coordinator = new WorkspaceCoordinator(key)
    coordinators.set(key, coordinator)
  }
  return coordinator
}
