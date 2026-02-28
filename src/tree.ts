/**
 * Conversation Tree
 *
 * A git-like data structure for agent conversations. The trunk ("main") is
 * the agent's ongoing understanding of the world. Incoming events fork
 * branches from main, execute concurrently, and merge back sequentially.
 *
 * Key concepts:
 *   - Node: a single message (user, assistant, tool_call, tool_result, system)
 *   - Branch: a named sequence of nodes that forks from main at a specific point
 *   - Main: the trunk — linear history of merged results
 *   - Fork: create a branch from main's current head
 *   - Merge: append a branch's summary to main (sequential, never concurrent)
 *
 * The tree is pure data. It doesn't execute anything — that's branch.ts and merge.ts.
 */

// =============================================================================
// Types
// =============================================================================

/** A single node in the conversation tree. */
export interface TreeNode {
  id: string;
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result" | "merge";
  content: string;
  timestamp: number;

  /** For tool_call nodes */
  toolName?: string;
  toolParams?: unknown;

  /** For tool_result nodes */
  toolCallId?: string;
  result?: unknown;

  /** For merge nodes — what branch produced this */
  mergedFrom?: string;
  mergeArtifacts?: MergeArtifacts;
}

/** Structured output of a completed branch, attached to merge nodes. */
export interface MergeArtifacts {
  summary: string;
  filesChanged: string[];
  testsRun?: { passed: number; failed: number };
  servicesDeployed?: string[];
  storeKeysWritten?: string[];
  error?: string;
}

/** A branch in the conversation tree. */
export interface Branch {
  name: string;
  status: "pending" | "running" | "done" | "error" | "merged";

  /** The index into main's nodes where this branch forked. */
  forkPoint: number;

  /** The event/task that triggered this branch. */
  trigger: string;

  /** Nodes produced by this branch (its own work, not main's prefix). */
  nodes: TreeNode[];

  /** VM ID this branch is executing on (set when running). */
  vmId?: string;

  /** Structured results (set when done). */
  artifacts?: MergeArtifacts;

  /** Timing. */
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

// =============================================================================
// ConversationTree
// =============================================================================

let nodeCounter = 0;
function nextId(): string {
  return `n_${Date.now()}_${++nodeCounter}`;
}

export class ConversationTree {
  /** The trunk — linear history of the agent's understanding. */
  main: TreeNode[] = [];

  /** All branches, keyed by name. */
  branches: Map<string, Branch> = new Map();

  /** Ordered queue of branch names waiting to merge. */
  private mergeQueue: string[] = [];

  // ---------------------------------------------------------------------------
  // Main branch operations
  // ---------------------------------------------------------------------------

  /** Append a node to main. */
  append(role: TreeNode["role"], content: string, extra?: Partial<TreeNode>): TreeNode {
    const node: TreeNode = { id: nextId(), role, content, timestamp: Date.now(), ...extra };
    this.main.push(node);
    return node;
  }

  /** Get main's current head index. */
  head(): number {
    return this.main.length - 1;
  }

  /** Get main's conversation as a serializable array. */
  mainHistory(): TreeNode[] {
    return [...this.main];
  }

  // ---------------------------------------------------------------------------
  // Branch operations
  // ---------------------------------------------------------------------------

  /** Fork a new branch from main's current head. */
  fork(name: string, trigger: string): Branch {
    if (this.branches.has(name)) {
      throw new Error(`Branch "${name}" already exists`);
    }
    const branch: Branch = {
      name,
      status: "pending",
      forkPoint: this.head(),
      trigger,
      nodes: [],
      createdAt: Date.now(),
    };
    this.branches.set(name, branch);
    return branch;
  }

  /** Mark a branch as running (VM assigned). */
  start(name: string, vmId: string): void {
    const branch = this.getBranch(name);
    branch.status = "running";
    branch.vmId = vmId;
    branch.startedAt = Date.now();
  }

  /** Mark a branch as completed with artifacts. */
  complete(name: string, artifacts: MergeArtifacts): void {
    const branch = this.getBranch(name);
    branch.status = "done";
    branch.artifacts = artifacts;
    branch.completedAt = Date.now();
    this.mergeQueue.push(name);
  }

