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
export type SignalDirection = "up" | "down" | "peer";
export type UpwardSignalType = "done" | "blocked" | "failed" | "progress" | "need-resources" | "checkpoint";
export type DownwardCommandType = "abort" | "pause" | "resume" | "steer";
export type PeerSignalType = "info" | "request" | "artifact" | "warning" | "handoff";
export type SignalType = UpwardSignalType | DownwardCommandType | PeerSignalType;

export interface ReefConfig {
  services: string[];
  capabilities: string[];
}

export interface ServiceEndpoint {
  name: string;
  port: number;
  protocol?: string;
}

export interface DiscoveryHints {
  registeredVia?: string;
  agentLabel?: string;
  parentSession?: boolean;
  reconnectKind?: "lieutenant" | "swarm" | "agent_vm" | "resource_vm";
  commitId?: string;
  roleHint?: string;
}

export interface VMNode {
  vmId: string;
  name: string;
  parentId: string | null;
  category: VMCategory;
  address: string | null;
  serviceEndpoints: ServiceEndpoint[];

  // Agent identity
  context: string | null;
  directive: string | null;
  model: string | null;
  effort: string | null;
  grants: Record<string, unknown> | null;
  reefConfig: ReefConfig;
  discovery: DiscoveryHints | null;

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
  serviceEndpoints?: ServiceEndpoint[];
  status?: VMStatus;
  lastHeartbeat?: number;
  context?: string;
  directive?: string;
  model?: string;
  effort?: string;
  grants?: Record<string, unknown>;
  reefConfig?: ReefConfig;
  spawnedBy?: string;
  discovery?: DiscoveryHints;
}

export interface UpdateVMInput {
  name?: string;
  parentId?: string | null;
  category?: VMCategory;
  address?: string;
  serviceEndpoints?: ServiceEndpoint[];
  status?: VMStatus;
  lastHeartbeat?: number;
  spawnedBy?: string;
  context?: string;
  directive?: string;
  model?: string;
  effort?: string;
  grants?: Record<string, unknown>;
  reefConfig?: ReefConfig;
  discovery?: DiscoveryHints | null;
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

export interface UsageRecord {
  id: string;
  agentId: string;
  agentName: string;
  taskId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  createdAt: number;
}

export interface UsageSessionSnapshot {
  id: string;
  agentId: string;
  agentName: string;
  taskId: string | null;
  sessionId: string;
  sessionFile: string | null;
  provider: string | null;
  model: string | null;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  createdAt: number;
  updatedAt: number;
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

function normalizeServiceEndpoints(value: unknown): ServiceEndpoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name : "",
      port: typeof entry.port === "number" ? entry.port : Number(entry.port),
      protocol: typeof entry.protocol === "string" ? entry.protocol : undefined,
    }))
    .filter((entry) => entry.name && Number.isFinite(entry.port));
}

