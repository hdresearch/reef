/**
 * VM Tree store — SQLite-backed VM lineage tree.
 *
 * This is the canonical VM tree from the architecture spec:
 *   roof reef (SQLite VM tree, module distribution)
 *    └── lieutenants (1:many, snapshot to create)
 *         └── swarm workers / agent VMs (fleets)
 *
 * Schema tracks:
 *   - Parent-child relationships (lineage)
 *   - VM category (lieutenant, swarm_vm, agent_vm, infra_vm)
 *   - Reef config per VM (the "DNA" — organs + capabilities)
 *   - Creation/update timestamps
 *
 * Separate from registry: registry tracks live VM health/heartbeats,
 * vm-tree tracks the permanent lineage and config history.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "ulid";

// =============================================================================
// Types
// =============================================================================

export type VMCategory = "lieutenant" | "swarm_vm" | "agent_vm" | "infra_vm";

export interface ReefConfig {
  organs: string[];
  capabilities: string[];
}

export interface VMNode {
  vmId: string;
  name: string;
  parentVmId: string | null;
  category: VMCategory;
  reefConfig: ReefConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVMInput {
  vmId?: string;
  name: string;
  parentVmId?: string;
  category: VMCategory;
  reefConfig?: ReefConfig;
}

export interface UpdateVMInput {
  name?: string;
  category?: VMCategory;
  reefConfig?: ReefConfig;
}

export interface TreeView {
  vm: VMNode;
  children: TreeView[];
}

// =============================================================================
// Constants
// =============================================================================

const VALID_CATEGORIES = new Set<string>(["lieutenant", "swarm_vm", "agent_vm", "infra_vm"]);
const DEFAULT_CONFIG: ReefConfig = { organs: [], capabilities: [] };

// =============================================================================
// Store
// =============================================================================

export class VMTreeStore {
  private db: Database;
  private dbPath: string;

  constructor(dbPath = "data/vms.sqlite") {
    this.dbPath = dbPath;
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vms (
        vm_id        TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        parent_vm_id TEXT REFERENCES vms(vm_id),
        category     TEXT NOT NULL CHECK(category IN ('lieutenant', 'swarm_vm', 'agent_vm', 'infra_vm')),
        reef_config  TEXT NOT NULL DEFAULT '{"organs":[],"capabilities":[]}',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_vms_parent ON vms(parent_vm_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_vms_category ON vms(category)`);
  }

  // =========================================================================
  // CRUD
  // =========================================================================

  create(input: CreateVMInput): VMNode {
    if (!input.name?.trim()) throw new Error("name is required");
    if (!input.category || !VALID_CATEGORIES.has(input.category)) {
      throw new Error(`invalid category: ${input.category}`);
    }

    // Validate parent exists if specified
    if (input.parentVmId) {
      const parent = this.get(input.parentVmId);
      if (!parent) throw new Error(`parent VM '${input.parentVmId}' not found`);
    }

    const vmId = input.vmId || ulid();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO vms (vm_id, name, parent_vm_id, category, reef_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        vmId,
        input.name.trim(),
        input.parentVmId || null,
        input.category,
        JSON.stringify(input.reefConfig || DEFAULT_CONFIG),
        now,
        now,
      ],
    );

    return this.get(vmId)!;
  }

  get(vmId: string): VMNode | undefined {
    const row = this.db.query("SELECT * FROM vms WHERE vm_id = ?").get(vmId) as any;
    return row ? rowToNode(row) : undefined;
  }

  update(vmId: string, input: UpdateVMInput): VMNode {
    const vm = this.get(vmId);
    if (!vm) throw new Error(`VM '${vmId}' not found`);

    if (input.category && !VALID_CATEGORIES.has(input.category)) {
      throw new Error(`invalid category: ${input.category}`);
    }

    const sets: string[] = [];
    const params: any[] = [];

    if (input.name !== undefined) {
      sets.push("name = ?");
      params.push(input.name.trim());
    }
    if (input.category !== undefined) {
      sets.push("category = ?");
      params.push(input.category);
    }
    if (input.reefConfig !== undefined) {
      sets.push("reef_config = ?");
      params.push(JSON.stringify(input.reefConfig));
    }

    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(vmId);

    this.db.run(`UPDATE vms SET ${sets.join(", ")} WHERE vm_id = ?`, params);
    return this.get(vmId)!;
  }

  remove(vmId: string): boolean {
    // Check for children — don't orphan them
    const kids = this.children(vmId);
    if (kids.length > 0) {
      throw new Error(`VM '${vmId}' has ${kids.length} children. Remove or reassign them first.`);
    }
    const result = this.db.run("DELETE FROM vms WHERE vm_id = ?", [vmId]);
    return result.changes > 0;
  }

  list(filters?: { category?: VMCategory; parentVmId?: string }): VMNode[] {
    let sql = "SELECT * FROM vms";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.category) {
      conditions.push("category = ?");
      params.push(filters.category);
    }
    if (filters?.parentVmId) {
      conditions.push("parent_vm_id = ?");
      params.push(filters.parentVmId);
    }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at";

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToNode);
  }

  // =========================================================================
  // Lineage queries
  // =========================================================================

  children(vmId: string): VMNode[] {
    return this.db
      .query("SELECT * FROM vms WHERE parent_vm_id = ? ORDER BY created_at")
      .all(vmId)
      .map(rowToNode);
  }

  ancestors(vmId: string): VMNode[] {
    const result: VMNode[] = [];
    let currentId: string | null = vmId;
    const seen = new Set<string>();

    while (currentId) {
      if (seen.has(currentId)) break;
      seen.add(currentId);
      const vm = this.get(currentId);
      if (!vm) break;
      result.unshift(vm);
      currentId = vm.parentVmId;
    }

    return result;
  }

  descendants(vmId: string): VMNode[] {
    const result: VMNode[] = [];
    const queue: string[] = [vmId];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);

      const kids = this.children(id);
      for (const kid of kids) {
        result.push(kid);
        queue.push(kid.vmId);
      }
    }

    return result;
  }

  /** Build a full tree view from a root (or all roots if no vmId given) */
  tree(vmId?: string): TreeView[] {
    if (vmId) {
      const vm = this.get(vmId);
      if (!vm) return [];
      return [this.buildTree(vm)];
    }

    // All roots (VMs with no parent)
    const roots = this.db
      .query("SELECT * FROM vms WHERE parent_vm_id IS NULL ORDER BY created_at")
      .all()
      .map(rowToNode);

    return roots.map((r) => this.buildTree(r));
  }

  private buildTree(vm: VMNode): TreeView {
    const kids = this.children(vm.vmId);
    return {
      vm,
      children: kids.map((k) => this.buildTree(k)),
    };
  }

  // =========================================================================
  // Config queries
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

  /** Find VMs that have a specific organ loaded */
  findByOrgan(organ: string): VMNode[] {
    // SQLite JSON — use LIKE for simplicity since json_each requires extension
    return this.db
      .query(`SELECT * FROM vms WHERE reef_config LIKE ?`)
      .all(`%"${organ}"%`)
      .map(rowToNode);
  }

  /** Find VMs that have a specific capability */
  findByCapability(capability: string): VMNode[] {
    return this.db
      .query(`SELECT * FROM vms WHERE reef_config LIKE ?`)
      .all(`%"${capability}"%`)
      .map(rowToNode);
  }

  // =========================================================================
  // Snapshots
  // =========================================================================

  /** Create a snapshot of the database */
  snapshot(snapshotDir = "data/snapshots"): string {
    if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotPath = join(snapshotDir, `vms-${timestamp}.sqlite`);
    copyFileSync(this.dbPath, snapshotPath);
    return snapshotPath;
  }

  /** Clean old snapshots, keeping the most recent N */
  pruneSnapshots(snapshotDir = "data/snapshots", keep = 24): number {
    if (!existsSync(snapshotDir)) return 0;

    const { readdirSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(snapshotDir)
      .filter((f: string) => f.startsWith("vms-") && f.endsWith(".sqlite"))
      .sort()
      .reverse();

    let removed = 0;
    for (let i = keep; i < files.length; i++) {
      try {
        unlinkSync(join(snapshotDir, files[i]));
        removed++;
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  // =========================================================================
  // Stats
  // =========================================================================

  stats(): { total: number; byCategory: Record<string, number>; roots: number } {
    const total = (this.db.query("SELECT COUNT(*) as c FROM vms").get() as any)?.c || 0;
    const roots = (this.db.query("SELECT COUNT(*) as c FROM vms WHERE parent_vm_id IS NULL").get() as any)?.c || 0;

    const byCategory: Record<string, number> = {};
    const rows = this.db.query("SELECT category, COUNT(*) as c FROM vms GROUP BY category").all() as any[];
    for (const row of rows) {
      byCategory[row.category] = row.c;
    }

    return { total, byCategory, roots };
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) as c FROM vms").get() as any)?.c || 0;
  }

  flush(): void {}

  close(): void {
    this.db.close();
  }
}

// =============================================================================
// Row mapper
// =============================================================================

function rowToNode(row: any): VMNode {
  return {
    vmId: row.vm_id,
    name: row.name,
    parentVmId: row.parent_vm_id || null,
    category: row.category,
    reefConfig: JSON.parse(row.reef_config || '{"organs":[],"capabilities":[]}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
