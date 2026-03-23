/**
 * Lieutenant store — persistent agent session state backed by SQLite.
 *
 * Tracks lieutenant lifecycle: creation, messaging, pause/resume, destruction.
 * Each lieutenant is a persistent agent session running on a Vers VM.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

// =============================================================================
// Types
// =============================================================================

export type LtStatus = "starting" | "idle" | "working" | "paused" | "error" | "destroyed";

export interface Lieutenant {
  id: string;
  name: string;
  role: string;
  vmId: string;
  status: LtStatus;
  lastOutput: string;
  outputHistory: string[];
  taskCount: number;
  createdAt: string;
  lastActivityAt: string;
  systemPrompt?: string;
  model?: string;
  parentAgent?: string;
}

export interface CreateInput {
  name: string;
  role: string;
  vmId?: string;
  systemPrompt?: string;
  model?: string;
  parentAgent?: string;
}

export interface UpdateInput {
  status?: LtStatus;
  lastOutput?: string;
  taskCount?: number;
  lastActivityAt?: string;
  vmId?: string;
}

// =============================================================================
// Errors
// =============================================================================

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

// =============================================================================
// Constants
// =============================================================================

const VALID_STATUSES = new Set<string>(["starting", "idle", "working", "paused", "error", "destroyed"]);
const MAX_OUTPUT_HISTORY = 20;

// =============================================================================
// Store
// =============================================================================

export class LieutenantStore {
  private db: Database;

  constructor(dbPath = "data/lieutenants.sqlite") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lieutenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        is_local INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'starting',
        last_output TEXT NOT NULL DEFAULT '',
        output_history TEXT NOT NULL DEFAULT '[]',
        task_count INTEGER NOT NULL DEFAULT 0,
        system_prompt TEXT,
        model TEXT,
        parent_agent TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lt_status ON lieutenants(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_lt_vm_id ON lieutenants(vm_id)`);
  }

  create(input: CreateInput): Lieutenant {
    if (!input.name?.trim()) throw new ValidationError("name is required");
    if (!input.role?.trim()) throw new ValidationError("role is required");

    const existing = this.getByName(input.name);
    if (existing && existing.status !== "destroyed") {
      throw new ConflictError(`Lieutenant '${input.name}' already exists. Destroy it first or use a different name.`);
    }

    // If re-creating over a destroyed entry, remove it first
    if (existing) {
      this.db.run("DELETE FROM lieutenants WHERE name = ?", [input.name]);
    }

    const id = ulid();
    const now = new Date().toISOString();
    const vmId = input.vmId || "";

    this.db.run(
      `INSERT INTO lieutenants (id, name, role, vm_id, is_local, status, system_prompt, model, parent_agent, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, 0, 'starting', ?, ?, ?, ?, ?)`,
      [
        id,
        input.name.trim(),
        input.role.trim(),
        vmId,
        input.systemPrompt || null,
        input.model || null,
        input.parentAgent || null,
        now,
        now,
      ],
    );

    return this.get(id)!;
  }

  get(id: string): Lieutenant | undefined {
    const row = this.db.query("SELECT * FROM lieutenants WHERE id = ?").get(id) as any;
    return row ? rowToLieutenant(row) : undefined;
  }

  getByName(name: string): Lieutenant | undefined {
    const row = this.db.query("SELECT * FROM lieutenants WHERE name = ?").get(name) as any;
    return row ? rowToLieutenant(row) : undefined;
  }

  list(filters?: { status?: LtStatus }): Lieutenant[] {
    let sql = "SELECT * FROM lieutenants WHERE status != 'destroyed'";
    const params: any[] = [];

    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }

    sql += " ORDER BY created_at DESC";

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToLieutenant);
  }

  update(name: string, input: UpdateInput): Lieutenant {
    const lt = this.getByName(name);
    if (!lt) throw new NotFoundError(`Lieutenant '${name}' not found`);

    if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }

    const sets: string[] = [];
    const params: any[] = [];

    if (input.status !== undefined) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.lastOutput !== undefined) {
      sets.push("last_output = ?");
      params.push(input.lastOutput);
    }
    if (input.taskCount !== undefined) {
      sets.push("task_count = ?");
      params.push(input.taskCount);
    }
    if (input.vmId !== undefined) {
      sets.push("vm_id = ?");
      params.push(input.vmId);
    }

    sets.push("last_activity_at = ?");
    params.push(input.lastActivityAt || new Date().toISOString());

    if (sets.length > 0) {
      params.push(name);
      this.db.run(`UPDATE lieutenants SET ${sets.join(", ")} WHERE name = ?`, params);
    }

    return this.getByName(name)!;
  }

  appendOutput(name: string, delta: string): void {
    this.db.run("UPDATE lieutenants SET last_output = last_output || ?, last_activity_at = ? WHERE name = ?", [
      delta,
      new Date().toISOString(),
      name,
    ]);
  }

  /** Push current lastOutput to history and reset it */
  rotateOutput(name: string): void {
    const lt = this.getByName(name);
    if (!lt || !lt.lastOutput.trim()) return;

    const history = [...lt.outputHistory, lt.lastOutput];
    if (history.length > MAX_OUTPUT_HISTORY) history.shift();

    this.db.run("UPDATE lieutenants SET output_history = ?, last_output = '' WHERE name = ?", [
      JSON.stringify(history),
      name,
    ]);
  }

  destroy(name: string): boolean {
    const lt = this.getByName(name);
    if (!lt) return false;

    this.db.run("UPDATE lieutenants SET status = 'destroyed', last_activity_at = ? WHERE name = ?", [
      new Date().toISOString(),
      name,
    ]);
    return true;
  }

  names(): string[] {
    const rows = this.db.query("SELECT name FROM lieutenants WHERE status != 'destroyed'").all() as any[];
    return rows.map((r) => r.name);
  }

  count(): number {
    const row = this.db.query("SELECT COUNT(*) as c FROM lieutenants WHERE status != 'destroyed'").get() as any;
    return row?.c || 0;
  }

  flush(): void {
    // WAL mode handles this — no-op
  }

  close(): void {
    this.db.close();
  }
}

function rowToLieutenant(row: any): Lieutenant {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    vmId: row.vm_id,
    status: row.status,
    lastOutput: row.last_output || "",
    outputHistory: JSON.parse(row.output_history || "[]"),
    taskCount: row.task_count,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    systemPrompt: row.system_prompt || undefined,
    model: row.model || undefined,
    parentAgent: row.parent_agent || undefined,
  };
}
