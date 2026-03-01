/**
 * Conversation Tree
 *
 * Every message is a node with a parent. The tree structure emerges naturally:
 * any node can have multiple children (forks). Named refs point to leaf nodes,
 * like git branches pointing to commits.
 *
 * Key concepts:
 *   - Node: a single message with a parentId
 *   - Ref: a named pointer to a node (e.g. "main" → latest system event)
 *   - Path: ancestors from a node back to root = the conversation context
 *   - Fork: add a child to any node — if it already has children, that's a branch point
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

// =============================================================================
// Types
// =============================================================================

export interface TreeNode {
  id: string;
  parentId: string | null;
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result" | "event";
  content: string;
  timestamp: number;

  /** For event nodes */
  source?: string;
  eventType?: string;
  meta?: Record<string, unknown>;

  /** For tool_call nodes */
  toolName?: string;
  toolParams?: unknown;

  /** For tool_result nodes */
  toolCallId?: string;
  result?: unknown;
}

/** Structured output attached to completed task refs. */
export interface TaskArtifacts {
  summary: string;
  filesChanged: string[];
  testsRun?: { passed: number; failed: number };
  servicesDeployed?: string[];
  error?: string;
}

/** Task metadata stored alongside refs. */
export interface TaskInfo {
  status: "running" | "done" | "error";
  trigger: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  artifacts?: TaskArtifacts;
}

// =============================================================================
// ConversationTree
// =============================================================================

let nodeCounter = 0;
function nextId(): string {
  return `n_${Date.now()}_${++nodeCounter}`;
}

export class ConversationTree {
  /** All nodes by ID. */
  nodes: Map<string, TreeNode> = new Map();

  /** Named refs — point to a node ID. "main" is the world timeline. */
  refs: Map<string, string> = new Map();

  /** Task metadata — keyed by ref name. */
  tasks: Map<string, TaskInfo> = new Map();

  /** Root node ID. */
  root: string | null = null;

