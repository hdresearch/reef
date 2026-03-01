/**
 * Commits store — VM snapshot ledger. Tracks golden images, rollback points.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

export interface CommitRecord {
  id: string;
  commitId: string;
  vmId: string;
  label?: string;
  agent?: string;
  tags: string[];
  createdAt: string;
  recordedAt: string;
}

export interface CommitInput {
  commitId: string;
  vmId: string;
  label?: string;
  agent?: string;
  tags?: string[];
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class CommitStore {
  private db: Database;

  constructor(dbPath = "data/commits.sqlite") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commits (
        id TEXT PRIMARY KEY,
        commit_id TEXT NOT NULL UNIQUE,
        vm_id TEXT NOT NULL,
        label TEXT,
        agent TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);
  }

  record(input: CommitInput): CommitRecord {
    if (!input.commitId?.trim()) throw new ValidationError("commitId is required");
    if (!input.vmId?.trim()) throw new ValidationError("vmId is required");

    const id = ulid();
    const now = new Date().toISOString();
    const tags = input.tags || [];

    this.db.run("INSERT OR REPLACE INTO commits VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      input.commitId.trim(),
      input.vmId.trim(),
      input.label?.trim() || null,
      input.agent?.trim() || null,
      JSON.stringify(tags),
      now,
      now,
    ]);

    return {
      id,
      commitId: input.commitId.trim(),
      vmId: input.vmId.trim(),
      label: input.label?.trim(),
      agent: input.agent?.trim(),
      tags,
      createdAt: now,
      recordedAt: now,
    };
  }

  get(commitId: string): CommitRecord | null {
    const row = this.db.query("SELECT * FROM commits WHERE commit_id = ?").get(commitId) as any;
    return row ? rowToCommit(row) : null;
  }

  list(filters?: { tag?: string; agent?: string; label?: string; vmId?: string; since?: string }): CommitRecord[] {
    let sql = "SELECT * FROM commits";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.agent) {
      conditions.push("agent = ?");
      params.push(filters.agent);
    }
    if (filters?.label) {
      conditions.push("label = ?");
      params.push(filters.label);
    }
    if (filters?.vmId) {
      conditions.push("vm_id = ?");
      params.push(filters.vmId);
    }
    if (filters?.tag) {
      conditions.push("tags LIKE ?");
      params.push(`%"${filters.tag}"%`);
    }
    if (filters?.since) {
      conditions.push("created_at >= ?");
      params.push(filters.since);
    }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at DESC";

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToCommit);
  }

  delete(commitId: string): boolean {
    const result = this.db.run("DELETE FROM commits WHERE commit_id = ?", [commitId]);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

function rowToCommit(row: any): CommitRecord {
  return {
    id: row.id,
    commitId: row.commit_id,
    vmId: row.vm_id,
    label: row.label || undefined,
    agent: row.agent || undefined,
    tags: JSON.parse(row.tags || "[]"),
    createdAt: row.created_at,
    recordedAt: row.recorded_at,
  };
}