function normalizeDiscovery(value: unknown): DiscoveryHints | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const reconnectKind = raw.reconnectKind;
  return {
    registeredVia: typeof raw.registeredVia === "string" ? raw.registeredVia : undefined,
    agentLabel: typeof raw.agentLabel === "string" ? raw.agentLabel : undefined,
    parentSession: typeof raw.parentSession === "boolean" ? raw.parentSession : undefined,
    reconnectKind:
      reconnectKind === "lieutenant" ||
      reconnectKind === "swarm" ||
      reconnectKind === "agent_vm" ||
      reconnectKind === "resource_vm"
        ? reconnectKind
        : undefined,
    commitId: typeof raw.commitId === "string" ? raw.commitId : undefined,
    roleHint: typeof raw.roleHint === "string" ? raw.roleHint : undefined,
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
				service_endpoints TEXT NOT NULL DEFAULT '[]',

				context         TEXT,
				directive       TEXT,
				model           TEXT,
				effort          TEXT,
				grants          TEXT,
				reef_config     TEXT NOT NULL DEFAULT '{"services":[],"capabilities":[]}',
				discovery       TEXT,

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

    this.ensureColumn("vm_tree", "service_endpoints", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("vm_tree", "discovery", "TEXT");

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
			CREATE TABLE IF NOT EXISTS usage_records (
				id                TEXT PRIMARY KEY,
				agent_id          TEXT NOT NULL,
				agent_name        TEXT NOT NULL,
				task_id           TEXT,
				provider          TEXT,
				model             TEXT,
				input_tokens      INTEGER NOT NULL DEFAULT 0,
				output_tokens     INTEGER NOT NULL DEFAULT 0,
				cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				total_tokens      INTEGER NOT NULL DEFAULT 0,
				input_cost        REAL NOT NULL DEFAULT 0,
				output_cost       REAL NOT NULL DEFAULT 0,
				cache_read_cost   REAL NOT NULL DEFAULT 0,
				cache_write_cost  REAL NOT NULL DEFAULT 0,
				total_cost        REAL NOT NULL DEFAULT 0,
				created_at        INTEGER NOT NULL
			)
		`);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_agent_name ON usage_records(agent_name, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_agent_id ON usage_records(agent_id, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_task ON usage_records(task_id, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model, created_at)");

    this.db.exec(`
			CREATE TABLE IF NOT EXISTS usage_sessions (
				id                 TEXT PRIMARY KEY,
				agent_id           TEXT NOT NULL,
				agent_name         TEXT NOT NULL,
				task_id            TEXT,
				session_id         TEXT NOT NULL,
				session_file       TEXT,
				provider           TEXT,
				model              TEXT,
				user_messages      INTEGER NOT NULL DEFAULT 0,
				assistant_messages INTEGER NOT NULL DEFAULT 0,
				tool_calls         INTEGER NOT NULL DEFAULT 0,
				tool_results       INTEGER NOT NULL DEFAULT 0,
				total_messages     INTEGER NOT NULL DEFAULT 0,
				input_tokens       INTEGER NOT NULL DEFAULT 0,
				output_tokens      INTEGER NOT NULL DEFAULT 0,
				cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0,
				total_tokens       INTEGER NOT NULL DEFAULT 0,
				total_cost         REAL NOT NULL DEFAULT 0,
				created_at         INTEGER NOT NULL,
				updated_at         INTEGER NOT NULL,
				UNIQUE(agent_id, session_id)
			)
		`);

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_sessions_agent_id ON usage_sessions(agent_id, updated_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_sessions_agent_name ON usage_sessions(agent_name, updated_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_sessions_task ON usage_sessions(task_id, updated_at)");

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

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
      `INSERT INTO vm_tree (id, name, parent_id, category, address, service_endpoints, context, directive, model, effort, grants, reef_config, discovery, status, last_heartbeat, spawned_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vmId,
        input.name.trim(),
        input.parentId || null,
        input.category,
        input.address || null,
        JSON.stringify(normalizeServiceEndpoints(input.serviceEndpoints)),
        input.context || null,
        input.directive || null,
        input.model || null,
        input.effort || null,
        input.grants ? JSON.stringify(input.grants) : null,
        JSON.stringify(normalizeReefConfig(input.reefConfig || DEFAULT_CONFIG)),
        input.discovery ? JSON.stringify(normalizeDiscovery(input.discovery)) : null,
        input.status || "creating",
        input.lastHeartbeat || null,
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
    if (input.serviceEndpoints !== undefined) {
      sets.push("service_endpoints = ?");
      params.push(JSON.stringify(normalizeServiceEndpoints(input.serviceEndpoints)));
    }
    if (input.reefConfig !== undefined) {
      sets.push("reef_config = ?");
      params.push(JSON.stringify(normalizeReefConfig(input.reefConfig)));
    }
    if (input.discovery !== undefined) {
      sets.push("discovery = ?");
      params.push(input.discovery ? JSON.stringify(normalizeDiscovery(input.discovery)) : null);
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
      serviceEndpoints: input.serviceEndpoints ?? existing.serviceEndpoints,
      status: input.status,
      lastHeartbeat: input.lastHeartbeat,
      context: input.context ?? existing.context,
      directive: input.directive ?? existing.directive,
      model: input.model ?? existing.model,
      effort: input.effort ?? existing.effort,
      grants: input.grants ?? existing.grants,
      reefConfig: input.reefConfig ?? existing.reefConfig,
      spawnedBy: input.spawnedBy ?? existing.spawnedBy,
      discovery: input.discovery ?? existing.discovery,
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
  // Usage
  // =========================================================================

  insertUsage(input: {
    agentId: string;
    agentName: string;
    taskId?: string | null;
    provider?: string | null;
    model?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    inputCost?: number;
    outputCost?: number;
    cacheReadCost?: number;
    cacheWriteCost?: number;
    totalCost?: number;
  }): UsageRecord {
    const id = ulid();
    const now = Date.now();
    const inputTokens = input.inputTokens || 0;
    const outputTokens = input.outputTokens || 0;
    const cacheReadTokens = input.cacheReadTokens || 0;
    const cacheWriteTokens = input.cacheWriteTokens || 0;
    const totalTokens = input.totalTokens || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const inputCost = input.inputCost || 0;
    const outputCost = input.outputCost || 0;
    const cacheReadCost = input.cacheReadCost || 0;
    const cacheWriteCost = input.cacheWriteCost || 0;
    const totalCost = input.totalCost || inputCost + outputCost + cacheReadCost + cacheWriteCost;

    this.db.run(
      `INSERT INTO usage_records (
        id, agent_id, agent_name, task_id, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
        input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.agentId,
        input.agentName,
        input.taskId || null,
        input.provider || null,
        input.model || null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        inputCost,
        outputCost,
        cacheReadCost,
        cacheWriteCost,
        totalCost,
        now,
      ],
    );

    return this.getUsage(id)!;
  }

  getUsage(id: string): UsageRecord | undefined {
    const row = this.db.query("SELECT * FROM usage_records WHERE id = ?").get(id) as any;
    return row ? rowToUsageRecord(row) : undefined;
  }

  queryUsage(filters: {
    agentName?: string;
    agentId?: string;
    taskId?: string;
    since?: number;
    limit?: number;
  }): UsageRecord[] {
    let sql = "SELECT * FROM usage_records";
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
    if (filters.taskId) {
      conditions.push("task_id = ?");
      params.push(filters.taskId);
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
      .map(rowToUsageRecord);
  }

  usageSummary(since?: number): {
    totals: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      totalCost: number;
    };
    byAgent: Array<{
      agentId: string;
      agentName: string;
      category: VMCategory | null;
      parentId: string | null;
      provider: string | null;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      totalCost: number;
      turns: number;
      lastSeen: number;
    }>;
    lineages: Array<{
      agentId: string;
      agentName: string;
      category: VMCategory | null;
      parentId: string | null;
      selfTokens: number;
      selfCost: number;
      subtreeTokens: number;
      subtreeCost: number;
      descendantAgents: number;
    }>;
    accuracy: {
      childAgentsSource: string;
      rootSource: string;
      caveats: string[];
    };
  } {
    const snapshots = this.queryLatestUsageSessions({ since });
    const snapshotAgentIds = new Set(snapshots.map((row) => row.agentId));
    const snapshotByAgent = new Map<
      string,
      {
        agentId: string;
        agentName: string;
        category: VMCategory | null;
        parentId: string | null;
        provider: string | null;
        model: string | null;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        totalTokens: number;
        totalCost: number;
        turns: number;
        lastSeen: number;
      }
    >();
    for (const row of snapshots) {
      const vm = this.getVM(row.agentId);
      const existing = snapshotByAgent.get(row.agentId);
      if (!existing) {
        snapshotByAgent.set(row.agentId, {
          agentId: row.agentId,
          agentName: row.agentName,
          category: vm?.category || null,
          parentId: vm?.parentId || null,
          provider: row.provider || null,
          model: row.model || null,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          totalTokens: row.totalTokens,
          totalCost: row.totalCost,
          turns: row.assistantMessages,
          lastSeen: row.updatedAt,
        });
        continue;
      }

      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.cacheReadTokens += row.cacheReadTokens;
      existing.cacheWriteTokens += row.cacheWriteTokens;
      existing.totalTokens += row.totalTokens;
      existing.totalCost += row.totalCost;
      existing.turns += row.assistantMessages;
      if (row.updatedAt >= existing.lastSeen) {
        existing.lastSeen = row.updatedAt;
        existing.provider = row.provider || existing.provider;
        existing.model = row.model || existing.model;
        existing.agentName = row.agentName || existing.agentName;
        existing.category = vm?.category || existing.category;
        existing.parentId = vm?.parentId || existing.parentId;
      }
    }

    const rawByAgent = this.queryRawUsageByAgent({ since, excludeAgentIds: [...snapshotAgentIds] });

    const byAgent = [...snapshotByAgent.values(), ...rawByAgent].sort(
      (a, b) => b.totalCost - a.totalCost || b.totalTokens - a.totalTokens,
    );

    const byAgentMap = new Map(byAgent.map((row) => [row.agentId, row]));
    const lineages = byAgent
      .map((row) => {
        const descendants = this.descendants(row.agentId)
          .map((vm) => byAgentMap.get(vm.vmId))
          .filter((entry): entry is NonNullable<typeof entry> => !!entry);
        const subtreeTokens = row.totalTokens + descendants.reduce((sum, child) => sum + child.totalTokens, 0);
        const subtreeCost = row.totalCost + descendants.reduce((sum, child) => sum + child.totalCost, 0);
        return {
          agentId: row.agentId,
          agentName: row.agentName,
          category: row.category,
          parentId: row.parentId,
          selfTokens: row.totalTokens,
          selfCost: row.totalCost,
          subtreeTokens,
          subtreeCost,
          descendantAgents: descendants.length,
        };
      })
      .sort((a, b) => b.subtreeCost - a.subtreeCost || b.subtreeTokens - a.subtreeTokens);

    const totals = byAgent.reduce(
      (acc, row) => {
        acc.inputTokens += row.inputTokens;
        acc.outputTokens += row.outputTokens;
        acc.cacheReadTokens += row.cacheReadTokens;
        acc.cacheWriteTokens += row.cacheWriteTokens;
        acc.totalTokens += row.totalTokens;
        acc.totalCost += row.totalCost;
        return acc;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        totalCost: 0,
      },
    );

    return {
      totals,
      byAgent,
      lineages,
      accuracy: {
        childAgentsSource:
          "latest successful RPC get_session_stats snapshot per lieutenant, agent VM, or swarm worker session; falls back to assistant-message usage when no snapshot exists yet",
        rootSource:
          "latest successful local RPC get_session_stats snapshot per root task session; falls back to assistant-message usage when no snapshot exists yet",
        caveats: [
          "root and child totals are canonical only as of the latest successful session stats pull for each session",
          "session-backed agents aggregate the latest snapshot from each known session, not just the latest session overall",
          "child lineage rollups are computed from vm-tree ancestry plus the latest per-agent total available",
          "agents without a session snapshot yet fall back to assistant message usage rows",
          "displayed dollar cost is harness-side model pricing, not provider billing reconciliation",
        ],
      },
    };
  }

  upsertUsageSession(input: {
    agentId: string;
    agentName: string;
    taskId?: string | null;
    sessionId: string;
    sessionFile?: string | null;
    provider?: string | null;
    model?: string | null;
    userMessages?: number;
    assistantMessages?: number;
    toolCalls?: number;
    toolResults?: number;
    totalMessages?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    totalCost?: number;
  }): UsageSessionSnapshot {
    const existing = this.db
      .query("SELECT id, created_at FROM usage_sessions WHERE agent_id = ? AND session_id = ?")
      .get(input.agentId, input.sessionId) as any;
    const now = Date.now();
    const id = existing?.id || ulid();
    const createdAt = existing?.created_at || now;
    const inputTokens = input.inputTokens || 0;
    const outputTokens = input.outputTokens || 0;
    const cacheReadTokens = input.cacheReadTokens || 0;
    const cacheWriteTokens = input.cacheWriteTokens || 0;
    const totalTokens = input.totalTokens || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

    this.db.run(
      `INSERT INTO usage_sessions (
        id, agent_id, agent_name, task_id, session_id, session_file, provider, model,
        user_messages, assistant_messages, tool_calls, tool_results, total_messages,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
        total_cost, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, session_id) DO UPDATE SET
        agent_name = excluded.agent_name,
        task_id = excluded.task_id,
        session_file = excluded.session_file,
        provider = excluded.provider,
        model = excluded.model,
        user_messages = excluded.user_messages,
        assistant_messages = excluded.assistant_messages,
        tool_calls = excluded.tool_calls,
        tool_results = excluded.tool_results,
        total_messages = excluded.total_messages,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        total_tokens = excluded.total_tokens,
        total_cost = excluded.total_cost,
        updated_at = excluded.updated_at`,
      [
        id,
        input.agentId,
        input.agentName,
        input.taskId || null,
        input.sessionId,
        input.sessionFile || null,
        input.provider || null,
        input.model || null,
        input.userMessages || 0,
        input.assistantMessages || 0,
        input.toolCalls || 0,
        input.toolResults || 0,
        input.totalMessages || 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        input.totalCost || 0,
        createdAt,
        now,
      ],
    );

    return this.getUsageSession(input.agentId, input.sessionId)!;
  }

  getUsageSession(agentId: string, sessionId: string): UsageSessionSnapshot | undefined {
    const row = this.db
      .query("SELECT * FROM usage_sessions WHERE agent_id = ? AND session_id = ?")
      .get(agentId, sessionId) as any;
    return row ? rowToUsageSessionSnapshot(row) : undefined;
  }

  queryLatestUsageSessions(filters: {
    since?: number;
    agentId?: string;
    agentName?: string;
    taskId?: string;
    limit?: number;
  }): UsageSessionSnapshot[] {
    let sql = `
      SELECT s.*
      FROM usage_sessions s
      INNER JOIN (
        SELECT agent_id, session_id, MAX(updated_at) AS max_updated_at
        FROM usage_sessions
        ${filters.since ? "WHERE updated_at >= ?" : ""}
        GROUP BY agent_id, session_id
      ) latest
      ON s.agent_id = latest.agent_id
      AND s.session_id = latest.session_id
      AND s.updated_at = latest.max_updated_at
    `;
    const params: any[] = [];
    if (filters.since) params.push(filters.since);

    const conditions: string[] = [];
    if (filters.agentId) {
      conditions.push("s.agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.agentName) {
      conditions.push("s.agent_name = ?");
      params.push(filters.agentName);
    }
    if (filters.taskId) {
      conditions.push("s.task_id = ?");
      params.push(filters.taskId);
    }
    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += " ORDER BY s.total_cost DESC, s.total_tokens DESC";
    if (filters.limit) sql += ` LIMIT ${filters.limit}`;

    return this.db
      .query(sql)
      .all(...params)
      .map(rowToUsageSessionSnapshot);
  }

  private queryRawUsageByAgent(filters: { since?: number; excludeAgentIds?: string[] }): Array<{
    agentId: string;
    agentName: string;
    category: VMCategory | null;
    parentId: string | null;
    provider: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    totalCost: number;
    turns: number;
    lastSeen: number;
  }> {
    const params: any[] = [];
    const conditions: string[] = [];
    if (filters.since) {
      conditions.push("created_at >= ?");
      params.push(filters.since);
    }
    if (filters.excludeAgentIds?.length) {
      const placeholders = filters.excludeAgentIds.map(() => "?").join(", ");
      conditions.push(`agent_id NOT IN (${placeholders})`);
      params.push(...filters.excludeAgentIds);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .query(
        `SELECT
          agent_id,
          agent_name,
          provider,
          model,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(total_cost), 0) as total_cost,
          COUNT(*) as turns,
          MAX(created_at) as last_seen
        FROM usage_records
        ${where}
        GROUP BY agent_id, agent_name
        ORDER BY total_cost DESC, total_tokens DESC`,
      )
      .all(...params) as any[];

    return rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      category: this.getVM(row.agent_id)?.category || null,
      parentId: this.getVM(row.agent_id)?.parentId || null,
      provider: row.provider || null,
      model: row.model || null,
      inputTokens: row.input_tokens || 0,
      outputTokens: row.output_tokens || 0,
      cacheReadTokens: row.cache_read_tokens || 0,
      cacheWriteTokens: row.cache_write_tokens || 0,
      totalTokens: row.total_tokens || 0,
      totalCost: row.total_cost || 0,
      turns: row.turns || 0,
      lastSeen: row.last_seen || 0,
    }));
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
    serviceEndpoints: normalizeServiceEndpoints(JSON.parse(row.service_endpoints || "[]")),
    context: row.context || null,
    directive: row.directive || null,
    model: row.model || null,
    effort: row.effort || null,
    grants: row.grants ? JSON.parse(row.grants) : null,
    reefConfig: normalizeReefConfig(JSON.parse(row.reef_config || '{"services":[],"capabilities":[]}')),
    discovery: row.discovery ? normalizeDiscovery(JSON.parse(row.discovery)) : null,
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

function rowToUsageRecord(row: any): UsageRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    taskId: row.task_id || null,
    provider: row.provider || null,
    model: row.model || null,
    inputTokens: row.input_tokens || 0,
    outputTokens: row.output_tokens || 0,
    cacheReadTokens: row.cache_read_tokens || 0,
    cacheWriteTokens: row.cache_write_tokens || 0,
    totalTokens: row.total_tokens || 0,
    inputCost: row.input_cost || 0,
    outputCost: row.output_cost || 0,
    cacheReadCost: row.cache_read_cost || 0,
    cacheWriteCost: row.cache_write_cost || 0,
    totalCost: row.total_cost || 0,
    createdAt: row.created_at,
  };
}

function rowToUsageSessionSnapshot(row: any): UsageSessionSnapshot {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    taskId: row.task_id || null,
    sessionId: row.session_id,
    sessionFile: row.session_file || null,
    provider: row.provider || null,
    model: row.model || null,
    userMessages: row.user_messages || 0,
    assistantMessages: row.assistant_messages || 0,
    toolCalls: row.tool_calls || 0,
    toolResults: row.tool_results || 0,
    totalMessages: row.total_messages || 0,
    inputTokens: row.input_tokens || 0,
    outputTokens: row.output_tokens || 0,
    cacheReadTokens: row.cache_read_tokens || 0,
    cacheWriteTokens: row.cache_write_tokens || 0,
    totalTokens: row.total_tokens || 0,
    totalCost: row.total_cost || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