  private persistPath: string | null = null;

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  persist(path: string): void {
    this.persistPath = path;
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        this.nodes = new Map(Object.entries(data.nodes ?? {}));
        this.refs = new Map(Object.entries(data.refs ?? {}));
        this.tasks = new Map(Object.entries(data.tasks ?? {}));
        this.root = data.root ?? null;
        console.log(`  [tree] loaded ${this.nodes.size} nodes from ${path}`);
      } catch (err) {
        console.error(`  [tree] failed to load ${path}:`, err);
      }
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      const dir = this.persistPath.replace(/\/[^/]+$/, "");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.toJSON()));
    } catch (err) {
      console.error(`  [tree] save failed:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  /** Add a node as a child of parentId. Returns the new node. */
  add(parentId: string | null, role: TreeNode["role"], content: string, extra?: Partial<TreeNode>): TreeNode {
    const node: TreeNode = {
      id: nextId(),
      parentId,
      role,
      content,
      timestamp: Date.now(),
      ...extra,
    };
    this.nodes.set(node.id, node);
    if (!parentId && !this.root) this.root = node.id;
    this.save();
    return node;
  }

  /** Add a node as child of a ref's current node, then advance the ref. */
  addToRef(refName: string, role: TreeNode["role"], content: string, extra?: Partial<TreeNode>): TreeNode {
    const parentId = this.refs.get(refName) ?? null;
    const node = this.add(parentId, role, content, extra);
    this.refs.set(refName, node.id);
    this.save();
    return node;
  }

  /** Get a node by ID. */
  get(id: string): TreeNode | undefined {
    return this.nodes.get(id);
  }

  /** Move a ref to point to a node. */
  setRef(name: string, nodeId: string): void {
    this.refs.set(name, nodeId);
    this.save();
  }

  /** Get the node ID a ref points to. */
  getRef(name: string): string | undefined {
    return this.refs.get(name);
  }

  // ---------------------------------------------------------------------------
  // Tree traversal
  // ---------------------------------------------------------------------------

  /** Walk from a node up to root. Returns nodes in root → node order. */
  ancestors(nodeId: string): TreeNode[] {
    const path: TreeNode[] = [];
    let current: string | null = nodeId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) break; // cycle protection
      seen.add(current);
      const node = this.nodes.get(current);
      if (!node) break;
      path.unshift(node);
      current = node.parentId;
    }
    return path;
  }

  /** Get direct children of a node. */
  children(nodeId: string): TreeNode[] {
    return [...this.nodes.values()].filter(n => n.parentId === nodeId);
  }

  /** Get the path from root to a ref's current node. */
  pathTo(refName: string): TreeNode[] {
    const nodeId = this.refs.get(refName);
    if (!nodeId) return [];
    return this.ancestors(nodeId);
  }

  // ---------------------------------------------------------------------------
  // Context — what a pi process sees
  // ---------------------------------------------------------------------------

  /** Build conversation context for replying to a specific node. */
  contextFor(nodeId: string): string {
    const path = this.ancestors(nodeId);
    const lines: string[] = [];

    for (const node of path) {
      if (node.role === "system") lines.push(`[system] ${node.content}`);
      else if (node.role === "event") lines.push(`[${node.eventType || "event"}] ${node.content}`);
      else if (node.role === "user") lines.push(`[user] ${node.content}`);
      else if (node.role === "assistant") lines.push(`[assistant] ${node.content}`);
      else if (node.role === "tool_call") lines.push(`[tool] ${node.toolName || node.content}`);
      else if (node.role === "tool_result") lines.push(`[result] ${node.content}`);
    }

    return lines.join("\n\n");
  }

  // ---------------------------------------------------------------------------
  // Task management
  // ---------------------------------------------------------------------------

  /** Start a task — creates a ref and task info. */
  startTask(name: string, trigger: string, parentId: string | null): TreeNode {
    const userNode = this.add(parentId, "user", trigger);
    this.refs.set(name, userNode.id);
    this.tasks.set(name, {
      status: "running",
      trigger,
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    this.save();
    return userNode;
  }

  /** Complete a task. */
  completeTask(name: string, artifacts: TaskArtifacts): void {
    const info = this.tasks.get(name);
    if (info) {
      info.status = "done";
      info.completedAt = Date.now();
      info.artifacts = artifacts;
    }
    this.save();
  }

  /** Fail a task. */
  failTask(name: string, error: string): void {
    const info = this.tasks.get(name);
    if (info) {
      info.status = "error";
      info.completedAt = Date.now();
      info.artifacts = { summary: `Failed: ${error}`, filesChanged: [], error };
    }
    this.save();
  }

  /** Reopen a completed task for continuation. */
  reopenTask(name: string): void {
    const info = this.tasks.get(name);
    if (info) {
      info.status = "running";
      info.completedAt = undefined;
      info.artifacts = undefined;
    }
    this.save();
  }

  /** Get task info. */
  getTask(name: string): TaskInfo | undefined {
    return this.tasks.get(name);
  }

  /** List all tasks. */
  listTasks(): Array<{ name: string; info: TaskInfo; leafId: string | undefined }> {
    return [...this.tasks.entries()].map(([name, info]) => ({
      name,
      info,
      leafId: this.refs.get(name),
    }));
  }

  // ---------------------------------------------------------------------------
  // Query helpers
  // ---------------------------------------------------------------------------

  /** Total node count. */
  size(): number {
    return this.nodes.size;
  }

  /** Count active (running) tasks. */
  activeTasks(): number {
    return [...this.tasks.values()].filter(t => t.status === "running").length;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJSON(): object {
    return {
      nodes: Object.fromEntries(this.nodes),
      refs: Object.fromEntries(this.refs),
      tasks: Object.fromEntries(this.tasks),
      root: this.root,
    };
  }

  static fromJSON(data: any): ConversationTree {
    const tree = new ConversationTree();
    tree.nodes = new Map(Object.entries(data.nodes ?? {}));
    tree.refs = new Map(Object.entries(data.refs ?? {}));
    tree.tasks = new Map(Object.entries(data.tasks ?? {}));
    tree.root = data.root ?? null;
    return tree;
  }
}