  /** Mark a branch as failed. */
  fail(name: string, error: string): void {
    const branch = this.getBranch(name);
    branch.status = "error";
    branch.artifacts = { summary: `Failed: ${error}`, filesChanged: [], error };
    branch.completedAt = Date.now();
    this.mergeQueue.push(name);
  }

  // ---------------------------------------------------------------------------
  // Merge operations
  // ---------------------------------------------------------------------------

  /** Get the next branch ready to merge (FIFO). Returns null if queue is empty. */
  nextMerge(): Branch | null {
    while (this.mergeQueue.length > 0) {
      const name = this.mergeQueue[0];
      const branch = this.branches.get(name);
      if (branch && (branch.status === "done" || branch.status === "error")) {
        return branch;
      }
      // Skip invalid entries
      this.mergeQueue.shift();
    }
    return null;
  }

  /**
   * Merge a branch into main. Appends a merge node with the branch's artifacts.
   * Call this only from the merge queue processor (one at a time).
   */
  merge(name: string): TreeNode {
    const branch = this.getBranch(name);
    if (branch.status !== "done" && branch.status !== "error") {
      throw new Error(`Branch "${name}" is ${branch.status}, cannot merge`);
    }

    // Remove from queue
    const idx = this.mergeQueue.indexOf(name);
    if (idx !== -1) this.mergeQueue.splice(idx, 1);

    // Append merge node to main
    const artifacts = branch.artifacts ?? { summary: "No artifacts", filesChanged: [] };
    const node = this.append("merge", artifacts.summary, {
      mergedFrom: name,
      mergeArtifacts: artifacts,
    });

    branch.status = "merged";
    return node;
  }

  // ---------------------------------------------------------------------------
  // Context — what a branch sees when it starts
  // ---------------------------------------------------------------------------

  /**
   * Build the context for a branch: main's history up to the fork point,
   * formatted as a string the agent can understand.
   */
  contextForBranch(name: string): string {
    const branch = this.getBranch(name);
    const history = this.main.slice(0, branch.forkPoint + 1);

    const lines: string[] = [];
    lines.push("# Agent State (main branch)");
    lines.push("");

    for (const node of history) {
      if (node.role === "system") {
        lines.push(`[system] ${node.content}`);
      } else if (node.role === "merge") {
        lines.push(`[merged: ${node.mergedFrom}] ${node.content}`);
        if (node.mergeArtifacts?.filesChanged.length) {
          lines.push(`  files: ${node.mergeArtifacts.filesChanged.join(", ")}`);
        }
      } else if (node.role === "user") {
        lines.push(`[user] ${node.content}`);
      } else if (node.role === "assistant") {
        lines.push(`[assistant] ${node.content}`);
      }
    }

    lines.push("");
    lines.push(`# Current Task`);
    lines.push(branch.trigger);

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Get a branch by name, or throw. */
  getBranch(name: string): Branch {
    const branch = this.branches.get(name);
    if (!branch) throw new Error(`Branch "${name}" not found`);
    return branch;
  }

  /** List all branches. */
  listBranches(): Branch[] {
    return [...this.branches.values()];
  }

  /** Get branches by status. */
  branchesByStatus(status: Branch["status"]): Branch[] {
    return this.listBranches().filter((b) => b.status === status);
  }

  /** How many branches are currently in-flight. */
  activeBranches(): number {
    return this.branchesByStatus("pending").length + this.branchesByStatus("running").length;
  }

  /** How many merges are waiting. */
  pendingMerges(): number {
    return this.mergeQueue.length;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /** Serialize the entire tree to JSON. */
  toJSON(): object {
    return {
      main: this.main,
      branches: Object.fromEntries(this.branches),
      mergeQueue: [...this.mergeQueue],
    };
  }

  /** Restore a tree from serialized JSON. */
  static fromJSON(data: any): ConversationTree {
    const tree = new ConversationTree();
    tree.main = data.main ?? [];
    tree.branches = new Map(Object.entries(data.branches ?? {}));
    // @ts-ignore — private field restore
    tree.mergeQueue = data.mergeQueue ?? [];
    return tree;
  }
}
