/**
 * Usage store — token/cost tracking. Uses Bun's built-in SQLite.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

// --- Types ---

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionRecord {
  id: string;
  sessionId: string;
  agent: string;
  parentAgent: string | null;
  model: string;
  tokens: TokenCounts;
  cost: CostBreakdown;
  turns: number;
  toolCalls: Record<string, number>;
  startedAt: string;
  endedAt: string;
  recordedAt: string;
}

export interface SessionInput {
  sessionId: string;
  agent: string;
  parentAgent?: string | null;
  model: string;
  tokens: TokenCounts;
  cost: CostBreakdown;
  turns: number;
  toolCalls?: Record<string, number>;
  startedAt: string;
  endedAt: string;
}

export interface VMRecord {
  id: string;
  vmId: string;
  role: string;
  agent: string;
  commitId?: string;
  createdAt: string;
  destroyedAt?: string;
  recordedAt: string;
}

export interface VMInput {
  vmId: string;
  role: string;
  agent: string;
  commitId?: string;
  createdAt: string;
  destroyedAt?: string;
}

export interface AgentUsage {
  tokens: number;
  cost: number;
  sessions: number;
}

export interface UsageSummary {
  range: string;
  totals: { tokens: number; cost: number; sessions: number; vms: number };
  byAgent: Record<string, AgentUsage>;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function parseDurationMs(duration: string): number | null {
  const match = duration.match(/^(\d+)(h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "h") return value * 3600_000;
  if (unit === "d") return value * 86400_000;
  return null;
}

// --- Store ---

export class UsageStore {
  private db: Database;

  constructor(dbPath = "data/usage.sqlite") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        parent_agent TEXT,
        model TEXT NOT NULL,
        tokens_input INTEGER NOT NULL,
        tokens_output INTEGER NOT NULL,
        tokens_cache_read INTEGER NOT NULL,
        tokens_cache_write INTEGER NOT NULL,
        tokens_total INTEGER NOT NULL,
        cost_input REAL NOT NULL,
        cost_output REAL NOT NULL,
        cost_cache_read REAL NOT NULL,
        cost_cache_write REAL NOT NULL,
        cost_total REAL NOT NULL,
        turns INTEGER NOT NULL,
        tool_calls TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vm_records (
        id TEXT PRIMARY KEY,
        vm_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent TEXT NOT NULL,
        commit_id TEXT,
        created_at TEXT NOT NULL,
        destroyed_at TEXT,
        recorded_at TEXT NOT NULL
      )
    `);
  }

  recordSession(input: SessionInput): SessionRecord {
    if (!input.sessionId?.trim()) throw new ValidationError("sessionId is required");
    if (!input.agent?.trim()) throw new ValidationError("agent is required");
    if (!input.model?.trim()) throw new ValidationError("model is required");
    if (typeof input.turns !== "number" || input.turns < 0) throw new ValidationError("turns must be non-negative");
    if (!input.startedAt) throw new ValidationError("startedAt is required");
    if (!input.endedAt) throw new ValidationError("endedAt is required");

    const id = ulid();
    const now = new Date().toISOString();
    const toolCalls = input.toolCalls || {};

    this.db.run(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      input.sessionId.trim(),
      input.agent.trim(),
      input.parentAgent?.trim() || null,
      input.model.trim(),
      input.tokens.input,
      input.tokens.output,
      input.tokens.cacheRead,
      input.tokens.cacheWrite,
      input.tokens.total,
      input.cost.input,
      input.cost.output,
      input.cost.cacheRead,
      input.cost.cacheWrite,
      input.cost.total,
      input.turns,
      JSON.stringify(toolCalls),
      input.startedAt,
      input.endedAt,
      now,
    ]);

    return {
      id,
      sessionId: input.sessionId.trim(),
      agent: input.agent.trim(),
      parentAgent: input.parentAgent?.trim() || null,
      model: input.model.trim(),
      tokens: input.tokens,
      cost: input.cost,
      turns: input.turns,
      toolCalls,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      recordedAt: now,
    };
  }

  listSessions(filters?: { agent?: string; range?: string }): SessionRecord[] {
    let sql = "SELECT * FROM sessions";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.agent) {
      conditions.push("agent = ?");
      params.push(filters.agent);
    }
    if (filters?.range) {
      const ms = parseDurationMs(filters.range);
      if (ms !== null) {
        conditions.push("started_at >= ?");
        params.push(new Date(Date.now() - ms).toISOString());
      }
    }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY started_at DESC";

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToSession);
  }

  recordVM(input: VMInput): VMRecord {
    if (!input.vmId?.trim()) throw new ValidationError("vmId is required");
    if (!input.agent?.trim()) throw new ValidationError("agent is required");
    if (!input.createdAt) throw new ValidationError("createdAt is required");

    // Check for destroy update
    if (input.destroyedAt) {
      const existing = this.db
        .query("SELECT * FROM vm_records WHERE vm_id = ? ORDER BY recorded_at DESC LIMIT 1")
        .get(input.vmId.trim()) as any;

      if (existing) {
        this.db.run("UPDATE vm_records SET destroyed_at = ? WHERE id = ?", [input.destroyedAt, existing.id]);
        const updated = rowToVM(existing);
        updated.destroyedAt = input.destroyedAt;
        return updated;
      }
    }

    const id = ulid();
    const now = new Date().toISOString();

    this.db.run("INSERT INTO vm_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      input.vmId.trim(),
      input.role || "worker",
      input.agent.trim(),
      input.commitId?.trim() || null,
      input.createdAt,
      input.destroyedAt || null,
      now,
    ]);

    return {
      id,
      vmId: input.vmId.trim(),
      role: input.role || "worker",
      agent: input.agent.trim(),
      commitId: input.commitId?.trim(),
      createdAt: input.createdAt,
      destroyedAt: input.destroyedAt,
      recordedAt: now,
    };
  }

  listVMs(filters?: { role?: string; agent?: string; range?: string }): VMRecord[] {
    let sql = "SELECT * FROM vm_records";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.role) {
      conditions.push("role = ?");
      params.push(filters.role);
    }
    if (filters?.agent) {
      conditions.push("agent = ?");
      params.push(filters.agent);
    }
    if (filters?.range) {
      const ms = parseDurationMs(filters.range);
      if (ms !== null) {
        conditions.push("created_at >= ?");
        params.push(new Date(Date.now() - ms).toISOString());
      }
    }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at DESC";

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToVM);
  }

  summary(range = "7d"): UsageSummary {
    const ms = parseDurationMs(range);
    const cutoff = ms !== null ? new Date(Date.now() - ms).toISOString() : new Date(0).toISOString();

    const agentRows = this.db
      .query(`
      SELECT agent, SUM(tokens_total) as tokens, ROUND(SUM(cost_total), 2) as cost, COUNT(*) as sessions
      FROM sessions WHERE started_at >= ? GROUP BY agent ORDER BY cost DESC
    `)
      .all(cutoff) as any[];

    const totalRow = this.db
      .query(`
      SELECT COALESCE(SUM(tokens_total), 0) as tokens, ROUND(COALESCE(SUM(cost_total), 0), 2) as cost, COUNT(*) as sessions
      FROM sessions WHERE started_at >= ?
    `)
      .get(cutoff) as any;

    const vmRow = this.db.query("SELECT COUNT(*) as vms FROM vm_records WHERE created_at >= ?").get(cutoff) as any;

    const byAgent: Record<string, AgentUsage> = {};
    for (const row of agentRows) {
      byAgent[row.agent] = {
        tokens: Number(row.tokens),
        cost: Number(row.cost),
        sessions: Number(row.sessions),
      };
    }

    return {
      range,
      totals: {
        tokens: Number(totalRow?.tokens || 0),
        cost: Number(totalRow?.cost || 0),
        sessions: Number(totalRow?.sessions || 0),
        vms: Number(vmRow?.vms || 0),
      },
      byAgent,
    };
  }

  close(): void {
    this.db.close();
  }
}

function rowToSession(row: any): SessionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    parentAgent: row.parent_agent || null,
    model: row.model,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      cacheRead: row.tokens_cache_read,
      cacheWrite: row.tokens_cache_write,
      total: row.tokens_total,
    },
    cost: {
      input: row.cost_input,
      output: row.cost_output,
      cacheRead: row.cost_cache_read,
      cacheWrite: row.cost_cache_write,
      total: row.cost_total,
    },
    turns: row.turns,
    toolCalls: JSON.parse(row.tool_calls || "{}"),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    recordedAt: row.recorded_at,
  };
}

function rowToVM(row: any): VMRecord {
  const record: VMRecord = {
    id: row.id,
    vmId: row.vm_id,
    role: row.role,
    agent: row.agent,
    createdAt: row.created_at,
    recordedAt: row.recorded_at,
  };
  if (row.commit_id) record.commitId = row.commit_id;
  if (row.destroyed_at) record.destroyedAt = row.destroyed_at;
  return record;
}
