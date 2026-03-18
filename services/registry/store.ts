/**
 * Registry store — VM service discovery backed by SQLite.
 *
 * Upgraded from in-memory to SQLite with:
 *   - VM lineage tracking (parent-child relationships)
 *   - Reef config per VM (the "DNA" concept — organs + capabilities)
 *   - Heartbeat-based liveness detection
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

// =============================================================================
// Types
// =============================================================================

export type VMRole = "infra" | "lieutenant" | "worker" | "golden" | "custom";
export type VMStatus = "running" | "paused" | "stopped";

export interface VMService {
  name: string;
  port: number;
  protocol?: string;
}

export interface ReefConfig {
  organs: string[];
  capabilities: string[];
}

export interface VM {
  id: string;
  name: string;
  role: VMRole;
  status: VMStatus;
  address: string;
  parentVmId: string | null;
  services: VMService[];
  reefConfig: ReefConfig;
  registeredBy: string;
  registeredAt: string;
  lastSeen: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterInput {
  id: string;
  name: string;
  role: VMRole;
  address: string;
  parentVmId?: string;
  services?: VMService[];
  reefConfig?: ReefConfig;
  registeredBy: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateInput {
  name?: string;
  status?: VMStatus;
  address?: string;
  services?: VMService[];
  reefConfig?: ReefConfig;
  metadata?: Record<string, unknown>;
}

export interface VMFilters {
  role?: VMRole;
  status?: VMStatus;
  parentVmId?: string;
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

const VALID_ROLES = new Set<string>(["infra", "lieutenant", "worker", "golden", "custom"]);
const VALID_STATUSES = new Set<string>(["running", "paused", "stopped"]);
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_REEF_CONFIG: ReefConfig = { organs: [], capabilities: [] };

// =============================================================================
// Store
// =============================================================================

export class RegistryStore {
  private db: Database;

  constructor(dbPath = "data/registry.sqlite") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('infra', 'lieutenant', 'worker', 'golden', 'custom')),
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'paused', 'stopped')),
        address TEXT NOT NULL,
        parent_vm_id TEXT REFERENCES vms(id) ON DELETE SET NULL,
        services TEXT NOT NULL DEFAULT '[]',
        reef_config TEXT NOT NULL DEFAULT '{"organs":[],"capabilities":[]}',
        registered_by TEXT NOT NULL,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_vms_role ON vms(role)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_vms_parent ON vms(parent_vm_id)`);
  }

  private isStale(lastSeen: string): boolean {
    return Date.now() - new Date(lastSeen).getTime() > STALE_THRESHOLD_MS;
  }

  register(input: RegisterInput): VM {
    if (!input.id?.trim()) throw new ValidationError("id is required");
    if (!input.name?.trim()) throw new ValidationError("name is required");
    if (!input.role || !VALID_ROLES.has(input.role)) throw new ValidationError(`invalid role: ${input.role}`);
    if (!input.address?.trim()) throw new ValidationError("address is required");
    if (!input.registeredBy?.trim()) throw new ValidationError("registeredBy is required");

    const now = new Date().toISOString();
    const existing = this.get(input.id);

    if (existing) {
      // Upsert — update existing registration
      this.db.run(
        `UPDATE vms SET name = ?, role = ?, status = 'running', address = ?,
         parent_vm_id = ?, services = ?, reef_config = ?, registered_by = ?,
         last_seen = ?, metadata = ? WHERE id = ?`,
        [
          input.name.trim(),
          input.role,
          input.address.trim(),
          input.parentVmId || existing.parentVmId || null,
          JSON.stringify(input.services || existing.services),
          JSON.stringify(input.reefConfig || existing.reefConfig),
          input.registeredBy.trim(),
          now,
          input.metadata ? JSON.stringify(input.metadata) : (existing.metadata ? JSON.stringify(existing.metadata) : null),
          input.id,
        ],
      );
    } else {
      this.db.run(
        `INSERT INTO vms (id, name, role, status, address, parent_vm_id, services, reef_config, registered_by, registered_at, last_seen, metadata)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id.trim(),
          input.name.trim(),
          input.role,
          input.address.trim(),
          input.parentVmId || null,
          JSON.stringify(input.services || []),
          JSON.stringify(input.reefConfig || DEFAULT_REEF_CONFIG),
          input.registeredBy.trim(),
          now,
          now,
          input.metadata ? JSON.stringify(input.metadata) : null,
        ],
      );
    }

    return this.get(input.id)!;
  }

  get(id: string): VM | undefined {
    const row = this.db.query("SELECT * FROM vms WHERE id = ?").get(id) as any;
    return row ? rowToVM(row) : undefined;
  }

  list(filters?: VMFilters): VM[] {
    let sql = "SELECT * FROM vms";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.role) {
      conditions.push("role = ?");
      params.push(filters.role);
    }
    if (filters?.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.parentVmId) {
      conditions.push("parent_vm_id = ?");
      params.push(filters.parentVmId);
    }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY last_seen DESC";

    let results = this.db
      .query(sql)
      .all(...params)
      .map(rowToVM);

    // Exclude stale VMs from "running" filter
    if (filters?.status === "running") {
      results = results.filter((v) => !this.isStale(v.lastSeen));
    }

    return results;
  }

  update(id: string, input: UpdateInput): VM {
    const vm = this.get(id);
    if (!vm) throw new NotFoundError("VM not found");

    if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
      throw new ValidationError(`invalid status: ${input.status}`);
    }

    const sets: string[] = [];
    const params: any[] = [];

    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(input.name.trim());
    }
    if (input.status !== undefined) {
      sets.push("status = ?");
      params.push(input.status);
    }
    if (input.address !== undefined) {
      sets.push("address = ?");
      params.push(input.address.trim());
    }
    if (input.services !== undefined) {
      sets.push("services = ?");
      params.push(JSON.stringify(input.services));
    }
    if (input.reefConfig !== undefined) {
      sets.push("reef_config = ?");
      params.push(JSON.stringify(input.reefConfig));
    }
    if (input.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(input.metadata));
    }

    sets.push("last_seen = ?");
    params.push(new Date().toISOString());

    if (sets.length > 0) {
      params.push(id);
      this.db.run(`UPDATE vms SET ${sets.join(", ")} WHERE id = ?`, params);
    }

    return this.get(id)!;
  }

  deregister(id: string): boolean {
    const result = this.db.run("DELETE FROM vms WHERE id = ?", [id]);
    return result.changes > 0;
  }

  heartbeat(id: string): VM {
    const vm = this.get(id);
    if (!vm) throw new NotFoundError("VM not found");

    this.db.run("UPDATE vms SET last_seen = ?, status = 'running' WHERE id = ?", [new Date().toISOString(), id]);
    return this.get(id)!;
  }

  discover(role: VMRole): VM[] {
    return this.db
      .query("SELECT * FROM vms WHERE role = ? AND status = 'running'")
      .all(role)
      .map(rowToVM)
      .filter((v) => !this.isStale(v.lastSeen));
  }

  // =========================================================================
  // Lineage queries
  // =========================================================================

  /** Get all direct children of a VM */
  children(vmId: string): VM[] {
    return this.db
      .query("SELECT * FROM vms WHERE parent_vm_id = ? ORDER BY registered_at")
      .all(vmId)
      .map(rowToVM);
  }

  /** Get ancestors from a VM up to the root */
  ancestors(vmId: string): VM[] {
    const result: VM[] = [];
    let currentId: string | null = vmId;
    const seen = new Set<string>();

    while (currentId) {
      if (seen.has(currentId)) break; // prevent cycles
      seen.add(currentId);
      const vm = this.get(currentId);
      if (!vm) break;
      result.unshift(vm);
      currentId = vm.parentVmId;
    }

    return result;
  }

  /** Get entire subtree rooted at a VM (BFS) */
  subtree(vmId: string): VM[] {
    const result: VM[] = [];
    const queue: string[] = [vmId];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);

      const vm = this.get(id);
      if (!vm) continue;
      result.push(vm);

      const kids = this.children(id);
      for (const kid of kids) {
        queue.push(kid.id);
      }
    }

    return result;
  }

  // =========================================================================
  // Config diff
  // =========================================================================

  /** Compare reef configs between two VMs */
  configDiff(vmIdA: string, vmIdB: string): { added: ReefConfig; removed: ReefConfig } | null {
    const a = this.get(vmIdA);
    const b = this.get(vmIdB);
    if (!a || !b) return null;

    return {
      added: {
        organs: b.reefConfig.organs.filter((o) => !a.reefConfig.organs.includes(o)),
        capabilities: b.reefConfig.capabilities.filter((c) => !a.reefConfig.capabilities.includes(c)),
      },
      removed: {
        organs: a.reefConfig.organs.filter((o) => !b.reefConfig.organs.includes(o)),
        capabilities: a.reefConfig.capabilities.filter((c) => !b.reefConfig.capabilities.includes(c)),
      },
    };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  count(): number {
    const row = this.db.query("SELECT COUNT(*) as c FROM vms").get() as any;
    return row?.c || 0;
  }

  flush(): void {
    // WAL mode handles durability
  }

  close(): void {
    this.db.close();
  }
}

// =============================================================================
// Row mapper
// =============================================================================

function rowToVM(row: any): VM {
  const vm: VM = {
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status,
    address: row.address,
    parentVmId: row.parent_vm_id || null,
    services: JSON.parse(row.services || "[]"),
    reefConfig: JSON.parse(row.reef_config || '{"organs":[],"capabilities":[]}'),
    registeredBy: row.registered_by,
    registeredAt: row.registered_at,
    lastSeen: row.last_seen,
  };
  if (row.metadata) {
    try {
      vm.metadata = JSON.parse(row.metadata);
    } catch {
      /* ignore malformed metadata */
    }
  }
  return vm;
}
