/**
 * Long-term Memory — ذاكرة طويلة المدى للمشروع
 *
 * يحفظ ويسترجع معلومات عن المشروع عبر الجلسات:
 * - أغراض الملفات
 * - القرارات التقنية
 * - تقاليد المشروع
 * - أخطاء سابقة وحلولها
 *
 * يخزن في SQLite عبر AppDatabase ويُحمّل كجزء من سياق الوكيل.
 *
 * الميزات المحسّنة:
 * - Confidence decay: تخفيض الثقة مع الوقت إذا لم تُستخدم
 * - Category-aware retrieval: إرجاع أفضل حسب التصنيف
 * - Memory verification: تحديث الثقة عند التناقض
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

// ─── Types ───────────────────────────────────────────────────────────

export type MemoryCategory = 'file_purpose' | 'decision' | 'convention' | 'error_fix' | 'architecture' | 'workflow'

export interface MemoryEntry {
  id: string
  workspace: string
  category: MemoryCategory
  key: string
  value: string
  confidence: number
  createdAt: number
  accessedAt: number
  accessCount: number
}

const MAX_MEMORY_PER_WORKSPACE = 1000
const MEMORY_CONTEXT_MAX_CHARS = 8_000
/** بعد 30 يومًا من عدم الاستخدام، يبدأ الثقة بالانخفاض */
const DECAY_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000
/** معدل تخفيض الثقة: 5% كل 30 يومًا */
const DECAY_RATE = 0.05

// ─── ProjectMemory ───────────────────────────────────────────────────

export class ProjectMemory {
  constructor(private db: DatabaseSync) {}

