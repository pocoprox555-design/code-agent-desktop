"use strict";
const electron = require("electron");
const path = require("node:path");
const node_fs = require("node:fs");
const node_url = require("node:url");
const zod = require("zod");
const node_sqlite = require("node:sqlite");
const node_crypto = require("node:crypto");
const gptTokenizer = require("gpt-tokenizer");
const node_child_process = require("node:child_process");
const node_readline = require("node:readline");
const promises = require("node:dns/promises");
const node_https = require("node:https");
const node_net = require("node:net");
const GO_BASE_URL = "https://opencode.ai/zen/go/v1/";
const GO_MODELS = [
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", apiStyle: "chat", contextWindow: 262144, contextSource: "conservative", modalities: ["text", "image", "video"] },
  { id: "kimi-k3", name: "Kimi K3", apiStyle: "chat", contextWindow: 1048576, contextSource: "catalog", modalities: ["text", "image", "video"] },
  { id: "mimo-v2.5", name: "MiMo V2.5", apiStyle: "chat", contextWindow: 1e6, contextSource: "catalog", modalities: ["text", "image", "video"] },
  { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", apiStyle: "chat", contextWindow: 1048576, contextSource: "catalog", modalities: ["text"] },
  { id: "minimax-m2.7", name: "MiniMax M2.7", apiStyle: "anthropic", contextWindow: 204800, contextSource: "catalog", modalities: ["text"] },
  { id: "minimax-m3", name: "MiniMax M3", apiStyle: "anthropic", contextWindow: 1e6, contextSource: "catalog", modalities: ["text", "image", "video"] },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus", apiStyle: "anthropic", contextWindow: 1e6, contextSource: "catalog", modalities: ["text", "image", "video"] },
  { id: "qwen3.7-max", name: "Qwen3.7 Max", apiStyle: "anthropic", contextWindow: 1e6, contextSource: "catalog", modalities: ["text"] },
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus", apiStyle: "anthropic", contextWindow: 1e6, contextSource: "catalog", modalities: ["text", "image", "video"] },
  { id: "qwen3.8-max", name: "Qwen3.8 Max", apiStyle: "anthropic", contextWindow: 1e6, contextSource: "catalog", modalities: ["text", "image", "video"] },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", apiStyle: "chat", contextWindow: 1e6, contextSource: "catalog", modalities: ["text"] },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", apiStyle: "chat", contextWindow: 1e6, contextSource: "catalog", modalities: ["text"] },
  { id: "glm-5.1", name: "GLM-5.1", apiStyle: "chat", contextWindow: 202752, contextSource: "catalog", modalities: ["text"] },
  { id: "glm-5.2", name: "GLM-5.2", apiStyle: "chat", contextWindow: 1e6, contextSource: "catalog", modalities: ["text"] },
  { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", apiStyle: "responses", contextWindow: 105e4, contextSource: "catalog", modalities: ["text", "pdf"] },
  { id: "grok-4.5", name: "Grok 4.5", apiStyle: "chat", contextWindow: 5e5, contextSource: "catalog", modalities: ["image"] },
  { id: "hy3", name: "Hy3", apiStyle: "chat", contextWindow: 256e3, contextSource: "conservative", modalities: ["text"] },
  { id: "kimi-k2.6", name: "Kimi K2.6", apiStyle: "chat", contextWindow: 262144, contextSource: "conservative", modalities: ["image"] }
];
const DEFAULT_GO_MODEL = GO_MODELS[0];
const GO_MODEL_COSTS = {
  "kimi-k2.7-code": { input: 0.6, output: 2.5, cacheRead: 0.1, cacheWrite: 0.6 },
  "kimi-k3": { input: 0.6, output: 2.5, cacheRead: 0.1, cacheWrite: 0.6 },
  "kimi-k2.6": { input: 0.6, output: 2.5, cacheRead: 0.1, cacheWrite: 0.6 },
  "mimo-v2.5": { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  "mimo-v2.5-pro": { input: 1.2, output: 4.8, cacheRead: 0.3, cacheWrite: 1.2 },
  "minimax-m2.7": { input: 0.2, output: 1.1, cacheRead: 0.05, cacheWrite: 0.2 },
  "minimax-m3": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 },
  "qwen3.6-plus": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  "qwen3.7-plus": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  "qwen3.7-max": { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  "qwen3.8-max": { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  "deepseek-v4-flash": { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  "deepseek-v4-pro": { input: 1.2, output: 4.8, cacheRead: 0.3, cacheWrite: 1.2 },
  "glm-5.1": { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  "glm-5.2": { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0.8 },
  "gpt-5.6-luna": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "grok-4.5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  "hy3": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 }
};
function modelCost(modelId) {
  return GO_MODEL_COSTS[modelId];
}
function calculateCost(modelId, usage2) {
  const cost = modelCost(modelId);
  if (!cost) return void 0;
  const input = usage2.input ?? 0;
  const output = usage2.output ?? 0;
  const cacheRead = usage2.cacheRead ?? 0;
  const cacheWrite = usage2.cacheWrite ?? 0;
  const chargedInput = Math.max(0, input - cacheRead);
  return (chargedInput * cost.input + cacheRead * cost.cacheRead + cacheWrite * cost.cacheWrite + output * cost.output) / 1e6;
}
function getGoModel(id2) {
  return GO_MODELS.find((model) => model.id === id2) ?? DEFAULT_GO_MODEL;
}
function goProviderConfig(apiKey = "", modelId = DEFAULT_GO_MODEL.id) {
  const model = getGoModel(modelId);
  return {
    name: "OpenCode Go",
    baseUrl: GO_BASE_URL,
    apiPath: apiPathFor(model.apiStyle),
    apiStyle: model.apiStyle,
    model: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: 32e3,
    apiKey
  };
}
function apiPathFor(style) {
  if (style === "responses") return "responses";
  if (style === "anthropic") return "messages";
  return "chat/completions";
}
function modelSupportsModality(modelId, modality) {
  return getGoModel(modelId).modalities.includes(modality);
}
const toolCallsSchema = zod.z.array(zod.z.object({ id: zod.z.string(), name: zod.z.string(), input: zod.z.record(zod.z.string(), zod.z.unknown()), output: zod.z.string().optional(), status: zod.z.enum(["running", "completed", "error", "denied"]), startedAt: zod.z.number().finite().optional(), completedAt: zod.z.number().finite().optional() }).passthrough());
const usageSchema = zod.z.object({ input: zod.z.number().finite(), output: zod.z.number().finite(), total: zod.z.number().finite().optional(), cacheRead: zod.z.number().finite().optional(), cacheWrite: zod.z.number().finite().optional(), reasoning: zod.z.number().finite().optional() }).passthrough();
const providerPayloadSchema = zod.z.array(zod.z.unknown());
class AppDatabase {
  db;
  messageCache = /* @__PURE__ */ new Map();
  constructor(path2) {
    this.db = new node_sqlite.DatabaseSync(path2);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.db.exec(`CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, session_id TEXT, category TEXT NOT NULL, action TEXT NOT NULL,
      detail TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events(created_at DESC);`);
  }
  close() {
    this.db.close();
  }
  migrate() {
    const hasSessions = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get());
    if (!hasSessions) {
      this.createSchema();
      return;
    }
    let version = Number(this.db.prepare("PRAGMA user_version").get().user_version);
    if (version < 2) {
      this.db.exec("BEGIN IMMEDIATE");
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
        `);
        this.db.exec("COMMIT");
        version = 2;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 3) {
      this.db.exec("BEGIN IMMEDIATE");
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
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 4) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN git_tracked INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=4;");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 5) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        try {
          this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
        } catch {
        }
        this.db.exec("PRAGMA user_version=5;");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 6) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        try {
          this.db.exec("ALTER TABLE sessions ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
        } catch {
        }
        this.db.exec("PRAGMA user_version=6;");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 7) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        try {
          this.db.exec("ALTER TABLE sessions ADD COLUMN todos TEXT NOT NULL DEFAULT '[]'");
        } catch {
        }
        this.db.exec("PRAGMA user_version=7;");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 8) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        try {
          this.db.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT");
        } catch {
        }
        this.db.exec("PRAGMA user_version=8;");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 9) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        try {
          this.db.exec("ALTER TABLE usage_events ADD COLUMN cost REAL NOT NULL DEFAULT 0");
        } catch {
        }
        this.db.exec("PRAGMA user_version=9;");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  createSchema() {
    this.db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL,
        permission_mode TEXT NOT NULL DEFAULT 'ask' CHECK(permission_mode IN ('ask','full')),
        agent_mode TEXT NOT NULL DEFAULT 'build' CHECK(agent_mode IN ('build','plan')),
        summary TEXT NOT NULL DEFAULT '', summary_sequence INTEGER NOT NULL DEFAULT 0,
        next_message_sequence INTEGER NOT NULL DEFAULT 1,
        git_tracked INTEGER NOT NULL DEFAULT 0,
        system_prompt TEXT NOT NULL DEFAULT '',
        todos TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
        content TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT, tool_calls TEXT,
        provider_payload TEXT, usage TEXT, attachments TEXT, reasoning TEXT, created_at INTEGER NOT NULL, UNIQUE(session_id, sequence)
      );
      CREATE INDEX messages_session_sequence ON messages(session_id, sequence);
      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT, request_id TEXT NOT NULL UNIQUE, message_id TEXT,
        purpose TEXT NOT NULL, model TEXT NOT NULL, api_style TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_input_tokens INTEGER, usage_known INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE INDEX usage_events_session_time ON usage_events(session_id, created_at DESC);
      PRAGMA user_version=9;
    `);
  }
  listSessions() {
    return this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all().map(mapSession);
  }
  getSession(id2) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id2);
    if (!row) throw new Error("المحادثة غير موجودة");
    return mapSession(row);
  }
  createSession(workspace, title = "محادثة جديدة", gitTracked = false) {
    const now = Date.now();
    const session = { id: node_crypto.randomUUID(), title, workspace, permissionMode: "ask", agentMode: "build", gitTracked, systemPrompt: "", todos: [], createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO sessions (id,title,workspace,permission_mode,agent_mode,summary,summary_sequence,next_message_sequence,git_tracked,system_prompt,todos,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(session.id, title, workspace, "ask", "build", "", 0, 1, gitTracked ? 1 : 0, "", "[]", now, now);
    return session;
  }
  updateSession(id2, patch) {
    const current = this.getSession(id2);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db.prepare("UPDATE sessions SET title=?,permission_mode=?,agent_mode=?,updated_at=? WHERE id=?").run(next.title, next.permissionMode, next.agentMode, next.updatedAt, id2);
    return next;
  }
  setSystemPrompt(id2, prompt) {
    const current = this.getSession(id2);
    const next = { ...current, systemPrompt: prompt, updatedAt: Date.now() };
    this.db.prepare("UPDATE sessions SET system_prompt=?, updated_at=? WHERE id=?").run(prompt, next.updatedAt, id2);
    return next;
  }
  getTodos(sessionId) {
    const row = this.db.prepare("SELECT todos FROM sessions WHERE id=?").get(sessionId);
    return parseStoredJson(row?.todos, todosSchema) ?? [];
  }
  setTodos(sessionId, items) {
    const now = Date.now();
    const existing = new Map(this.getTodos(sessionId).map((todo) => [todo.id, todo]));
    const next = items.map((item) => {
      const prior = existing.get(item.content);
      if (prior) return { ...prior, content: item.content, status: item.status ?? prior.status, priority: item.priority ?? prior.priority, updatedAt: now };
      return { id: node_crypto.randomUUID(), content: item.content, status: item.status ?? "pending", priority: item.priority ?? "medium", createdAt: now, updatedAt: now };
    });
    this.db.prepare("UPDATE sessions SET todos=?, updated_at=? WHERE id=?").run(JSON.stringify(next), now, sessionId);
    return next;
  }
  deleteSession(id2) {
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id2);
    this.messageCache.delete(id2);
  }
  listMessages(sessionId) {
    return this.listStoredMessages(sessionId).map(publicMessage);
  }
  getStoredMessage(sessionId, id2) {
    return this.listStoredMessages(sessionId).find((message) => message.id === id2);
  }
  listStoredMessages(sessionId) {
    const cached = this.messageCache.get(sessionId);
    if (cached) return cached;
    const messages = this.db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY sequence").all(sessionId).map(mapMessage);
    this.messageCache.set(sessionId, messages);
    return messages;
  }
  addMessage(input) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT next_message_sequence FROM sessions WHERE id=?").get(input.sessionId);
      if (!row) throw new Error("المحادثة غير موجودة");
      const createdAt = input.createdAt ?? Date.now();
      const message = { ...input, id: input.id ?? node_crypto.randomUUID(), createdAt, sequence: row.next_message_sequence };
      this.db.prepare(`INSERT INTO messages
        (id,session_id,sequence,role,content,reasoning,tool_call_id,tool_name,tool_calls,provider_payload,usage,created_at,attachments)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        message.id,
        message.sessionId,
        message.sequence,
        message.role,
        message.content,
        message.reasoning ?? null,
        message.toolCallId ?? null,
        message.toolName ?? null,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.providerPayload ? JSON.stringify(message.providerPayload) : null,
        message.usage ? JSON.stringify(message.usage) : null,
        createdAt,
        message.attachments ? JSON.stringify(message.attachments) : null
      );
      this.db.prepare("UPDATE sessions SET next_message_sequence=next_message_sequence+1,updated_at=? WHERE id=?").run(Date.now(), message.sessionId);
      this.db.exec("COMMIT");
      const cached = this.messageCache.get(message.sessionId);
      if (cached) cached.push(message);
      return message;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  completeToolCall(messageId, toolCalls, toolMessage) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE messages SET tool_calls=? WHERE id=?").run(JSON.stringify(toolCalls ?? []), messageId);
      const row = this.db.prepare("SELECT next_message_sequence FROM sessions WHERE id=?").get(toolMessage.sessionId);
      const message = { ...toolMessage, id: node_crypto.randomUUID(), createdAt: Date.now(), sequence: row.next_message_sequence };
      this.db.prepare("INSERT INTO messages (id,session_id,sequence,role,content,reasoning,tool_call_id,tool_name,tool_calls,provider_payload,usage,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(message.id, message.sessionId, message.sequence, message.role, message.content, message.reasoning ?? null, message.toolCallId ?? null, message.toolName ?? null, null, null, null, message.createdAt);
      this.db.prepare("UPDATE sessions SET next_message_sequence=next_message_sequence+1,updated_at=? WHERE id=?").run(Date.now(), message.sessionId);
      this.db.exec("COMMIT");
      const cached = this.messageCache.get(message.sessionId);
      if (cached) {
        const assistant = cached.find((item) => item.id === messageId);
        if (assistant) assistant.toolCalls = toolCalls;
        cached.push(message);
      }
      return message;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  repairIncompleteToolCalls() {
    const assistants = this.db.prepare("SELECT * FROM messages WHERE role='assistant' AND tool_calls IS NOT NULL ORDER BY session_id,sequence").all();
    for (const row of assistants) {
      const calls = parseStoredJson(row.tool_calls, toolCallsSchema);
      if (!calls) continue;
      const existing = new Set(this.db.prepare("SELECT tool_call_id FROM messages WHERE session_id=? AND role='tool' AND sequence>?").all(String(row.session_id), Number(row.sequence)).map((item) => item.tool_call_id));
      for (const call of calls.filter((item) => !existing.has(item.id))) {
        call.status = "error";
        call.output = "توقف التنفيذ السابق قبل تسجيل نتيجة الأداة، ولن يعاد تشغيلها تلقائيًا.";
        call.completedAt = Date.now();
        this.completeToolCall(String(row.id), calls, { sessionId: String(row.session_id), role: "tool", content: call.output, toolCallId: call.id, toolName: call.name });
      }
    }
  }
  getSummary(sessionId) {
    const row = this.db.prepare("SELECT summary,summary_sequence FROM sessions WHERE id=?").get(sessionId);
    return { text: row?.summary ?? "", throughSequence: row?.summary_sequence ?? 0 };
  }
  setSummary(sessionId, text, throughSequence, expectedSequence) {
    return Number(this.db.prepare("UPDATE sessions SET summary=?,summary_sequence=?,updated_at=? WHERE id=? AND summary_sequence=?").run(text, throughSequence, Date.now(), sessionId, expectedSequence).changes) === 1;
  }
  recordUsage(input) {
    const usage2 = input.usage;
    const inputTokens = usage2 ? Math.max(0, Math.floor(usage2.input)) : null;
    const outputTokens = usage2 ? Math.max(0, Math.floor(usage2.output)) : null;
    const totalTokens = usage2 ? Math.max(0, Math.floor(usage2.total ?? usage2.input + usage2.output)) : null;
    const cost = usage2 ? calculateCost(input.model, usage2) ?? 0 : 0;
    this.db.prepare(`INSERT OR IGNORE INTO usage_events
      (id,session_id,run_id,request_id,message_id,purpose,model,api_style,input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,estimated_input_tokens,usage_known,cost,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      node_crypto.randomUUID(),
      input.sessionId,
      input.runId ?? null,
      input.requestId,
      input.messageId ?? null,
      input.purpose,
      input.model,
      input.apiStyle,
      inputTokens,
      outputTokens,
      totalTokens,
      usage2?.cacheRead ?? null,
      usage2?.cacheWrite ?? null,
      usage2?.reasoning ?? null,
      input.estimatedInputTokens ?? null,
      usage2 ? 1 : 0,
      cost,
      Date.now()
    );
  }
  getUsageSummary(sessionId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN input_tokens ELSE 0 END),0) AS input,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN output_tokens ELSE 0 END),0) AS output,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN total_tokens ELSE 0 END),0) AS total,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN cache_read_tokens ELSE 0 END),0) AS cache_read,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN cache_write_tokens ELSE 0 END),0) AS cache_write,
      COALESCE(SUM(CASE WHEN usage_known=1 THEN reasoning_tokens ELSE 0 END),0) AS reasoning,
      COALESCE(SUM(estimated_input_tokens),0) AS estimated_input,
      COALESCE(SUM(cost),0) AS cost,
      MAX(created_at) AS last_at FROM usage_events WHERE session_id=?`).get(sessionId);
    return { requests: Number(row.requests), input: Number(row.input), output: Number(row.output), total: Number(row.total), cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write), reasoning: Number(row.reasoning), estimatedInput: Number(row.estimated_input), cost: Number(row.cost), lastAt: row.last_at ? Number(row.last_at) : void 0 };
  }
  addAudit(input) {
    const event = { ...input, id: node_crypto.randomUUID(), createdAt: Date.now() };
    this.db.prepare("INSERT INTO audit_events (id,session_id,category,action,detail,outcome,created_at) VALUES (?,?,?,?,?,?,?)").run(event.id, event.sessionId ?? null, event.category, event.action, event.detail.slice(0, 2e4), event.outcome, event.createdAt);
    return event;
  }
  listAudit(limit = 200) {
    const rows = this.db.prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").all(Math.min(1e3, Math.max(1, limit)));
    return rows.map((row) => ({ id: String(row.id), sessionId: row.session_id ? String(row.session_id) : void 0, category: row.category, action: String(row.action), detail: String(row.detail), outcome: row.outcome, createdAt: Number(row.created_at) }));
  }
}
function mapSession(row) {
  return { id: String(row.id), title: String(row.title), workspace: String(row.workspace), permissionMode: row.permission_mode, agentMode: row.agent_mode, gitTracked: Boolean(row.git_tracked), systemPrompt: String(row.system_prompt ?? ""), todos: parseStoredJson(row.todos, todosSchema) ?? [], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
const attachmentsSchema = zod.z.array(zod.z.object({ name: zod.z.string(), mimeType: zod.z.string(), data: zod.z.string(), size: zod.z.number() }).passthrough());
const todosSchema = zod.z.array(zod.z.object({ id: zod.z.string(), content: zod.z.string(), status: zod.z.enum(["pending", "in_progress", "completed", "cancelled"]), priority: zod.z.enum(["high", "medium", "low"]), createdAt: zod.z.number().finite(), updatedAt: zod.z.number().finite() }).passthrough());
function mapMessage(row) {
  return { id: String(row.id), sessionId: String(row.session_id), sequence: Number(row.sequence), role: row.role, content: String(row.content), reasoning: row.reasoning ? String(row.reasoning) : void 0, toolCallId: row.tool_call_id ? String(row.tool_call_id) : void 0, toolName: row.tool_name ? String(row.tool_name) : void 0, toolCalls: parseStoredJson(row.tool_calls, toolCallsSchema), providerPayload: parseStoredJson(row.provider_payload, providerPayloadSchema), usage: parseStoredJson(row.usage, usageSchema), attachments: parseStoredJson(row.attachments, attachmentsSchema), createdAt: Number(row.created_at) };
}
function parseStoredJson(value, schema) {
  if (!value) return void 0;
  try {
    const result = schema.safeParse(JSON.parse(String(value)));
    return result.success ? result.data : void 0;
  } catch {
    return void 0;
  }
}
function publicMessage(message) {
  return { id: message.id, sessionId: message.sessionId, sequence: message.sequence, role: message.role, content: message.content, reasoning: message.reasoning, toolCallId: message.toolCallId, toolName: message.toolName, toolCalls: message.toolCalls?.map((call) => ({ ...call, input: publicToolInput(call.name, call.input) })), usage: message.usage, attachments: message.attachments, createdAt: message.createdAt };
}
function publicToolInput(name, input) {
  if (name === "write_file" && typeof input.content === "string") {
    const { content, ...rest } = input;
    return { ...rest, contentReceipt: { bytes: Buffer.byteLength(content), sha256: node_crypto.createHash("sha256").update(content).digest("hex") } };
  }
  if (name === "edit_file") {
    const result = { ...input };
    for (const field of ["old_string", "new_string"]) if (typeof result[field] === "string" && result[field].length > 2e3) {
      result[`${field}_receipt`] = { bytes: Buffer.byteLength(result[field]), sha256: node_crypto.createHash("sha256").update(result[field]).digest("hex") };
      delete result[field];
    }
    return result;
  }
  return input;
}
const modelIds = new Set(GO_MODELS.map((model) => model.id));
const storedSchema = zod.z.object({ model: zod.z.string(), encryptedKey: zod.z.string().max(65536).optional(), contextWindow: zod.z.number().int().min(32e3).max(2e6).optional() }).passthrough();
class ProviderStore {
  constructor(path2) {
    this.path = path2;
  }
  path;
  get() {
    if (!node_fs.existsSync(this.path)) return goProviderConfig();
    try {
      const stored = storedSchema.parse(JSON.parse(node_fs.readFileSync(this.path, "utf8")));
      const apiKey = stored.encryptedKey && electron.safeStorage.isEncryptionAvailable() ? electron.safeStorage.decryptString(Buffer.from(stored.encryptedKey, "base64")) : "";
      const config = goProviderConfig(apiKey, modelIds.has(stored.model) ? stored.model : void 0);
      if (stored.contextWindow) config.contextWindow = stored.model === "kimi-k2.7-code" && stored.contextWindow === 1e6 ? 256e3 : stored.contextWindow;
      return config;
    } catch (error) {
      console.warn("تعذر قراءة إعداد المزود؛ يستخدم الإعداد الافتراضي:", error instanceof Error ? error.message : String(error));
      return goProviderConfig();
    }
  }
  getSettings() {
    return toSettings(this.get());
  }
  resolve(update) {
    const current = this.get();
    if (!modelIds.has(update.model)) throw new Error("النموذج المحدد غير معروف");
    const config = goProviderConfig(update.apiKey?.trim() ? update.apiKey : current.apiKey, update.model);
    if (update.contextWindow) config.contextWindow = Math.min(2e6, Math.max(32e3, Math.floor(update.contextWindow)));
    else if (current.model === update.model) config.contextWindow = current.contextWindow;
    return config;
  }
  save(update) {
    const normalized = this.resolve(update);
    if (normalized.apiKey && !electron.safeStorage.isEncryptionAvailable()) throw new Error("تشفير Windows DPAPI غير متاح في هذه الجلسة");
    const encryptedKey = normalized.apiKey ? electron.safeStorage.encryptString(normalized.apiKey).toString("base64") : void 0;
    const temporary = `${this.path}.${process.pid}.tmp`;
    node_fs.writeFileSync(temporary, JSON.stringify({ model: normalized.model, contextWindow: normalized.contextWindow, ...encryptedKey ? { encryptedKey } : {} }, null, 2), { encoding: "utf8", mode: 384, flag: "wx" });
    const backup = `${this.path}.${process.pid}.bak`;
    try {
      if (node_fs.existsSync(this.path)) node_fs.renameSync(this.path, backup);
      node_fs.renameSync(temporary, this.path);
      node_fs.rmSync(backup, { force: true });
    } catch (error) {
      node_fs.rmSync(temporary, { force: true });
      if (node_fs.existsSync(backup) && !node_fs.existsSync(this.path)) node_fs.renameSync(backup, this.path);
      throw error;
    }
    return toSettings(normalized);
  }
  clear() {
    node_fs.rmSync(this.path, { force: true });
    return toSettings(goProviderConfig());
  }
}
function toSettings(config) {
  const { apiKey, ...settings } = config;
  return { ...settings, hasApiKey: Boolean(apiKey) };
}
class ContextOverflowError extends Error {
}
class DeadlineExceededError extends Error {
}
class ProviderTimeoutError extends Error {
}
class ProviderResponseTooLargeError extends Error {
}
const MAX_CONCURRENT_MODEL_REQUESTS = 2;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const requestSlots = /* @__PURE__ */ new Map();
async function requestModel(config, messages, tools, options = {}) {
  const normalized = options instanceof AbortSignal ? { signal: options } : options;
  const retries = normalized.retries ?? 2;
  let lastError;
  let outputStarted = false;
  const requestOptions = normalized.onTextDelta ? { ...normalized, onTextDelta: (delta) => {
    outputStarted = true;
    normalized.onTextDelta?.(delta);
  } } : normalized;
  const key = normalized.concurrencyKey ?? "global";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      assertDeadline(normalized.deadlineAt);
      await acquireModelRequestSlot(key, normalized.signal, normalized.deadlineAt);
      try {
        return await requestOnce(config, messages, tools, requestOptions);
      } finally {
        releaseModelRequestSlot(key);
      }
    } catch (error) {
      lastError = error;
      if (normalized.signal?.aborted || outputStarted || attempt === retries || !retryable(error)) throw friendlyProviderError(error);
      const remaining = normalized.deadlineAt === void 0 ? Number.POSITIVE_INFINITY : normalized.deadlineAt - Date.now();
      if (remaining <= 1e3) throw new DeadlineExceededError("انتهى الوقت المتاح لطلب المزود");
      const wait = Math.min(retryDelay(error, attempt), remaining - 1e3);
      normalized.onRetry?.(attempt + 1, wait);
      await delay(wait, normalized.signal, normalized.deadlineAt);
    }
  }
  throw lastError;
}
function estimateModelRequestTokens(config, messages, tools, maxOutputTokens = config.maxOutputTokens) {
  const body = config.apiStyle === "chat" ? toChatBody(config, messages, tools, maxOutputTokens) : config.apiStyle === "responses" ? toResponsesBody(config, messages, tools, maxOutputTokens) : toAnthropicBody(config, messages, tools, maxOutputTokens);
  return estimateSerializedTokens(JSON.stringify(body));
}
function estimateSerializedTokens(value) {
  try {
    return Math.max(1, gptTokenizer.countTokens(value));
  } catch {
    let ascii = 0;
    let nonAscii = 0;
    for (let index = 0; index < value.length; index++) {
      if (value.charCodeAt(index) < 128) ascii++;
      else nonAscii++;
    }
    return Math.ceil(ascii / 3.8 + nonAscii / 1.8);
  }
}
function acquireModelRequestSlot(key, signal, deadlineAt) {
  if (signal?.aborted) return Promise.reject(new DOMException("تم إلغاء طلب المزود", "AbortError"));
  assertDeadline(deadlineAt);
  const state = requestSlots.get(key) ?? { active: 0, queue: [] };
  requestSlots.set(key, state);
  if (state.active < MAX_CONCURRENT_MODEL_REQUESTS) {
    state.active++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { signal, deadlineAt, resolve, reject, abort: () => {
    }, settled: false };
    const remove = (error) => {
      if (entry.settled) return;
      entry.settled = true;
      const index = state.queue.indexOf(entry);
      if (index >= 0) state.queue.splice(index, 1);
      if (entry.timer) clearTimeout(entry.timer);
      signal?.removeEventListener("abort", entry.abort);
      reject(error);
    };
    entry.abort = () => remove(new DOMException("تم إلغاء طلب المزود", "AbortError"));
    signal?.addEventListener("abort", entry.abort, { once: true });
    if (deadlineAt !== void 0) entry.timer = setTimeout(() => remove(new DeadlineExceededError("انتهى انتظار دور طلب المزود")), Math.max(1, deadlineAt - Date.now()));
    state.queue.push(entry);
  });
}
function releaseModelRequestSlot(key) {
  const state = requestSlots.get(key);
  if (!state) return;
  state.active = Math.max(0, state.active - 1);
  while (state.queue.length && state.active < MAX_CONCURRENT_MODEL_REQUESTS) {
    const next = state.queue.shift();
    if (next.settled) continue;
    if (next.signal?.aborted) {
      next.abort();
      continue;
    }
    if (next.deadlineAt !== void 0 && next.deadlineAt <= Date.now()) {
      next.abort();
      continue;
    }
    next.settled = true;
    if (next.timer) clearTimeout(next.timer);
    next.signal?.removeEventListener("abort", next.abort);
    state.active++;
    next.resolve();
  }
  if (state.active === 0 && state.queue.length === 0) requestSlots.delete(key);
}
async function requestOnce(config, messages, tools, options) {
  const apiStyle = config.apiStyle;
  const url = new URL(apiPathFor(apiStyle), GO_BASE_URL).toString();
  const headers = { "content-type": "application/json" };
  if (config.apiKey) {
    if (apiStyle === "anthropic") {
      headers["x-api-key"] = config.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else headers.authorization = `Bearer ${config.apiKey}`;
  }
  const maxOutput = options.maxOutputTokens ?? config.maxOutputTokens;
  const body = apiStyle === "chat" ? toChatBody(config, messages, tools, maxOutput) : apiStyle === "responses" ? toResponsesBody(config, messages, tools, maxOutput) : toAnthropicBody(config, messages, tools, maxOutput);
  if (options.onTextDelta) {
    body.stream = true;
    if (apiStyle === "chat") body.stream_options = { include_usage: true };
  }
  const controller = new AbortController();
  let timedOut = false;
  const remaining = options.deadlineAt === void 0 ? Number.POSITIVE_INFINITY : options.deadlineAt - Date.now();
  if (remaining <= 0) throw new DeadlineExceededError("انتهى الوقت المتاح لطلب المزود");
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Math.min(options.timeoutMs ?? 9e4, remaining)));
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!response.ok) {
      const raw2 = await readBoundedBody(response, Math.min(maxResponseBytes, 1e6));
      if (isContextOverflow(response.status, raw2)) throw new ContextOverflowError(`تجاوز الطلب نافذة سياق المزود: ${raw2.slice(0, 1e3)}`);
      throw new ProviderHttpError(response.status, parseRetryAfter(response.headers.get("retry-after-ms"), response.headers.get("retry-after")), `فشل المزود (${response.status}): ${raw2.slice(0, 1e3)}`);
    }
    options.onResponseStarted?.();
    if (options.onTextDelta) return parseEventStream(response, apiStyle, options.onTextDelta, maxResponseBytes, options.onReasoningDelta);
    const raw = await readBoundedBody(response, maxResponseBytes);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("أعاد المزود JSON غير صالح");
    }
    if (apiStyle === "chat") return parseChat(data);
    if (apiStyle === "responses") return parseResponses(data);
    return parseAnthropic(data);
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException("تم إلغاء طلب المزود", "AbortError");
    if (timedOut && options.deadlineAt !== void 0 && Date.now() >= options.deadlineAt) throw new DeadlineExceededError("انتهى الوقت المتاح لطلب المزود");
    if (timedOut) throw new ProviderTimeoutError("انتهت مهلة اتصال المزود");
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ProviderResponseTooLargeError(`استجابة المزود أكبر من الحد (${maxBytes} بايت)`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new ProviderResponseTooLargeError(`استجابة المزود أكبر من الحد (${maxBytes} بايت)`);
      chunks.push(part.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
    reader.releaseLock();
  }
}
async function parseEventStream(response, style, onTextDelta, maxBytes, onReasoningDelta) {
  if (!response.body) throw new Error("المزود لا يدعم بث الاستجابة");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  let eventName = "message";
  let dataLines = [];
  const state = makeStreamState();
  let bytes = 0;
  const flush = () => {
    if (dataLines.length) events.push({ event: eventName, data: dataLines.join("\n") });
    eventName = "message";
    dataLines = [];
  };
  try {
    while (true) {
      const part = await reader.read();
      bytes += part.value?.byteLength ?? 0;
      if (bytes > maxBytes) throw new ProviderResponseTooLargeError(`بث المزود أكبر من الحد (${maxBytes} بايت)`);
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
      const lines = buffer.split(/\r?\n/);
      buffer = part.done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line) {
          flush();
          continue;
        }
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      while (events.length) {
        const item = events.shift();
        if (item.data === "[DONE]") continue;
        let data;
        try {
          data = JSON.parse(item.data);
        } catch {
          continue;
        }
        consumeStreamEvent(style, item.event, data, state, onTextDelta, onReasoningDelta);
      }
      if (part.done) {
        flush();
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
    reader.releaseLock();
  }
  while (events.length) {
    const item = events.shift();
    if (item.data !== "[DONE]") {
      try {
        consumeStreamEvent(style, item.event, JSON.parse(item.data), state, onTextDelta, onReasoningDelta);
      } catch {
      }
    }
  }
  return finishStream(style, state);
}
function makeStreamState() {
  return { text: "", reasoning: "", finishReason: "unknown", chatCalls: /* @__PURE__ */ new Map(), anthropicCalls: /* @__PURE__ */ new Map(), responseCalls: /* @__PURE__ */ new Map(), responseOutput: [] };
}
function consumeStreamEvent(style, event, data, state, onTextDelta, onReasoningDelta) {
  if (style === "chat") {
    const choice = data.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      state.text += delta;
      onTextDelta(delta);
    }
    const reasoningDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
    if (typeof reasoningDelta === "string" && reasoningDelta) {
      state.reasoning += reasoningDelta;
      onReasoningDelta?.(reasoningDelta);
    }
    for (const call of choice?.delta?.tool_calls ?? []) {
      const index = Number(call.index ?? 0);
      const current = state.chatCalls.get(index) ?? { id: "", name: "", arguments: "" };
      current.id += call.id ?? "";
      current.name += call.function?.name ?? "";
      current.arguments += call.function?.arguments ?? "";
      state.chatCalls.set(index, current);
    }
    if (choice?.finish_reason) state.finishReason = mapChatReason(choice.finish_reason);
    if (data.usage) state.usage = usage(data.usage, "prompt_tokens", "completion_tokens");
    return;
  }
  if (style === "anthropic") {
    if (data.type === "content_block_start" && data.content_block?.type === "tool_use") state.anthropicCalls.set(Number(data.index), { id: String(data.content_block.id ?? ""), name: String(data.content_block.name ?? ""), arguments: "" });
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") {
      const delta = String(data.delta.text ?? "");
      state.text += delta;
      onTextDelta(delta);
    }
    if (data.type === "content_block_delta" && data.delta?.type === "thinking_delta") {
      const delta = String(data.delta.thinking ?? "");
      state.reasoning += delta;
      onReasoningDelta?.(delta);
    }
    if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
      const current = state.anthropicCalls.get(Number(data.index));
      if (current) current.arguments += String(data.delta.partial_json ?? "");
    }
    if (data.type === "message_start" && data.message?.usage) state.usage = usage(data.message.usage, "input_tokens", "output_tokens");
    if (data.type === "message_delta") {
      state.finishReason = mapAnthropicReason(data.delta?.stop_reason);
      if (data.usage) state.usage = mergeUsage$1(state.usage, usage(data.usage, "input_tokens", "output_tokens"));
    }
    return;
  }
  const type = data.type ?? event;
  if (type === "response.output_text.delta") {
    const delta = String(data.delta ?? "");
    state.text += delta;
    onTextDelta(delta);
  }
  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    const delta = String(data.delta ?? "");
    state.reasoning += delta;
    onReasoningDelta?.(delta);
  }
  if (type === "response.output_item.added" && data.item?.type === "function_call") state.responseCalls.set(String(data.item.call_id ?? data.item.id ?? data.output_index), { id: String(data.item.call_id ?? ""), name: String(data.item.name ?? ""), arguments: String(data.item.arguments ?? "") });
  if (type === "response.function_call_arguments.delta") {
    const key = String(data.call_id ?? data.item_id ?? data.output_index);
    const current = state.responseCalls.get(key);
    if (current) current.arguments += String(data.delta ?? "");
  }
  if (type === "response.output_item.done" && data.item) {
    state.responseOutput[Number(data.output_index ?? state.responseOutput.length)] = data.item;
    if (data.item.type === "function_call") state.responseCalls.set(String(data.item.call_id ?? data.item.id ?? data.output_index), { id: String(data.item.call_id ?? ""), name: String(data.item.name ?? ""), arguments: String(data.item.arguments ?? "") });
  }
  if (type === "response.completed" && data.response) {
    state.responseOutput = data.response.output ?? state.responseOutput;
    state.usage = usage(data.response.usage, "input_tokens", "output_tokens");
    state.finishReason = state.responseCalls.size ? "tool_calls" : "stop";
  }
  if (type === "response.incomplete") state.finishReason = data.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : "unknown";
  if (type === "response.failed") state.finishReason = "error";
}
function finishStream(style, state) {
  const toolCalls = style === "chat" ? [...state.chatCalls.values()] : style === "anthropic" ? [...state.anthropicCalls.values()] : [...state.responseCalls.values()];
  const finishReason = toolCalls.length ? "tool_calls" : state.finishReason === "unknown" && state.text ? "stop" : state.finishReason;
  const reply = { text: state.text, reasoning: state.reasoning || void 0, toolCalls, finishReason, usage: state.usage };
  if (style === "responses") reply.providerPayload = state.responseOutput.filter(Boolean);
  return reply;
}
function toChatBody(config, messages, tools, maxOutput) {
  return { model: config.model, messages: messages.map(({ providerPayload: _, messageId: __, ...message }) => ({ ...message, content: normalizeChatContent(message.content) })), ...tools.length ? { tools, tool_choice: "auto" } : {}, temperature: 0.2, max_tokens: maxOutput };
}
function normalizeChatContent(content) {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type === "image" && block.source && typeof block.source === "object") {
      const source = block.source;
      return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
    }
    if (block.type === "video" && block.source && typeof block.source === "object") {
      const source = block.source;
      return { type: "video_url", video_url: { url: `data:${source.media_type};base64,${source.data}` } };
    }
    return block;
  });
}
function parseChat(data) {
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error("استجابة Chat لا تحتوي رسالة");
  const message = choice.message;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => ({ id: String(call.id ?? ""), name: String(call.function?.name ?? ""), arguments: String(call.function?.arguments ?? "") })) : [];
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : typeof message.reasoning === "string" ? message.reasoning : void 0;
  return { text: textContent(message.content), reasoning, toolCalls, finishReason: toolCalls.length ? "tool_calls" : mapChatReason(choice.finish_reason), usage: usage(data.usage, "prompt_tokens", "completion_tokens") };
}
function toResponsesBody(config, messages, tools, maxOutput) {
  const input = [];
  for (const message of messages) {
    if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.tool_call_id, output: typeof message.content === "string" ? message.content : JSON.stringify(message.content) });
    else if (message.role === "assistant" && message.providerPayload?.length) input.push(...message.providerPayload);
    else {
      if (message.content) {
        if (typeof message.content === "string") input.push({ role: message.role, content: message.content });
        else input.push({ role: message.role, content: message.content });
      }
      for (const call of message.tool_calls ?? []) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return { model: config.model, input, ...tools.length ? { tools: tools.map((item) => ({ type: "function", name: item.function.name, description: item.function.description, parameters: item.function.parameters })) } : {}, max_output_tokens: maxOutput, store: false };
}
function parseResponses(data) {
  if (!Array.isArray(data.output)) throw new Error("استجابة Responses لا تحتوي output صالحًا");
  const output = data.output;
  const text = typeof data.output_text === "string" ? data.output_text : output.flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
  const reasoning = output.flatMap((item) => item.content ?? []).filter((part) => part.type === "reasoning").map((part) => part.summary?.map((s) => s.text ?? "").join("") ?? part.text ?? "").join("") || (typeof data.reasoning_summary_text === "string" ? data.reasoning_summary_text : void 0);
  const toolCalls = output.filter((item) => item.type === "function_call").map((item) => {
    if (!item.call_id) throw new Error("استدعاء Responses بلا call_id");
    return { id: String(item.call_id), name: String(item.name ?? ""), arguments: String(item.arguments ?? "") };
  });
  let finishReason = toolCalls.length ? "tool_calls" : data.status === "completed" ? "stop" : data.status === "cancelled" ? "cancelled" : data.status === "failed" ? "error" : "unknown";
  if (data.incomplete_details?.reason === "max_output_tokens") finishReason = "length";
  if (data.incomplete_details?.reason === "content_filter") finishReason = "content_filter";
  return { text, reasoning, toolCalls, finishReason, providerPayload: output, usage: usage(data.usage, "input_tokens", "output_tokens") };
}
function toAnthropicBody(config, messages, tools, maxOutput) {
  const systemMessages = messages.filter((message) => message.role === "system");
  const systemBlocks = systemMessages.map((message) => ({ type: "text", text: typeof message.content === "string" ? message.content : message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") }));
  if (systemBlocks.length) systemBlocks.at(-1).cache_control = { type: "ephemeral" };
  const output = [];
  for (const message of messages.filter((item) => item.role !== "system")) {
    if (message.role === "tool") {
      const content2 = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      output.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: content2, is_error: content2.includes('"ok": false') || content2.startsWith("خطأ:") }] });
      continue;
    }
    const content = [];
    if (message.content) {
      if (typeof message.content === "string") content.push({ type: "text", text: message.content });
      else {
        for (const block of message.content) {
          if (block.type === "image" && block.source && typeof block.source === "object") {
            const source = block.source;
            content.push({ type: "image", source: { type: "base64", media_type: source.media_type, data: source.data } });
          } else if (block.type === "video" && block.source && typeof block.source === "object") {
            const source = block.source;
            content.push({ type: "video", source: { type: "base64", media_type: source.media_type, data: source.data } });
          } else if (block.type === "text") content.push({ type: "text", text: block.text ?? "" });
          else content.push(block);
        }
      }
    }
    for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
    output.push({ role: message.role, content });
  }
  const merged = mergeAnthropicMessages(output);
  const lastMessage = merged.at(-1);
  const lastBlock = lastMessage?.content.at(-1);
  if (lastBlock && typeof lastBlock === "object") lastBlock.cache_control = { type: "ephemeral" };
  return { model: config.model, ...systemBlocks.length ? { system: systemBlocks } : {}, messages: merged, ...tools.length ? { tools: tools.map((item) => ({ name: item.function.name, description: item.function.description, input_schema: item.function.parameters })) } : {}, max_tokens: maxOutput, temperature: 0.2 };
}
function parseAnthropic(data) {
  if (!Array.isArray(data.content)) throw new Error("استجابة Anthropic لا تحتوي content صالحًا");
  const toolCalls = data.content.filter((part) => part.type === "tool_use").map((part) => ({ id: String(part.id ?? ""), name: String(part.name ?? ""), arguments: JSON.stringify(part.input ?? {}) }));
  const reasoning = data.content.filter((part) => part.type === "thinking").map((part) => String(part.thinking ?? "")).join("");
  return { text: data.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(""), reasoning: reasoning || void 0, toolCalls, finishReason: toolCalls.length ? "tool_calls" : mapAnthropicReason(data.stop_reason), usage: usage(data.usage, "input_tokens", "output_tokens") };
}
function mergeAnthropicMessages(messages) {
  const result = [];
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [message.content];
    const previous = result.at(-1);
    if (previous?.role === message.role) previous.content.push(...content);
    else result.push({ role: message.role, content: [...content] });
  }
  return result;
}
class ProviderHttpError extends Error {
  constructor(status, retryAfterMs, message) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
  status;
  retryAfterMs;
}
function retryable(error) {
  return !(error instanceof ContextOverflowError) && (error instanceof ProviderTimeoutError || error instanceof ProviderHttpError && [408, 409, 429, 500, 502, 503, 504, 529].includes(error.status) || error instanceof TypeError || /(?:terminated|socket|connection.*closed|other side closed)/i.test(error instanceof Error ? error.message : String(error)));
}
function friendlyProviderError(error) {
  const technical = error instanceof Error ? error.message : String(error);
  if (/(?:terminated|socket|connection.*closed|other side closed)/i.test(technical)) return new Error(`انقطع اتصال المزود قبل اكتمال الرد بعد إعادة المحاولة. أرسل الرسالة مرة أخرى. (تفاصيل فنية: ${technical.slice(0, 500)})`);
  return error;
}
function retryDelay(error, attempt) {
  if (error instanceof ProviderHttpError && error.retryAfterMs !== void 0) return Math.min(3e4, error.retryAfterMs);
  return Math.min(1e4, 500 * 2 ** attempt + Math.random() * 250);
}
function parseRetryAfter(milliseconds, value) {
  if (milliseconds) {
    const parsed = Number(milliseconds);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  if (!value) return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
  const date = Date.parse(value);
  return Number.isNaN(date) ? void 0 : Math.max(0, date - Date.now());
}
function isContextOverflow(status, body) {
  const value = body.toLowerCase();
  if (/(?:rate limit|too many requests|throttl)/i.test(value)) return false;
  return [400, 413, 422].includes(status) && (status === 413 || /(?:prompt is too long|request_too_large|input is too long|exceeds the context window|maximum context length|context_length_exceeded|model_context_window_exceeded|too many tokens|token limit exceeded|reduce the length of the messages|tokens in request more than max tokens allowed)/i.test(value));
}
function delay(ms, signal, deadlineAt) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const deadline = deadlineAt === void 0 ? void 0 : setTimeout(() => {
      clearTimeout(timer);
      cleanup();
      reject(new DeadlineExceededError("انتهى الوقت المتاح لطلب المزود"));
    }, Math.max(1, deadlineAt - Date.now()));
    const abort = () => {
      clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
      cleanup();
      reject(new DOMException("تم الإلغاء", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function mapChatReason(value) {
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  if (value === "tool_calls") return "tool_calls";
  return "unknown";
}
function mapAnthropicReason(value) {
  if (value === "end_turn" || value === "stop_sequence") return "stop";
  if (value === "max_tokens") return "length";
  if (value === "refusal") return "content_filter";
  if (value === "tool_use") return "tool_calls";
  return "unknown";
}
function textContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
  return "";
}
function usage(data, input, output) {
  if (!data) return void 0;
  const inputTokens = finiteNumber(data[input]);
  const outputTokens = finiteNumber(data[output]);
  const cacheRead = finiteNumber(data.cache_read_input_tokens ?? data[input === "prompt_tokens" ? "prompt_tokens_details" : "input_tokens_details"]?.cached_tokens);
  const cacheWrite = finiteNumber(data.cache_creation_input_tokens);
  const reasoning = finiteNumber(data.completion_tokens_details?.reasoning_tokens ?? data.output_tokens_details?.reasoning_tokens);
  return { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, ...cacheRead ? { cacheRead } : {}, ...cacheWrite ? { cacheWrite } : {}, ...reasoning ? { reasoning } : {} };
}
function mergeUsage$1(first, second) {
  if (!first) return second;
  if (!second) return first;
  return { input: second.input || first.input, output: second.output || first.output, total: second.total ?? first.total, cacheRead: second.cacheRead ?? first.cacheRead, cacheWrite: second.cacheWrite ?? first.cacheWrite, reasoning: second.reasoning ?? first.reasoning };
}
function finiteNumber(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}
function parseArguments(value) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("مدخل الأداة ليس object");
  return parsed;
}
function assertDeadline(deadlineAt) {
  if (deadlineAt !== void 0 && deadlineAt <= Date.now()) throw new DeadlineExceededError("انتهى الوقت المتاح لطلب المزود");
}
const MAX_READ_LINES = 2e3;
const MAX_OUTPUT_BYTES = 1e5;
const MAX_SEARCH_RESULTS = 500;
const MAX_GLOB_RESULTS = 2e3;
const toolDefinitions = [
  tool("read_file", "اقرأ ملفًا نصيًا مع أرقام الأسطر وإجمالي عدد الأسطر. استخدم offset وlimit للملفات الكبيرة.", { path: str("مسار الملف"), offset: integer("أول سطر، يبدأ من 1", 1), limit: integer("عدد الأسطر، أقصاه 2000", 1, MAX_READ_LINES) }, ["path"]),
  tool("read_files", "اقرأ عدة ملفات نصية كاملة في استدعاء واحد. تعيد nextCursor فقط إذا لم تتسع كل الملفات.", { paths: str("مسارات مفصولة بأسطر جديدة"), path: str("مجلد البداية"), include: str("glob مثل **/*.java"), cursor: str("مؤشر متابعة تعيده الأداة"), max_files: integer("أقصى ملفات في الدفعة", 1, 100) }, []),
  tool("read_message", "استرجع رسالة سابقة كاملة من سجل هذه الجلسة بمعرّفها id. تُستخدم لاستعادة محتوى أو نتيجة أداة ضُغطت في سياق سابق.", { id: str("معرّف الرسالة كما يظهر في السجل") }, ["id"]),
  tool("load_skill", "حمّل مهارة (Skill) من مجلد .skills أو .opencode/skills أو skills في مساحة العمل بقراءة SKILL.md. تُستخدم لمهام متخصصة مثل مراجعة الكود، البحث العميق، إنشاء الوثائق، أو أي إجراء موثّق بخطوات. أعد النص الكامل للمهارة مع وصفها.", { name: str("اسم المهارة (اسم مجلدها)"), max_chars: integer("حد أقصى للأحرف", 1e3, 1e5) }, ["name"]),
  tool("task", "أطلق وكيلًا فرعيًا مستقلاً يعمل في سياق منفصل تمامًا عن محادثتك (لا يشارك سياقك ولا يلوّثه). مثالي للمشاريع الضخمة: فكّر في تقسيم عملك إلى مهام متوازية أو متسلسلة لكل منها هدف واضح — يفهم الوكلاء الفرعيون وحدات المشروع، ويتتبعون دوالًا عبر ملفات متعددة، ويراجعون مجلدات كاملة، ويبحثون ويحللون، ثم يعيدون خلاصة مركزة منظمة فقط. أنت كمشرف تبقى مسؤولًا عن دقة النتيجة، فاصنع المهام بدقة، وأدمج الخلاصات، وطبّق قراراتك بنفسك.", { prompt: str("المهمة الكاملة بالتفصيل: ما التحليل المطلوب، الملفات/المجلدات المستهدفة، الأسئلة الدقيقة التي يجب الإجابة عنها، ومواصفات الخلاصة المطلوبة"), description: str("وصف مختصر (سطر واحد) يظهر للمستخدم") }, ["prompt", "description"]),
  tool("task_parallel", "أطلق عدة وكلاء فرعيين متوازيين في سياقات مستقلة تمامًا، كلٌّ يعمل على جزء منفصل من المهمة ولا يرى محادثتك. مثالي للمشاريع الضخمة: قسّم التحليل إلى مهام مستقلة (كل وحدة/مجلد/سؤال منفصل) وأطلِقها معًا لتسريع الفحص، ثم ادمج خلاصاتهم واتخذ القرار النهائي بنفسك. الحد الأقصى 5 مهام في الاستدعاء، ويعمل عدد منها بالتوازي بأمان دون إجهاد المزود.", { tasks: str("مصفوفة JSON من المهام، كل منها: {prompt, description} — حتى 5 مهام") }, ["tasks"]),
  tool("todo_write", "حدّث خطة العمل (Todos) لهذه الجلسة. استدعِها أولًا قبل تنفيذ مهمة متعددة الخطوات، وحدّثها بعد كل خطوة. items مصفوفة JSON كاملة تحل محل القائمة السابقة.", { items: str("مصفوفة JSON من المهام: [{content, status: pending|in_progress|completed|cancelled, priority: high|medium|low}]") }, ["items"]),
  tool("todo_read", "اقرأ خطة العمل (Todos) الحالية لهذه الجلسة.", {}, []),
  tool("run_command", "نفّذ أمرًا معرفًا (Slash Command) من ملف commands.json في مساحة العمل. يستبدل القالب بالوسائط المعطاة ويعيد النص الناتج لتنفيذه. استخدمه عندما يطلب المستخدم أمرًا معرفًا مثل /review أو /test أو /init.", { name: str("اسم الأمر"), arguments: str("الوسائط (اختياري)") }, ["name"]),
  tool("count_lines", "احسب عدد أسطر ملف نصي أو مجلد بالكامل. يدعم مجلدات recursion ويحصّل كل ملفات نصية.", { path: str("مسار الملف أو المجلد"), include: str("glob مثل *.java أو *.xml لتصفيتها") }, ["path"]),
  tool("list_directory", "اعرض محتويات مجلد.", { path: str("المجلد، الافتراضي الجذر"), limit: integer("أقصى عدد عناصر", 1, 1e3) }, []),
  tool("glob_files", "ابحث عن ملفات بنمط glob مثل **/*.ts.", { path: str("مجلد البداية، الافتراضي الجذر"), pattern: str("نمط glob"), limit: integer("أقصى عدد نتائج", 1, MAX_GLOB_RESULTS) }, ["pattern"]),
  tool("search_files", "ابحث نصيًا داخل الملفات وأعد file:line:column.", { path: str("مجلد البداية، الافتراضي الجذر"), pattern: str("نص أو regex"), include: str("glob اختياري مثل *.ts"), fixed_strings: bool("اعتبر النمط نصًا حرفيًا"), case_sensitive: bool("بحث حساس لحالة الأحرف"), limit: integer("أقصى عدد نتائج", 1, MAX_SEARCH_RESULTS) }, ["pattern"]),
  tool("search_symbols", "ابحث عن رموز برمجية (دوال، أصناف، واجهات، متغيرات عامة) في المشروع وأعدها مع أرقام الأسطر. مفيد لتتبع التعريفات في المشاريع الكبيرة دون قراءة كل ملف.", { path: str("مجلد البداية، الافتراضي الجذر"), query: str("اسم الرمز أو جزء منه (غير حساس لحالة الأحرف)"), limit: integer("أقصى عدد نتائج", 1, MAX_SEARCH_RESULTS) }, ["query"]),
  tool("write_file", "أنشئ ملفًا أو استبدل محتواه بالكامل.", { path: str("مسار الملف"), content: str("المحتوى الكامل") }, ["path", "content"]),
  tool("edit_file", "عدّل ملف باستبدال نص مطابق. اقرأ الملف أولًا بأداة read_file ثم عدّل. اجعل old_string قصيرًا ودقيقة.", { path: str("مسار الملف"), old_string: str("النص الحالي الدقيق للبحث عنه"), new_string: str("النص البديل") }, ["path", "old_string", "new_string"]),
  tool("patch_file", "عدّل ملف بعدة تغييرات دفعة واحدة. كل تغيير يحدد start_line و end_line و new_lines و expected (اختياري: نص الأسطر الحالية من start_line إلى end_line كما قرأتها — يُتحقق من مطابقته قبل التطبيق ويرفض التعديل إن تغيّرت). اقرأ الملف أولًا بأداة read_file وضمّن expected دائمًا لضمان عدم تعديل مواضع خاطئة. أعد diff كامل.", { path: str("مسار الملف"), patches: str("مصفوفة JSON من التغييرات: [{start_line, end_line, new_lines, expected}]") }, ["path", "patches"]),
  tool("create_directory", "أنشئ مجلدًا.", { path: str("مسار المجلد") }, ["path"]),
  tool("get_file_info", "أعد معلومات ملف أو مجلد مع عدد الأسطر.", { path: str("المسار") }, ["path"]),
  tool("web_fetch", "اجلب صفحة HTTPS عامة. يمنع localhost ويتطلب موافقة.", { url: str("رابط HTTPS"), max_bytes: integer("حد المحتوى", 1e3, 5e5) }, ["url"]),
  tool("web_search", "ابحث في الويب عن معلومات حديثة وأعد روابط وعناوين ومقتطفات.", { query: str("عبارة البحث"), max_results: integer("أقصى عدد نتائج", 1, 10) }, ["query"]),
  tool("git_status", "اعرض حالة مستودع Git داخل مساحة العمل.", { path: str("مجلد المستودع، الافتراضي الجذر") }, []),
  tool("git_diff", "اعرض الفرق الحالي في مستودع Git دون تنفيذ تغيير.", { path: str("مجلد المستودع، الافتراضي الجذر"), staged: bool("اعرض التغييرات المرحّلة فقط") }, []),
  tool("git_log", "اعرض آخر commits في مستودع Git.", { path: str("مجلد المستودع، الافتراضي الجذر"), limit: integer("عدد commits", 1, 50) }, []),
  tool("delete_file", "احذف ملفًا واحدًا نهائيًا داخل مساحة العمل. يرفض حذف المجلدات، ويتطلب موافقة صريحة دائمًا.", { path: str("مسار الملف") }, ["path"]),
  tool("move_file", "انقل أو أعد تسمية ملف داخل مساحة العمل. الوجهة يجب أن تكون داخل المساحة.", { from: str("المسار الحالي"), to: str("المسار الجديد") }, ["from", "to"]),
  tool("append_file", "أضف نصًا إلى نهاية ملف نصي (أو أنشئه إن لم يوجد). يبقي المحتوى السابق كما هو.", { path: str("مسار الملف"), content: str("النص المضاف") }, ["path", "content"]),
  tool("tree", "اعرض شجرة بنية المشروع داخل مساحة العمل مع تجاهل مجلدات البناء تلقائيًا.", { path: str("مجلد البداية، الافتراضي الجذر"), max_entries: integer("أقصى عدد عناصر", 1, 2e3) }, []),
  tool("git_branch", "اعرض الفروع المحلية للريبو الحالي.", { path: str("مجلد المستودع، الافتراضي الجذر") }, []),
  tool("git_show", "اعرض محتوى commit أو ملف من ريفزيون معين مثل HEAD أو HEAD~1 أو commit:file.", { path: str("مجلد المستودع، الافتراضي الجذر"), spec: str("المواصفة مثل HEAD أو commit-hash أو commit:path") }, ["spec"]),
  tool("git_add", "أضف ملفات إلى منطقة staging في الريبو (لا ينشئ commit).", { path: str("مجلد المستودع، الافتراضي الجذر"), files: str('مسارات مفصولة بأسطر جديدة، أو "." للكل') }, ["files"]),
  tool("git_restore", "استعد ملفًا من HEAD (يُلغي تغييراته غير الملتزمة نهائيًا). يتطلب موافقة صريحة دائمًا.", { path: str("مجلد المستودع، الافتراضي الجذر"), file: str("مسار الملف بالنسبة لمسار المستودع") }, ["file"]),
  tool("git_checkout", "بدّل إلى فرع موجود في الريبو.", { path: str("مجلد المستودع، الافتراضي الجذر"), branch: str("اسم الفرع") }, ["branch"]),
  tool("git_reset", "ألغِ الترحيل إلى HEAD (mixed) أو حرّك HEAD دون لمس الملفات (soft). يرفض --hard نهائيًا.", { path: str("مجلد المستودع، الافتراضي الجذر"), mode: str("soft أو mixed، الافتراضي mixed") }, []),
  tool("git_commit", "أنشئ commit في المستودع الحالي. يتطلب موافقة صريحة دائمًا حتى في وضع الوصول الكامل.", { path: str("مجلد المستودع، الافتراضي الجذر"), message: str("رسالة commit"), all: bool("أضف كل التغييرات قبل commit") }, ["message"]),
  tool("git_revert", "تراجع بأمان عن commit محدد بإنشاء revert commit جديد. استخدم hash الذي أعادته gitAutoCommit، ويتطلب موافقة صريحة دائمًا.", { path: str("مجلد المستودع، الافتراضي الجذر"), commit: str("hash كامل أو مختصر للـcommit") }, ["commit"]),
  tool("git_revert_step", "ألغِ آخر خطوة تنفيذ كاملة: يسترجع كل التعديلات التي حُفظت في آخر commit تلقائي (gitAutoCommit) بإنشاء revert commit واحد، دون لمس التغييرات غير الملتزمة. يتطلب موافقة صريحة دائمًا.", { path: str("مجلد المستودع، الافتراضي الجذر") }, []),
  tool("run_powershell", "شغّل أمر PowerShell مع مهلة وحد مخرجات. يتطلب موافقة في كل مرة. المهلة حتى 10 دقائق.", { command: str("الأمر الكامل"), cwd: str("مجلد التشغيل داخل مساحة العمل"), timeout_ms: integer("المهلة بالمللي ثانية", 1e3, 6e5) }, ["command"])
];
async function executeTool(name, input, context) {
  if (context.deadlineAt !== void 0 && Date.now() >= context.deadlineAt) return failure("DEADLINE_EXCEEDED", "انتهى الوقت المتاح للجولة الحالية.");
  const mutating = ["write_file", "edit_file", "patch_file", "create_directory", "run_powershell", "git_commit", "git_revert", "git_revert_step", "delete_file", "move_file", "append_file", "git_add", "git_restore", "git_checkout", "git_reset"].includes(name);
  if (context.session.agentMode === "plan" && mutating) return failure("PLAN_MODE", "وضع Plan لا يسمح بالتعديل أو تنفيذ الأوامر.");
  const destructive = ["delete_file", "git_restore", "git_checkout", "git_reset", "git_revert", "git_revert_step"].includes(name);
  const root = await canonicalWorkspace(context.session.workspace);
  if (name.startsWith("mcp_") || name.startsWith("tavily_")) {
    if (context.session.agentMode === "plan") return failure("PLAN_MODE", "وضع Plan لا يسمح باستدعاء أدوات MCP لأنها قد تعدل خارج المشروع.");
    if (!context.mcp) return failure("MCP_UNAVAILABLE", "مدير MCP غير متاح.");
    if (context.session.permissionMode === "ask" && !await context.approve(`السماح بأداة MCP ${name}؟`, JSON.stringify({ tool: name, input }, null, 2), true)) return failure("APPROVAL_DENIED", "رفض المستخدم تنفيذ أداة MCP.");
    return context.mcp.call(name, input, context.signal, context.session.workspace);
  }
  const targetInput = name === "read_files" && typeof input.paths === "string" ? "." : name === "move_file" && typeof input.from === "string" ? input.from : typeof input.path === "string" ? input.path : typeof input.cwd === "string" ? input.cwd : ".";
  const target = name === "web_fetch" || name === "web_search" ? { absolute: root.canonical, relative: "." } : name === "write_file" || name === "create_directory" || name === "append_file" ? await resolveCreatable(root, targetInput) : await resolveExisting(root, targetInput);
  const sensitive = isSensitiveInput(name, input, target.relative);
  const shell = name === "run_powershell";
  const criticalShell = shell && isCriticalCommand(String(input.command ?? ""));
  const web = name === "web_fetch" || name === "web_search";
  const criticalGit = name === "git_commit" || name === "git_revert";
  const needsApproval = context.session.permissionMode === "ask" && (sensitive || shell || web || criticalGit || destructive || mutating);
  if (needsApproval) {
    const preview = await buildApprovalPreview(name, input, target, sensitive);
    if (!await context.approve(`السماح بأداة ${name}؟`, preview.detail, criticalShell || shell || criticalGit || sensitive, preview.rememberKey)) return failure("APPROVAL_DENIED", "رفض المستخدم تنفيذ الأداة.");
    if (preview.verify) await preview.verify();
    if (name === "write_file" || name === "create_directory" || name === "append_file") await resolveCreatable(root, targetInput);
    else if (name !== "move_file") await resolveExisting(root, targetInput);
  }
  switch (name) {
    case "read_file":
      return readTextFile(target.absolute, target.relative, number(input.offset, 1, 1), number(input.limit, 500, 1, MAX_READ_LINES));
    case "read_files":
      return readFiles(root.canonical, target.absolute, optionalString(input.paths), optionalString(input.include), optionalString(input.cursor), number(input.max_files, 10, 1, 100), context.maxOutputChars ?? 3e5, context.signal);
    case "read_message": {
      const id2 = requiredString(input.id, "id");
      if (!context.readStoredMessage) return failure("READ_MESSAGE_UNAVAILABLE", "أداة read_message غير متاحة في هذا السياق.");
      const stored = await context.readStoredMessage(id2);
      if (!stored) return failure("MESSAGE_NOT_FOUND", `لا توجد رسالة بمعرّف ${id2} في سجل هذه الجلسة.`);
      return success({ ...stored, content: stored.content.slice(0, 2e5) });
    }
    case "load_skill": {
      const name2 = requiredString(input.name, "name");
      if (!context.loadSkill) return failure("SKILL_UNAVAILABLE", "أداة load_skill غير متاحة في هذا السياق.");
      const skill = await context.loadSkill(name2);
      if (!skill) return failure("SKILL_NOT_FOUND", `لا توجد مهارة باسم ${name2} في مجلدات مهارات المشروع.`);
      const maxChars = number(input.max_chars, 6e4, 1e3, 1e5);
      return success({ name: skill.name, description: skill.description, content: skill.content.slice(0, maxChars), truncated: skill.content.length > maxChars });
    }
    case "task": {
      if (!context.runSubagent) return failure("SUBAGENT_UNAVAILABLE", "أداة task غير متاحة في هذا السياق.");
      const prompt = requiredString(input.prompt, "prompt");
      const description = String(input.description ?? "");
      if (prompt.length > 1e5) return failure("INVALID_TASK_INPUT", "prompt أطول من الحد المسموح (100000 حرف).");
      const signal = context.signal;
      const subagent = await context.runSubagent({ prompt, description }, signal);
      if (!subagent.ok) return failure("SUBAGENT_FAILED", `فشل الوكيل الفرعي: ${subagent.error ?? "خطأ غير معروف"}`);
      return success({ description, steps: subagent.steps, summary: subagent.summary });
    }
    case "task_parallel": {
      if (!context.runSubagentBatch) return failure("SUBAGENT_UNAVAILABLE", "أداة task_parallel غير متاحة في هذا السياق.");
      const raw = requiredString(input.tasks, "tasks");
      let parsed;
      try {
        parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error();
      } catch {
        return failure("INVALID_TASKS_INPUT", "tasks يجب أن تكون مصفوفة JSON صالحة.");
      }
      const tasks = parsed.slice(0, 5).map((item) => ({ prompt: typeof item.prompt === "string" ? item.prompt.slice(0, 1e5) : "", description: typeof item.description === "string" ? item.description.slice(0, 200) : "وكيل فرعي" }));
      if (!tasks.length || tasks.some((task) => !task.prompt.trim())) return failure("INVALID_TASKS_INPUT", "كل مهمة تتطلب prompt نصيًا.");
      const results = await context.runSubagentBatch(tasks, context.signal);
      return success({ count: results.length, results });
    }
    case "todo_write": {
      if (!context.todos) return failure("TODOS_UNAVAILABLE", "أداة todo_write غير متاحة في هذا السياق.");
      const raw = requiredString(input.items, "items");
      let parsed;
      try {
        parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error();
      } catch {
        return failure("INVALID_TODO_INPUT", "items يجب أن تكون مصفوفة JSON صالحة.");
      }
      const items = parsed.slice(0, 100).map((item) => {
        const status = item.status === "completed" || item.status === "in_progress" || item.status === "cancelled" ? item.status : void 0;
        const priority = item.priority === "high" || item.priority === "low" ? item.priority : void 0;
        return { content: typeof item.content === "string" ? item.content.slice(0, 500) : "", status, priority };
      });
      if (items.some((item) => !item.content.trim())) return failure("INVALID_TODO_INPUT", "كل مهمة تتطلب content نصيًا.");
      const todos = await context.todos.set(items);
      return success({ count: todos.length, todos });
    }
    case "todo_read": {
      if (!context.todos) return failure("TODOS_UNAVAILABLE", "أداة todo_read غير متاحة في هذا السياق.");
      return success({ count: (await context.todos.get()).length, todos: await context.todos.get() });
    }
    case "run_command": {
      if (!context.runCommand) return failure("COMMAND_UNAVAILABLE", "أداة run_command غير متاحة في هذا السياق.");
      const result = await context.runCommand(requiredString(input.name, "name"), typeof input.arguments === "string" ? input.arguments : void 0);
      if (!result.ok) return failure("COMMAND_FAILED", result.error ?? "فشل تنفيذ الأمر");
      return success({ name: input.name, output: result.output });
    }
    case "count_lines":
      return countLines(target.absolute, target.relative, optionalString(input.include));
    case "list_directory":
      return listDirectory(target.absolute, target.relative, number(input.limit, 500, 1, 1e3));
    case "glob_files":
      return globFiles(target.absolute, root.canonical, requiredString(input.pattern, "pattern"), number(input.limit, 1e3, 1, MAX_GLOB_RESULTS), context.signal);
    case "search_files":
      return searchFiles(target.absolute, root.canonical, requiredString(input.pattern, "pattern"), optionalString(input.include), Boolean(input.fixed_strings), Boolean(input.case_sensitive), number(input.limit, MAX_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS), context.signal);
    case "search_symbols":
      return searchSymbols(target.absolute, root.canonical, requiredString(input.query, "query"), number(input.limit, MAX_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS), context.signal);
    case "write_file": {
      const output = await writeFileAtomic(target.absolute, target.relative, requiredString(input.content, "content"));
      return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, "write_file", [target.relative]));
    }
    case "edit_file": {
      const output = await editFile(target.absolute, target.relative, requiredString(input.old_string, "old_string"), String(input.new_string ?? ""));
      return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, "edit_file", [target.relative]));
    }
    case "patch_file": {
      const output = await patchFile(target.absolute, target.relative, requiredString(input.patches, "patches"));
      return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, "patch_file", [target.relative]));
    }
    case "create_directory": {
      await node_fs.promises.mkdir(target.absolute, { recursive: true });
      return success({ path: target.relative, created: true });
    }
    case "get_file_info":
      return fileInfo(target.absolute, target.relative);
    case "web_fetch":
      return webFetch(requiredString(input.url, "url"), number(input.max_bytes, 2e5, 1e3, 5e5), context.signal, context.deadlineAt);
    case "web_search":
      return webSearch(requiredString(input.query, "query"), number(input.max_results, 5, 1, 10), context.signal, context.deadlineAt);
    case "git_status":
      return gitStatus(target.absolute, context.signal, context.trackProcess, context.deadlineAt);
    case "git_diff":
      return gitDiff(target.absolute, Boolean(input.staged), context.signal, context.trackProcess, context.deadlineAt);
    case "git_log":
      return gitLog(target.absolute, number(input.limit, 10, 1, 50), context.signal, context.trackProcess, context.deadlineAt);
    case "git_commit":
      return gitCommit(target.absolute, requiredString(input.message, "message"), Boolean(input.all), context.signal, context.trackProcess, context.deadlineAt);
    case "git_revert":
      return gitRevert(target.absolute, requiredString(input.commit, "commit"), context.signal, context.trackProcess, context.deadlineAt);
    case "git_revert_step":
      return gitRevertStep(target.absolute, context.signal, context.trackProcess, context.deadlineAt);
    case "delete_file": {
      const output = await deleteFile(target.absolute, target.relative);
      return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, "delete_file", [target.relative]));
    }
    case "move_file": {
      const destination = await resolveCreatable(root, requiredString(input.to, "to"));
      const output = await moveFile(root.canonical, requiredString(input.from, "from"), requiredString(input.to, "to"));
      return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, "move_file", [target.relative, destination.relative]));
    }
    case "append_file": {
      const output = await appendFile(target.absolute, target.relative, requiredString(input.content, "content"));
      return withAutoCommit(output, await maybeAutoCommit(context, root.canonical, "append_file", [target.relative]));
    }
    case "tree":
      return projectTree(target.absolute, root.canonical, number(input.max_entries, 1e3, 1, 2e3), context.signal);
    case "git_branch":
      return gitBranch(target.absolute, context.signal, context.trackProcess, context.deadlineAt);
    case "git_show":
      return gitShow(target.absolute, requiredString(input.spec, "spec"), context.signal, context.trackProcess, context.deadlineAt);
    case "git_add":
      return gitAdd(target.absolute, requiredString(input.files, "files"), context.signal, context.trackProcess, context.deadlineAt);
    case "git_restore":
      return gitRestore(target.absolute, requiredString(input.file, "file"), context.signal, context.trackProcess, context.deadlineAt);
    case "git_checkout":
      return gitCheckout(target.absolute, requiredString(input.branch, "branch"), context.signal, context.trackProcess, context.deadlineAt);
    case "git_reset":
      return gitReset(target.absolute, String(input.mode ?? "mixed"), context.signal, context.trackProcess, context.deadlineAt);
    case "run_powershell": {
      const requestedTimeout = number(input.timeout_ms, 3e4, 1e3, 6e5);
      const remaining = context.deadlineAt === void 0 ? requestedTimeout : Math.max(1e3, Math.min(requestedTimeout, context.deadlineAt - Date.now()));
      const result = await runPowerShell(requiredString(input.command, "command"), target.absolute, context.signal, remaining, context.trackProcess);
      return success(result);
    }
    default:
      throw new Error(`أداة غير معروفة: ${name}`);
  }
}
async function runPowerShell(command, cwd, signal, timeoutMs = 3e4, trackProcess) {
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = node_child_process.spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd, windowsHide: true, env: safeEnvironment$1() });
    trackProcess?.(child);
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (chunk) => {
      if (bytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_OUTPUT_BYTES - bytes;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) truncated = true;
    };
    const killTree = () => {
      if (!child.pid || child.killed) return;
      child.kill();
      const killer = node_child_process.spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const abort = () => killTree();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(new DOMException("تم إلغاء الأمر", "AbortError"));
        return;
      }
      resolve({ output: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? -1, timedOut, truncated, durationMs: Date.now() - startedAt });
    });
    function cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  });
}
async function canonicalWorkspace(workspace) {
  const canonical = await node_fs.promises.realpath(path.resolve(workspace));
  const stat = await node_fs.promises.stat(canonical);
  if (!stat.isDirectory()) throw new Error("مساحة العمل ليست مجلدًا");
  return { canonical };
}
async function resolveExisting(root, input) {
  const candidate = path.resolve(root.canonical, input);
  const canonical = await node_fs.promises.realpath(candidate);
  assertInside(root.canonical, canonical);
  return { absolute: canonical, relative: relativePath(root.canonical, canonical) };
}
async function resolveCreatable(root, input) {
  const candidate = path.resolve(root.canonical, input);
  assertInside(root.canonical, candidate);
  let ancestor = candidate;
  while (true) {
    try {
      await node_fs.promises.lstat(ancestor);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const canonicalAncestor = await node_fs.promises.realpath(ancestor);
  assertInside(root.canonical, canonicalAncestor);
  let current = root.canonical;
  for (const part of path.relative(root.canonical, ancestor).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await node_fs.promises.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("لا يسمح بالكتابة عبر رابط رمزي أو junction");
  }
  return { absolute: candidate, relative: relativePath(root.canonical, candidate) };
}
function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("المسار خارج مساحة العمل");
}
function relativePath(root, target) {
  return path.relative(root, target).replaceAll("\\", "/") || ".";
}
async function scanLines(filePath2, collectStart, collectLimit) {
  const stat = await node_fs.promises.stat(filePath2);
  const stream = node_fs.createReadStream(filePath2, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const reader = node_readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  let totalLines = 0;
  let outputBytes = 0;
  let outputTruncated = false;
  let binary = false;
  let streamError = null;
  stream.on("error", (error) => {
    streamError = error;
    reader.close();
  });
  reader.on("error", (error) => {
    streamError = error;
  });
  stream.on("data", (chunk) => {
    if (!binary && String(chunk).includes("\0")) {
      binary = true;
      reader.close();
      stream.destroy();
    }
  });
  try {
    for await (const line of reader) {
      if (binary) break;
      totalLines++;
      if (collectStart && collectLimit && totalLines >= collectStart && totalLines < collectStart + collectLimit) {
        const rendered = `${totalLines}: ${line}`;
        const size = Buffer.byteLength(rendered) + 1;
        if (outputBytes + size <= MAX_OUTPUT_BYTES) {
          lines.push(rendered);
          outputBytes += size;
        } else outputTruncated = true;
      }
    }
    if (streamError && !binary) throw streamError;
    if (binary) throw new Error("الملف ثنائي وليس نصيًا");
    return { totalLines, bytes: stat.size, lines, outputTruncated };
  } finally {
    try {
      reader.close();
    } catch {
    }
    try {
      stream.destroy();
    } catch {
    }
  }
}
async function readTextFile(filePath2, relative, offset, limit) {
  const result = await scanLines(filePath2, offset, limit);
  return success({ path: relative, totalLines: result.totalLines, bytes: result.bytes, range: { start: result.lines.length ? offset : null, end: result.lines.length ? offset + result.lines.length - 1 : null, requestedLimit: limit }, truncated: result.outputTruncated || offset + result.lines.length <= result.totalLines, lines: result.lines });
}
async function readFiles(root, directory, pathsValue, include, cursorValue, maxFiles, maxOutputChars, signal) {
  const candidates = [];
  if (pathsValue) {
    const paths = [...new Set(pathsValue.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
    for (const input of paths) {
      signal.throwIfAborted();
      const canonical = await node_fs.promises.realpath(path.resolve(root, input));
      assertInside(root, canonical);
      if ((await node_fs.promises.stat(canonical)).isFile()) candidates.push({ absolute: canonical, relative: relativePath(root, canonical) });
    }
  } else {
    if (!include) throw new Error("read_files يتطلب paths أو include");
    const matcher = globRegex(include);
    await walkFiles(directory, root, signal, async (absolute, relative) => {
      if (matcher.test(relative) || matcher.test(path.basename(relative))) candidates.push({ absolute, relative });
      return candidates.length < 2e3;
    });
  }
  candidates.sort((a, b) => a.relative.localeCompare(b.relative));
  const cursorMatch = /^(\d+):(\d+)(?::(\d+))?$/.exec(cursorValue ?? "0:0:0");
  if (!cursorMatch) throw new Error("cursor غير صالح؛ استخدم القيمة التي أعادتها read_files كما هي");
  let fileIndex = Number(cursorMatch[1]);
  let lineIndex = Number(cursorMatch[2]);
  let characterIndex = Number(cursorMatch[3] ?? 0);
  const files = [];
  let usedChars = 0;
  let processedFiles = 0;
  while (fileIndex < candidates.length && processedFiles < maxFiles) {
    const candidate = candidates[fileIndex];
    signal.throwIfAborted();
    const stat = await node_fs.promises.stat(candidate.absolute);
    if (stat.size > 5e6) {
      fileIndex++;
      lineIndex = 0;
      characterIndex = 0;
      continue;
    }
    const text = await node_fs.promises.readFile(candidate.absolute, "utf8");
    if (text.includes("\0")) {
      fileIndex++;
      lineIndex = 0;
      characterIndex = 0;
      continue;
    }
    const rawLines = text.split(/\r\n|\n|\r/);
    if (rawLines.at(-1) === "") rawLines.pop();
    const rendered = [];
    const startLine = lineIndex + 1;
    const startCharacter = characterIndex;
    while (lineIndex < rawLines.length) {
      const rawLine = rawLines[lineIndex];
      const prefix = `${lineIndex + 1}${characterIndex ? `[char ${characterIndex + 1}]` : ""}: `;
      const available = Math.max(1, maxOutputChars - usedChars - prefix.length - 1);
      const segment = rawLine.slice(characterIndex, characterIndex + available);
      rendered.push(`${prefix}${segment}`);
      usedChars += prefix.length + segment.length + 1;
      characterIndex += segment.length;
      if (characterIndex < rawLine.length) break;
      lineIndex++;
      characterIndex = 0;
      if (usedChars >= maxOutputChars) break;
    }
    files.push({ path: candidate.relative, totalLines: rawLines.length, bytes: stat.size, range: { start: startLine, end: Math.min(rawLines.length, lineIndex + (characterIndex ? 1 : 0)), startCharacter, endCharacter: characterIndex }, complete: lineIndex >= rawLines.length, content: rendered.join("\n") });
    if (lineIndex < rawLines.length) break;
    fileIndex++;
    lineIndex = 0;
    characterIndex = 0;
    processedFiles++;
    if (usedChars >= maxOutputChars) break;
  }
  const nextCursor = fileIndex < candidates.length ? `${fileIndex}:${lineIndex}:${characterIndex}` : null;
  return success({ totalFiles: candidates.length, cursor: cursorValue ?? "0:0:0", filesRead: files.length, nextCursor, complete: nextCursor === null, files });
}
async function countLines(filePath2, relative, include) {
  const stat = await node_fs.promises.stat(filePath2);
  if (!stat.isDirectory()) {
    const result = await scanLines(filePath2);
    return success({ path: relative, totalLines: result.totalLines, bytes: result.bytes });
  }
  const includePattern = include ? globToRegex(include) : null;
  const files = [];
  let totalLines = 0;
  let totalBytes = 0;
  let totalFiles = 0;
  await walkFiles(filePath2, filePath2, new AbortController().signal, async (absolute, rel) => {
    if (includePattern && !includePattern.test(rel)) return true;
    try {
      const result = await scanLines(absolute);
      files.push({ path: rel, lines: result.totalLines, bytes: result.bytes });
      totalLines += result.totalLines;
      totalBytes += result.bytes;
      totalFiles++;
    } catch {
    }
    return true;
  });
  files.sort((a, b) => b.lines - a.lines);
  return success({ path: relative, totalFiles, totalLines, totalBytes, files: files.slice(0, 200) });
}
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "{{GLOBSTAR}}").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`${escaped}$`, "i");
}
async function listDirectory(directory, relative, limit) {
  const entries = await node_fs.promises.readdir(directory, { withFileTypes: true });
  const items = entries.slice(0, limit).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "link" : "file" }));
  return success({ path: relative, totalEntries: entries.length, truncated: entries.length > limit, entries: items });
}
async function walkFiles(directory, root, signal, onFile) {
  signal.throwIfAborted();
  const entries = await node_fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry.isSymbolicLink() || isIgnoredEntry(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!await walkFiles(absolute, root, signal, onFile)) return false;
    } else if (entry.isFile() && !await onFile(absolute, relativePath(root, absolute))) return false;
  }
  return true;
}
function isIgnoredEntry(name) {
  return ["node_modules", ".git", "out", "dist"].includes(name) || name.startsWith("release-") || name.startsWith("dist-v") || name.startsWith("win-unpacked") || name.endsWith(".tmp");
}
async function globFiles(directory, root, pattern, limit, signal) {
  const matcher = globRegex(pattern);
  const files = [];
  const completed = await walkFiles(directory, root, signal, async (_absolute, relative) => {
    if (matcher.test(relative)) files.push(relative);
    return files.length < limit;
  });
  return success({ pattern, count: files.length, truncated: !completed, files });
}
async function searchFiles(directory, root, pattern, include, fixed, caseSensitive, limit, signal) {
  let matcher;
  try {
    matcher = new RegExp(fixed ? escapeRegex(pattern) : pattern, caseSensitive ? "g" : "gi");
  } catch (error) {
    throw new Error(`تعبير البحث غير صالح: ${error instanceof Error ? error.message : String(error)}`);
  }
  const includeMatcher = include ? globRegex(include) : null;
  const matches = [];
  let skippedBinary = 0;
  const completed = await walkFiles(directory, root, signal, async (absolute, relative) => {
    if (includeMatcher && !includeMatcher.test(relative) && !includeMatcher.test(path.basename(relative))) return true;
    const stat = await node_fs.promises.stat(absolute);
    if (stat.size > 5e6) return true;
    let text;
    try {
      text = await node_fs.promises.readFile(absolute, "utf8");
    } catch {
      return true;
    }
    if (text.includes("\0")) {
      skippedBinary++;
      return true;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      matcher.lastIndex = 0;
      const match = matcher.exec(lines[index]);
      if (match) {
        const start = Math.max(0, match.index - 50);
        matches.push({ path: relative, line: index + 1, column: match.index + 1, text: lines[index].slice(start, start + 120) });
      }
      if (matches.length >= limit) return false;
    }
    return true;
  });
  return success({ pattern, count: matches.length, truncated: !completed, skippedBinary, matches });
}
const SYMBOL_EXTENSIONS = /* @__PURE__ */ new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".kt", ".kts", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".rb", ".swift", ".dart", ".sh", ".sql", ".vue", ".svelte", ".json", ".css", ".scss", ".html", ".xml", ".yml", ".yaml", ".toml", ".md", ".gradle", ".groovy"]);
const SYMBOL_PATTERNS = [
  { kind: "function", pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
  { kind: "class", pattern: /^(?:export\s+)?class\s+(\w+)/ },
  { kind: "interface", pattern: /^(?:export\s+)?interface\s+(\w+)/ },
  { kind: "type", pattern: /^(?:export\s+)?(?:type|enum)\s+(\w+)/ },
  { kind: "const", pattern: /(?:const|let|var)\s+(\w+)\s*=\s*(?:function|\(|async|class)/ },
  { kind: "method", pattern: /(?:def\s+|async\s+def\s+|func\s+|public\s+\w+\s+|private\s+\w+\s+|protected\s+\w+\s+)(\w+)\s*\(/ },
  { kind: "method", pattern: /^\s*(?:(?:public|private|protected)\s+)?[\w<>[\],?]+\s+(\w+)\s*\([^)]*\)\s*\{?\s*$/ },
  { kind: "import", pattern: /^import\s+(?:\{\s*([^}]+?)\s*\}|(\w+))\s+from/ }
];
async function searchSymbols(directory, root, query, limit, signal) {
  const lower = query.trim().toLowerCase();
  if (!lower) throw new Error("query لا يمكن أن يكون فارغًا");
  const symbols = [];
  const completed = await walkFiles(directory, root, signal, async (absolute, relative) => {
    const ext = path.extname(absolute).toLowerCase();
    if (!SYMBOL_EXTENSIONS.has(ext)) return true;
    const stat = await node_fs.promises.stat(absolute);
    if (stat.size > 2e6) return true;
    let text;
    try {
      text = await node_fs.promises.readFile(absolute, "utf8");
    } catch {
      return true;
    }
    if (text.includes("\0")) return true;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.toLowerCase().includes(lower)) continue;
      for (const { kind, pattern } of SYMBOL_PATTERNS) {
        const match = pattern.exec(line);
        if (!match) continue;
        const name = (match[1] ?? "").trim().split(/[,}\s]/)[0] ?? "";
        if (!name || !name.toLowerCase().includes(lower)) continue;
        symbols.push({ path: relative, line: index + 1, kind, name: name.slice(0, 120) });
        break;
      }
      if (symbols.length >= limit) return false;
    }
    return true;
  });
  return success({ query: query.trim(), count: symbols.length, truncated: !completed, symbols });
}
async function writeFileAtomic(target, relative, content) {
  const previous = await readOptionalText(target);
  await node_fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.r-code-${node_crypto.randomBytes(8).toString("hex")}.tmp`;
  const handle2 = await node_fs.promises.open(temporary, node_fs.constants.O_CREAT | node_fs.constants.O_EXCL | node_fs.constants.O_WRONLY, 384);
  try {
    await handle2.writeFile(content, "utf8");
    await handle2.sync();
  } finally {
    await handle2.close();
  }
  const backup = `${target}.r-code-${node_crypto.randomBytes(8).toString("hex")}.bak`;
  let backedUp = false;
  try {
    try {
      await node_fs.promises.rename(target, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await node_fs.promises.rename(temporary, target);
    if (backedUp) await node_fs.promises.rm(backup, { force: true });
  } catch (error) {
    await node_fs.promises.rm(temporary, { force: true });
    if (backedUp) {
      await node_fs.promises.rm(target, { force: true });
      await node_fs.promises.rename(backup, target);
    }
    throw error;
  }
  const diff = isSensitive(relative) ? { text: "[محتوى ملف حساس محجوب]", truncated: false } : diffPreview(previous ?? "", content);
  return success({ path: relative, bytes: Buffer.byteLength(content), sha256: node_crypto.createHash("sha256").update(content).digest("hex"), diff: diff.text, diffTruncated: diff.truncated });
}
async function editFile(target, relative, oldString, newString) {
  if (!oldString) throw new Error("old_string لا يمكن أن يكون فارغًا");
  const content = await node_fs.promises.readFile(target, "utf8");
  const applied = applyEdit(content, oldString, newString);
  await writeFileAtomic(target, relative, applied.content);
  const diff = isSensitive(relative) ? { text: "[محتوى ملف حساس محجوب]", truncated: false } : diffPreview(content, applied.content);
  return success({ path: relative, changed: true, startLine: applied.startLine, removedLines: applied.removedLines, addedLines: applied.addedLines, diff: diff.text, diffTruncated: diff.truncated, totalLines: applied.content.split("\n").length });
}
function applyEdit(content, oldString, newString) {
  if (!oldString) throw new Error("old_string لا يمكن أن يكون فارغًا");
  let matchIndex = content.indexOf(oldString);
  if (matchIndex !== -1) {
    const exactCount = countOccurrences(content, oldString);
    if (exactCount > 1) throw new Error(`النص المطابق موجود ${exactCount} مرات؛ اجعل old_string أطول وأكثر تحديدًا`);
  } else {
    const normalized = normalizeForMatch(oldString);
    matchIndex = findFuzzyMatch(content, normalized);
    if (matchIndex !== -1) {
      const fuzzyCount = countOccurrences(normalizeForMatch(content), normalized);
      if (fuzzyCount > 1) throw new Error(`النص المطابق موجود ${fuzzyCount} مرات؛ اجعل old_string أطول وأكثر تحديدًا`);
    }
  }
  if (matchIndex === -1) throw new Error("لم يتم العثور على النص المطابق. اقرأ الملف أولًا ثم استخدم النص الدقيق.");
  const startLine = content.slice(0, matchIndex).split("\n").length;
  const removedLines = oldString.split("\n").length;
  const addedLines = newString.split("\n").length;
  return { content: content.slice(0, matchIndex) + newString + content.slice(matchIndex + oldString.length), startLine, removedLines, addedLines };
}
function normalizeForMatch(value) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ").replace(/ +$/gm, "");
}
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
function findFuzzyMatch(content, normalizedNeedle) {
  const normalizedContent = normalizeForMatch(content);
  const rawIndexAt = (normalizedIndex) => {
    let rawIndex = 0;
    let normalizedPos = 0;
    while (normalizedPos < normalizedIndex && rawIndex < content.length) {
      const ch = content[rawIndex];
      if (ch === "\r" || ch === "	") rawIndex++;
      else if (ch === "\n") {
        rawIndex++;
        if (rawIndex < content.length && content[rawIndex] === "\r") rawIndex++;
        normalizedPos++;
      } else if (ch === " ") {
        while (rawIndex < content.length && content[rawIndex] === " ") rawIndex++;
        normalizedPos++;
      } else {
        rawIndex++;
        normalizedPos++;
      }
    }
    return rawIndex;
  };
  const findUnique = (variant) => {
    const count = countOccurrences(normalizedContent, variant);
    if (count > 1) throw new Error(`النص المطابق موجود ${count} مرات؛ اجعل old_string أطول وأكثر تحديدًا`);
    if (count === 1) return rawIndexAt(normalizedContent.indexOf(variant));
    return -1;
  };
  let matchIndex = findUnique(normalizedNeedle);
  if (matchIndex !== -1) return matchIndex;
  const noTrailingWhitespace = normalizedNeedle.replace(/ +$/gm, "");
  if (noTrailingWhitespace !== normalizedNeedle) {
    matchIndex = findUnique(noTrailingWhitespace);
    if (matchIndex !== -1) return matchIndex;
  }
  const strippedLines = normalizedNeedle.split("\n").filter((line) => line.trim().length > 0).join("\n");
  if (strippedLines !== normalizedNeedle) {
    matchIndex = findUnique(strippedLines);
    if (matchIndex !== -1) return matchIndex;
  }
  return -1;
}
async function patchFile(target, relative, patchesRaw) {
  const content = await node_fs.promises.readFile(target, "utf8");
  const applied = applyPatches(content, patchesRaw);
  await writeFileAtomic(target, relative, applied.content);
  const diff = isSensitive(relative) ? { text: "[محتوى ملف حساس محجوب]", truncated: false } : diffPreview(content, applied.content);
  return success({ path: relative, patchesApplied: applied.applied.length, applied: applied.applied, totalLines: applied.content.split("\n").length, diff: diff.text, diffTruncated: diff.truncated });
}
function applyPatches(content, patchesRaw) {
  const patches = JSON.parse(patchesRaw);
  if (!Array.isArray(patches) || patches.length === 0) throw new Error("patches يجب أن تكون مصفوفة JSON غير فارغة");
  const lines = content.split("\n");
  const parsed = [];
  for (const patch of patches) {
    const start = Number(patch.start_line);
    const end = Number(patch.end_line);
    const newLines = typeof patch.new_lines === "string" ? patch.new_lines.split("\n") : Array.isArray(patch.new_lines) ? patch.new_lines.map(String) : [];
    if (!Number.isFinite(start) || start < 1 || start > lines.length + 1) throw new Error(`start_line غير صالح: ${start}`);
    if (!Number.isFinite(end) || end < start - 1 || end > lines.length) throw new Error(`end_line غير صالح: ${end}`);
    const expected = typeof patch.expected === "string" ? patch.expected : void 0;
    parsed.push({ start, end, newLines, expected });
  }
  const sorted = [...parsed].sort((a, b) => b.start - a.start);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1].start <= sorted[index].end) throw new Error("تتداخل التعديلات في نفس الأسطر؛ ادمجها في تعديل واحد");
  }
  const applied = [];
  for (const patch of sorted) {
    const before = lines.slice(patch.start - 1, patch.end).join("\n");
    if (patch.expected !== void 0 && normalizeForMatch(before) !== normalizeForMatch(patch.expected)) {
      throw new Error(`الأسطر ${patch.start}-${patch.end} لا تطابق المحتوى المتوقع؛ أعد قراءة الملف وحدّث expected من الأرقام الجديدة. المتوقع: ${patch.expected.slice(0, 300)}`);
    }
    lines.splice(patch.start - 1, patch.end - patch.start + 1, ...patch.newLines);
    applied.push({ start: patch.start, removed: patch.end - patch.start + 1, added: patch.newLines.length });
  }
  return { content: lines.join("\n"), applied };
}
async function fileInfo(target, relative) {
  const stat = await node_fs.promises.stat(target);
  const info = { path: relative, type: stat.isDirectory() ? "directory" : "file", size: stat.size, modifiedAt: stat.mtime.toISOString(), createdAt: stat.birthtime.toISOString() };
  if (stat.isFile() && stat.size <= 2e7) {
    try {
      info.totalLines = (await scanLines(target)).totalLines;
    } catch {
      info.binary = true;
    }
  }
  return success(info);
}
async function readOptionalText(target) {
  try {
    return await node_fs.promises.readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
function hashText(value) {
  return value === void 0 ? "missing" : node_crypto.createHash("sha256").update(value).digest("hex");
}
function diffPreview(before, after) {
  const oldLines = before.split(/\r\n|\n|\r/);
  const newLines = after.split(/\r\n|\n|\r/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const changedOld = oldLines.slice(prefix, oldLines.length - suffix);
  const changedNew = newLines.slice(prefix, newLines.length - suffix);
  const output = [`@@ السطور ${prefix + 1}-${Math.max(prefix + changedOld.length, prefix + changedNew.length)} @@`, ...changedOld.map((line) => `-${line}`), ...changedNew.map((line) => `+${line}`)];
  const maxLines = 80;
  const maxChars = 12e3;
  let truncated = output.length > maxLines;
  let text = output.slice(0, maxLines).join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) text += "\n...[تم اختصار الفرق]";
  return { text, truncated };
}
function operationKey(name, target, payload) {
  return `${name}:${target}:${node_crypto.createHash("sha256").update(payload).digest("hex")}`;
}
function isSensitiveInput(name, input, target) {
  const values = [target, input.path, input.cwd, input.paths, input.include, input.from, input.to, input.file].filter((value) => typeof value === "string");
  return values.some((value) => isSensitive(value));
}
async function buildApprovalPreview(name, input, target, sensitive) {
  if (name === "web_fetch") return { detail: JSON.stringify({ tool: name, url: input.url, maxBytes: input.max_bytes ?? 2e5 }, null, 2) };
  if (name === "web_search") return { detail: JSON.stringify({ tool: name, query: String(input.query ?? "").slice(0, 500), maxResults: input.max_results ?? 5 }, null, 2) };
  if (name === "run_powershell") return { detail: JSON.stringify({ tool: name, cwd: target.relative, command: input.command, timeoutMs: input.timeout_ms ?? 3e4 }, null, 2) };
  if (name === "git_commit") return { detail: JSON.stringify({ tool: name, repository: target.relative, message: String(input.message ?? "").slice(0, 1e3), all: Boolean(input.all) }, null, 2) };
  if (name === "git_revert") return { detail: JSON.stringify({ tool: name, repository: target.relative, commit: String(input.commit ?? "").slice(0, 40), operation: "create a new commit that safely reverses the selected commit" }, null, 2) };
  if (name === "git_revert_step") return { detail: JSON.stringify({ tool: name, repository: target.relative, operation: "reverse the last automatic (gitAutoCommit) commit with a new commit" }, null, 2) };
  if (name === "delete_file") {
    const current2 = await readOptionalText(target.absolute);
    const fingerprint = hashText(current2);
    return { detail: JSON.stringify({ tool: name, target: target.relative, operation: "delete file permanently (لا يمكن التراجع)" }, null, 2), rememberKey: operationKey(name, target.relative, fingerprint), verify: async () => {
      const now = await readOptionalText(target.absolute);
      if (hashText(now) !== fingerprint) throw new Error("تغيّر الملف بعد عرض المعاينة؛ اطلب الحذف من جديد.");
    } };
  }
  if (name === "move_file") return { detail: JSON.stringify({ tool: name, from: String(input.from ?? ""), to: String(input.to ?? ""), operation: "move/rename file داخل مساحة العمل" }, null, 2), rememberKey: operationKey(name, `${input.from}:${input.to}`, "") };
  if (name === "git_add") return { detail: JSON.stringify({ tool: name, repository: target.relative, files: String(input.files ?? "").slice(0, 2e3) }, null, 2) };
  if (name === "git_restore") return { detail: JSON.stringify({ tool: name, repository: target.relative, file: input.file, operation: "discard uncommitted changes for this file (لا يمكن التراجع)" }, null, 2) };
  if (name === "git_checkout") return { detail: JSON.stringify({ tool: name, repository: target.relative, branch: input.branch }, null, 2) };
  if (name === "git_reset") return { detail: JSON.stringify({ tool: name, repository: target.relative, mode: input.mode ?? "mixed", operation: "unstage or move HEAD دون لمس ملفات العمل" }, null, 2) };
  if (name === "create_directory") {
    const key2 = operationKey(name, target.relative, "");
    return { detail: JSON.stringify({ tool: name, target: target.relative, operation: "create directory" }, null, 2), rememberKey: key2 };
  }
  const current = await readOptionalText(target.absolute);
  const currentHash = hashText(current);
  let next = current ?? "";
  let payload = "";
  if (name === "write_file") {
    payload = requiredString(input.content, "content");
    next = payload;
  } else if (name === "edit_file") {
    const applied = applyEdit(current ?? "", requiredString(input.old_string, "old_string"), String(input.new_string ?? ""));
    payload = String(input.new_string ?? "");
    next = applied.content;
  } else if (name === "patch_file") {
    const applied = applyPatches(current ?? "", requiredString(input.patches, "patches"));
    payload = String(input.patches);
    next = applied.content;
  } else if (name === "append_file") {
    payload = requiredString(input.content, "content");
    next = current ? `${current}${current.endsWith("\n") ? "" : "\n"}${payload}` : payload;
  }
  const nextHash = hashText(next);
  const preview = sensitive ? { text: "[محتوى ملف حساس محجوب]", truncated: false } : diffPreview(current ?? "", next);
  const detail = JSON.stringify({ tool: name, target: target.relative, currentExists: current !== void 0, currentSha256: currentHash, newSha256: nextHash, contentBytes: Buffer.byteLength(next), diff: preview.text, diffTruncated: preview.truncated }, null, 2);
  const key = sensitive ? void 0 : operationKey(name, target.relative, `${currentHash}:${hashText(payload)}`);
  return { detail, rememberKey: key, verify: async () => {
    const now = await readOptionalText(target.absolute);
    if (hashText(now) !== currentHash) throw new Error("تغير الملف بعد عرض المعاينة؛ أعد قراءة الملف واطلب العملية من جديد.");
  } };
}
async function webFetch(value, maxBytes, signal, deadlineAt) {
  const MAX_REDIRECTS = 2;
  let url = new URL(value);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" || url.username || url.password || isBlockedHost(url.hostname)) throw new Error("يسمح فقط بروابط HTTPS العامة دون بيانات دخول");
    let response;
    try {
      response = await requestPublicHttps(url, maxBytes, signal, deadlineAt);
    } catch (error) {
      if (!(error instanceof Error) || !error.redirectStatus) throw error;
      const location = String(error.headers?.["location"] ?? "");
      if (!location) throw new Error(`إعادة توجيه بلا وجهة من ${url.toString()}`);
      url = new URL(location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`فشل جلب الصفحة (${response.status})`);
    if (!/(?:text|json|xml|javascript)/i.test(response.contentType)) throw new Error(`نوع المحتوى غير مدعوم: ${response.contentType}`);
    const rawContent = response.body.toString("utf8");
    const content = /html/i.test(response.contentType) ? htmlToText(rawContent) : rawContent;
    return success({ url: url.toString(), contentType: response.contentType, bytes: response.body.length, truncated: response.truncated, content });
  }
  throw new Error(`أكثر من ${MAX_REDIRECTS} إعادة توجيه متتالية؛ أُوقف الجلب.`);
}
const webSearchCache = /* @__PURE__ */ new Map();
const WEB_SEARCH_CACHE_MS = 10 * 6e4;
async function webSearch(query, maxResults, signal, deadlineAt) {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("query لا يمكن أن يكون فارغًا");
  const cacheKey = `${trimmed.slice(0, 300)}:${maxResults}`;
  const cached = webSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WEB_SEARCH_CACHE_MS) return success({ query: trimmed, provider: "cache", results: cached.results.slice(0, maxResults) });
  try {
    const results2 = await searchDuckDuckGo(trimmed, maxResults, signal, deadlineAt);
    if (results2.length) {
      webSearchCache.set(cacheKey, { at: Date.now(), results: results2 });
      return success({ query: trimmed, provider: "DuckDuckGo HTML", results: results2 });
    }
  } catch {
  }
  const results = await searchBing(trimmed, maxResults, signal, deadlineAt);
  if (!results.length) throw new Error("لم يُعد البحث أي نتائج من المزودين المتاحين");
  webSearchCache.set(cacheKey, { at: Date.now(), results });
  return success({ query: trimmed, provider: "Bing HTML", results });
}
async function searchDuckDuckGo(query, maxResults, signal, deadlineAt) {
  let url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query.slice(0, 500));
  let response;
  try {
    response = await requestPublicHttps(url, 1e6, signal, deadlineAt);
  } catch (error) {
    if (!(error instanceof Error) || !error.redirectStatus) throw error;
    const location = String(error.headers?.["location"] ?? "");
    if (!location) throw error;
    url = new URL(location, url);
    response = await requestPublicHttps(url, 1e6, signal, deadlineAt);
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`فشل البحث (${response.status})`);
  const html = response.body.toString("utf8");
  const results = [];
  const matcher = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a|<div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)(?:<\/a>|<\/div>)/gi;
  for (const match of html.matchAll(matcher)) {
    const rawUrl = decodeRedirectUrl(match[1] ?? "");
    if (!/^https:\/\//i.test(rawUrl)) continue;
    results.push({ title: htmlToText(match[2] ?? "").slice(0, 300), url: rawUrl, snippet: htmlToText(match[3] ?? "").slice(0, 500) });
    if (results.length >= maxResults) break;
  }
  return results;
}
async function searchBing(query, maxResults, signal, deadlineAt) {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query.slice(0, 500));
  const response = await requestPublicHttps(url, 15e5, signal, deadlineAt);
  if (response.status < 200 || response.status >= 300) throw new Error(`فشل البحث (${response.status})`);
  const html = response.body.toString("utf8");
  const results = [];
  const blockMatcher = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  for (const match of html.matchAll(blockMatcher)) {
    const rawUrl = match[1] ?? "";
    if (!/^https:\/\//i.test(rawUrl)) continue;
    results.push({ title: htmlToText(match[2] ?? "").slice(0, 300), url: rawUrl, snippet: htmlToText(match[3] ?? "").slice(0, 500) });
    if (results.length >= maxResults) break;
  }
  return results;
}
async function requestPublicHttps(url, maxBytes, signal, deadlineAt) {
  const remaining = deadlineAt === void 0 ? 3e4 : deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("انتهى الوقت المتاح لطلب الويب");
  const addresses = await promises.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address))) throw new Error("النطاق يشير إلى شبكة محلية أو عنوان غير مسموح");
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const request = node_https.request(url, { method: "GET", headers: { "user-agent": "Rahma-Code-Agent/1.0" }, servername: url.hostname, lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family) }, (response) => {
      const status = response.statusCode ?? 0;
      const contentType = String(response.headers["content-type"] ?? "");
      if (status >= 300 && status < 400) {
        const headers = response.headers;
        response.resume();
        fail(Object.assign(new Error("REDIRECT"), { redirectStatus: status, headers }));
        return;
      }
      response.on("data", (chunk) => {
        if (settled) return;
        const available = maxBytes - bytes;
        if (available <= 0) {
          truncated = true;
          response.destroy();
          return;
        }
        chunks.push(chunk.subarray(0, available));
        bytes += Math.min(chunk.length, available);
        if (chunk.length > available) {
          truncated = true;
          response.destroy();
        }
      });
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status, contentType, headers: response.headers, body: Buffer.concat(chunks), truncated });
      };
      response.on("end", finish);
      response.on("error", (error) => truncated ? finish() : fail(error));
    });
    const abort = () => {
      request.destroy(new DOMException("تم إلغاء طلب الويب", "AbortError"));
    };
    timeout = setTimeout(() => request.destroy(new Error("انتهت مهلة طلب الويب")), Math.min(3e4, remaining));
    signal.addEventListener("abort", abort, { once: true });
    request.on("error", fail);
    request.end();
  });
}
function decodeRedirectUrl(value) {
  try {
    const url = new URL(value, "https://html.duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : url.toString();
  } catch {
    return "";
  }
}
async function gitStatus(cwd, signal, trackProcess, deadlineAt) {
  return success(await runGit(["status", "--short", "--branch"], cwd, signal, trackProcess, deadlineAt));
}
async function gitDiff(cwd, staged, signal, trackProcess, deadlineAt) {
  return success(await runGit(["diff", "--no-ext-diff", "--unified=3", ...staged ? ["--staged"] : []], cwd, signal, trackProcess, deadlineAt));
}
async function gitLog(cwd, limit, signal, trackProcess, deadlineAt) {
  return success(await runGit(["log", `-${limit}`, "--date=iso", "--pretty=format:%h%n%an%n%ad%n%s%n---"], cwd, signal, trackProcess, deadlineAt));
}
async function gitCommit(cwd, message, all, signal, trackProcess, deadlineAt) {
  if (!message.trim()) throw new Error("رسالة commit لا يمكن أن تكون فارغة");
  if (all) await runGit(["add", "--all"], cwd, signal, trackProcess, deadlineAt);
  return success({ output: await runGit(["-c", "user.name=Rahma Code Agent", "-c", "user.email=rahma@local", "commit", "--message", message.slice(0, 500)], cwd, signal, trackProcess, deadlineAt) });
}
async function gitRevert(cwd, commit, signal, trackProcess, deadlineAt) {
  const hash = commit.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error("commit يجب أن يكون hash صالحًا من 7 إلى 40 خانة");
  const output = await runGit(["-c", "user.name=Rahma Code Agent", "-c", "user.email=rahma@local", "revert", "--no-edit", hash], cwd, signal, trackProcess, deadlineAt);
  const revertCommit = (await runGit(["rev-parse", "HEAD"], cwd, signal, trackProcess, deadlineAt)).trim();
  return success({ reverted: hash, revertCommit, output });
}
async function gitRevertStep(cwd, signal, trackProcess, deadlineAt) {
  const head = (await runGit(["rev-parse", "HEAD"], cwd, signal, trackProcess, deadlineAt)).trim();
  const headMessage = (await runGit(["log", "-1", "--pretty=%s"], cwd, signal, trackProcess, deadlineAt)).replace(/^\uFEFF/, "").trim();
  if (!headMessage.startsWith("تلقائي [")) throw new Error("آخر commit ليس تلقائيًا (gitAutoCommit)؛ استخدم git_revert مع hash محدد.");
  const output = await runGit(["-c", "user.name=Rahma Code Agent", "-c", "user.email=rahma@local", "revert", "--no-edit", head], cwd, signal, trackProcess, deadlineAt);
  const revertCommit = (await runGit(["rev-parse", "HEAD"], cwd, signal, trackProcess, deadlineAt)).trim();
  return success({ revertedStep: head, revertCommit, revertedMessage: headMessage, output });
}
async function deleteFile(target, relative) {
  const stat = await node_fs.promises.lstat(target);
  if (stat.isDirectory()) throw new Error("delete_file يحذف الملفات فقط؛ لا يحذف المجلدات.");
  if (stat.isSymbolicLink()) throw new Error("لا يسمح بحذف روابط رمزية عبر delete_file.");
  await node_fs.promises.rm(target, { force: false });
  return success({ path: relative, deleted: true });
}
async function moveFile(root, fromInput, toInput) {
  const source = await resolveExisting({ canonical: root }, fromInput);
  const sourceStat = await node_fs.promises.lstat(source.absolute);
  if (sourceStat.isDirectory()) throw new Error("move_file ينقل الملفات فقط؛ لا ينقل المجلدات.");
  if (sourceStat.isSymbolicLink()) throw new Error("لا يسمح بنقل روابط رمزية عبر move_file.");
  const destination = await resolveCreatable({ canonical: root }, toInput);
  if (source.absolute === destination.absolute) throw new Error("المصدر والوجهة متطابقان");
  const existing = await node_fs.promises.lstat(destination.absolute).catch(() => null);
  if (existing) throw new Error(`الوجهة موجودة بالفعل: ${destination.relative}`);
  await node_fs.promises.rename(source.absolute, destination.absolute);
  return success({ from: source.relative, to: destination.relative, moved: true });
}
async function appendFile(target, relative, content) {
  if (!content) throw new Error("content لا يمكن أن يكون فارغًا");
  const previous = await readOptionalText(target);
  const next = previous ? `${previous}${previous.endsWith("\n") ? "" : "\n"}${content}` : content;
  await writeFileAtomic(target, relative, next);
  return success({ path: relative, appendedBytes: Buffer.byteLength(content), totalBytes: Buffer.byteLength(next) });
}
async function projectTree(directory, root, maxEntries, signal) {
  const entries = [];
  let count = 0;
  let truncated = false;
  const walk = async (current, depth) => {
    signal.throwIfAborted();
    if (count >= maxEntries) {
      truncated = true;
      return;
    }
    const children = await node_fs.promises.readdir(current, { withFileTypes: true });
    const dirs = children.filter((item) => item.isDirectory() && !item.isSymbolicLink() && !isIgnoredEntry(item.name)).sort((a, b) => a.name.localeCompare(b.name));
    const files = children.filter((item) => item.isFile() && !item.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      if (count >= maxEntries) {
        truncated = true;
        return;
      }
      entries.push({ path: relativePath(root, path.join(current, dir.name)), type: "directory", depth });
      count++;
      await walk(path.join(current, dir.name), depth + 1);
    }
    for (const file of files) {
      if (count >= maxEntries) {
        truncated = true;
        return;
      }
      entries.push({ path: relativePath(root, path.join(current, file.name)), type: "file", depth });
      count++;
    }
  };
  await walk(directory, 0);
  return success({ path: relativePath(root, directory), totalEntries: entries.length, truncated, entries });
}
async function gitBranch(cwd, signal, trackProcess, deadlineAt) {
  return success({ output: await runGit(["branch", "--list"], cwd, signal, trackProcess, deadlineAt) });
}
async function gitShow(cwd, spec, signal, trackProcess, deadlineAt) {
  return success({ output: await runGit(["show", "--no-ext-diff", "--unified=3", spec.trim().slice(0, 500)], cwd, signal, trackProcess, deadlineAt) });
}
async function gitAdd(cwd, files, signal, trackProcess, deadlineAt) {
  const paths = [...new Set(files.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
  if (!paths.length) throw new Error("files لا يمكن أن يكون فارغًا");
  return success({ output: await runGit(["add", "--", ...paths.slice(0, 100)], cwd, signal, trackProcess, deadlineAt) });
}
async function gitRestore(cwd, file, signal, trackProcess, deadlineAt) {
  if (!file.trim()) throw new Error("file لا يمكن أن يكون فارغًا");
  return success({ output: await runGit(["restore", "--", file.trim().slice(0, 1e3)], cwd, signal, trackProcess, deadlineAt) });
}
async function gitCheckout(cwd, branch, signal, trackProcess, deadlineAt) {
  if (!branch.trim()) throw new Error("branch لا يمكن أن يكون فارغًا");
  return success({ output: await runGit(["checkout", branch.trim().slice(0, 500)], cwd, signal, trackProcess, deadlineAt) });
}
async function gitReset(cwd, mode, signal, trackProcess, deadlineAt) {
  if (!["soft", "mixed"].includes(mode)) throw new Error("mode يجب أن يكون soft أو mixed فقط؛ يمنع --hard نهائيًا");
  return success({ output: await runGit(["reset", mode === "soft" ? "--soft" : "--mixed", "HEAD"], cwd, signal, trackProcess, deadlineAt) });
}
async function runGit(args, cwd, signal, trackProcess, deadlineAt) {
  return new Promise((resolve, reject) => {
    const child = node_child_process.spawn("git.exe", args, { cwd, windowsHide: true, env: safeEnvironment$1() });
    trackProcess?.(child);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const append = (chunk) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      const remaining2 = MAX_OUTPUT_BYTES - bytes;
      chunks.push(chunk.subarray(0, remaining2));
      bytes += Math.min(chunk.length, remaining2);
    };
    const kill = () => {
      if (!child.killed) child.kill();
    };
    const abort = () => kill();
    signal.addEventListener("abort", abort, { once: true });
    const remaining = deadlineAt === void 0 ? 6e4 : deadlineAt - Date.now();
    if (remaining <= 0) {
      kill();
      reject(new Error("انتهى الوقت المتاح لـ Git"));
      return;
    }
    const timeout = setTimeout(kill, Math.min(6e4, remaining));
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const output = Buffer.concat(chunks).toString("utf8");
      if (signal.aborted) reject(new DOMException("تم إلغاء Git", "AbortError"));
      else if (code !== 0) reject(new Error(`فشل Git (${code ?? -1}): ${output.slice(0, 4e3)}`));
      else resolve(output);
    });
    function cleanup() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  });
}
async function maybeAutoCommit(context, repoRoot, action, relatives) {
  if (!context.session.gitTracked) return void 0;
  const paths = [...new Set(relatives)].filter((item) => item && item !== ".");
  if (!paths.length) return { enabled: true, committed: false, paths, error: "لا توجد مسارات قابلة للحفظ" };
  try {
    const gitOptions = { signal: context.signal, timeoutMs: 3e4, trackProcess: context.trackProcess };
    await runGitQuiet(["add", "--all", "--", ...paths], repoRoot, gitOptions);
    await runGitQuiet(["-c", "user.name=Rahma Code Agent", "-c", "user.email=rahma@local", "commit", "--only", "--message", `تلقائي [${action}] ${paths.join(", ")}`.slice(0, 200), "--", ...paths], repoRoot, gitOptions);
    return { enabled: true, committed: true, commit: (await runGitQuiet(["rev-parse", "HEAD"], repoRoot, gitOptions)).trim(), paths };
  } catch (error) {
    return { enabled: true, committed: false, paths, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
  }
}
function withAutoCommit(output, gitAutoCommit) {
  if (!gitAutoCommit) return output;
  try {
    const parsed = JSON.parse(output);
    if (parsed.ok && parsed.data && typeof parsed.data === "object") return success({ ...parsed.data, gitAutoCommit });
  } catch {
  }
  return output;
}
async function ensureGitRepository(workspace) {
  const root = await canonicalWorkspace(workspace);
  const gitignorePath = path.join(root.canonical, ".gitignore");
  let gitignore = false;
  try {
    await node_fs.promises.access(gitignorePath);
  } catch {
    await node_fs.promises.writeFile(gitignorePath, "node_modules\nout\ndist\nrelease-*\ndist-v*\nwin-unpacked*\n*.tmp\n*.log\n.DS_Store\n", "utf8");
    gitignore = true;
  }
  let initialized = false;
  try {
    await node_fs.promises.access(path.join(root.canonical, ".git"));
  } catch {
    await runGitQuiet(["init", "-b", "main"], root.canonical, { timeoutMs: 12e4 });
    initialized = true;
  }
  let committed = false;
  try {
    await runGitQuiet(["add", "--all"], root.canonical, { timeoutMs: 12e4 });
    await runGitQuiet(["-c", "user.name=Rahma Code Agent", "-c", "user.email=rahma@local", "commit", "--allow-empty", "--message", "بداية المشروع: قاعدة أولية"], root.canonical, { timeoutMs: 12e4 });
    committed = true;
  } catch {
  }
  return { initialized, committed, gitignore };
}
async function runGitQuiet(args, cwd, options = {}) {
  const { signal, timeoutMs = 3e4, trackProcess } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("تم إلغاء Git", "AbortError"));
      return;
    }
    const child = node_child_process.spawn("git.exe", args, { cwd, windowsHide: true, env: safeEnvironment$1() });
    trackProcess?.(child);
    const chunks = [];
    let settled = false;
    let timedOut = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (!child.killed) child.kill();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill();
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      const output = Buffer.concat(chunks).toString("utf8");
      if (signal?.aborted) reject(new DOMException("تم إلغاء Git", "AbortError"));
      else if (timedOut) reject(new Error(`انتهت مهلة Git التلقائي (${timeoutMs}ms): ${output.slice(0, 500)}`));
      else if (exitCode === 0) resolve(output);
      else reject(new Error(output.slice(0, 2e3)));
    });
  });
}
function isBlockedHost(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || Boolean(node_net.isIP(value) && isBlockedAddress(value));
}
function isBlockedAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  if (mapped) return isBlockedAddress(mapped);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isBlockedAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }
  if (node_net.isIP(value) === 4) {
    const parts = value.split(".").map(Number);
    const first = parts[0] ?? 0;
    const second = parts[1] ?? 0;
    return first === 0 || first === 10 || first === 127 || first >= 224 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first === 100 && second >= 64 && second <= 127 || first === 198 && (second === 18 || second === 19);
  }
  if (node_net.isIP(value) === 6) {
    if (value === "::" || value === "::1") return true;
    const first = Number.parseInt(value.split(":")[0] || "0", 16);
    return first >= 64512 && first <= 65023 || first >= 65152 && first <= 65215 || first >= 65280;
  }
  return true;
}
function htmlToText(value) {
  return decodeHtmlEntities(value.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}
function decodeHtmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
    }
    return named[entity.toLowerCase()] ?? " ";
  });
}
function isSensitive(value) {
  const normalized = value.replaceAll("\\", "/");
  return /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|ed25519)|credentials|auth\.json|provider\.json|kubeconfig)(?:$|\/)/i.test(normalized) || /(?:^|\/)(?:\.ssh|\.aws|\.azure)(?:\/|$)/i.test(normalized);
}
function isCriticalCommand(command) {
  return /(?:Remove-Item\s+.*(?:-Recurse|-Force)|Format-Volume|Clear-Disk|Stop-Computer|Restart-Computer|Set-MpPreference|reg(?:\.exe)?\s+delete|diskpart|bcdedit|cipher\s+\/w|taskkill\s+.*\/f)/i.test(command);
}
function safeEnvironment$1() {
  return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT };
}
function success(data) {
  return JSON.stringify({ ok: true, data }, null, 2);
}
function failure(code, message) {
  return JSON.stringify({ ok: false, error: { code, message } }, null, 2);
}
function requiredString(value, field) {
  if (typeof value !== "string") throw new Error(`${field} يجب أن يكون نصًا`);
  return value;
}
function optionalString(value) {
  return typeof value === "string" && value ? value : void 0;
}
function number(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}
function globRegex(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += escapeRegex(char);
  }
  return new RegExp(`${source}$`, "i");
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function tool(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
function str(description) {
  return { type: "string", description };
}
function bool(description) {
  return { type: "boolean", description };
}
function integer(description, minimum, maximum) {
  return { type: "integer", description, minimum, ...maximum ? { maximum } : {} };
}
class McpManager {
  constructor(globalConfigPath) {
    this.globalConfigPath = globalConfigPath;
  }
  globalConfigPath;
  connections = /* @__PURE__ */ new Map();
  bindings = /* @__PURE__ */ new Map();
  async tools(workspace, signal, trackProcess, approve) {
    const config = await mergeConfigs(this.globalConfigPath, path.join(workspace, ".mcp.json"));
    const key = path.resolve(workspace);
    const existing = this.connections.get(key) ?? /* @__PURE__ */ new Map();
    this.connections.set(key, existing);
    const configured = new Set(Object.entries(config?.mcpServers ?? {}).filter((entry) => Boolean(entry[1] && (typeof entry[1].command === "string" && entry[1].command.trim() || typeof entry[1].url === "string" && entry[1].url.trim()))).map(([name]) => name));
    for (const [serverName, managed] of existing) if (!configured.has(serverName)) {
      existing.delete(serverName);
      this.removeBindings(key, serverName);
      await managed.connection.close();
    }
    if (!config) {
      if (!existing.size) this.connections.delete(key);
      return [];
    }
    const definitions = [];
    for (const [serverName, raw] of Object.entries(config.mcpServers ?? {})) {
      const isRemote = Boolean(raw && typeof raw.url === "string" && raw.url.trim().length > 0);
      if (!isRemote && (!raw || typeof raw.command !== "string" || !raw.command.trim())) continue;
      const normalized = isRemote ? { url: String(raw.url), headers: objectStrings(raw.headers) } : { command: String(raw.command), args: Array.isArray(raw.args) ? raw.args.filter((item) => typeof item === "string") : [], env: objectStrings(raw.env) };
      const fingerprint = configFingerprint(normalized);
      let managed = existing.get(serverName);
      if (managed && (managed.fingerprint !== fingerprint || !managed.connection.isAlive())) {
        existing.delete(serverName);
        this.removeBindings(key, serverName);
        await managed.connection.close();
        managed = void 0;
      }
      if (!managed) {
        const preview = isRemote ? { server: serverName, url: normalized.url } : { server: serverName, command: redactMcpText(normalized.command), args: normalized.args.map(redactMcpText), envNames: Object.keys(normalized.env).sort() };
        if (approve && !await approve(`السماح بتشغيل خادم MCP ${serverName}؟`, JSON.stringify(preview, null, 2))) continue;
        const connection2 = isRemote ? new RemoteMcpConnection(normalized) : new McpConnection(normalized, workspace);
        managed = { fingerprint, connection: connection2 };
        existing.set(serverName, managed);
        try {
          await connection2.start(signal);
          if (connection2.child) trackProcess?.(connection2.child);
        } catch (error) {
          existing.delete(serverName);
          await connection2.close();
          throw new Error(`تعذر تشغيل خادم MCP ${serverName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const connection = managed.connection;
      this.removeBindings(key, serverName);
      const listed = await connection.listTools(signal);
      for (const tool2 of listed) {
        if (!tool2.name || !/^[\w.-]+$/.test(tool2.name)) continue;
        const name = exposedName(serverName, tool2.name);
        const definition = { type: "function", function: { name, description: `[MCP ${serverName}] ${tool2.description ?? tool2.name}`, parameters: tool2.inputSchema && typeof tool2.inputSchema === "object" ? tool2.inputSchema : { type: "object", properties: {}, additionalProperties: true } } };
        this.bindings.set(`${key}:${name}`, { server: serverName, originalName: tool2.name, connection });
        definitions.push(definition);
      }
    }
    return definitions;
  }
  removeBindings(workspace, server) {
    for (const [key, binding] of this.bindings) if (key.startsWith(`${workspace}:`) && binding.server === server) this.bindings.delete(key);
  }
  async call(name, input, signal, workspace) {
    const binding = workspace ? this.bindings.get(`${path.resolve(workspace)}:${name}`) : [...this.bindings.entries()].find(([key]) => key.endsWith(`:${name}`))?.[1];
    if (!binding) throw new Error(`أداة MCP غير موجودة أو انتهت جلسة الخادم: ${name}`);
    return binding.connection.callTool(binding.originalName, input, signal);
  }
  async close() {
    const connections = [...this.connections.values()].flatMap((items) => [...items.values()].map((item) => item.connection));
    this.connections.clear();
    this.bindings.clear();
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }
}
class McpConnection {
  constructor(config, cwd) {
    this.config = config;
    this.cwd = cwd;
  }
  config;
  cwd;
  child;
  reader = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  closed = null;
  stderrTail = "";
  isAlive() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }
  async start(signal) {
    if (this.child) return;
    const command = process.platform === "win32" && ["npx", "npm", "pnpm", "yarn"].includes(this.config.command.toLowerCase()) ? `${this.config.command}.cmd` : this.config.command;
    const commandLine = [command, ...this.config.args].map(commandArgument).join(" ");
    const executable = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command) ? process.env.ComSpec ?? "cmd.exe" : command;
    const args = executable === (process.env.ComSpec ?? "cmd.exe") ? ["/d", "/s", "/c", commandLine] : this.config.args;
    this.child = node_child_process.spawn(executable, args, { cwd: this.cwd, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env: safeEnvironment(this.config.env) });
    this.reader = node_readline.createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => this.receive(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-65536);
    });
    const closed = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
        resolve(error instanceof Error ? error : new Error(String(error)));
      });
      this.child.once("close", (code) => {
        const error = new Error(`أغلق خادم MCP الاتصال (${code ?? -1})`);
        this.rejectPending(error);
        resolve(error);
      });
    });
    this.closed = closed;
    const response = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Rahma Code Agent", version: "0.5.0" } }, signal);
    if (!response) throw new Error("استجابة تهيئة MCP فارغة");
    this.notify("notifications/initialized", {});
  }
  async listTools(signal) {
    const result = await this.request("tools/list", {}, signal);
    return Array.isArray(result?.tools) ? result.tools : [];
  }
  async callTool(name, input, signal) {
    const result = await this.request("tools/call", { name, arguments: input }, signal);
    const content = Array.isArray(result?.content) ? result.content.map((part) => part?.type === "text" ? String(part.text ?? "") : JSON.stringify(part)).join("\n") : result?.structuredContent ? JSON.stringify(result.structuredContent) : "";
    return JSON.stringify({ ok: !result?.isError, data: { content: content.slice(0, 5e5), isError: Boolean(result?.isError) } }, null, 2);
  }
  async close() {
    this.rejectPending(new Error("أغلق خادم MCP"));
    this.reader?.close();
    this.reader = null;
    if (this.child && !this.child.killed) this.child.kill();
    if (this.closed) await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 1e3))]);
  }
  request(method, params, signal) {
    if (!this.child || this.child.killed) return Promise.reject(new Error("خادم MCP غير متصل"));
    if (signal.aborted) return Promise.reject(new DOMException("تم إلغاء طلب MCP", "AbortError"));
    const id2 = this.nextId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id2);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => settle(new Error(`انتهت مهلة MCP للطلب ${method}`)), 3e4);
      const abort = () => settle(new DOMException("تم إلغاء طلب MCP", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id2, { resolve: (value) => settle(null, value), reject: (error) => settle(error), timer, abort });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: id2, method, params })}
`);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  notify(method, params) {
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}
`);
    } catch {
    }
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  receive(line) {
    try {
      const message = JSON.parse(line);
      if (message.id === void 0) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "خطأ MCP غير معروف"));
      else pending.resolve(message.result);
    } catch {
    }
  }
}
class RemoteMcpConnection {
  constructor(config) {
    this.config = config;
  }
  config;
  nextId = 1;
  alive = false;
  child;
  isAlive() {
    return this.alive;
  }
  async start(signal) {
    const url = new URL(this.config.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("يسمح فقط بروابط MCP عن بُعد HTTP/HTTPS");
    const response = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Rahma Code Agent", version: "0.5.0" } }, signal);
    if (!response) throw new Error("استجابة تهيئة MCP عن بُعد فارغة");
    this.alive = true;
    try {
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, signal);
    } catch {
    }
  }
  async listTools(signal) {
    const result = await this.request("tools/list", {}, signal);
    return Array.isArray(result?.tools) ? result.tools : [];
  }
  async callTool(name, input, signal) {
    const result = await this.request("tools/call", { name, arguments: input }, signal);
    const content = Array.isArray(result?.content) ? result.content.map((part) => part?.type === "text" ? String(part.text ?? "") : JSON.stringify(part)).join("\n") : result?.structuredContent ? JSON.stringify(result.structuredContent) : "";
    return JSON.stringify({ ok: !result?.isError, data: { content: content.slice(0, 5e5), isError: Boolean(result?.isError) } }, null, 2);
  }
  async close() {
    this.alive = false;
  }
  async request(method, params, signal) {
    if (signal.aborted) throw new DOMException("تم إلغاء طلب MCP", "AbortError");
    const id2 = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id: id2, method, params }, signal);
    return response;
  }
  async post(payload, signal) {
    const url = new URL(this.config.url);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("انتهت مهلة طلب MCP عن بُعد")), 6e4);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.config.headers }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok) throw new Error(`فشل خادم MCP عن بُعد (${response.status}): ${(await response.text()).slice(0, 1e3)}`);
      const contentType = String(response.headers.get("content-type") ?? "");
      const text = await response.text();
      if (/\bjson\b/i.test(contentType)) {
        const parsed2 = JSON.parse(text);
        if (parsed2?.error) throw new Error(parsed2.error.message ?? "خطأ MCP غير معروف");
        return parsed2?.result ?? parsed2;
      }
      if (/text\/event-stream/i.test(contentType)) {
        for (const block of text.split(/\r?\n\r?\n/)) {
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data || data === "[DONE]") continue;
          try {
            const parsed2 = JSON.parse(data);
            if (parsed2?.error) throw new Error(parsed2.error.message ?? "خطأ MCP غير معروف");
            if (parsed2?.id === payload.id) return parsed2.result ?? parsed2;
          } catch {
            continue;
          }
        }
        throw new Error("لم يستجب خادم MCP عن بُعد بحل متطابق");
      }
      const parsed = JSON.parse(text);
      if (parsed?.error) throw new Error(parsed.error.message ?? "خطأ MCP غير معروف");
      return parsed?.result ?? parsed;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
async function mergeConfigs(globalPath, workspacePath) {
  const [global, workspace] = await Promise.all([readConfigFile(globalPath, "إعداد MCP العام"), readConfigFile(workspacePath, "ملف .mcp.json")]);
  if (!global && !workspace) return null;
  return { mcpServers: { ...global?.mcpServers ?? {}, ...workspace?.mcpServers ?? {} } };
}
async function readConfigFile(filePath2, label) {
  if (!filePath2) return null;
  try {
    const text = await node_fs.promises.readFile(filePath2, "utf8");
    if (Buffer.byteLength(text) > 1e6) throw new Error("ملف MCP أكبر من الحد");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${label} غير صالح: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function objectStrings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string"));
}
function safeEnvironment(extra) {
  return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, ...extra };
}
function exposedName(server, tool2) {
  const normalized = tool2.replaceAll("-", "_");
  return server === "tavily" ? normalized.startsWith("tavily_") ? normalized : `tavily_${normalized}` : `mcp_${server.replaceAll(/[^a-zA-Z0-9_]/g, "_")}_${normalized}`;
}
function commandArgument(value) {
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/["^]/g, (character) => `^${character}`)}"` : value;
}
function redactMcpText(value) {
  return value.replace(/((?:tavily)?api[_-]?key=)[^&\s]+/gi, "$1[محجوب]").replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s&]+/gi, "$1[محجوب]");
}
function configFingerprint(config) {
  return node_crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
const MAX_STEPS = 30;
const MAX_RUNTIME_MS = 30 * 6e4;
const APPROVAL_TIMEOUT_MS = 5 * 6e4;
const MAX_PARALLEL_READ_TOOLS = 6;
const SUBAGENT_MAX_STEPS = 10;
const SUBAGENT_MAX_RUNTIME_MS = 8 * 6e4;
const PARALLEL_READ_TOOLS = /* @__PURE__ */ new Set(["read_file", "read_files", "read_message", "count_lines", "list_directory", "glob_files", "search_files", "search_symbols", "get_file_info", "tree"]);
const SUBAGENT_TOOL_NAMES = /* @__PURE__ */ new Set(["read_file", "read_files", "read_message", "count_lines", "list_directory", "glob_files", "search_files", "search_symbols", "get_file_info", "tree", "load_skill", "web_fetch", "web_search", "git_status", "git_diff", "git_log", "git_branch", "git_show"]);
const projectInstructionsCache = /* @__PURE__ */ new Map();
class AgentRunner {
  constructor(db, providers, getWebContents, modelRequest = requestModel, mcp = new McpManager()) {
    this.db = db;
    this.providers = providers;
    this.getWebContents = getWebContents;
    this.modelRequest = modelRequest;
    this.mcp = mcp;
    this.db.repairIncompleteToolCalls();
  }
  db;
  providers;
  getWebContents;
  modelRequest;
  mcp;
  runs = /* @__PURE__ */ new Map();
  approvals = /* @__PURE__ */ new Map();
  approvalGrants = /* @__PURE__ */ new Map();
  states() {
    return [...this.runs].map(([sessionId, run]) => ({ sessionId, runId: run.runId, state: run.controller.signal.aborted ? "cancelling" : this.hasApproval(sessionId, run.runId) ? "awaiting_approval" : "running", status: run.status, error: run.error, pendingApprovals: [...this.approvals.values()].filter((item) => item.sessionId === sessionId && item.runId === run.runId).map((item) => item.request) }));
  }
  async send(sessionId, text, attachments) {
    const existing = this.runs.get(sessionId);
    if (existing) {
      if (existing.initializing) await existing.ready;
      const current = this.runs.get(sessionId);
      if (!current || current !== existing) throw new Error("انتهى التشغيل قبل قبول الرسالة؛ أعد الإرسال.");
      if (current.controller.signal.aborted) throw new Error("ينهي الوكيل الإيقاف الحالي؛ أعد الإرسال بعد ظهوره متوقفًا.");
      const message = this.db.addMessage({ sessionId, role: "user", content: text });
      current.pendingMessages.push(message);
      this.db.addAudit({ sessionId, category: "agent", action: "queue", detail: text.slice(0, 1e3), outcome: "started" });
      this.emit({ sessionId, runId: current.runId, type: "message", message });
      this.setStatus(sessionId, "تصل رسالتك للوكيل في الجولة التالية...", current);
      return;
    }
    const config = this.providers.get();
    if (!config.apiKey) throw new Error("أضف مفتاح API من الإعدادات أولًا");
    if (attachments?.length) {
      const unsupported = attachments.find((attachment) => attachment.mimeType.startsWith("image/") ? !modelSupportsModality(config.model, "image") : attachment.mimeType.startsWith("video/") ? !modelSupportsModality(config.model, "video") : false);
      if (unsupported) throw new Error(`النموذج ${config.model} لا يدعم مرفقات من نوع ${unsupported.mimeType}. غيّر النموذج من الإعدادات أو أزل المرفق.`);
    }
    const session = this.db.getSession(sessionId);
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const controller = new AbortController();
    const run = { runId: node_crypto.randomUUID(), controller, startedAt: Date.now(), deadlineAt: Date.now() + MAX_RUNTIME_MS, status: "يبدأ التنفيذ...", pendingMessages: [], childProcesses: /* @__PURE__ */ new Set(), initializing: true, ready, resolveReady, rejectReady };
    this.runs.set(sessionId, run);
    try {
      const workspace = await node_fs.promises.realpath(session.workspace);
      if (!(await node_fs.promises.stat(workspace)).isDirectory()) throw new Error();
      const userMessage = this.db.addMessage({ sessionId, role: "user", content: text, attachments });
      this.db.addAudit({ sessionId, category: "agent", action: "run", detail: text.slice(0, 1e3), outcome: "started" });
      this.emit({ sessionId, runId: run.runId, type: "message", message: userMessage });
      run.initializing = false;
      run.resolveReady();
      run.promise = this.runLoop(session, config, run);
      void run.promise;
    } catch (error) {
      run.initializing = false;
      const message = error instanceof Error && error.message ? error.message : `مساحة عمل هذه الجلسة لم تعد موجودة: ${session.workspace}
افتح مجلد المشروع الصحيح من زر "فتح مشروع" ثم أعد المحاولة.`;
      run.rejectReady(new Error(message));
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId);
      throw new Error(message);
    }
  }
  async runLoop(session, config, run) {
    const sessionId = session.id;
    const controller = run.controller;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        this.assertRunning(run);
        this.drainPending(sessionId, run);
        this.setStatus(sessionId, step ? `يحلل نتيجة الخطوة ${step}...` : "يحلل المشروع ويجهز السياق...", run);
        const availableTools = [...toolDefinitions, ...await this.mcp.tools(session.workspace, controller.signal, (child) => {
          run.childProcesses.add(child);
          child.once("close", () => run.childProcesses.delete(child));
        }, session.permissionMode === "ask" ? (title, detail) => this.approve(sessionId, run, title, detail, true) : void 0)];
        const prepared = await this.buildContext(session, config, availableTools, controller.signal, run.deadlineAt, run.runId);
        const estimatedTokens = estimateModelRequestTokens(config, prepared.messages, availableTools, prepared.maxOutputTokens);
        this.emit({ sessionId, runId: run.runId, type: "context", context: { estimatedTokens, compacted: prepared.compacted, contextWindow: config.contextWindow } });
        const streamId = node_crypto.randomUUID();
        let streamed = false;
        this.emit({ sessionId, runId: run.runId, type: "stream", stream: { id: streamId, delta: "", state: "start" } });
        let reply;
        try {
          const emitDelta = (delta) => {
            streamed = true;
            this.emit({ sessionId, runId: run.runId, type: "stream", stream: { id: streamId, delta, state: "delta" } });
          };
          const emitReasoningDelta = (delta) => {
            this.emit({ sessionId, runId: run.runId, type: "stream", stream: { id: streamId, delta, state: "delta", reasoning: true } });
          };
          try {
            reply = await this.modelRequest(config, prepared.messages, availableTools, { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 6e5, retries: 2, maxOutputTokens: prepared.maxOutputTokens, onTextDelta: emitDelta, onReasoningDelta: emitReasoningDelta });
            this.recordUsage(sessionId, run, config, reply.usage, estimatedTokens, "agent", streamId);
          } catch (error) {
            if (!(error instanceof ContextOverflowError) || streamed) throw error;
            this.setStatus(sessionId, "رفض المزود حجم السياق؛ يعيد بناء ذاكرة العمل ويحاول مرة واحدة...", run);
            const recovered = forceCompactForOverflow(prepared.messages);
            reply = await this.modelRequest(config, recovered, availableTools, { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 6e5, retries: 0, maxOutputTokens: prepared.maxOutputTokens, onTextDelta: emitDelta, onReasoningDelta: emitReasoningDelta });
            this.recordUsage(sessionId, run, config, reply.usage, estimateModelRequestTokens(config, recovered, availableTools, prepared.maxOutputTokens), "overflow-recovery", streamId);
          }
          if (!reply.toolCalls.length && reply.finishReason === "length") {
            let combinedText = reply.text;
            let combinedUsage = reply.usage;
            const continuationContext = [...prepared.messages, { role: "assistant", content: reply.text, providerPayload: reply.providerPayload }];
            while (reply.finishReason === "length") {
              this.assertRunning(run);
              this.setStatus(sessionId, "يتابع الرد تلقائيًا بعد بلوغ حد إخراج المزود...", run);
              continuationContext.push({ role: "user", content: "تابع مباشرة من آخر موضع دون تكرار، وأكمل الرد حتى النهاية." });
              const next = await this.modelRequest(config, continuationContext, [], { signal: controller.signal, deadlineAt: run.deadlineAt, concurrencyKey: `session:${sessionId}`, timeoutMs: 6e5, retries: 2, maxOutputTokens: prepared.maxOutputTokens, onTextDelta: emitDelta });
              this.recordUsage(sessionId, run, config, next.usage, estimateModelRequestTokens(config, continuationContext, [], prepared.maxOutputTokens), "continuation", streamId);
              combinedUsage = mergeUsage(combinedUsage, next.usage);
              if (!next.text.trim() || next.text === reply.text || combinedText.endsWith(next.text)) {
                reply = { ...next, text: combinedText, finishReason: "stop", providerPayload: void 0, usage: combinedUsage };
                break;
              }
              combinedText += next.text;
              continuationContext.push({ role: "assistant", content: next.text, providerPayload: next.providerPayload });
              reply = { ...next, text: combinedText, providerPayload: void 0, usage: combinedUsage };
            }
          }
        } finally {
          this.emit({ sessionId, runId: run.runId, type: "stream", stream: { id: streamId, delta: "", state: "done" } });
        }
        if (reply.toolCalls.length === 0) {
          if (reply.finishReason === "length") reply.finishReason = "stop";
          if (reply.finishReason === "content_filter") throw new Error("أوقف المزود الرد بسبب سياسة المحتوى.");
          if (reply.finishReason !== "stop") throw new Error(`انتهى النموذج بحالة غير مكتملة: ${reply.finishReason}`);
          if (!reply.text.trim()) throw new Error("أعاد النموذج ردًا فارغًا دون تنفيذ أدوات.");
          const message = this.db.addMessage({ id: streamId, sessionId, role: "assistant", content: reply.text, reasoning: reply.reasoning, providerPayload: reply.providerPayload, usage: reply.usage });
          this.emit({ sessionId, runId: run.runId, type: "message", message });
          if (run.pendingMessages.length) {
            this.setStatus(sessionId, "وصلت رسائل متابعة، يواصل الوكيل مع السياق المحدّث...", run);
            continue;
          }
          return;
        }
        validateCallIds(reply.toolCalls);
        const validations = reply.toolCalls.map((call) => validateToolCall(call, availableTools));
        const records = reply.toolCalls.map((call, index) => ({ id: call.id, name: call.name, input: validations[index].input, status: "running", step: step + 1, startedAt: Date.now() }));
        const thought = this.db.addMessage({ id: streamId, sessionId, role: "assistant", content: reply.text, reasoning: reply.reasoning, toolCalls: records, providerPayload: reply.providerPayload, usage: reply.usage });
        this.emit({ sessionId, runId: run.runId, type: "message", message: thought });
        const executeCall = async (index) => {
          const call = reply.toolCalls[index];
          const validation = validations[index];
          const record = records[index];
          this.db.addAudit({ sessionId, category: "tool", action: call.name, detail: JSON.stringify(projectToolInput(call.name, record.input)), outcome: "started" });
          this.emit({ sessionId, runId: run.runId, type: "tool", tool: record });
          let output;
          if (!validation.ok) {
            output = JSON.stringify({ ok: false, error: { code: "INVALID_TOOL_INPUT", message: validation.error } }, null, 2);
            record.status = "error";
          } else if (controller.signal.aborted) {
            output = JSON.stringify({ ok: false, error: { code: "ABORTED", message: "تم الإلغاء قبل تنفيذ الأداة." } }, null, 2);
            record.status = "error";
          } else {
            try {
              output = await executeTool(call.name, validation.input, { session: this.db.getSession(sessionId), signal: controller.signal, deadlineAt: run.deadlineAt, maxOutputChars: Math.min(15e5, Math.max(12e4, Math.floor(config.contextWindow * 1.2))), mcp: this.mcp, trackProcess: (child) => {
                run.childProcesses.add(child);
                child.once("close", () => run.childProcesses.delete(child));
              }, approve: (title, detail, critical, rememberKey) => this.approve(sessionId, run, title, detail, critical, rememberKey), readStoredMessage: (id2) => Promise.resolve(this.db.getStoredMessage(sessionId, id2)), loadSkill: (name) => loadSkillFromWorkspace(session.workspace, name), todos: { get: () => Promise.resolve(this.db.getTodos(sessionId)), set: (items) => {
                const todos = this.db.setTodos(sessionId, items);
                this.emit({ sessionId, runId: run.runId, type: "todo", todos });
                return Promise.resolve(todos);
              } }, runSubagent: (input, subSignal) => this.runSubagent(this.db.getSession(sessionId), config, run, input, subSignal), runSubagentBatch: (tasks, subSignal) => this.runSubagentBatch(this.db.getSession(sessionId), config, run, tasks, subSignal), runCommand: async (name, argumentsText) => {
                const commands = await loadProjectCommands(session.workspace);
                const command = commands.find((item) => item.name === name);
                if (!command) return { ok: false, error: `أمر غير معروف: ${name}` };
                return { ok: true, output: renderCommandTemplate(command.template, argumentsText ?? "") };
              } });
              record.status = output.includes('"ok": false') ? output.includes("APPROVAL_DENIED") || output.includes("PLAN_MODE") ? "denied" : "error" : "completed";
            } catch (error) {
              output = JSON.stringify({ ok: false, error: { code: controller.signal.aborted ? "ABORTED" : "TOOL_ERROR", message: error instanceof Error ? error.message : String(error) } }, null, 2);
              record.status = "error";
            }
          }
          const outputLimit = call.name === "read_files" || call.name === "tree" ? Math.min(16e5, Math.max(15e4, Math.floor(config.contextWindow * 1.3))) : call.name === "web_fetch" ? Math.min(6e5, Math.max(25e4, Math.floor(config.contextWindow * 0.4))) : 1e5;
          record.output = output.slice(0, outputLimit);
          record.completedAt = Date.now();
        };
        const persistCall = (index) => {
          const call = reply.toolCalls[index];
          const record = records[index];
          this.db.completeToolCall(thought.id, records, { sessionId, role: "tool", content: record.output ?? "", toolCallId: call.id, toolName: call.name });
          this.db.addAudit({ sessionId, category: "tool", action: call.name, detail: (record.output ?? "").slice(0, 4e3), outcome: record.status === "completed" ? "completed" : record.status === "denied" ? "denied" : "failed" });
          this.emit({ sessionId, runId: run.runId, type: "tool", tool: record });
        };
        const parallel = reply.toolCalls.length > 1 && reply.toolCalls.every((call, index) => validations[index].ok && PARALLEL_READ_TOOLS.has(call.name));
        if (parallel) {
          this.setStatus(sessionId, `ينفذ ${reply.toolCalls.length} عمليات قراءة وبحث بالتوازي...`, run);
          await runWithConcurrency(reply.toolCalls.length, MAX_PARALLEL_READ_TOOLS, executeCall);
          for (let index = 0; index < reply.toolCalls.length; index++) persistCall(index);
        } else {
          for (let index = 0; index < reply.toolCalls.length; index++) {
            await executeCall(index);
            persistCall(index);
          }
        }
      }
      throw new Error(`وصل الوكيل إلى حد ${MAX_STEPS} جولة. أرسل رسالة متابعة ليكمل.`);
    } catch (error) {
      if (controller.signal.aborted) {
        this.db.addAudit({ sessionId, category: "agent", action: "run", detail: "ألغى المستخدم التشغيل", outcome: "cancelled" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.db.addAudit({ sessionId, category: "agent", action: "run", detail: message, outcome: "failed" });
        run.error = message;
        this.emit({ sessionId, runId: run.runId, type: "error", text: message });
      }
    } finally {
      this.cancelApprovals(sessionId, run.runId);
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId);
      this.emit({ sessionId, runId: run.runId, type: "status", text: controller.signal.aborted ? "تم إيقاف التنفيذ." : "" });
    }
  }
  cancel(sessionId) {
    const run = this.runs.get(sessionId);
    if (!run) return;
    for (const child of run.childProcesses) {
      try {
        child.kill();
      } catch {
      }
    }
    run.controller.abort();
    this.cancelApprovals(sessionId, run.runId);
    this.setStatus(sessionId, "تم إيقاف التنفيذ.", run);
  }
  answerApproval(id2, allowed, remember = false) {
    const pending = this.approvals.get(id2);
    if (!pending) throw new Error("طلب الموافقة منتهي أو غير موجود");
    this.approvals.delete(id2);
    clearTimeout(pending.timer);
    pending.abort();
    if (allowed && remember && pending.rememberKey) this.approvalGrantsFor(pending.sessionId).add(pending.rememberKey);
    this.db.addAudit({ sessionId: pending.sessionId, category: "approval", action: id2, detail: allowed ? remember && pending.rememberKey ? "سمح المستخدم وحفظ القرار لبقية الجلسة" : "سمح المستخدم" : "رفض المستخدم", outcome: allowed ? "allowed" : "denied" });
    pending.resolve(allowed);
  }
  async shutdown() {
    const runs = [...this.runs.values()];
    for (const run of runs) {
      for (const child of run.childProcesses) {
        try {
          child.kill();
        } catch {
        }
      }
      run.controller.abort();
      this.cancelApprovalsForRun(run, new DOMException("يتم إغلاق التطبيق", "AbortError"));
    }
    await Promise.allSettled(runs.map((run) => run.promise).filter((promise) => Boolean(promise)));
    await this.mcp.close();
  }
  forgetSession(sessionId) {
    this.approvalGrants.delete(sessionId);
    this.cancelApprovals(sessionId);
  }
  async buildContext(session, config, definitions, signal, deadlineAt, runId) {
    const maxOutputTokens = Math.min(config.maxOutputTokens, Math.max(2048, Math.floor(config.contextWindow * 0.25)));
    const safetyTokens = Math.max(8e3, Math.floor(config.contextWindow * 0.08));
    const hardLimit = config.contextWindow - maxOutputTokens - safetyTokens;
    let history = this.db.listStoredMessages(session.id);
    let summary = this.db.getSummary(session.id);
    let compacted = false;
    const instructions = await projectInstructions(session.workspace);
    const commands = await loadProjectCommands(session.workspace);
    const toolHints = buildToolHints(definitions);
    let messages = makeContext(session, instructions, summary.text, history.filter((message) => message.sequence > summary.throughSequence), commands, toolHints);
    let estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens);
    if (estimatedTokens > hardLimit) {
      const turns = userTurns(history.filter((message) => message.sequence > summary.throughSequence));
      const candidates = turns.slice(0, Math.max(0, turns.length - 2));
      if (candidates.length) {
        const cut = candidates.at(-1).at(-1).sequence;
        const content = candidates.flat().map(summaryLine).join("\n").slice(0, 1e5);
        try {
          const compactReply = await this.modelRequest(config, [
            { role: "system", content: "لخص سجل وكيل برمجي بدقة شديدة. احتفظ بالهدف والقيود والقرارات والملفات المعدلة ونتائج الاختبارات والأخطاء والخطوة التالية. لا تخترع معلومات. اكتب بالعربية." },
            { role: "user", content: `${summary.text ? `الملخص السابق:
${summary.text}

` : ""}السجل الجديد:
${content}` }
          ], [], { signal, deadlineAt, concurrencyKey: `session:${session.id}`, timeoutMs: 6e4, retries: 0, maxOutputTokens: 2048 });
          const activeRun = this.runs.get(session.id);
          if (activeRun?.runId === runId) this.recordUsage(session.id, activeRun, config, compactReply.usage, estimateModelRequestTokens(config, [{ role: "user", content }], [], 2048), "compaction");
          if (compactReply.finishReason === "stop" && compactReply.text.trim() && this.db.setSummary(session.id, compactReply.text, cut, summary.throughSequence)) {
            summary = { text: compactReply.text, throughSequence: cut };
            compacted = true;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          this.db.addAudit({ sessionId: session.id, category: "agent", action: "context-compaction", detail: error instanceof Error ? error.message : String(error), outcome: "failed" });
        }
        history = this.db.listStoredMessages(session.id);
        messages = makeContext(session, instructions, summary.text, history.filter((message) => message.sequence > summary.throughSequence), commands, toolHints);
        estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens);
      }
    }
    if (estimatedTokens > hardLimit) {
      for (const message of messages) {
        if (message.role === "tool" && message.content.length > 2e3) message.content = compactToolResult(message, 800);
      }
      estimatedTokens = estimateModelRequestTokens(config, messages, definitions, maxOutputTokens);
    }
    if (estimatedTokens > hardLimit) throw new Error(`السياق تجاوز حد النموذج (${config.contextWindow.toLocaleString("en")} رمز). السجل الكامل محفوظ. ابدأ جلسة جديدة.`);
    return { messages, maxOutputTokens, compacted };
  }
  approve(sessionId, run, title, detail, critical, rememberKey) {
    if (run.controller.signal.aborted) return Promise.reject(new DOMException("تم الإلغاء", "AbortError"));
    if (rememberKey && this.approvalGrantsFor(sessionId).has(rememberKey)) {
      this.db.addAudit({ sessionId, category: "approval", action: title, detail: "موافقة محفوظة لبقية الجلسة", outcome: "allowed" });
      return Promise.resolve(true);
    }
    const id2 = node_crypto.randomUUID();
    const request = { id: id2, sessionId, title, detail, risk: critical ? "critical" : "normal", canRemember: Boolean(rememberKey) };
    this.db.addAudit({ sessionId, category: "approval", action: title, detail, outcome: "started" });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this.approvals.get(id2);
        if (!pending) return;
        this.approvals.delete(id2);
        clearTimeout(pending.timer);
        reject(new DOMException("تم الإلغاء", "AbortError"));
      };
      const timer = setTimeout(() => {
        const pending = this.approvals.get(id2);
        if (!pending) return;
        this.approvals.delete(id2);
        run.controller.signal.removeEventListener("abort", onAbort);
        reject(new Error("انتهت مهلة الموافقة وتم رفض العملية تلقائيًا"));
      }, APPROVAL_TIMEOUT_MS);
      this.approvals.set(id2, { sessionId, runId: run.runId, request, rememberKey, timer, abort: () => run.controller.signal.removeEventListener("abort", onAbort), resolve, reject });
      run.controller.signal.addEventListener("abort", onAbort, { once: true });
      this.sendApproval(request);
    });
  }
  sendApproval(request) {
    const contents = this.getWebContents();
    if (!contents || contents.isDestroyed()) return;
    try {
      contents.send("approval:request", request);
    } catch {
    }
  }
  cancelApprovals(sessionId, runId) {
    for (const [id2, pending] of this.approvals) if (pending.sessionId === sessionId && (!runId || pending.runId === runId)) {
      this.approvals.delete(id2);
      clearTimeout(pending.timer);
      pending.abort();
      pending.reject(new DOMException("تم الإلغاء", "AbortError"));
    }
  }
  cancelApprovalsForRun(run, error) {
    for (const [id2, pending] of this.approvals) if (pending.runId === run.runId) {
      this.approvals.delete(id2);
      clearTimeout(pending.timer);
      pending.abort();
      pending.reject(error);
    }
  }
  hasApproval(sessionId, runId) {
    return [...this.approvals.values()].some((item) => item.sessionId === sessionId && (!runId || item.runId === runId));
  }
  approvalGrantsFor(sessionId) {
    const grants = this.approvalGrants.get(sessionId) ?? /* @__PURE__ */ new Set();
    this.approvalGrants.set(sessionId, grants);
    return grants;
  }
  drainPending(sessionId, run) {
    while (run.pendingMessages.length) {
      const message = run.pendingMessages.shift();
      this.db.addAudit({ sessionId, category: "agent", action: "inject", detail: message.content.slice(0, 1e3), outcome: "started" });
    }
  }
  recordUsage(sessionId, run, config, usage2, estimatedInputTokens, purpose, messageId) {
    this.db.recordUsage({ sessionId, runId: run.runId, requestId: node_crypto.randomUUID(), messageId, purpose, model: config.model, apiStyle: config.apiStyle, usage: usage2, estimatedInputTokens });
    const total = this.db.getUsageSummary(sessionId);
    this.emit({ sessionId, runId: run.runId, type: "status", usage: { delta: usage2 ?? { input: estimatedInputTokens, output: 0, total: estimatedInputTokens }, estimated: !usage2, total }, text: run.status });
  }
  assertRunning(run) {
    if (run.controller.signal.aborted) throw new DOMException("تم الإلغاء", "AbortError");
    if (Date.now() >= run.deadlineAt) throw new DeadlineExceededError("وصل الوكيل إلى الحد الزمني الأقصى وهو 30 دقيقة.");
  }
  setStatus(sessionId, status, run) {
    const current = this.runs.get(sessionId);
    if (run && current !== run) return;
    if (current) current.status = status;
    this.emit({ sessionId, runId: run?.runId ?? current?.runId, type: "status", text: status });
  }
  emit(event) {
    const contents = this.getWebContents();
    if (!contents || contents.isDestroyed()) return;
    try {
      if (event.message) {
        const { providerPayload: _, ...message } = event.message;
        contents.send("agent:event", { ...event, message: { ...message, toolCalls: message.toolCalls?.map((call) => ({ ...call, input: projectToolInput(call.name, call.input) })) } });
        return;
      }
      contents.send("agent:event", event);
    } catch {
    }
  }
  async runSubagent(session, config, parentRun, input, signal) {
    const sessionId = session.id;
    const startedAt = Date.now();
    const deadlineAt = Math.min(parentRun.deadlineAt, startedAt + SUBAGENT_MAX_RUNTIME_MS);
    const subRunId = node_crypto.randomUUID();
    const subTools = toolDefinitions.filter((tool2) => SUBAGENT_TOOL_NAMES.has(tool2.function.name));
    const messages = [{ role: "system", content: subagentSystemPrompt(session, input.prompt) }];
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const contextBudget = Math.floor(config.contextWindow * 0.55);
    let steps = 0;
    const emitSubagent = (state, step, extra = {}) => {
      this.emit({ sessionId, runId: parentRun.runId, type: "subagent", subagent: { id: subRunId, description: input.description || "وكيل فرعي", state, step, ...extra } });
    };
    emitSubagent("running", 0);
    try {
      for (let step = 0; step < SUBAGENT_MAX_STEPS; step++) {
        steps = step + 1;
        if (signal.aborted) throw new DOMException("أُلغي الوكيل الفرعي", "AbortError");
        if (Date.now() >= deadlineAt) throw new Error("وصل الوكيل الفرعي إلى الحد الزمني المسموح");
        this.setStatus(sessionId, input.description ? `${input.description} — جولة ${step + 1}...` : `وكيل فرعي — جولة ${step + 1}...`, parentRun);
        const reply = await this.modelRequest(config, messages, subTools, { signal: controller.signal, deadlineAt, concurrencyKey: `subagent:${sessionId}:${subRunId}`, timeoutMs: 3e5, retries: 1, maxOutputTokens: 4096 });
        if (reply.usage) {
          const total = this.db.getUsageSummary(sessionId);
          this.emit({ sessionId, runId: parentRun.runId, type: "status", usage: { delta: reply.usage, estimated: false, total }, text: parentRun.status });
        }
        if (!reply.toolCalls.length) {
          const summary = reply.text.trim();
          if (summary) emitSubagent("completed", steps, { summary });
          return { ok: Boolean(summary), summary: summary || "اكتملت مهمة الوكيل الفرعي دون خلاصة نصية.", steps };
        }
        validateCallIds(reply.toolCalls);
        const validations = reply.toolCalls.map((call) => validateToolCall(call, subTools));
        messages.push({ role: "assistant", content: reply.text, tool_calls: reply.toolCalls.map((call, index) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(validations[index].input) } })) });
        for (let index = 0; index < reply.toolCalls.length; index++) {
          const call = reply.toolCalls[index];
          const validation = validations[index];
          let output;
          if (!validation.ok) {
            output = JSON.stringify({ ok: false, error: { code: "INVALID_TOOL_INPUT", message: validation.error } }, null, 2);
          } else {
            try {
              emitSubagent("running", steps, { tool: call.name });
              output = await executeTool(call.name, validation.input, { session, signal: controller.signal, deadlineAt, maxOutputChars: 8e4, mcp: this.mcp, trackProcess: (child) => {
                parentRun.childProcesses.add(child);
                child.once("close", () => parentRun.childProcesses.delete(child));
              }, approve: (title, detail, critical, rememberKey) => this.approve(sessionId, parentRun, title, detail, critical, rememberKey), loadSkill: (name) => loadSkillFromWorkspace(session.workspace, name), runSubagent: void 0 });
            } catch (error) {
              output = JSON.stringify({ ok: false, error: { code: controller.signal.aborted ? "ABORTED" : "TOOL_ERROR", message: error instanceof Error ? error.message : String(error) } }, null, 2);
            }
          }
          this.db.addAudit({ sessionId, category: "tool", action: call.name, detail: `[وكيل فرعي] ${JSON.stringify(input.description ?? "").slice(0, 200)}`, outcome: output.includes('"ok": false') ? "failed" : "completed" });
          messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: output.slice(0, 6e4) });
          this.setStatus(sessionId, input.description ? `${input.description} — ${call.name}` : `وكيل فرعي — ${call.name}`, parentRun);
        }
        const estimated = estimateModelRequestTokens(config, messages, subTools, 4096);
        if (estimated > contextBudget) compactSubagentMessages(messages);
      }
      return { ok: true, summary: "وصل الوكيل الفرعي إلى الحد الأقصى من الخطوات دون خلاصة نهائية. أعد تقسيم المهمة إلى مهام أصغر.", steps };
    } catch (error) {
      if (signal.aborted || controller.signal.aborted) throw error;
      emitSubagent("failed", steps, { error: error instanceof Error ? error.message : String(error) });
      return { ok: false, summary: "", error: error instanceof Error ? error.message : String(error), steps };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  async runSubagentBatch(session, config, parentRun, tasks, signal) {
    const limited = tasks.slice(0, 5);
    const results = new Array(limited.length);
    const concurrency = Math.min(2, limited.length);
    let next = 0;
    const worker = async () => {
      while (next < limited.length) {
        const index = next++;
        const task = limited[index];
        try {
          const result = await this.runSubagent(session, config, parentRun, task, signal);
          results[index] = { ok: result.ok, description: task.description, summary: result.summary, error: result.error, steps: result.steps };
        } catch (error) {
          if (signal.aborted) throw error;
          results[index] = { ok: false, description: task.description, summary: "", error: error instanceof Error ? error.message : String(error), steps: 0 };
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  }
}
function makeContext(session, instructions, summary, history, commands = [], toolHints = "") {
  const result = [{ role: "system", content: systemPrompt(session, instructions, commands, toolHints) }];
  if (summary) result.push({ role: "system", content: `ذاكرة مضغوطة للتاريخ السابق:
${summary}` });
  for (const message of history) result.push(toModelMessage(message));
  return result;
}
function buildToolHints(definitions) {
  return definitions.map((definition) => `- ${definition.function.name}: ${definition.function.description}`).join("\n");
}
const modelMessageCache = /* @__PURE__ */ new WeakMap();
function systemPrompt(session, instructions, commands = [], toolHints = "") {
  const permissionRule = session.permissionMode === "full" ? "\n- قاعدة الصلاحية النهائية: وصول كامل مفعّل؛ نفّذ جميع الأدوات بما فيها الطرفية والويب وMCP دون طلب أي موافقة." : "\n- قاعدة الصلاحية النهائية: وضع اسألني مفعّل؛ اطلب الموافقة قبل كل عملية معدّلة أو حساسة أو طرفية أو ويب أو MCP.";
  const efficiency = permissionRule + "\n- اجمع عمليات القراءة والبحث المستقلة في استجابة أدوات واحدة كي ينفذها التطبيق بالتوازي ويقل عدد جولات المزود.\n- عند طلب عد أسطر مجلد: استخدم count_lines على المجلد مباشرة بدلا من استدعاء count_lines لكل ملف. أداة count_lines تدعم مجلدات recursion وتعيد إحصائية كاملة.\n- عند طلب قراءة مجلد أو مجموعة ملفات كاملة: استخدم glob_files مرة واحدة ثم read_files لقراءة الملفات كاملة؛ لا تستدع count_lines لكل ملف ولا تقسّم الملف يدويًا إلى read_file متكررة.\n- إذا أعادت read_files قيمة nextCursor فاستدعها مرة أخرى بهذا cursor حتى complete=true، وإلا فقد اكتملت المجموعة.\n- قبل طلب دفعة read_files التالية، اكتب في content خلاصة فنية مركزة لما فهمته من الدفعة الحالية: الأصناف، العلاقات، القرارات، الأخطاء، والمسارات المهمة. هذه الخلاصة هي ذاكرة العمل للمهمة الطويلة.\n- إذا ضُغطت نتيجة أداة في السياق (رسالة تحمل وسم الاستهلاك)، استرجعها كاملة بـ read_message بمعرّف الرسالة قبل الاعتماد عليها.\n- عند استخدام patch_file، اضمّن expected في كل رقعة يحتوي على نص الأسطر الحالية بالضبط كما قرأتها من read_file، ليُتحقق من تطابقها قبل التطبيق ويُمنع تعديل مواضع خاطئة.\n- قبل مهمة متعددة الخطوات: خطط بـ todo_write بقائمة مهام مكتملة، وحدّث حالة كل مهمة بعد إنجازها عبر todo_write، وابدأ برنامجك بإعادة كتابة القائمة كاملة بعد كل خطوة. لا تعدّل الملفات قبل كتابة الخطة.\n- عند الحاجة لإجراء متخصص موثّق (مراجعة، بحث عميق، تنسيق، توليد وثائق): استخدم load_skill باسم المهارة من مجلدات .skills أو skills في مساحة العمل واتبع تعليماتها حرفيًا.\n- أنت المشرف على المشروع: في المهام الكبيرة أو عند تفحص مشروع ضخم، قسّم العمل واستخدم أداة task لتشغيل وكلاء فرعيين بسياق مستقل تمامًا لا يلوّث سياق محادثتك. اكتب لكل وكيل فرعي برومبت دقيق يحدد بالضبط ما يفحصه والأسئلة المطلوبة ومواصفات الخلاصة، ثم ادمج خلاصاته واتخذ القرارات النهائية بنفسك. بهذا يبقى سياقك نظيفًا حتى مع قراءة عشرات الملفات.\n- عند وجود مهام تحليلية مستقلة (وحدات مختلفة، مجلدات منفصلة، أسئلة مستقلة): أطلقها معًا عبر task_parallel بقائمة تصل إلى 5 مهام لفحص المشروع الضخم بسرعة، ثم ادمج الخلاصات واتخذ القرارات النهائية بنفسك.\n- لا تقسّم العمل القابل للتنفيذ بأدوات مستقلة إلى جولات نموذج منفصلة، لكن أبق الكتابة والطرفية متسلسلة." + (session.gitTracked ? "\n- تتبع Git التلقائي مفعّل: كل أداة تعديل تحفظ مساراتها فورًا في commit وتعيد hash داخل gitAutoCommit. لذلك قد يكون git status نظيفًا وgit diff فارغًا بعد نجاح التعديل. للتراجع استخدم git_revert مع hash المعاد، ولا تستخدم git_restore." : "");
  const commandsBlock = commands.length ? `

أوامر معرفة (Slash Commands) متاحة في هذا المشروع — عند طلب المستخدم أمرًا منها نفّذه عبر run_command مع تمرير الاسم والوسائط:
${commands.map((command) => `- /${command.name}${command.description ? `: ${command.description}` : ""}`).join("\n")}` : "";
  const toolsBlock = toolHints ? `

الأدوات المتاحة لك الآن (أسماء حقيقية تُرسل للمزود — استخدمها كما هي):
${toolHints}` : "";
  return `أنت Rahma Code Agent، وكيل هندسة برمجيات محلي يعمل على Windows. رد بالعربية الواضحة وأبق أسماء الكود والأوامر بلغتها الأصلية.
مساحة العمل الوحيدة المسموحة: ${session.workspace}
الوضع: ${session.agentMode === "build" ? "Build: نفذ المهمة واستخدم الأدوات حتى تكتمل" : "Plan: حلل واقرأ فقط ولا تعدل"}
الصلاحية: ${session.permissionMode === "full" ? "وصول كامل: جميع الأدوات بما فيها الطرفية والويب وMCP تُنفَّذ دون طلب أي موافقة" : "اسألني: كل عملية معدّلة أو حساسة أو طرفية أو ويب أو MCP تتطلب موافقتك"}
قواعد إلزامية:
- افحص بنية المشروع والملفات ذات الصلة قبل الاستنتاج.
- استخدم المسارات النسبية إلى جذر مساحة العمل افتراضيًا، مثل app/src، ولا تحاول فحص المجلد الأب أو جذور الأقراص.
- لا تقل إن ملفًا أو مشروعًا موجود إلا إذا أعادت الأداة نتيجة ok=true تثبت ذلك.
- إذا أعادت الأداة ok=false أو خطأ مسار، اقرأ الخطأ حرفيًا ولا تخمن نتيجة بديلة.
- استخدم read_file الذي يعيد totalLines وأرقام الأسطر، واستخدم count_lines عند الحاجة لعدد دقيق.
- استخدم glob_files للأسماء وsearch_files للمحتوى ولا تتصفح عشوائيًا. استخدم web_search لاكتشاف الروابط ثم web_fetch لقراءة الصفحة. استخدم أدوات git المخصصة قبل PowerShell.${efficiency}
- لا تدّع تنفيذ شيء لم تنفذه. استمر واختبر التغييرات عند الإمكان.
- لا تكشف الأسرار ولا تطلب الوصول خارج مساحة العمل.
- عند فشل أداة، حلل الخطأ وصحح المدخلات مرة واحدة؛ لا تجرب D:\\ أو مجلدات الأب.
- اجعل التغييرات صغيرة وصحيحة، وأعط في النهاية ملخصًا والتحقق الذي أجريته.${commandsBlock}${toolsBlock}${session.systemPrompt ? `

تعليمات المستخدم الخاصة (يلزم الالتزام بها طوال الجلسة):
${session.systemPrompt}` : ""}${instructions ? `

تعليمات المشروع:
${instructions}` : ""}`;
}
function subagentSystemPrompt(session, task) {
  return `أنت وكيل فرعي تابع لـ Rahma Code Agent، تعمل في سياق مستقل تمامًا منفصل عن المحادثة الرئيسية.
مهمتك الموكلة إليك من الوكيل الرئيسي (نفّذها بدقة وحرفية، أنت مسؤول عن جودة نتيجتها):
${task}

مساحة العمل: ${session.workspace}

قواعد صارمة:
- أنت وكيل تحليل وبحث فقط: مسموح لك أدوات القراءة والبحث وGit (قراءة) والويب. لا تعدّل أي ملف ولا تنفّذ أوامر طرفية ولا Git الكتابية ولا MCP ولا تستخدم todo.
- افحص الملفات والبنية الفعلية قبل أي استنتاج؛ لا تخمّن ولا تدّع شيئًا لم تقرأه.
- استخدم المسارات النسبية إلى جذر مساحة العمل فقط، ولا تفحص المجلد الأب.
- اجمع عمليات القراءة والبحث المستقلة في استدعاء أدوات واحد، واستخدم read_files مع cursor حتى complete=true عند الحاجة.
- إذا لم تجد ما تبحث عنه، اذكر ذلك صراحةً ولا تختلق.

عند الانتهاء أعد خلاصة نهائية منظمة بالعربية تعتمد عليها بشكل كامل:
- الإجابات الدقيقة عن أسئلة المهمة، مرفقة بالأدلة (المسار ورقم السطر إن أمكن).
- البنية والعلاقات بين الملفات التي اكتشفتها.
- أي تحذيرات أو أجزاء لم تُفحص.
لا تكرر نص الملفات؛ كن مركّزًا وكاملًا ودقيقًا.`;
}
async function projectInstructions(workspace) {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const target = path.join(workspace, name);
      const stat = await node_fs.promises.stat(target);
      const cached = projectInstructionsCache.get(target);
      if (cached?.modifiedAt === stat.mtimeMs) return cached.content;
      let content = await node_fs.promises.readFile(target, "utf8");
      if (content.length > 4e4) content = `${content.slice(0, 4e4)}

[مقصوص: تجاوز ملف التعليمات 40,000 حرف، عُرضت البداية فقط]`;
      projectInstructionsCache.set(target, { modifiedAt: stat.mtimeMs, content });
      return content;
    } catch {
    }
  }
  return "";
}
const SKILL_DIRS = [".skills", ".opencode/skills", "skills", ".claude/skills"];
const skillCache = /* @__PURE__ */ new Map();
const commandCache = /* @__PURE__ */ new Map();
async function loadProjectCommands(workspace) {
  const target = path.join(workspace, "commands.json");
  try {
    const stat = await node_fs.promises.stat(target);
    const cached = commandCache.get(target);
    if (cached?.modifiedAt === stat.mtimeMs) return cached.commands;
    const parsed = JSON.parse(await node_fs.promises.readFile(target, "utf8"));
    const commands = Object.entries(parsed?.command ?? {}).filter(([, value]) => value && typeof value.template === "string").map(([name, value]) => ({ name, description: value?.description, template: value.template, agent: value?.agent, model: value?.model, subtask: value?.subtask }));
    commandCache.set(target, { modifiedAt: stat.mtimeMs, commands });
    return commands;
  } catch {
    return [];
  }
}
function renderCommandTemplate(template, argumentsText) {
  const args = argumentsText.trim();
  return template.replace(/\$ARGUMENTS/g, args).replace(/\$1/g, args);
}
async function loadSkillFromWorkspace(workspace, name) {
  const safeName = name.replace(/[\\/]/g, "");
  if (!safeName || safeName === ".." || safeName === ".") return void 0;
  const cacheKey = `${workspace}:${safeName}`;
  const cached = skillCache.get(cacheKey);
  if (cached) return cached;
  for (const dir of SKILL_DIRS) {
    const base = path.join(workspace, dir);
    for (const candidate of [path.join(base, safeName), path.join(base, safeName, "SKILL.md")]) {
      try {
        const stat = await node_fs.promises.stat(candidate);
        if (!stat.isFile()) continue;
        let content = await node_fs.promises.readFile(candidate, "utf8");
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
        let description = "";
        if (frontmatter) {
          const desc = /description\s*:\s*(?:"([^"]*)"|'([^']*)'|>?\s*([^\n]+))/.exec(frontmatter[1] ?? "");
          if (desc) description = (desc[1] ?? desc[2] ?? desc[3] ?? "").trim();
          content = content.slice(frontmatter[0].length);
        }
        const skill = { name: safeName, description: description.slice(0, 500), content: content.trim() };
        skillCache.set(cacheKey, skill);
        return skill;
      } catch {
      }
    }
  }
  return void 0;
}
function toModelMessage(message) {
  let cached = modelMessageCache.get(message);
  if (!cached) {
    if (message.role === "tool") {
      cached = { role: "tool", content: message.content, tool_call_id: message.toolCallId, name: message.toolName, messageId: message.id };
    } else {
      const attachments = message.attachments;
      let content = message.content;
      if (attachments?.length) {
        const blocks = [{ type: "text", text: message.content }];
        for (const attachment of attachments) {
          if (attachment.mimeType.startsWith("image/")) blocks.push({ type: "image", source: { type: "base64", media_type: attachment.mimeType, data: attachment.data } });
          else if (attachment.mimeType.startsWith("video/")) blocks.push({ type: "video", source: { type: "base64", media_type: attachment.mimeType, data: attachment.data } });
        }
        content = blocks;
      }
      cached = { role: message.role, content, providerPayload: message.providerPayload, tool_calls: message.toolCalls?.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(projectToolInput(call.name, call.input)) } })) };
    }
    modelMessageCache.set(message, cached);
  }
  return { ...cached, providerPayload: cached.providerPayload?.map((item) => item && typeof item === "object" ? { ...item } : item), tool_calls: cached.tool_calls?.map((call) => ({ ...call, function: { ...call.function } })) };
}
function validateCallIds(calls) {
  const ids = /* @__PURE__ */ new Set();
  for (const call of calls) {
    if (!call.id || !call.name) throw new Error("أعاد المزود استدعاء أداة بلا id أو name");
    if (ids.has(call.id)) throw new Error(`كرر المزود tool call id: ${call.id}`);
    ids.add(call.id);
  }
}
function validateToolCall(call, definitions = toolDefinitions) {
  const definition = definitions.find((item) => item.function.name === call.name);
  if (!definition) return { ok: false, input: {}, error: `الأداة غير معروفة: ${call.name}` };
  let input;
  try {
    const parsed = JSON.parse(call.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("يجب أن تكون المدخلات object");
    input = parsed;
  } catch (error) {
    return { ok: false, input: {}, error: `JSON غير صالح: ${error instanceof Error ? error.message : String(error)}` };
  }
  const schema = definition.function.parameters;
  for (const key of schema.required ?? []) if (!(key in input)) return { ok: false, input, error: `الحقل المطلوب مفقود: ${key}` };
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) if (!schema.properties?.[key]) return { ok: false, input, error: `حقل غير مسموح: ${key}` };
  }
  for (const [key, value] of Object.entries(input)) {
    const rule = schema.properties?.[key];
    if (!rule) continue;
    if (rule.type === "string" && typeof value !== "string" || rule.type === "boolean" && typeof value !== "boolean" || (rule.type === "number" || rule.type === "integer") && (typeof value !== "number" || !Number.isFinite(value) || rule.type === "integer" && !Number.isInteger(value))) return { ok: false, input, error: `نوع الحقل ${key} غير صحيح` };
    if (typeof value === "number" && (rule.minimum !== void 0 && value < rule.minimum || rule.maximum !== void 0 && value > rule.maximum)) return { ok: false, input, error: `قيمة الحقل ${key} خارج النطاق` };
  }
  return { ok: true, input };
}
function userTurns(messages) {
  const turns = [];
  for (const message of messages) {
    if (message.role === "user" || !turns.length) turns.push([]);
    turns.at(-1).push(message);
  }
  return turns;
}
function summaryLine(message) {
  const tools = message.toolCalls?.map((call) => `${call.name}(${JSON.stringify(projectToolInput(call.name, call.input)).slice(0, 500)}): ${call.output?.slice(0, 1500) ?? call.status}`).join("\n") ?? "";
  return `[seq ${message.sequence}] ${message.role}: ${message.content.slice(0, 4e3)}${tools ? `
${tools}` : ""}`;
}
function compactToolResult(message, previewChars) {
  const contentStr = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  let metadata = "";
  try {
    const parsed = JSON.parse(contentStr);
    const data = parsed?.data;
    metadata = JSON.stringify({ ok: parsed?.ok, path: data?.path, totalLines: data?.totalLines, range: data?.range, count: data?.count, truncated: data?.truncated, bytes: data?.bytes });
  } catch {
  }
  const retrieveHint = message.messageId ? `
[استرجع النص الكامل عبر read_message بمعرّف ${message.messageId}]` : "";
  return `${metadata ? `${metadata}
` : ""}${contentStr.slice(0, previewChars)}
[تم استهلاك هذه النتيجة في جولة سابقة وضغط محتواها الخام؛ أعد قراءة النطاق فقط إذا احتجت تفاصيله.]${retrieveHint}`;
}
function compactSubagentMessages(messages) {
  const keptToolMessages = 2;
  let toolCount = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "tool") {
      toolCount++;
      if (toolCount > keptToolMessages && typeof message.content === "string" && message.content.length > 2e3) {
        message.content = compactToolResult(message, 500);
      }
    }
  }
}
function mergeUsage(first, second) {
  if (!first) return second;
  if (!second) return first;
  return { input: first.input + second.input, output: first.output + second.output, total: (first.total ?? first.input + first.output) + (second.total ?? second.input + second.output), cacheRead: (first.cacheRead ?? 0) + (second.cacheRead ?? 0), cacheWrite: (first.cacheWrite ?? 0) + (second.cacheWrite ?? 0), reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) };
}
async function runWithConcurrency(count, concurrency, execute) {
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const index = next++;
      await execute(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker()));
}
function projectToolInput(name, input) {
  if (name === "write_file" && typeof input.content === "string") {
    const { content, ...rest } = input;
    return { ...rest, contentReceipt: contentReceipt(content, input.path) };
  }
  if (name === "edit_file") {
    const result = { ...input };
    if (typeof result.old_string === "string" && result.old_string.length > 2e3) {
      result.oldStringReceipt = contentReceipt(result.old_string, input.path);
      delete result.old_string;
    }
    if (typeof result.new_string === "string" && result.new_string.length > 2e3) {
      result.newStringReceipt = contentReceipt(result.new_string, input.path);
      delete result.new_string;
    }
    return result;
  }
  return input;
}
function contentReceipt(content, pathValue) {
  return { bytes: Buffer.byteLength(content), sha256: node_crypto.createHash("sha256").update(content).digest("hex"), persistedAtPath: pathValue, note: "المحتوى الكامل محفوظ في سجل الجلسة والملف الناتج؛ استخدم read_file/read_files عند الحاجة إليه." };
}
function forceCompactForOverflow(messages) {
  const result = messages.map((message) => ({ ...message }));
  let userSeen = 0;
  let assistantCallsSeen = 0;
  for (let index = result.length - 1; index >= 0; index--) {
    const message = result[index];
    if (message.role === "user") userSeen++;
    if (message.role === "assistant" && message.tool_calls) {
      assistantCallsSeen++;
      if (assistantCallsSeen > 2) {
        message.tool_calls = message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: call.function.arguments.length > 2e3 ? JSON.stringify({ receipt: "مدخل أداة قديم محفوظ في السجل الكامل" }) : call.function.arguments } }));
      }
    }
    if (message.role === "tool" && (userSeen >= 1 || message.content.length > 2e3)) message.content = compactToolResult(message, 500);
  }
  return result;
}
function isTrustedRendererUrl(value, trusted) {
  try {
    return Boolean(trusted) && new URL(value).href === new URL(trusted).href;
  } catch {
    return false;
  }
}
let mainWindow = null;
let trustedRendererUrl = "";
let database = null;
let agentRunner = null;
let quitting = false;
process.on("uncaughtException", (error) => {
  try {
    database?.addAudit({ category: "security", action: "uncaught-exception", detail: `${error?.message ?? String(error)}`.slice(0, 4e3), outcome: "failed" });
  } catch {
    console.error("uncaughtException", error);
  }
  console.error("uncaughtException", error);
});
process.on("unhandledRejection", (reason) => {
  try {
    database?.addAudit({ category: "security", action: "unhandled-rejection", detail: `${reason instanceof Error ? reason.message : String(reason)}`.slice(0, 4e3), outcome: "failed" });
  } catch {
    console.error("unhandledRejection", reason);
  }
  console.error("unhandledRejection", reason);
});
if (!electron.app.requestSingleInstanceLock()) electron.app.quit();
else {
  electron.app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  void electron.app.whenReady().then(() => {
    const db = new AppDatabase(path.join(electron.app.getPath("userData"), "r-code-agent.db"));
    database = db;
    const providers = new ProviderStore(path.join(electron.app.getPath("userData"), "provider.json"));
    const agent = new AgentRunner(db, providers, () => mainWindow?.isDestroyed() ? null : mainWindow?.webContents ?? null, void 0, new McpManager(path.join(electron.app.getPath("userData"), "mcp.json")));
    agentRunner = agent;
    registerIpc(db, providers, agent);
    createWindow();
  });
  electron.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") electron.app.quit();
  });
  electron.app.on("before-quit", (event) => {
    if (quitting) {
      database?.close();
      database = null;
      agentRunner = null;
      return;
    }
    event.preventDefault();
    quitting = true;
    void agentRunner?.shutdown().finally(() => electron.app.quit());
  });
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
function createWindow() {
  const rendererFile = path.join(__dirname, "../renderer/index.html");
  const developmentUrl = !electron.app.isPackaged ? process.env.ELECTRON_RENDERER_URL : void 0;
  trustedRendererUrl = developmentUrl ? new URL(developmentUrl).href : node_url.pathToFileURL(rendererFile).href;
  const window = new electron.BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#0d1017",
    title: "Rahma Code Agent",
    webPreferences: { preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false }
  });
  mainWindow = window;
  const electronSession = window.webContents.session;
  electronSession.setPermissionCheckHandler(() => false);
  electronSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  electronSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedUrl(url)) {
      event.preventDefault();
      void openExternal(url);
    }
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(rendererFile);
}
const id = zod.z.string().uuid();
const filePath = zod.z.string().min(1).max(32767);
const providerUpdate = zod.z.object({ model: zod.z.enum(GO_MODELS.map((model) => model.id)), apiKey: zod.z.string().max(8192).optional(), contextWindow: zod.z.number().int().min(32e3).max(2e6).optional() }).strict();
const sessionPatch = zod.z.object({ title: zod.z.string().trim().min(1).max(200).optional(), permissionMode: zod.z.enum(["ask", "full"]).optional(), agentMode: zod.z.enum(["build", "plan"]).optional() }).strict();
const sessionCreate = zod.z.object({ workspace: filePath, title: zod.z.string().trim().min(1).max(200).optional(), initGit: zod.z.boolean().optional() }).strict();
function registerIpc(db, providers, agent) {
  handle("sessions:create", zod.z.tuple([sessionCreate]), async (input) => {
    const workspace = await node_fs.promises.realpath(input.workspace);
    if (!(await node_fs.promises.stat(workspace)).isDirectory()) throw new Error("مساحة العمل ليست مجلدًا");
    if (input.initGit) await ensureGitRepository(workspace);
    return db.createSession(workspace, input.title, Boolean(input.initGit));
  });
  handle("sessions:list", zod.z.tuple([]), () => db.listSessions());
  handle("sessions:update", zod.z.tuple([id, sessionPatch]), (sessionId, patch) => db.updateSession(sessionId, patch));
  handle("sessions:remove", zod.z.tuple([id]), (sessionId) => {
    agent.forgetSession(sessionId);
    db.deleteSession(sessionId);
  });
  handle("sessions:setPrompt", zod.z.tuple([id, zod.z.string().max(5e4)]), (sessionId, prompt) => db.setSystemPrompt(sessionId, prompt));
  handle("sessions:messages", zod.z.tuple([id]), (sessionId) => db.listMessages(sessionId));
  handle("sessions:usage", zod.z.tuple([id]), (sessionId) => db.getUsageSummary(sessionId));
  electron.ipcMain.handle("agent:send", (event, ...raw) => {
    assertTrustedSender(event);
    const [sessionId, text] = zod.z.tuple([id, zod.z.string().trim().min(1).max(2e5), zod.z.union([zod.z.array(zod.z.unknown()), zod.z.undefined()]).optional()]).parse(raw);
    const attachments = raw.length > 2 && Array.isArray(raw[2]) ? raw[2] : void 0;
    return agent.send(sessionId, text, attachments);
  });
  handle("agent:cancel", zod.z.tuple([id]), (sessionId) => agent.cancel(sessionId));
  handle("agent:states", zod.z.tuple([]), () => agent.states());
  handle("approval:answer", zod.z.tuple([id, zod.z.boolean(), zod.z.boolean().optional()]), (approvalId, allowed, remember = false) => agent.answerApproval(approvalId, allowed, remember));
  handle("audit:list", zod.z.tuple([zod.z.union([zod.z.number().int().min(1).max(1e3), zod.z.undefined()])]), (limit) => db.listAudit(limit));
  handle("clipboard:writeText", zod.z.tuple([zod.z.string().max(1e6)]), (text) => electron.clipboard.writeText(text));
  handle("provider:get", zod.z.tuple([]), () => providers.getSettings());
  handle("provider:save", zod.z.tuple([providerUpdate]), (update) => providers.save(update));
  handle("provider:clear", zod.z.tuple([]), () => providers.clear());
  handle("provider:test", zod.z.tuple([providerUpdate]), async (update) => {
    const config = providers.resolve(update);
    if (!config.apiKey) throw new Error("أضف مفتاح API أولًا");
    const reply = await requestModel(config, [{ role: "user", content: "أجب بكلمة: متصل" }], [], { timeoutMs: 3e4, retries: 1 });
    return reply.text;
  });
  handle("files:chooseFolder", zod.z.tuple([]), async () => (await electron.dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] })).filePaths[0] ?? null);
  handle("files:list", zod.z.tuple([id, zod.z.union([filePath, zod.z.undefined()])]), async (sessionId, requested) => {
    const target = await trustedSessionPath(db, sessionId, requested ?? ".");
    const entries = await node_fs.promises.readdir(target, { withFileTypes: true });
    return entries.filter((entry) => !["node_modules", ".git"].includes(entry.name) && !entry.name.startsWith("release-") && !entry.name.startsWith("dist-v") && !entry.name.startsWith("win-unpacked") && !entry.name.endsWith(".tmp")).slice(0, 500).map((entry) => ({ name: entry.name, path: path.join(target, entry.name), directory: entry.isDirectory(), size: 0 }));
  });
  handle("files:read", zod.z.tuple([id, filePath]), async (sessionId, requested) => {
    const target = await trustedSessionPath(db, sessionId, requested);
    const stat = await node_fs.promises.stat(target);
    if (!stat.isFile() || stat.size > 5e5) throw new Error("الملف غير نصي أو أكبر من حد العرض");
    return node_fs.promises.readFile(target, "utf8");
  });
  handle("files:readAsBase64", zod.z.tuple([id, filePath]), async (sessionId, requested) => {
    const target = await trustedSessionPath(db, sessionId, requested);
    const stat = await node_fs.promises.stat(target);
    if (!stat.isFile() || stat.size > 2e7) throw new Error("الملف فارغ أو أكبر من 20 ميغابايت");
    const data = await node_fs.promises.readFile(target);
    const mime = mimeForExt(path.extname(target).toLowerCase());
    return { name: target.split(/[\\/]/).pop() ?? "file", mimeType: mime, data: data.toString("base64"), size: stat.size };
  });
}
function handle(channel, schema, listener) {
  electron.ipcMain.handle(channel, (event, ...raw) => {
    assertTrustedSender(event);
    return listener(...schema.parse(raw));
  });
}
function assertTrustedSender(event) {
  const window = mainWindow;
  if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error("مصدر IPC غير موثوق");
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !isTrustedUrl(frame.url)) throw new Error("مصدر IPC غير موثوق");
}
function isTrustedUrl(value) {
  return isTrustedRendererUrl(value, trustedRendererUrl);
}
async function trustedSessionPath(db, sessionId, requested) {
  const root = await node_fs.promises.realpath(db.getSession(sessionId).workspace);
  const target = await node_fs.promises.realpath(path.resolve(root, requested));
  const difference = path.relative(root, target);
  if (difference.startsWith("..") || path.isAbsolute(difference)) throw new Error("المسار خارج مساحة العمل");
  return target;
}
async function openExternal(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return;
    await electron.shell.openExternal(url.toString());
  } catch {
  }
}
function mimeForExt(ext) {
  const map = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".tiff": "image/tiff", ".tif": "image/tiff", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".pdf": "application/pdf", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv", ".xml": "text/xml", ".html": "text/html", ".md": "text/markdown" };
  return map[ext] ?? "application/octet-stream";
}
