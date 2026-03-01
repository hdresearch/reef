/**
 * Event Tree
 *
 * Every event is a node with a parent. The tree structure emerges naturally:
 * user prompts, tool calls, tool results, assistant responses, cron fires,
 * service deploys — all nodes with causal links (parentId).
 *
 * Key concepts:
 *   - Node: a single event with a parentId
 *   - Ref: a named pointer to a node (e.g. "main" → system root, "task-1" → latest response)
 *   - Path: ancestors from a node back to root = the conversation context
 *   - Fork: add a child to any node — multiple children = branch point
 *
 * Tiered storage:
 *   - Hot: recent nodes in memory (active tasks + last N completed)
 *   - Cold: archived task subtrees on disk, loaded on demand
 *   - Archive dir: {dataDir}/archive/ — one JSON file per task
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  /** Hot nodes — in memory. */
  nodes: Map<string, TreeNode> = new Map();

  /** Parent → child IDs, maintained on insert. */
  private childIndex: Map<string, string[]> = new Map();

  /** Named refs — point to a node ID. "main" is the world timeline. */
  refs: Map<string, string> = new Map();

  /** Task metadata — keyed by ref name. */
  tasks: Map<string, TaskInfo> = new Map();

  /** Root node ID. */
  root: string | null = null;

  private persistPath: string | null = null;

  /** Directory for cold storage archives. */
  private archiveDir: string | null = null;

  /** Set of task names whose subtrees are archived (cold). */
  private archivedTasks: Set<string> = new Set();

  /** How many completed tasks to keep hot before archiving. */
  hotLimit = 50;

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  persist(path: string): void {
    this.persistPath = path;
    const dir = path.replace(/\/[^/]+$/, "");
    this.archiveDir = join(dir, "archive");

    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        this.nodes = new Map(Object.entries(data.nodes ?? {}));
        this.refs = new Map(Object.entries(data.refs ?? {}));
        this.tasks = new Map(Object.entries(data.tasks ?? {}));
        this.root = data.root ?? null;
        this.archivedTasks = new Set(data.archivedTasks ?? []);
        this.rebuildChildIndex();
        console.log(`  [tree] loaded ${this.nodes.size} nodes from ${path}`);
      } catch (err) {
        console.error(`  [tree] failed to load ${path}:`, err);
      }
    }
  }

  private rebuildChildIndex(): void {
    this.childIndex.clear();
    for (const [id, node] of this.nodes) {
      if (node.parentId) {
        const kids = this.childIndex.get(node.parentId);
        if (kids) kids.push(id);
        else this.childIndex.set(node.parentId, [id]);
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
  // Cold storage — archive & restore
  // ---------------------------------------------------------------------------

  /**
   * Archive a completed task's subtree to disk.
   * Removes all descendant nodes from hot storage.
   * The task's root user node stays hot (so the parent link is intact).
   */
  archiveTask(taskName: string): boolean {
    if (!this.archiveDir) return false;
    const info = this.tasks.get(taskName);
    if (!info || info.status === "running") return false;

    const leafId = this.refs.get(taskName);
    if (!leafId) return false;

    // Walk ancestors to find the task's user node (first user node in path)
    const path = this.ancestors(leafId);
    const taskRoot = path.find((n) => n.role === "user");
    if (!taskRoot) return false;

    // Collect all descendants of the task root
    const subtreeNodes: TreeNode[] = [];
    const queue = [taskRoot.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const node = this.nodes.get(id);
      if (!node) continue;
      subtreeNodes.push(node);
      const kids = this.childIndex.get(id);
      if (kids) queue.push(...kids);
    }

    if (subtreeNodes.length === 0) return false;

    // Write archive
    if (!existsSync(this.archiveDir)) mkdirSync(this.archiveDir, { recursive: true });
    const archivePath = join(this.archiveDir, `${taskName}.json`);
    writeFileSync(archivePath, JSON.stringify({ nodes: subtreeNodes, taskName }));

    // Remove descendants from hot (keep the task root user node as a stub)
    for (const node of subtreeNodes) {
      if (node.id === taskRoot.id) continue; // keep the root
      this.nodes.delete(node.id);
      if (node.parentId) {
        const kids = this.childIndex.get(node.parentId);
        if (kids) {
          const idx = kids.indexOf(node.id);
          if (idx >= 0) kids.splice(idx, 1);
        }
      }
    }
    // Clear children of taskRoot in index (they're archived)
    this.childIndex.delete(taskRoot.id);

    this.archivedTasks.add(taskName);
    this.save();
    return true;
  }

  /**
   * Restore an archived task's subtree back to hot storage.
   * Returns true if restored, false if not archived or file missing.
   */
  restoreTask(taskName: string): boolean {
    if (!this.archiveDir) return false;
    if (!this.archivedTasks.has(taskName)) return false;

    const archivePath = join(this.archiveDir, `${taskName}.json`);
    if (!existsSync(archivePath)) return false;

    try {
      const data = JSON.parse(readFileSync(archivePath, "utf-8"));
      const nodes: TreeNode[] = data.nodes ?? [];

      for (const node of nodes) {
        this.nodes.set(node.id, node);
        if (node.parentId) {
          const kids = this.childIndex.get(node.parentId);
          if (kids) {
            if (!kids.includes(node.id)) kids.push(node.id);
          } else {
            this.childIndex.set(node.parentId, [node.id]);
          }
        }
      }

      this.archivedTasks.delete(taskName);
      this.save();
      return true;
    } catch (err) {
      console.error(`  [tree] failed to restore archive ${taskName}:`, err);
      return false;
    }
  }

  /** Check if a task is archived. */
  isArchived(taskName: string): boolean {
    return this.archivedTasks.has(taskName);
  }

  /**
   * Auto-archive old completed tasks to stay under hotLimit.
   * Archives oldest completed tasks first.
   */
  pruneToLimit(): number {
    const completed = this.listTasks()
      .filter((t) => t.info.status !== "running" && !this.archivedTasks.has(t.name))
      .sort((a, b) => (a.info.completedAt ?? 0) - (b.info.completedAt ?? 0));

    const excess = completed.length - this.hotLimit;
    let archived = 0;
    for (let i = 0; i < excess; i++) {
      if (this.archiveTask(completed[i].name)) archived++;
    }
    return archived;
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
    if (parentId) {
      const kids = this.childIndex.get(parentId);
      if (kids) kids.push(node.id);
      else this.childIndex.set(parentId, [node.id]);
    }
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
    const ids = this.childIndex.get(nodeId);
    if (!ids) return [];
    return ids.map((id) => this.nodes.get(id)!).filter(Boolean);
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

  /** Total node count (hot only). */
  size(): number {
    return this.nodes.size;
  }

  /** Count active (running) tasks. */
  activeTasks(): number {
    return [...this.tasks.values()].filter((t) => t.status === "running").length;
  }

  /** List archived task names. */
  archivedTaskNames(): string[] {
    return [...this.archivedTasks];
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
      archivedTasks: [...this.archivedTasks],
    };
  }

  static fromJSON(data: any): ConversationTree {
    const tree = new ConversationTree();
    tree.nodes = new Map(Object.entries(data.nodes ?? {}));
    tree.refs = new Map(Object.entries(data.refs ?? {}));
    tree.tasks = new Map(Object.entries(data.tasks ?? {}));
    tree.root = data.root ?? null;
    tree.archivedTasks = new Set(data.archivedTasks ?? []);
    tree.rebuildChildIndex();
    return tree;
  }
}
