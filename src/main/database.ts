import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { calculateCost } from '../shared/models'
import type { AgentRunState, AuditEvent, Attachment, Checkpoint, Message, ModelUsage, Session, Subagent, SubagentEvent, Todo, UsageSummary } from '../shared/types'

export interface StoredMessage extends Message { sequence: number; providerPayload?: unknown[]; archived?: boolean }
export interface SummaryState { text: string; throughSequence: number }
export interface UsageEventInput {
  sessionId: string
  runId?: string
  requestId: string
  messageId?: string
  purpose: 'agent' | 'continuation' | 'compaction' | 'overflow-recovery' | 'subagent'
  model: string
  apiStyle: string
  usage?: ModelUsage
  estimatedInputTokens?: number
}

export interface StepMetricInput {
  runId: string; sessionId: string; step: number; discoveryMs: number; contextMs: number; modelMs: number; firstTokenMs?: number; toolMs: number; totalMs: number
  tools: string[]; model?: string; changedFiles?: number; retries?: number; compactionReason?: string
}

const toolCallsSchema = z.array(z.object({ id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()), todoId: z.string().nullable().optional(), output: z.string().optional(), status: z.enum(['running', 'completed', 'error', 'denied']), startedAt: z.number().finite().optional(), completedAt: z.number().finite().optional() }).passthrough())
const usageSchema = z.object({ input: z.number().finite(), output: z.number().finite(), total: z.number().finite().optional(), cacheRead: z.number().finite().optional(), cacheWrite: z.number().finite().optional(), reasoning: z.number().finite().optional() }).passthrough()
const providerPayloadSchema = z.array(z.unknown())

export class AppDatabase {
  private db: DatabaseSync
  private messageCache = new Map<string, StoredMessage[]>()
  // حد أدنى لعدد الجلسات المخزنة مؤقتًا — الرسائل قد تحمل مرفقات base64 كبيرة
  // (لقطات معاينة وصور)، فسقف مرتفع يضخم الذاكرة في الجلسات الطويلة.
  private static readonly MESSAGE_CACHE_MAX_SIZE = 20

