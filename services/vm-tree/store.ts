/**
 * VM Tree store — unified SQLite database for all fleet state.
 *
 * v2: replaces registry.sqlite, vms.sqlite, lieutenants.sqlite, and data/store.json.
 * Single database file owns 7 tables:
 *   - vm_tree:       every VM in the fleet (identity, status, RPC, snapshots, lineage)
 *   - signals:       bidirectional signal/command delivery between agents
 *   - agent_events:  lifecycle audit trail
 *   - logs:          operational trace (tool calls, errors, decisions)
 *   - store:         key-value persistence (replaces JSON file)
 *   - store_history: versioned write history for store keys
 *
 * commits.sqlite stays separate (different domain — snapshot ledger).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

// =============================================================================
// Types
// =============================================================================

export type VMCategory = "infra_vm" | "lieutenant" | "agent_vm" | "swarm_vm" | "resource_vm";
export type VMStatus = "creating" | "running" | "paused" | "stopped" | "error" | "destroyed" | "rewound";
export type SignalDirection = "up" | "down";
export type UpwardSignalType = "done" | "blocked" | "failed" | "progress" | "need-resources" | "checkpoint";
export type DownwardCommandType = "abort" | "pause" | "resume" | "steer";
export type SignalType = UpwardSignalType | DownwardCommandType;

export interface ReefConfig {
  services: string[];
  capabilities: string[];
}

export interface VMNode {
  vmId: string;
  name: string;
  parentId: string | null;
  category: VMCategory;
  address: string | null;

  // Agent identity
  context: string | null;
  directive: string | null;
  model: string | null;
  effort: string | null;
  grants: Record<string, unknown> | null;
  reefConfig: ReefConfig;

  // Status
  status: VMStatus;
  lastHeartbeat: number | null;
  spawnedBy: string | null;

  // RPC
  rpcStatus: string | null;
  rpcPid: number | null;
  rpcModel: string | null;
  rpcLastActivity: number | null;

  // Snapshots
  baselineCommit: string | null;
  lastCheckpointCommit: string | null;
  completionCommit: string | null;

  // Rewind lineage
  rewindFrom: string | null;
  rewindTo: string | null;

  // Timestamps
  createdAt: number;
  updatedAt: number | null;
}

export interface CreateVMInput {
  vmId?: string;
  name: string;
  parentId?: string | null;
  category: VMCategory;
  address?: string;
  context?: string;
  directive?: string;
  model?: string;
  effort?: string;
  grants?: Record<string, unknown>;
  reefConfig?: ReefConfig;
  spawnedBy?: string;
}

export interface UpdateVMInput {
  name?: string;
  parentId?: string | null;
  category?: VMCategory;
  address?: string;
  status?: VMStatus;
  lastHeartbeat?: number;
  spawnedBy?: string;
  context?: string;
  directive?: string;
  model?: string;
  effort?: string;
  grants?: Record<string, unknown>;
  reefConfig?: ReefConfig;
  rpcStatus?: string;
  rpcPid?: number;
  rpcModel?: string;
  rpcLastActivity?: number;
  baselineCommit?: string;
  lastCheckpointCommit?: string;
  completionCommit?: string;
  rewindFrom?: string;
  rewindTo?: string;
}

export interface Signal {
  id: string;
  fromAgent: string;
  toAgent: string;
  direction: SignalDirection;
  signalType: SignalType;
  payload: Record<string, unknown> | null;
  acknowledged: boolean;
  createdAt: number;
}

export interface AgentEvent {
  id: string;
  agentId: string;
  event: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface LogEntry {
  id: string;
  agentId: string;
  agentName: string;
  level: string;
  category: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface StoreEntry {
  key: string;
  value: unknown;
  agentName: string | null;
  agentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TreeView {
  vm: VMNode;
  children: TreeView[];
}

// =============================================================================
// Constants
// =============================================================================

const VALID_CATEGORIES = new Set<VMCategory>(["infra_vm", "lieutenant", "agent_vm", "swarm_vm", "resource_vm"]);
const VALID_STATUSES = new Set<VMStatus>(["creating", "running", "paused", "stopped", "error", "destroyed", "rewound"]);
const DEFAULT_CONFIG: ReefConfig = { services: [], capabilities: [] };

function normalizeReefConfig(value: unknown): ReefConfig {
  if (!value || typeof value !== "object") return { ...DEFAULT_CONFIG };
  const raw = value as Record<string, unknown>;
  const services = Array.isArray(raw.services) ? raw.services : Array.isArray(raw.organs) ? raw.organs : [];
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  return {
    services: services.filter((entry): entry is string => typeof entry === "string"),
    capabilities: capabilities.filter((entry): entry is string => typeof entry === "string"),
  };
}

// =============================================================================
// Store
// =============================================================================

export class VMTreeStore {
  private db: Database;
  private dbPath: string;

  constructor(dbPath = "data/fleet.sqlite") {
    this.dbPath = dbPath;
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.initTables();
  }

  /** Expose the database handle for other services (signals, logs, store) */
  getDb(): Database {
    return this.db;
  }

  private initTables(): void {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS vm_tree (
				id              TEXT PRIMARY KEY,
				name            TEXT NOT NULL,
				parent_id       TEXT,
				category        TEXT NOT NULL,
				address         TEXT,

				context         TEXT,
				directive       TEXT,
				model           TEXT,
				effort          TEXT,
				grants          TEXT,
				reef_config     TEXT NOT NULL DEFAULT '{"services":[],"capabilities":[]}',

				status          TEXT NOT NULL DEFAULT 'creating',
				last_heartbeat  INTEGER,
				spawned_by      TEXT,

				rpc_status      TEXT,
				rpc_pid         INTEGER,
				rpc_model       TEXT,
				rpc_last_activity INTEGER,

				baseline_commit         TEXT,
				last_checkpoint_commit  TEXT,
				completion_commit       TEXT,

				rewind_from     TEXT,
				rewind_to       TEXT,

				created_at      INTEGER NOT NULL,
				updated_at      INTEGER
			)
		`);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_vm_tree_name ON vm_tree(name, status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_vm_tree_parent ON vm_tree(parent_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_vm_tree_category ON vm_tree(category)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_vm_tree_status ON vm_tree(status)");

    this.db.exec(`
			CREATE TABLE IF NOT EXISTS signals (
				id              TEXT PRIMARY KEY,
				from_agent      TEXT NOT NULL,
				to_agent        TEXT NOT NULL,
				direction       TEXT NOT NULL,
				signal_type     TEXT NOT NULL,
				payload         TEXT,
				acknowledged    INTEGER NOT NULL DEFAULT 0,
				created_at      INTEGER NOT NULL
			)
		`);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_signals_to ON signals(to_agent, acknowledged, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_signals_from ON signals(from_agent, created_at)");

    this.db.exec(`
			CREATE TABLE IF NOT EXISTS agent_events (
				id              TEXT PRIMARY KEY,
				agent_id        TEXT NOT NULL,
				event           TEXT NOT NULL,
				metadata        TEXT,
				created_at      INTEGER NOT NULL
			)
		`);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event, created_at)");

    this.db.exec(`
			CREATE TABLE IF NOT EXISTS logs (
				id              TEXT PRIMARY KEY,
				agent_id        TEXT NOT NULL,
				agent_name      TEXT NOT NULL,
				level           TEXT NOT NULL,
				category        TEXT,
				message         TEXT NOT NULL,
				metadata        TEXT,
				created_at      INTEGER NOT NULL
			)
		`);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_logs_agent_name ON logs(agent_name, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_logs_agent_id ON logs(agent_id, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category, created_at)");

    this.db.exec(`
			CREATE TABLE IF NOT EXISTS store (
				key             TEXT PRIMARY KEY,
				value           TEXT NOT NULL,
				agent_name      TEXT,
				agent_id        TEXT,
				created_at      INTEGER NOT NULL,
				updated_at      INTEGER NOT NULL
			)
		`);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_store_agent ON store(agent_name)");

    this.db.exec(`
			CREATE TABLE IF NOT EXISTS store_history (
				id              TEXT PRIMARY KEY,
				key             TEXT NOT NULL,
				value           TEXT NOT NULL,
				agent_name      TEXT,
				agent_id        TEXT,
				written_at      INTEGER NOT NULL
			)
		`);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_store_history_key ON store_history(key, written_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_store_history_agent ON store_history(agent_name, written_at)");
  }

  // =========================================================================
  // VM CRUD
  // =========================================================================

  createVM(input: CreateVMInput): VMNode {
    if (!input.name?.trim()) throw new Error("name is required");
    if (!input.category || !VALID_CATEGORIES.has(input.category)) {
      throw new Error(`invalid category: ${input.category}`);
    }

    // Enforce name uniqueness among active VMs
    const existing = this.db
      .query("SELECT id FROM vm_tree WHERE name = ? AND status IN ('creating', 'running', 'paused')")
      .get(input.name.trim()) as any;
    if (existing) {
      throw new Error(`agent name '${input.name.trim()}' is already in use by VM ${existing.id}`);
    }

    const vmId = input.vmId || ulid();
    const now = Date.now();

    this.db.run(
      `INSERT INTO vm_tree (id, name, parent_id, category, address, context, directive, model, effort, grants, reef_config, status, spawned_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)`,
      [
        vmId,
        input.name.trim(),
        input.parentId || null,
        input.category,
        input.address || null,
        input.context || null,
        input.directive || null,
        input.model || null,
        input.effort || null,
        input.grants ? JSON.stringify(input.grants) : null,
        JSON.stringify(normalizeReefConfig(input.reefConfig || DEFAULT_CONFIG)),
        input.spawnedBy || null,
        now,
        now,
      ],
    );

    return this.getVM(vmId)!;
  }

  getVM(vmId: string): VMNode | undefined {
    const row = this.db.query("SELECT * FROM vm_tree WHERE id = ?").get(vmId) as any;
    return row ? rowToVMNode(row) : undefined;
  }

  getVMByName(name: string): VMNode | undefined {
    const row = this.db
      .query(
        "SELECT * FROM vm_tree WHERE name = ? AND status IN ('creating', 'running', 'paused') ORDER BY created_at DESC LIMIT 1",
      )
      .get(name) as any;
    return row ? rowToVMNode(row) : undefined;
  }

  updateVM(vmId: string, input: UpdateVMInput): VMNode {
    const vm = this.getVM(vmId);
    if (!vm) throw new Error(`VM '${vmId}' not found`);

    if (input.category && !VALID_CATEGORIES.has(input.category)) {
      throw new Error(`invalid category: ${input.category}`);
    }
    if (input.status && !VALID_STATUSES.has(input.status)) {
      throw new Error(`invalid status: ${input.status}`);
    }

    const sets: string[] = [];
    const params: any[] = [];

    const fields: Array<[keyof UpdateVMInput, string]> = [
      ["name", "name"],
      ["parentId", "parent_id"],
      ["category", "category"],
      ["address", "address"],
      ["status", "status"],
      ["lastHeartbeat", "last_heartbeat"],
      ["spawnedBy", "spawned_by"],
      ["context", "context"],
      ["directive", "directive"],
      ["model", "model"],
      ["effort", "effort"],
      ["rpcStatus", "rpc_status"],
      ["rpcPid", "rpc_pid"],
      ["rpcModel", "rpc_model"],
      ["rpcLastActivity", "rpc_last_activity"],
      ["baselineCommit", "baseline_commit"],
      ["lastCheckpointCommit", "last_checkpoint_commit"],
      ["completionCommit", "completion_commit"],
      ["rewindFrom", "rewind_from"],
      ["rewindTo", "rewind_to"],
    ];

    for (const [key, col] of fields) {
      if (input[key] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(input[key] ?? null);
      }
    }

    if (input.grants !== undefined) {
      sets.push("grants = ?");
      params.push(input.grants ? JSON.stringify(input.grants) : null);
    }
    if (input.reefConfig !== undefined) {
      sets.push("reef_config = ?");
      params.push(JSON.stringify(normalizeReefConfig(input.reefConfig)));
    }

    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(vmId);

    this.db.run(`UPDATE vm_tree SET ${sets.join(", ")} WHERE id = ?`, params);
    return this.getVM(vmId)!;
  }

  upsertVM(input: CreateVMInput): VMNode {
    // Check by vmId first
    const existing = input.vmId ? this.getVM(input.vmId) : undefined;
    if (!existing) {
      // Check if name is taken by an active VM — if so, mark the old one as destroyed and create new
      const byName = input.name ? this.getVMByName(input.name.trim()) : undefined;
      if (byName && byName.vmId !== input.vmId) {
        this.updateVM(byName.vmId, { status: "destroyed" });
      }
      return this.createVM(input);
    }

    return this.updateVM(existing.vmId, {
      name: input.name,
      parentId: input.parentId ?? existing.parentId,
      category: input.category,
      address: input.address ?? existing.address,
      context: input.context ?? existing.context,
      directive: input.directive ?? existing.directive,
      model: input.model ?? existing.model,
      effort: input.effort ?? existing.effort,
      grants: input.grants ?? existing.grants,
      reefConfig: input.reefConfig ?? existing.reefConfig,
      spawnedBy: input.spawnedBy ?? existing.spawnedBy,
    });
  }

  listVMs(filters?: { category?: VMCategory; status?: VMStatus; parentId?: string }): VMNode[] {
    let sql = "SELECT * FROM vm_tree";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters?.category) {
      conditions.push("category = ?");
      params.push(filters.category);
    }
    if (filters?.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.parentId) {
      conditions.push("parent_id = ?");
      params.push(filters.parentId);
    }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at";

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToVMNode);
  }

  // =========================================================================
  // Lineage queries
  // =========================================================================

  children(vmId: string): VMNode[] {
    return this.db.query("SELECT * FROM vm_tree WHERE parent_id = ? ORDER BY created_at").all(vmId).map(rowToVMNode);
  }

  ancestors(vmId: string): VMNode[] {
    const result: VMNode[] = [];
    let currentId: string | null = vmId;
    const seen = new Set<string>();

    while (currentId) {
      if (seen.has(currentId)) break;
      seen.add(currentId);
      const vm = this.getVM(currentId);
      if (!vm) break;
      result.unshift(vm);
      currentId = vm.parentId;
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

  tree(vmId?: string): TreeView[] {
    if (vmId) {
      const vm = this.getVM(vmId);
      if (!vm) return [];
      return [this.buildTree(vm)];
    }

    const roots = this.db
      .query("SELECT * FROM vm_tree WHERE parent_id IS NULL ORDER BY created_at")
      .all()
      .map(rowToVMNode);

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
  // Signals
  // =========================================================================

  insertSignal(input: {
    fromAgent: string;
    toAgent: string;
    direction: SignalDirection;
    signalType: SignalType;
    payload?: Record<string, unknown>;
  }): Signal {
    const id = ulid();
    const now = Date.now();

    this.db.run(
      "INSERT INTO signals (id, from_agent, to_agent, direction, signal_type, payload, acknowledged, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      [
        id,
        input.fromAgent,
        input.toAgent,
        input.direction,
        input.signalType,
        input.payload ? JSON.stringify(input.payload) : null,
        now,
      ],
    );

    return this.getSignal(id)!;
  }

  getSignal(id: string): Signal | undefined {
    const row = this.db.query("SELECT * FROM signals WHERE id = ?").get(id) as any;
    return row ? rowToSignal(row) : undefined;
  }

  querySignals(filters: {
    toAgent?: string;
    fromAgent?: string;
    direction?: SignalDirection;
    signalType?: SignalType;
    acknowledged?: boolean;
    since?: number;
    limit?: number;
  }): Signal[] {
    let sql = "SELECT * FROM signals";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.toAgent) {
      conditions.push("to_agent = ?");
      params.push(filters.toAgent);
    }
    if (filters.fromAgent) {
      conditions.push("from_agent = ?");
      params.push(filters.fromAgent);
    }
    if (filters.direction) {
      conditions.push("direction = ?");
      params.push(filters.direction);
    }
    if (filters.signalType) {
      conditions.push("signal_type = ?");
      params.push(filters.signalType);
    }
    if (filters.acknowledged !== undefined) {
      conditions.push("acknowledged = ?");
      params.push(filters.acknowledged ? 1 : 0);
    }
    if (filters.since) {
      conditions.push("created_at >= ?");
      params.push(filters.since);
    }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at DESC";
    if (filters.limit) sql += ` LIMIT ${filters.limit}`;

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToSignal);
  }

  acknowledgeSignal(id: string): void {
    this.db.run("UPDATE signals SET acknowledged = 1 WHERE id = ?", [id]);
  }

  acknowledgeSignals(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(`UPDATE signals SET acknowledged = 1 WHERE id IN (${placeholders})`, ids);
  }

  // =========================================================================
  // Agent Events
  // =========================================================================

  insertAgentEvent(agentId: string, event: string, metadata?: Record<string, unknown>): AgentEvent {
    const id = ulid();
    const now = Date.now();

    this.db.run("INSERT INTO agent_events (id, agent_id, event, metadata, created_at) VALUES (?, ?, ?, ?, ?)", [
      id,
      agentId,
      event,
      metadata ? JSON.stringify(metadata) : null,
      now,
    ]);

    return { id, agentId, event, metadata: metadata || null, createdAt: now };
  }

  queryAgentEvents(filters: { agentId?: string; event?: string; since?: number; limit?: number }): AgentEvent[] {
    let sql = "SELECT * FROM agent_events";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.agentId) {
      conditions.push("agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.event) {
      conditions.push("event = ?");
      params.push(filters.event);
    }
    if (filters.since) {
      conditions.push("created_at >= ?");
      params.push(filters.since);
    }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at DESC";
    if (filters.limit) sql += ` LIMIT ${filters.limit}`;

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToAgentEvent);
  }

  // =========================================================================
  // Logs
  // =========================================================================

  insertLog(input: {
    agentId: string;
    agentName: string;
    level: string;
    category?: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): LogEntry {
    const id = ulid();
    const now = Date.now();

    this.db.run(
      "INSERT INTO logs (id, agent_id, agent_name, level, category, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.agentId,
        input.agentName,
        input.level,
        input.category || null,
        input.message,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
      ],
    );

    return {
      id,
      agentId: input.agentId,
      agentName: input.agentName,
      level: input.level,
      category: input.category || null,
      message: input.message,
      metadata: input.metadata || null,
      createdAt: now,
    };
  }

  queryLogs(filters: {
    agentName?: string;
    agentId?: string;
    level?: string;
    category?: string;
    since?: number;
    limit?: number;
  }): LogEntry[] {
    let sql = "SELECT * FROM logs";
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.agentName) {
      conditions.push("agent_name = ?");
      params.push(filters.agentName);
    }
    if (filters.agentId) {
      conditions.push("agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.level) {
      conditions.push("level = ?");
      params.push(filters.level);
    }
    if (filters.category) {
      conditions.push("category = ?");
      params.push(filters.category);
    }
    if (filters.since) {
      conditions.push("created_at >= ?");
      params.push(filters.since);
    }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY created_at DESC";
    if (filters.limit) sql += ` LIMIT ${filters.limit}`;

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToLogEntry);
  }

  // =========================================================================
  // Store (key-value)
  // =========================================================================

  storeGet(key: string): StoreEntry | undefined {
    const row = this.db.query("SELECT * FROM store WHERE key = ?").get(key) as any;
    return row ? rowToStoreEntry(row) : undefined;
  }

  storePut(key: string, value: unknown, agentName?: string, agentId?: string): StoreEntry {
    const now = Date.now();
    const valueStr = JSON.stringify(value);

    const existing = this.storeGet(key);
    if (existing) {
      this.db.run("UPDATE store SET value = ?, agent_name = ?, agent_id = ?, updated_at = ? WHERE key = ?", [
        valueStr,
        agentName || null,
        agentId || null,
        now,
        key,
      ]);
    } else {
      this.db.run(
        "INSERT INTO store (key, value, agent_name, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [key, valueStr, agentName || null, agentId || null, now, now],
      );
    }

    // Append to history
    this.db.run(
      "INSERT INTO store_history (id, key, value, agent_name, agent_id, written_at) VALUES (?, ?, ?, ?, ?, ?)",
      [ulid(), key, valueStr, agentName || null, agentId || null, now],
    );

    return this.storeGet(key)!;
  }

  storeDelete(key: string): boolean {
    const result = this.db.run("DELETE FROM store WHERE key = ?", [key]);
    return result.changes > 0;
  }

  storeList(agentName?: string): StoreEntry[] {
    if (agentName) {
      return this.db
        .query("SELECT * FROM store WHERE agent_name = ? ORDER BY updated_at DESC")
        .all(agentName)
        .map(rowToStoreEntry);
    }
    return this.db.query("SELECT * FROM store ORDER BY updated_at DESC").all().map(rowToStoreEntry);
  }

  storeHistory(
    key: string,
    since?: number,
  ): Array<{ id: string; value: unknown; agentName: string | null; agentId: string | null; writtenAt: number }> {
    let sql = "SELECT * FROM store_history WHERE key = ?";
    const params: any[] = [key];
    if (since) {
      sql += " AND written_at >= ?";
      params.push(since);
    }
    sql += " ORDER BY written_at DESC";

    return this.db
      .query(sql)
      .all(...params)
      .map((row: any) => ({
        id: row.id,
        value: JSON.parse(row.value),
        agentName: row.agent_name || null,
        agentId: row.agent_id || null,
        writtenAt: row.written_at,
      }));
  }

  // =========================================================================
  // Fleet status
  // =========================================================================

  fleetStatus(): {
    alive: number;
    byCategory: Record<string, number>;
    byStatus: Record<string, number>;
    totalSpawned: number;
  } {
    const alive =
      (this.db.query("SELECT COUNT(*) as c FROM vm_tree WHERE status NOT IN ('destroyed', 'rewound')").get() as any)
        ?.c || 0;
    const totalSpawned = (this.db.query("SELECT COUNT(*) as c FROM vm_tree").get() as any)?.c || 0;

    const byCategory: Record<string, number> = {};
    const catRows = this.db
      .query(
        "SELECT category, COUNT(*) as c FROM vm_tree WHERE status NOT IN ('destroyed', 'rewound') GROUP BY category",
      )
      .all() as any[];
    for (const row of catRows) byCategory[row.category] = row.c;

    const byStatus: Record<string, number> = {};
    const statusRows = this.db.query("SELECT status, COUNT(*) as c FROM vm_tree GROUP BY status").all() as any[];
    for (const row of statusRows) byStatus[row.status] = row.c;

    return { alive, byCategory, byStatus, totalSpawned };
  }

  // =========================================================================
  // Config queries
  // =========================================================================

  configDiff(vmIdA: string, vmIdB: string): { added: ReefConfig; removed: ReefConfig } | null {
    const a = this.getVM(vmIdA);
    const b = this.getVM(vmIdB);
    if (!a || !b) return null;

    return {
      added: {
        services: b.reefConfig.services.filter((s) => !a.reefConfig.services.includes(s)),
        capabilities: b.reefConfig.capabilities.filter((c) => !a.reefConfig.capabilities.includes(c)),
      },
      removed: {
        services: a.reefConfig.services.filter((s) => !b.reefConfig.services.includes(s)),
        capabilities: a.reefConfig.capabilities.filter((c) => !b.reefConfig.capabilities.includes(c)),
      },
    };
  }

  findByService(service: string): VMNode[] {
    return this.db.query("SELECT * FROM vm_tree WHERE reef_config LIKE ?").all(`%"${service}"%`).map(rowToVMNode);
  }

  findByCapability(capability: string): VMNode[] {
    return this.db.query("SELECT * FROM vm_tree WHERE reef_config LIKE ?").all(`%"${capability}"%`).map(rowToVMNode);
  }

  // =========================================================================
  // Database snapshots
  // =========================================================================

  snapshot(snapshotDir = "data/snapshots"): string {
    const { copyFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });
    this.db.exec("PRAGMA wal_checkpoint(FULL)");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotPath = join(snapshotDir, `fleet-${timestamp}.sqlite`);
    copyFileSync(this.dbPath, snapshotPath);
    return snapshotPath;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  count(): number {
    return (this.db.query("SELECT COUNT(*) as c FROM vm_tree").get() as any)?.c || 0;
  }

  flush(): void {}

  close(): void {
    this.db.close();
  }
}

// =============================================================================
// Row mappers
// =============================================================================

function rowToVMNode(row: any): VMNode {
  return {
    vmId: row.id,
    name: row.name,
    parentId: row.parent_id || null,
    category: row.category,
    address: row.address || null,
    context: row.context || null,
    directive: row.directive || null,
    model: row.model || null,
    effort: row.effort || null,
    grants: row.grants ? JSON.parse(row.grants) : null,
    reefConfig: normalizeReefConfig(JSON.parse(row.reef_config || '{"services":[],"capabilities":[]}')),
    status: row.status,
    lastHeartbeat: row.last_heartbeat || null,
    spawnedBy: row.spawned_by || null,
    rpcStatus: row.rpc_status || null,
    rpcPid: row.rpc_pid || null,
    rpcModel: row.rpc_model || null,
    rpcLastActivity: row.rpc_last_activity || null,
    baselineCommit: row.baseline_commit || null,
    lastCheckpointCommit: row.last_checkpoint_commit || null,
    completionCommit: row.completion_commit || null,
    rewindFrom: row.rewind_from || null,
    rewindTo: row.rewind_to || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
  };
}

function rowToSignal(row: any): Signal {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    direction: row.direction,
    signalType: row.signal_type,
    payload: row.payload ? JSON.parse(row.payload) : null,
    acknowledged: row.acknowledged === 1,
    createdAt: row.created_at,
  };
}

function rowToAgentEvent(row: any): AgentEvent {
  return {
    id: row.id,
    agentId: row.agent_id,
    event: row.event,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
  };
}

function rowToLogEntry(row: any): LogEntry {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    level: row.level,
    category: row.category || null,
    message: row.message,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
  };
}

function rowToStoreEntry(row: any): StoreEntry {
  return {
    key: row.key,
    value: JSON.parse(row.value),
    agentName: row.agent_name || null,
    agentId: row.agent_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