  /** Initialize the memory table (called from migration) */
  initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_memory (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS memory_workspace ON project_memory(workspace, category);
      CREATE INDEX IF NOT EXISTS memory_key ON project_memory(workspace, key);
    `)
    const columns = this.db.prepare('PRAGMA table_info(project_memory)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'last_decay_at')) this.db.exec('ALTER TABLE project_memory ADD COLUMN last_decay_at INTEGER NOT NULL DEFAULT 0')
  }

  /** Save a memory entry (upsert by workspace + category + key) */
  save(workspace: string, category: MemoryCategory, key: string, value: string, confidence = 0.7): MemoryEntry {
    const now = Date.now()
    const normalized = key.trim().toLowerCase().slice(0, 200)
    const existing = this.findByKey(workspace, category, normalized)

    if (existing) {
      const changed = existing.value.trim().toLowerCase() !== value.trim().toLowerCase()
      // أحدث save هو الحقيقة الحالية. عند الاستبدال المتناقض لا نورث ثقة أعلى من القيمة القديمة.
      const newConfidence = changed ? Math.max(0.3, Math.min(0.8, confidence - 0.1)) : Math.min(1, Math.max(existing.confidence, confidence))
      const accessCount = existing.accessCount + 1
      this.db.prepare('UPDATE project_memory SET value=?, confidence=?, accessed_at=?, access_count=? WHERE id=?')
        .run(value, newConfidence, now, accessCount, existing.id)
      return { ...existing, value, confidence: newConfidence, accessedAt: now, accessCount }
    }

    // Insert new
    const id = randomUUID()
    this.db.prepare('INSERT INTO project_memory (id,workspace,category,key,value,confidence,created_at,accessed_at,access_count) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, workspace, category, normalized, value, confidence, now, now, 1)

    // Evict oldest if over limit
    this.evictIfNeeded(workspace)

    return { id, workspace, category, key: normalized, value, confidence, createdAt: now, accessedAt: now, accessCount: 1 }
  }

  /** Get memory entries for a workspace, optionally filtered by category */
  getByWorkspace(workspace: string, category?: MemoryCategory, query?: string, limit = 50): MemoryEntry[] {
    let sql: string
    let params: Array<string | number>

    if (query) {
      const searchTerm = `%${query.toLowerCase().slice(0, 100)}%`
      if (category) {
        sql = 'SELECT * FROM project_memory WHERE workspace=? AND category=? AND (key LIKE ? OR value LIKE ?) ORDER BY confidence DESC, accessed_at DESC LIMIT ?'
        params = [workspace, category, searchTerm, searchTerm, limit]
      } else {
        sql = 'SELECT * FROM project_memory WHERE workspace=? AND (key LIKE ? OR value LIKE ?) ORDER BY confidence DESC, accessed_at DESC LIMIT ?'
        params = [workspace, searchTerm, searchTerm, limit]
      }
    } else if (category) {
      sql = 'SELECT * FROM project_memory WHERE workspace=? AND category=? ORDER BY confidence DESC, accessed_at DESC LIMIT ?'
      params = [workspace, category, limit]
    } else {
      sql = 'SELECT * FROM project_memory WHERE workspace=? ORDER BY confidence DESC, accessed_at DESC LIMIT ?'
      params = [workspace, limit]
    }

    const entries = (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(mapMemoryEntry)
    this.markAccessed(entries)
    return entries.map((entry) => ({ ...entry, accessedAt: Date.now(), accessCount: entry.accessCount + 1 }))
  }

  /** Get a specific memory by key */
  getByKey(workspace: string, key: string, category?: MemoryCategory): MemoryEntry | undefined {
    const entry = category ? this.findByKey(workspace, category, key) : this.findByKeyAnyCategory(workspace, key)
    if (!entry) return undefined
    this.markAccessed([entry])
    return { ...entry, accessedAt: Date.now(), accessCount: entry.accessCount + 1 }
  }

  /** Build context string for the agent (added to system prompt) */
  buildContextString(workspace: string, query?: string): string {
    // تطبيق تخفيض الثقة قبل الإرجاع
    this.applyDecay(workspace)

    let entries: MemoryEntry[] = []
    if (query) {
      const seen = new Set<string>()
      for (const term of query.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu)?.slice(0, 8) ?? []) {
        for (const entry of this.getByWorkspace(workspace, undefined, term, 10)) if (!seen.has(entry.id)) { seen.add(entry.id); entries.push(entry) }
      }
      entries.sort((first, second) => second.confidence - first.confidence || second.accessedAt - first.accessedAt)
      entries = entries.slice(0, 30)
    }
    if (!entries.length) entries = this.getByWorkspace(workspace, undefined, undefined, 30)
    if (!entries.length) return ''

    const lines: string[] = ['Stored project memory:']
    for (const entry of entries) {
      const categoryLabel = CATEGORY_LABELS[entry.category] ?? entry.category
      lines.push(`- [${categoryLabel}] ${entry.key}: ${entry.value.slice(0, 300)}`)
    }

    const result = lines.join('\n')
    return result.length > MEMORY_CONTEXT_MAX_CHARS ? result.slice(0, MEMORY_CONTEXT_MAX_CHARS) + '\n[...تم اختصار الذاكرة]' : result
  }

  /** Delete a specific memory entry */
  delete(workspace: string, id: string): void {
    this.db.prepare('DELETE FROM project_memory WHERE workspace=? AND id=?').run(workspace, id)
  }

  /** Delete all memories for a workspace */
  clearWorkspace(workspace: string): void {
    this.db.prepare('DELETE FROM project_memory WHERE workspace=?').run(workspace)
  }

  /** Get stats for a workspace */
  stats(workspace: string): { total: number; byCategory: Record<string, number> } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM project_memory WHERE workspace=?').get(workspace) as { count: number }).count
    const rows = this.db.prepare('SELECT category, COUNT(*) as count FROM project_memory WHERE workspace=? GROUP BY category').all(workspace) as Array<{ category: string; count: number }>
    const byCategory: Record<string, number> = {}
    for (const row of rows) byCategory[row.category] = row.count
    return { total, byCategory }
  }

  // ─── Private ────────────────────────────────────────────────────

  /** تطبيق تخفيض الثقة على الذاكرة القديمة غير المستخدمة */
  private applyDecay(workspace: string): void {
    const now = Date.now()
    const decayThreshold = now - DECAY_THRESHOLD_MS
    // تخفيض الثقة للentries التي لم تُستخدم منذ 30 يومًا
    this.db.prepare(`
      UPDATE project_memory
      SET confidence = MAX(0.1, confidence - ?), last_decay_at = ?
      WHERE workspace = ? AND accessed_at < ? AND last_decay_at < ? AND confidence > 0.1
    `).run(DECAY_RATE, now, workspace, decayThreshold, decayThreshold)
  }

  private findByKey(workspace: string, category: MemoryCategory, key: string): MemoryEntry | undefined {
    const row = this.db.prepare('SELECT * FROM project_memory WHERE workspace=? AND category=? AND key=?').get(workspace, category, key) as Record<string, unknown> | undefined
    return row ? mapMemoryEntry(row) : undefined
  }

  private findByKeyAnyCategory(workspace: string, key: string): MemoryEntry | undefined {
    const row = this.db.prepare('SELECT * FROM project_memory WHERE workspace=? AND key=? ORDER BY confidence DESC, accessed_at DESC LIMIT 1').get(workspace, key) as Record<string, unknown> | undefined
    return row ? mapMemoryEntry(row) : undefined
  }

  private markAccessed(entries: MemoryEntry[]): void {
    if (!entries.length) return
    const now = Date.now()
    const update = this.db.prepare('UPDATE project_memory SET accessed_at=?, access_count=access_count+1 WHERE id=?')
    for (const entry of entries) update.run(now, entry.id)
  }

  private evictIfNeeded(workspace: string): void {
    const count = (this.db.prepare('SELECT COUNT(*) as count FROM project_memory WHERE workspace=?').get(workspace) as { count: number }).count
    if (count <= MAX_MEMORY_PER_WORKSPACE) return

    const excess = count - MAX_MEMORY_PER_WORKSPACE
    this.db.prepare('DELETE FROM project_memory WHERE workspace=? AND id IN (SELECT id FROM project_memory WHERE workspace=? ORDER BY access_count ASC, accessed_at ASC LIMIT ?)').run(workspace, workspace, excess)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  file_purpose: 'File purpose',
  decision: 'Decision',
  convention: 'Convention',
  error_fix: 'Error & fix',
  architecture: 'Architecture',
  workflow: 'Workflow',
}

function mapMemoryEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    category: String(row.category) as MemoryCategory,
    key: String(row.key),
    value: String(row.value),
    confidence: Number(row.confidence),
    createdAt: Number(row.created_at),
    accessedAt: Number(row.accessed_at),
    accessCount: Number(row.access_count),
  }
}