  /** للوصول المباشر لقاعدة البيانات (للأنظمة المساعدة مثل Memory) */
  get rawDb(): DatabaseSync { return this.db }

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // WAL + synchronous=NORMAL: مزيج آمن مع WAL وأسرع في الكتابة من FULL.
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
    this.ensureStepMetricsTable()
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, session_id TEXT, category TEXT NOT NULL, action TEXT NOT NULL,
      detail TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events(created_at DESC);`)
  }

  close(): void {
    // دمج ملف WAL في القاعدة الرئيسية عند الإغلاق حتى لا يتضخم بين الجلسات
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch { /* الإغلاق يستمر */ }
    this.db.close()
  }

  getDb(): DatabaseSync { return this.db }

  private migrate(): void {
    const hasSessions = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get())
    if (!hasSessions) {
      this.createSchema()
      return
    }
    let version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version < 2) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`
          ALTER TABLE sessions ADD COLUMN summary_sequence INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE sessions ADD COLUMN next_message_sequence INTEGER NOT NULL DEFAULT 1;
          CREATE TABLE messages_v2 (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
            tool_call_id TEXT, tool_name TEXT, tool_calls TEXT, provider_payload TEXT, created_at INTEGER NOT NULL,
            UNIQUE(session_id, sequence)
          );
          INSERT INTO messages_v2
            (id, session_id, sequence, role, content, tool_call_id, tool_name, tool_calls, provider_payload, created_at)
          SELECT id, session_id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at, id),
            role, content, tool_call_id, tool_name, tool_calls, NULL, created_at FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_v2 RENAME TO messages;
          CREATE INDEX messages_session_sequence ON messages(session_id, sequence);
          UPDATE sessions SET summary='', summary_sequence=0,
            next_message_sequence=COALESCE((SELECT MAX(sequence)+1 FROM messages WHERE messages.session_id=sessions.id), 1);
          PRAGMA user_version=2;
        `)
        this.db.exec('COMMIT')
        version = 2
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 3) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`
          ALTER TABLE messages ADD COLUMN usage TEXT;
          CREATE TABLE IF NOT EXISTS usage_events (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            run_id TEXT, request_id TEXT NOT NULL UNIQUE, message_id TEXT,
            purpose TEXT NOT NULL, model TEXT NOT NULL, api_style TEXT NOT NULL,
            input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
            cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
            estimated_input_tokens INTEGER, usage_known INTEGER NOT NULL, created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS usage_events_session_time ON usage_events(session_id, created_at DESC);
          PRAGMA user_version=3;
        `)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 4) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec('ALTER TABLE sessions ADD COLUMN git_tracked INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=4;')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 5) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        try { this.db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT') } catch {}
        this.db.exec('PRAGMA user_version=5;')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 6) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        try { this.db.exec('ALTER TABLE sessions ADD COLUMN system_prompt TEXT NOT NULL DEFAULT \'\'') } catch {}
        this.db.exec('PRAGMA user_version=6;')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 7) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        try { this.db.exec('ALTER TABLE sessions ADD COLUMN todos TEXT NOT NULL DEFAULT \'[]\'') } catch {}
        this.db.exec('PRAGMA user_version=7;')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 8) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        try { this.db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT') } catch {}
        this.db.exec('PRAGMA user_version=8;')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 9) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        try { this.db.exec('ALTER TABLE usage_events ADD COLUMN cost REAL NOT NULL DEFAULT 0') } catch {}
        this.db.exec('PRAGMA user_version=9;')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 10) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS subagent_events (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL, description TEXT NOT NULL, state TEXT NOT NULL,
          step INTEGER NOT NULL, tool TEXT, summary TEXT, error TEXT, created_at INTEGER NOT NULL
        ); CREATE INDEX IF NOT EXISTS subagent_events_session_time ON subagent_events(session_id, created_at); PRAGMA user_version=10;`)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 11) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL, status TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT
        ); CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs(status); PRAGMA user_version=11;`)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 12) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN plan_approved INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=12;")
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    if (version < 13) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT; CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_session_id);")
        this.db.exec('PRAGMA user_version=13;')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 14) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec('PRAGMA user_version=14;')
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    if (version < 15) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec('PRAGMA user_version=15; COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    if (version < 16) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS custom_prompts (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
      ); PRAGMA user_version=16;`)
    }
    if (version < 17) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS project_memory (
            id TEXT PRIMARY KEY, workspace TEXT NOT NULL, category TEXT NOT NULL,
            key TEXT NOT NULL, value TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5,
            created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS memory_workspace ON project_memory(workspace, category);
          CREATE INDEX IF NOT EXISTS memory_key ON project_memory(workspace, key);
          PRAGMA user_version=17;
        `)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    this.ensureCheckpointsTable()
    this.ensureSubagentsTable()
    // افحص المراجع القديمة حتى بعد أن تكون قاعدة البيانات قد سجّلت الإصدار 19.
    this.migratePermissionMode()
    this.migrateMessageArchive()
  }

  private migrateMessageArchive(): void {
    const hasMessages = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get())
    if (!hasMessages) return
    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    if (columns.some((column) => column.name === 'archived')) {
      const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      if (version < 20) this.db.exec('PRAGMA user_version=20')
      return
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0; CREATE INDEX IF NOT EXISTS messages_active_sequence ON messages(session_id, archived, sequence); PRAGMA user_version=20;')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private migratePermissionMode(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get() as { sql?: string } | undefined
    if (!row?.sql || row.sql.includes("'read-only'")) {
      this.repairLegacySessionReferencesOnStartup()
      const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      if (version < 19) this.db.exec('PRAGMA user_version=19')
      return
    }

    // SQLite cannot alter a CHECK constraint in place. Rebuild only sessions,
    // preserving every column and leaving all related data intact.
    // ملاحظة: ننسخ إلى sessions_new ثم نعيد التسمية، ولا نستخدم جدولاً مؤقتاً
    // باسم sessions_legacy حتى لا تفشل القواعد التي تخلّفت محاولة سابقة بها.
    this.db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
    try {
      this.repairLegacySessionReferences()
      this.db.exec('DROP TABLE IF EXISTS sessions_legacy; DROP TABLE IF EXISTS sessions_new;')
      this.db.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL,
          permission_mode TEXT NOT NULL DEFAULT 'ask' CHECK(permission_mode IN ('ask','full','read-only')),
          agent_mode TEXT NOT NULL DEFAULT 'build' CHECK(agent_mode IN ('build','plan')),
          summary TEXT NOT NULL DEFAULT '', summary_sequence INTEGER NOT NULL DEFAULT 0,
          next_message_sequence INTEGER NOT NULL DEFAULT 1,
          git_tracked INTEGER NOT NULL DEFAULT 0,
          system_prompt TEXT NOT NULL DEFAULT '',
          todos TEXT NOT NULL DEFAULT '[]', plan_approved INTEGER NOT NULL DEFAULT 0,
          parent_session_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        INSERT INTO sessions_new (id,title,workspace,permission_mode,agent_mode,summary,summary_sequence,next_message_sequence,git_tracked,system_prompt,todos,plan_approved,parent_session_id,created_at,updated_at)
          SELECT id,title,workspace,permission_mode,agent_mode,summary,summary_sequence,next_message_sequence,git_tracked,system_prompt,todos,plan_approved,parent_session_id,created_at,updated_at FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_session_id);
        PRAGMA user_version=19;
      `)
      this.db.exec('COMMIT; PRAGMA foreign_keys=ON')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } finally { this.db.exec('PRAGMA foreign_keys=ON') }
      throw error
    }
  }

  private repairLegacySessionReferencesOnStartup(): void {
    const hasBrokenReferences = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('sessions', 'sessions_legacy') AND sql LIKE '%sessions_legacy%'").get())
    if (!hasBrokenReferences) return
    this.db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE')
    try {
      this.repairLegacySessionReferences()
      this.db.exec('COMMIT; PRAGMA foreign_keys=ON')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } finally { this.db.exec('PRAGMA foreign_keys=ON') }
      throw error
    }
  }

  /** إصلاح الجداول التابعة التي بقيت تشير إلى اسم جدول جلسات من ترحيل فاشل. */
  private repairLegacySessionReferences(): void {
    const tables = this.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('sessions', 'sessions_legacy') AND sql LIKE '%sessions_legacy%'").all() as Array<{ name: string; sql: string }>
    for (const table of tables) {
      const safeName = table.name.replace(/"/g, '""')
      const backupName = `${table.name}_legacy_fk`.replace(/"/g, '""')
      const indexes = this.db.prepare('SELECT name, sql FROM sqlite_master WHERE type=\'index\' AND tbl_name=? AND sql IS NOT NULL').all(table.name) as Array<{ name: string; sql: string }>
      for (const index of indexes) this.db.exec(`DROP INDEX "${index.name.replace(/"/g, '""')}"`)
      this.db.exec(`ALTER TABLE "${safeName}" RENAME TO "${backupName}"`)
      const repairedSql = table.sql.replace(/sessions_legacy/gi, 'sessions')
      this.db.exec(repairedSql)
      const columns = this.db.prepare(`PRAGMA table_info("${backupName}")`).all() as Array<{ name: string }>
      const columnList = columns.map((column) => `"${column.name.replace(/"/g, '""')}"`).join(',')
      this.db.exec(`INSERT INTO "${safeName}" (${columnList}) SELECT ${columnList} FROM "${backupName}"; DROP TABLE "${backupName}"`)
      for (const index of indexes) this.db.exec(index.sql)
    }
  }

  private ensureCheckpointsTable(): void {
    const hasTable = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints'").get())
    if (!hasTable) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec('CREATE TABLE checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, label TEXT NOT NULL, message_snapshot TEXT NOT NULL DEFAULT \'[]\', files_changed TEXT NOT NULL DEFAULT \'[]\', created_at INTEGER NOT NULL)')
        this.db.exec('CREATE INDEX checkpoints_session ON checkpoints(session_id, created_at DESC)')
        this.db.exec('PRAGMA user_version=18')
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
  }

  private ensureSubagentsTable(): void {
    const hasTable = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='subagents'").get())
    if (!hasTable) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`CREATE TABLE IF NOT EXISTS subagents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '#3b82f6',
          model TEXT NOT NULL DEFAULT '',
          system_prompt TEXT NOT NULL DEFAULT '',
          allowed_tools TEXT NOT NULL DEFAULT '*',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );`)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL,
        permission_mode TEXT NOT NULL DEFAULT 'ask' CHECK(permission_mode IN ('ask','full','read-only')),
        agent_mode TEXT NOT NULL DEFAULT 'build' CHECK(agent_mode IN ('build','plan')),
        summary TEXT NOT NULL DEFAULT '', summary_sequence INTEGER NOT NULL DEFAULT 0,
        next_message_sequence INTEGER NOT NULL DEFAULT 1,
        git_tracked INTEGER NOT NULL DEFAULT 0,
        system_prompt TEXT NOT NULL DEFAULT '',
         todos TEXT NOT NULL DEFAULT '[]', plan_approved INTEGER NOT NULL DEFAULT 0,
        parent_session_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        content TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT, tool_calls TEXT,
        provider_payload TEXT, usage TEXT, attachments TEXT, reasoning TEXT, created_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id, sequence)
      );
      CREATE INDEX messages_session_sequence ON messages(session_id, sequence);
      CREATE INDEX messages_active_sequence ON messages(session_id, archived, sequence);
      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT, request_id TEXT NOT NULL UNIQUE, message_id TEXT,
        purpose TEXT NOT NULL, model TEXT NOT NULL, api_style TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_input_tokens INTEGER, usage_known INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE INDEX usage_events_session_time ON usage_events(session_id, created_at DESC);
      CREATE TABLE subagent_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, description TEXT NOT NULL, state TEXT NOT NULL,
        step INTEGER NOT NULL, tool TEXT, summary TEXT, error TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX subagent_events_session_time ON subagent_events(session_id, created_at);
       CREATE TABLE agent_runs (
         session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
         run_id TEXT NOT NULL, status TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
         started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT
       );
       CREATE INDEX agent_runs_status ON agent_runs(status);
       CREATE TABLE project_memory (
         id TEXT PRIMARY KEY, workspace TEXT NOT NULL, category TEXT NOT NULL,
         key TEXT NOT NULL, value TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5,
         created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX memory_workspace ON project_memory(workspace, category);
       CREATE INDEX memory_key ON project_memory(workspace, key);
       CREATE TABLE checkpoints (
         id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
         label TEXT NOT NULL, message_snapshot TEXT NOT NULL DEFAULT '[]',
         files_changed TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
       );
       CREATE INDEX checkpoints_session ON checkpoints(session_id, created_at DESC);
         PRAGMA user_version=20;
    `)
    this.db.exec(`CREATE TABLE IF NOT EXISTS custom_prompts (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
    );`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS subagents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#3b82f6', model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '', allowed_tools TEXT NOT NULL DEFAULT '*',
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`)
  }

  listSessions(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Record<string, unknown>[]).map(mapSession)
  }

  getSession(id: string): Session {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error('المحادثة غير موجودة')
    return mapSession(row)
  }

  createSession(workspace: string, title = 'محادثة جديدة', gitTracked = false): Session {
    const now = Date.now()
    const session: Session = { id: randomUUID(), title, workspace, permissionMode: 'ask', agentMode: 'build', planApproved: false, gitTracked, systemPrompt: '', todos: [], createdAt: now, updatedAt: now }
    this.db.prepare('INSERT INTO sessions (id,title,workspace,permission_mode,agent_mode,summary,summary_sequence,next_message_sequence,git_tracked,system_prompt,todos,plan_approved,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(session.id, title, workspace, 'ask', 'build', '', 0, 1, gitTracked ? 1 : 0, '', '[]', 0, now, now)
    return session
  }

  updateSession(id: string, patch: Partial<Pick<Session, 'title' | 'permissionMode' | 'agentMode'>>): Session {
    const current = this.getSession(id)
    // يُسمح بالتحويل الحر بين Plan وBuild متى شاء المستخدم؛ لا نحاصره بالاعتماد.
    const next = { ...current, ...patch, updatedAt: Date.now() }
    this.db.prepare('UPDATE sessions SET title=?,permission_mode=?,agent_mode=?,updated_at=? WHERE id=?')
      .run(next.title, next.permissionMode, next.agentMode, next.updatedAt, id)
    return next
  }

  approvePlan(id: string): Session {
    const current = this.getSession(id)
    const updatedAt = Date.now()
    this.db.prepare('UPDATE sessions SET plan_approved=1,updated_at=? WHERE id=?').run(updatedAt, id)
    this.addAudit({ sessionId: id, category: 'agent', action: 'plan-approval', detail: 'اعتمد المستخدم خطة العمل قبل الانتقال إلى Build.', outcome: 'allowed' })
    return { ...current, planApproved: true, updatedAt }
  }

  setSystemPrompt(id: string, prompt: string): Session {
    const current = this.getSession(id)
    const next = { ...current, systemPrompt: prompt, updatedAt: Date.now() }
    this.db.prepare('UPDATE sessions SET system_prompt=?, updated_at=? WHERE id=?')
      .run(prompt, next.updatedAt, id)
    return next
  }


  // ─── Subagent CRUD ─────────────────────────────────────────────────

  listSubagents(): Subagent[] {
    return (this.db.prepare('SELECT * FROM subagents ORDER BY created_at').all() as Record<string, unknown>[]).map(mapSubagent)
  }

  getSubagent(id: string): Subagent | null {
    const row = this.db.prepare('SELECT * FROM subagents WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? mapSubagent(row) : null
  }

  getSubagentByName(name: string): Subagent | null {
    const row = this.db.prepare('SELECT * FROM subagents WHERE name=?').get(name) as Record<string, unknown> | undefined
    return row ? mapSubagent(row) : null
  }

  createSubagent(input: Omit<Subagent, 'id' | 'createdAt' | 'updatedAt'>): Subagent {
    const now = Date.now()
    const id = randomUUID()
    this.db.prepare('INSERT INTO subagents (id,name,description,color,model,system_prompt,allowed_tools,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.name, input.description, input.color, input.model, input.systemPrompt, input.allowedTools, input.enabled ? 1 : 0, now, now)
    return { id, ...input, createdAt: now, updatedAt: now }
  }

  updateSubagent(id: string, input: Partial<Omit<Subagent, 'id' | 'createdAt' | 'updatedAt'>>): Subagent {
    const current = this.getSubagent(id)
    if (!current) throw new Error('الوكيل الفرعي غير موجود')
    const next = { ...current, ...input, updatedAt: Date.now() }
    this.db.prepare('UPDATE subagents SET name=?,description=?,color=?,model=?,system_prompt=?,allowed_tools=?,enabled=?,updated_at=? WHERE id=?')
      .run(next.name, next.description, next.color, next.model, next.systemPrompt, next.allowedTools, next.enabled ? 1 : 0, next.updatedAt, id)
    return next
  }

  removeSubagent(id: string): void {
    this.db.prepare('DELETE FROM subagents WHERE id=?').run(id)
  }

  listEnabledSubagents(): Subagent[] {
    return (this.db.prepare('SELECT * FROM subagents WHERE enabled=1 ORDER BY created_at').all() as Record<string, unknown>[]).map(mapSubagent)
  }

  listCustomPrompts(): Array<{ id: string; title: string; content: string; createdAt: number }> {
    return (this.db.prepare('SELECT * FROM custom_prompts ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((row) => ({ id: String(row.id), title: String(row.title), content: String(row.content), createdAt: Number(row.created_at) }))
  }

  addCustomPrompt(title: string, content: string): { id: string; title: string; content: string; createdAt: number } {
    const id = randomUUID()
    const createdAt = Date.now()
    this.db.prepare('INSERT INTO custom_prompts (id, title, content, created_at) VALUES (?, ?, ?, ?)').run(id, title, content, createdAt)
    return { id, title, content, createdAt }
  }

  removeCustomPrompt(id: string): void {
    this.db.prepare('DELETE FROM custom_prompts WHERE id=?').run(id)
  }

  getTodos(sessionId: string): Todo[] {
    const row = this.db.prepare('SELECT todos FROM sessions WHERE id=?').get(sessionId) as { todos?: string } | undefined
    return parseStoredJson(row?.todos, todosSchema) ?? []
  }

  setTodos(sessionId: string, items: Array<{ content: string; status?: Todo['status']; priority?: Todo['priority'] }>): Todo[] {
    const now = Date.now()
    const existing = new Map(this.getTodos(sessionId).map((todo) => [todo.content, todo]))
    const next = items.map((item) => {
      const prior = existing.get(item.content)
      if (prior) return { ...prior, content: item.content, status: item.status ?? prior.status, priority: item.priority ?? prior.priority, updatedAt: now }
      return { id: randomUUID(), content: item.content, status: item.status ?? 'pending', priority: item.priority ?? 'medium', createdAt: now, updatedAt: now }
    })
    this.db.prepare('UPDATE sessions SET todos=?, updated_at=? WHERE id=?').run(JSON.stringify(next), now, sessionId)
    return next
  }

  deleteSession(id: string): void { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); this.messageCache.delete(id) }

  deleteAllSessions(): number {
    const count = (this.db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number }).cnt
    this.db.prepare('DELETE FROM sessions').run()
    this.db.prepare('DELETE FROM audit_events').run()
    this.db.prepare('DELETE FROM custom_prompts').run()
    this.db.prepare('DELETE FROM subagents').run()
    this.db.prepare('DELETE FROM project_memory').run()
    this.messageCache.clear()
    return count
  }

  startAgentRun(sessionId: string, runId: string, startedAt: number): void {
    this.db.prepare(`INSERT INTO agent_runs (session_id,run_id,status,step,started_at,updated_at,error)
      VALUES (?,?, 'running',0,?,?,NULL)
      ON CONFLICT(session_id) DO UPDATE SET run_id=excluded.run_id,status='running',step=0,started_at=excluded.started_at,updated_at=excluded.updated_at,error=NULL`)
      .run(sessionId, runId, startedAt, startedAt)
  }

  updateAgentRun(sessionId: string, runId: string, step: number): void {
    this.db.prepare("UPDATE agent_runs SET step=?,updated_at=? WHERE session_id=? AND run_id=? AND status='running'").run(step, Date.now(), sessionId, runId)
  }

  finishAgentRun(sessionId: string, runId: string, status: AgentRunState['status'], error?: string): void {
    this.db.prepare('UPDATE agent_runs SET status=?,updated_at=?,error=? WHERE session_id=? AND run_id=?').run(status, Date.now(), error ?? null, sessionId, runId)
  }

  markRunningRunsInterrupted(): void {
    this.db.prepare("UPDATE agent_runs SET status='interrupted',updated_at=?,error=? WHERE status='running'").run(Date.now(), 'توقف التطبيق قبل اكتمال التشغيل.')
  }

  getAgentRun(sessionId: string): AgentRunState | undefined {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE session_id=?').get(sessionId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return { sessionId: String(row.session_id), runId: String(row.run_id), status: row.status as AgentRunState['status'], step: Number(row.step), startedAt: Number(row.started_at), updatedAt: Number(row.updated_at), ...(row.error ? { error: String(row.error) } : {}) }
  }

  listMessages(sessionId: string, limit?: number, offset?: number): Message[] {
    return this.listAllStoredMessages(sessionId, limit, offset).map(publicMessage)
  }

  getStoredMessage(sessionId: string, id: string): StoredMessage | undefined {
    // تحسين: استعلام مباشر بدل تحميل كل الرسائل والبحث بـ .find()
    const row = this.db.prepare('SELECT * FROM messages WHERE id=? AND session_id=?').get(id, sessionId) as Record<string, unknown> | undefined
    return row ? mapMessage(row) : undefined
  }

  listStoredMessages(sessionId: string, limit?: number, offset?: number): StoredMessage[] {
    // Pagination: إذا تم تحديد limit/offset، نجلب من قاعدة البيانات مباشرة
    if (limit !== undefined && offset !== undefined) {
      const messages = (this.db.prepare(
        'SELECT * FROM messages WHERE session_id=? AND archived=0 ORDER BY sequence LIMIT ? OFFSET ?'
      ).all(sessionId, limit, offset) as Record<string, unknown>[]).map(mapMessage)
      return messages
    }

    // Full load: استخدم الكاش
    const cached = this.messageCache.get(sessionId)
    if (cached) return cached
    const messages = (this.db.prepare('SELECT * FROM messages WHERE session_id=? AND archived=0 ORDER BY sequence').all(sessionId) as Record<string, unknown>[]).map(mapMessage)
    this.setMessageCache(sessionId, messages)
    return messages
  }

  private ensureStepMetricsTable(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS step_metrics (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      step INTEGER NOT NULL, discovery_ms INTEGER NOT NULL, context_ms INTEGER NOT NULL, model_ms INTEGER NOT NULL,
      first_token_ms INTEGER, tool_ms INTEGER NOT NULL, total_ms INTEGER NOT NULL, tools_count INTEGER NOT NULL,
      tool_names TEXT NOT NULL, model TEXT, changed_files_count INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0,
      compaction_reason TEXT, created_at INTEGER NOT NULL, UNIQUE(run_id, step)
    ); CREATE INDEX IF NOT EXISTS step_metrics_session_step ON step_metrics(session_id, created_at);`)
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version < 21) this.db.exec('PRAGMA user_version=21')
  }

  /** السجل الكامل للواجهة والتدقيق، بما في ذلك الرسائل المؤرشفة بعد الضغط. */
  listAllStoredMessages(sessionId: string, limit?: number, offset = 0): StoredMessage[] {
    if (limit !== undefined) return (this.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY sequence LIMIT ? OFFSET ?').all(sessionId, limit, offset) as Record<string, unknown>[]).map(mapMessage)
    return (this.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY sequence').all(sessionId) as Record<string, unknown>[]).map(mapMessage)
  }

  /** تعيين كاش الرسائل مع تحسين LRU وإدارة الذاكرة (P2-07) */
  private setMessageCache(sessionId: string, messages: StoredMessage[]): void {
    // تحسين LRU: نحذف ثم نعيد الإدراج لتحديث ترتيب الوصول
    if (this.messageCache.has(sessionId)) {
      this.messageCache.delete(sessionId)
      this.messageCache.set(sessionId, messages)
      return
    }
    
    // إخلاء أقدم جلسة إذا تجاوزنا الحد
    while (this.messageCache.size >= AppDatabase.MESSAGE_CACHE_MAX_SIZE) {
      const first = this.messageCache.keys().next().value
      if (first) this.messageCache.delete(first)
      else break
    }
    this.messageCache.set(sessionId, messages)
  }

  /** حذف الرسائل القديمة بعد الضغط لتقليل استهلاك الذاكرة */
  pruneMessagesBefore(sessionId: string, sequence: number): void {
    this.db.prepare('DELETE FROM messages WHERE session_id=? AND sequence<=?').run(sessionId, sequence)
    const cached = this.messageCache.get(sessionId)
    if (cached) {
      // تحسين LRU: نحذف ثم نعيد الإدراج لتحديث ترتيب الوصول
      this.messageCache.delete(sessionId)
      this.messageCache.set(sessionId, cached.filter((m) => m.sequence > sequence))
    }
  }

  /** حذف جميع رسائل جلسة (لاسترجاع checkpoint) */
  clearMessages(sessionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id=?').run(sessionId)
    // تحسين LRU: التأكد من حذف الجلسة من الكاش
    this.messageCache.delete(sessionId)
  }

  clearConversation(sessionId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id=?').run(sessionId)
      this.db.prepare("UPDATE sessions SET summary='',summary_sequence=0,next_message_sequence=1,todos='[]',updated_at=? WHERE id=?").run(Date.now(), sessionId)
      this.db.prepare('DELETE FROM subagent_events WHERE session_id=?').run(sessionId)
      this.db.prepare('DELETE FROM checkpoints WHERE session_id=?').run(sessionId)
      this.db.prepare('DELETE FROM agent_runs WHERE session_id=?').run(sessionId)
      this.db.exec('COMMIT')
      // تحسين LRU: التأكد من حذف الجلسة من الكاش
      this.messageCache.delete(sessionId)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  addMessage(input: Omit<Message, 'id' | 'createdAt'> & Partial<Pick<Message, 'id' | 'createdAt'>> & { providerPayload?: unknown[] }): StoredMessage {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT next_message_sequence FROM sessions WHERE id=?').get(input.sessionId) as { next_message_sequence: number } | undefined
      if (!row) throw new Error('المحادثة غير موجودة')
      const createdAt = input.createdAt ?? Date.now()
      const message: StoredMessage = { ...input, id: input.id ?? randomUUID(), createdAt, sequence: row.next_message_sequence }
      this.db.prepare(`INSERT INTO messages
        (id,session_id,sequence,role,content,reasoning,tool_call_id,tool_name,tool_calls,provider_payload,usage,created_at,attachments)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        message.id, message.sessionId, message.sequence, message.role, message.content, message.reasoning ?? null,
        message.toolCallId ?? null, message.toolName ?? null,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.providerPayload ? JSON.stringify(message.providerPayload) : null,
        message.usage ? JSON.stringify(message.usage) : null, createdAt,
        message.attachments ? JSON.stringify(message.attachments) : null
      )
      this.db.prepare('UPDATE sessions SET next_message_sequence=next_message_sequence+1,updated_at=? WHERE id=?').run(Date.now(), message.sessionId)
      this.db.exec('COMMIT')
      const cached = this.messageCache.get(message.sessionId)
      if (cached) cached.push(message)
      return message
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  completeToolCall(messageId: string, toolCalls: Message['toolCalls'], toolMessage: Omit<Message, 'id' | 'createdAt'>): StoredMessage {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE messages SET tool_calls=? WHERE id=?').run(JSON.stringify(toolCalls ?? []), messageId)
      const row = this.db.prepare('SELECT next_message_sequence FROM sessions WHERE id=?').get(toolMessage.sessionId) as { next_message_sequence: number }
      const message: StoredMessage = { ...toolMessage, id: randomUUID(), createdAt: Date.now(), sequence: row.next_message_sequence }
      this.db.prepare('INSERT INTO messages (id,session_id,sequence,role,content,reasoning,tool_call_id,tool_name,tool_calls,provider_payload,usage,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(message.id, message.sessionId, message.sequence, message.role, message.content, message.reasoning ?? null, message.toolCallId ?? null, message.toolName ?? null, null, null, null, message.createdAt)
      this.db.prepare('UPDATE sessions SET next_message_sequence=next_message_sequence+1,updated_at=? WHERE id=?').run(Date.now(), message.sessionId)
      this.db.exec('COMMIT')
      const cached = this.messageCache.get(message.sessionId)
      if (cached) {
        const assistant = cached.find((item) => item.id === messageId)
        if (assistant) assistant.toolCalls = toolCalls
        cached.push(message)
      }
      return message
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  updateToolCalls(messageId: string, toolCalls: Message['toolCalls']): void {
    this.db.prepare('UPDATE messages SET tool_calls=? WHERE id=?').run(JSON.stringify(toolCalls ?? []), messageId)
    for (const messages of this.messageCache.values()) {
      const message = messages.find((item) => item.id === messageId)
      if (message) { message.toolCalls = toolCalls; break }
    }
  }

  updateToolResult(sessionId: string, toolCallId: string, content: string): void {
    this.db.prepare("UPDATE messages SET content=? WHERE session_id=? AND role='tool' AND tool_call_id=?").run(content, sessionId, toolCallId)
    const message = this.messageCache.get(sessionId)?.find((item) => item.role === 'tool' && item.toolCallId === toolCallId)
    if (message) message.content = content
  }

  repairIncompleteToolCalls(): void {
    // تحسين: تحميل فقط رسائل المساعد من الجلسات النشطة (التي بها run بحالة running)
    // بدلاً من تحميل كل رسائل المساعد من كل الجلسات عند الإقلاع
    // إذا لم توجد جلسات نشطة، نfallback للسلوك الأصلي
    let assistants = this.db.prepare(`
      SELECT m.* FROM messages m
      INNER JOIN agent_runs r ON m.session_id = r.session_id
      WHERE m.role='assistant' AND m.tool_calls IS NOT NULL AND r.status='running'
      ORDER BY m.session_id, m.sequence
    `).all() as Record<string, unknown>[]
    if (!assistants.length) {
      assistants = this.db.prepare("SELECT * FROM messages WHERE role='assistant' AND tool_calls IS NOT NULL ORDER BY session_id,sequence").all() as Record<string, unknown>[]
    }
    for (const row of assistants) {
      const calls = parseStoredJson(row.tool_calls, toolCallsSchema)
      if (!calls) continue
      const existing = new Set((this.db.prepare("SELECT tool_call_id FROM messages WHERE session_id=? AND role='tool' AND sequence>?").all(String(row.session_id), Number(row.sequence)) as Array<{ tool_call_id: string }>).map((item) => item.tool_call_id))
      for (const call of calls.filter((item) => !existing.has(item.id))) {
        call.status = 'error'; call.output = 'توقف التنفيذ السابق قبل تسجيل نتيجة الأداة، ولن يعاد تشغيلها تلقائيًا.'; call.completedAt = Date.now()
        this.completeToolCall(String(row.id), calls, { sessionId: String(row.session_id), role: 'tool', content: call.output, toolCallId: call.id, toolName: call.name })
      }
    }
  }

  getSummary(sessionId: string): SummaryState {
    const row = this.db.prepare('SELECT summary,summary_sequence FROM sessions WHERE id=?').get(sessionId) as { summary: string; summary_sequence: number } | undefined
    return { text: row?.summary ?? '', throughSequence: row?.summary_sequence ?? 0 }
  }

  saveSubagentEvent(sessionId: string, runId: string, event: SubagentEvent): void {
    this.db.prepare(`INSERT INTO subagent_events (id,session_id,run_id,description,state,step,tool,summary,error,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,step=excluded.step,tool=excluded.tool,summary=excluded.summary,error=excluded.error,created_at=excluded.created_at`)
      .run(event.id, sessionId, runId, event.description, event.state, event.step, event.tool ?? null, event.summary ?? null, event.error ?? null, Date.now())
  }

  listSubagentEvents(sessionId: string): SubagentEvent[] {
    const rows = this.db.prepare('SELECT * FROM subagent_events WHERE session_id=? ORDER BY created_at,id').all(sessionId) as Record<string, unknown>[]
    return rows.map((row) => ({ id: String(row.id), runId: String(row.run_id), description: String(row.description), state: row.state as SubagentEvent['state'], step: Number(row.step), ...(row.tool ? { tool: String(row.tool) } : {}), ...(row.summary ? { summary: String(row.summary) } : {}), ...(row.error ? { error: String(row.error) } : {}) }))
  }

  setSummary(sessionId: string, text: string, throughSequence: number, expectedSequence: number): boolean {
    return Number(this.db.prepare('UPDATE sessions SET summary=?,summary_sequence=?,updated_at=? WHERE id=? AND summary_sequence=?').run(text, throughSequence, Date.now(), sessionId, expectedSequence).changes) === 1
  }

  /** لا تؤرشف شيئًا إلا إذا نجح تحديث الملخص المشروط، وكلاهما في معاملة واحدة. */
  setSummaryAndArchive(sessionId: string, text: string, throughSequence: number, expectedSequence: number): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed = Number(this.db.prepare('UPDATE sessions SET summary=?,summary_sequence=?,updated_at=? WHERE id=? AND summary_sequence=?').run(text, throughSequence, Date.now(), sessionId, expectedSequence).changes) === 1
      if (!changed) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.prepare('UPDATE messages SET archived=1 WHERE session_id=? AND sequence<=?').run(sessionId, throughSequence)
      this.db.exec('COMMIT')
      const cached = this.messageCache.get(sessionId)
      if (cached) this.messageCache.set(sessionId, cached.filter((message) => message.sequence > throughSequence))
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  recordUsage(input: UsageEventInput): void {
    const usage = input.usage
    const inputTokens = usage ? Math.max(0, Math.floor(usage.input)) : null
    const outputTokens = usage ? Math.max(0, Math.floor(usage.output)) : null
    const totalTokens = usage ? Math.max(0, Math.floor(usage.total ?? usage.input + usage.output)) : null
    const cost = usage ? calculateCost(input.model, usage) ?? 0 : 0
    this.db.prepare(`INSERT OR IGNORE INTO usage_events
      (id,session_id,run_id,request_id,message_id,purpose,model,api_style,input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,estimated_input_tokens,usage_known,cost,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), input.sessionId, input.runId ?? null, input.requestId, input.messageId ?? null,
      input.purpose, input.model, input.apiStyle, inputTokens, outputTokens, totalTokens,
      usage?.cacheRead ?? null, usage?.cacheWrite ?? null, usage?.reasoning ?? null,
      input.estimatedInputTokens ?? null, usage ? 1 : 0, cost, Date.now()
    )
  }

  getUsageSummary(sessionId: string): UsageSummary {
    const row = this.db.prepare(`SELECT COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN input_tokens ELSE 0 END),0) AS input,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN output_tokens ELSE 0 END),0) AS output,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN total_tokens ELSE 0 END),0) AS total,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN cache_read_tokens ELSE 0 END),0) AS cache_read,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN cache_write_tokens ELSE 0 END),0) AS cache_write,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN reasoning_tokens ELSE 0 END),0) AS reasoning,
      COALESCE(SUM(estimated_input_tokens),0) AS estimated_input,
      COALESCE(SUM(cost),0) AS cost,
      MAX(created_at) AS last_at FROM usage_events WHERE session_id=?`).get(sessionId) as Record<string, unknown>
    return { requests: Number(row.requests), input: Number(row.input), output: Number(row.output), total: Number(row.total), cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write), reasoning: Number(row.reasoning), estimatedInput: Number(row.estimated_input), cost: Number(row.cost), lastAt: row.last_at ? Number(row.last_at) : undefined }
  }

  recordStepMetric(input: StepMetricInput): void {
    this.db.prepare(`INSERT INTO step_metrics (id,run_id,session_id,step,discovery_ms,context_ms,model_ms,first_token_ms,tool_ms,total_ms,tools_count,tool_names,model,changed_files_count,retries,compaction_reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,step) DO UPDATE SET discovery_ms=excluded.discovery_ms,context_ms=excluded.context_ms,model_ms=excluded.model_ms,first_token_ms=excluded.first_token_ms,tool_ms=excluded.tool_ms,total_ms=excluded.total_ms,tools_count=excluded.tools_count,tool_names=excluded.tool_names,model=excluded.model,changed_files_count=excluded.changed_files_count,retries=excluded.retries,compaction_reason=excluded.compaction_reason`)
      .run(randomUUID(), input.runId, input.sessionId, input.step, input.discoveryMs, input.contextMs, input.modelMs, input.firstTokenMs ?? null, input.toolMs, input.totalMs, input.tools.length, JSON.stringify(input.tools), input.model ?? null, input.changedFiles ?? 0, input.retries ?? 0, input.compactionReason ?? null, Date.now())
  }

  listStepMetrics(sessionId: string): StepMetricInput[] {
    return (this.db.prepare('SELECT * FROM step_metrics WHERE session_id=? ORDER BY step').all(sessionId) as Record<string, unknown>[]).map((row) => ({ runId: String(row.run_id), sessionId: String(row.session_id), step: Number(row.step), discoveryMs: Number(row.discovery_ms), contextMs: Number(row.context_ms), modelMs: Number(row.model_ms), ...(row.first_token_ms !== null ? { firstTokenMs: Number(row.first_token_ms) } : {}), toolMs: Number(row.tool_ms), totalMs: Number(row.total_ms), tools: JSON.parse(String(row.tool_names)) as string[], ...(row.model ? { model: String(row.model) } : {}), changedFiles: Number(row.changed_files_count), retries: Number(row.retries), ...(row.compaction_reason ? { compactionReason: String(row.compaction_reason) } : {}) }))
  }

  addAudit(input: Omit<AuditEvent, 'id' | 'createdAt'>): AuditEvent {
    const event: AuditEvent = { ...input, id: randomUUID(), createdAt: Date.now() }
    this.db.prepare('INSERT INTO audit_events (id,session_id,category,action,detail,outcome,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(event.id, event.sessionId ?? null, event.category, event.action, event.detail.slice(0, 20_000), event.outcome, event.createdAt)
    return event
  }

  listAudit(limit = 200): AuditEvent[] {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?').all(Math.min(1000, Math.max(1, limit))) as Record<string, unknown>[]
    return rows.map((row) => ({ id: String(row.id), sessionId: row.session_id ? String(row.session_id) : undefined, category: row.category as AuditEvent['category'], action: String(row.action), detail: String(row.detail), outcome: row.outcome as AuditEvent['outcome'], createdAt: Number(row.created_at) }))
  }

  // ─── Checkpoints ────────────────────────────────────────────────────

  /** إنشاء نقطة تفتيش جديدة */
  createCheckpoint(sessionId: string, label: string, messages: Message[], filesChanged: string[]): Checkpoint {
    const id = randomUUID()
    const now = Date.now()
    const messageSnapshot = JSON.stringify(messages.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })))
    const filesJson = JSON.stringify(filesChanged)
    this.db.prepare('INSERT INTO checkpoints (id, session_id, label, message_snapshot, files_changed, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, sessionId, label, messageSnapshot, filesJson, now)
    // حذف الأقدم إذا تجاوز 100
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM checkpoints WHERE session_id = ?').get(sessionId) as { c: number }).c
    if (count > 100) {
      const toDelete = count - 100
      this.db.prepare('DELETE FROM checkpoints WHERE id IN (SELECT id FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC LIMIT ?)').run(sessionId, toDelete)
    }
    return { id, sessionId, label, messageSnapshot, filesChanged, createdAt: now }
  }

  /** قائمة نقاط التفتيش لجلسة */
  listCheckpoints(sessionId: string, limit = 100): Checkpoint[] {
    const rows = this.db.prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(sessionId, Math.min(100, limit)) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      label: String(row.label),
      messageSnapshot: String(row.message_snapshot),
      filesChanged: JSON.parse(String(row.files_changed)) as string[],
      createdAt: Number(row.created_at),
    }))
  }

  /** جلب نقطة تفتيش واحدة */
  getCheckpoint(checkpointId: string): Checkpoint | undefined {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(checkpointId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      label: String(row.label),
      messageSnapshot: String(row.message_snapshot),
      filesChanged: JSON.parse(String(row.files_changed)) as string[],
      createdAt: Number(row.created_at),
    }
  }

  /** حذف نقطة تفتيش */
  deleteCheckpoint(checkpointId: string): void {
    this.db.prepare('DELETE FROM checkpoints WHERE id = ?').run(checkpointId)
  }

  /** استرجاع رسائل من نقطة تفتيش */
  restoreCheckpointMessages(checkpointId: string): Array<{ id: string; role: string; content: string; createdAt: number }> {
    const cp = this.getCheckpoint(checkpointId)
    if (!cp) return []
    try { return JSON.parse(cp.messageSnapshot) as Array<{ id: string; role: string; content: string; createdAt: number }> } catch { return [] }
  }
}

function mapSession(row: Record<string, unknown>): Session {
  return { id: String(row.id), title: String(row.title), workspace: String(row.workspace), permissionMode: row.permission_mode as Session['permissionMode'], agentMode: row.agent_mode as Session['agentMode'], planApproved: Boolean(row.plan_approved), gitTracked: Boolean(row.git_tracked), systemPrompt: String(row.system_prompt ?? ''), todos: parseStoredJson(row.todos, todosSchema) ?? [], ...(row.parent_session_id ? { parentSessionId: String(row.parent_session_id) } : {}), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
}

function mapSubagent(row: Record<string, unknown>): Subagent {
  return { id: String(row.id), name: String(row.name), description: String(row.description), color: String(row.color), model: String(row.model), systemPrompt: String(row.system_prompt), allowedTools: String(row.allowed_tools), enabled: Boolean(row.enabled), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
}

const attachmentsSchema = z.array(z.object({ name: z.string(), mimeType: z.string(), data: z.string(), size: z.number() }).passthrough())
const todosSchema = z.array(z.object({ id: z.string(), content: z.string(), status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']), priority: z.enum(['high', 'medium', 'low']), createdAt: z.number().finite(), updatedAt: z.number().finite() }).passthrough())

function mapMessage(row: Record<string, unknown>): StoredMessage {
  return { id: String(row.id), sessionId: String(row.session_id), sequence: Number(row.sequence), role: row.role as Message['role'], content: String(row.content), reasoning: row.reasoning ? String(row.reasoning) : undefined, toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined, toolName: row.tool_name ? String(row.tool_name) : undefined, toolCalls: parseStoredJson(row.tool_calls, toolCallsSchema), providerPayload: parseStoredJson(row.provider_payload, providerPayloadSchema), usage: parseStoredJson(row.usage, usageSchema), attachments: parseStoredJson(row.attachments, attachmentsSchema), archived: Boolean(row.archived), createdAt: Number(row.created_at) }
}

function parseStoredJson<T>(value: unknown, schema: z.ZodType<T>): T | undefined {
  if (!value) return undefined
  try { const result = schema.safeParse(JSON.parse(String(value))); return result.success ? result.data : undefined } catch { return undefined }
}

function publicMessage(message: StoredMessage): Message { return { id: message.id, sessionId: message.sessionId, sequence: message.sequence, role: message.role, content: message.content, reasoning: message.reasoning, toolCallId: message.toolCallId, toolName: message.toolName, toolCalls: message.toolCalls?.map((call) => ({ ...call, input: publicToolInput(call.name, call.input) })), usage: message.usage, attachments: message.attachments, createdAt: message.createdAt } }
function publicToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> { if (name === 'write_file' && typeof input.content === 'string') { const { content, ...rest } = input; return { ...rest, contentReceipt: { bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') } } } if (name === 'edit_file') { const result = { ...input }; for (const field of ['old_string', 'new_string'] as const) if (typeof result[field] === 'string' && result[field].length > 2_000) { result[`${field}_receipt`] = { bytes: Buffer.byteLength(result[field]), sha256: createHash('sha256').update(result[field]).digest('hex') }; delete result[field] } return result } return input }
