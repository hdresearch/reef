/**
 * Agent Loop
 *
 * The async event loop at the heart of reef. Incoming events — HTTP requests,
 * cron triggers, agent messages — fork branches from main. Branches execute
 * concurrently on Vers VMs. Results merge back sequentially.
 *
 * The loop manages:
 *   - The conversation tree (main + branches)
 *   - Branch execution (fork VM, run pi, capture results)
 *   - Merge queue (sequential, FIFO)
 *   - Event intake (anything can submit events)
 *
 * Usage:
 *   const loop = new AgentLoop({ commitId, anthropicApiKey, workspaceDir });
 *   loop.start();
 *   const branchName = await loop.submit("Build a cron service.");
 *   // ... branch executes in background, merges when done
 */

import { ConversationTree, type MergeArtifacts, type TreeNode } from "./tree.js";
import { executeBranch, type BranchConfig, type BranchHandle } from "./branch.js";
import { MergeQueue, type MergeQueueConfig } from "./merge.js";

// =============================================================================
// Types
// =============================================================================

export interface AgentLoopConfig {
  /** Vers commit ID to fork branches from. */
  commitId: string;

  /** Anthropic API key for branch agents. */
  anthropicApiKey: string;

  /** Local workspace directory (main's files). */
  workspaceDir: string;

  /** Model for branch agents. Default: claude-sonnet-4-20250514 */
  model?: string;

  /** System prompt for main. */
  systemPrompt?: string;

  /** Max concurrent branches. Default: 5 */
  maxConcurrent?: number;

  /** Per-branch timeout in ms. Default: 10 minutes */
  branchTimeoutMs?: number;

  /** Vers API config override. */
  vers?: { apiKey?: string; baseUrl?: string };

  /** Called on events (for UI/logging). */
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "branch_created"; name: string; trigger: string }
  | { type: "branch_started"; name: string; vmId: string }
  | { type: "branch_completed"; name: string; artifacts: MergeArtifacts }
  | { type: "branch_failed"; name: string; error: string }
  | { type: "merge_complete"; name: string; artifacts: MergeArtifacts }
  | { type: "merge_error"; name: string; error: string }
  | { type: "queue_full"; trigger: string };

// =============================================================================
// AgentLoop
// =============================================================================

let branchCounter = 0;

export class AgentLoop {
  readonly tree: ConversationTree;
  private mergeQueue: MergeQueue;
  private config: AgentLoopConfig;
  private maxConcurrent: number;
  private started = false;

  constructor(config: AgentLoopConfig) {
    this.config = config;
    this.maxConcurrent = config.maxConcurrent ?? 5;
    this.tree = new ConversationTree();

    // Initialize main with system prompt
    if (config.systemPrompt) {
      this.tree.append("system", config.systemPrompt);
    }

    // Set up merge queue
    this.mergeQueue = new MergeQueue(this.tree, {
      workspaceDir: config.workspaceDir,
      onMerge: (name, artifacts) => {
        this.emit({ type: "merge_complete", name, artifacts });
      },
      onError: (name, error) => {
        this.emit({ type: "merge_error", name, error: error.message });
      },
    });
  }

  /** Start the merge queue processing loop. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.mergeQueue.start();
  }

  /** Stop the merge queue. In-flight branches continue but won't merge. */
  stop(): void {
    this.started = false;
    this.mergeQueue.stop();
  }

  /**
   * Submit a task. Forks a branch from main, executes it on a Vers VM.
   * Returns the branch name immediately — execution is async.
   *
   * If max concurrent branches are in-flight, throws.
   */
  submit(task: string, opts?: { name?: string }): string {
    const active = this.tree.activeBranches();
    if (active >= this.maxConcurrent) {
      this.emit({ type: "queue_full", trigger: task });
      throw new Error(`Max concurrent branches (${this.maxConcurrent}) reached. ${active} in-flight.`);
    }

    // Generate branch name
    const name = opts?.name ?? `branch-${++branchCounter}-${Date.now()}`;

    // Fork from main
    const branch = this.tree.fork(name, task);
    this.emit({ type: "branch_created", name, trigger: task });

    // Build context for the branch (main's history + task)
    const context = this.tree.contextForBranch(name);

    // Launch branch in background — don't block the caller
    this.launchBranch(name, context, task);

    return name;
  }

  /**
   * Submit and wait — convenience method that submits a task and blocks
   * until the branch is merged. Returns the merge artifacts.
   */
  async submitAndWait(task: string, opts?: { name?: string }): Promise<MergeArtifacts> {
    const name = await this.submit(task, opts);

    // Poll until merged
    return new Promise((resolve) => {
      const check = () => {
        const branch = this.tree.getBranch(name);
        if (branch.status === "merged") {
          resolve(branch.artifacts ?? { summary: "Merged.", filesChanged: [] });
          return;
        }
        if (branch.status === "error" && !this.tree.pendingMerges()) {
          // Error that never made it to merge
          resolve(branch.artifacts ?? { summary: "Failed.", filesChanged: [], error: "unknown" });
          return;
        }
        setTimeout(check, 1000);
      };
      check();
    });
  }

  // ---------------------------------------------------------------------------
  // Branch lifecycle (background)
  // ---------------------------------------------------------------------------

  private async launchBranch(name: string, context: string, task: string): Promise<void> {
    try {
      const handle = await executeBranch(context, task, {
        commitId: this.config.commitId,
        anthropicApiKey: this.config.anthropicApiKey,
        model: this.config.model,
        vers: this.config.vers,
        timeoutMs: this.config.branchTimeoutMs,
      });

      this.tree.start(name, handle.vmId);
      this.emit({ type: "branch_started", name, vmId: handle.vmId });

      // Track in merge queue — when the branch completes, it'll queue for merge
      this.mergeQueue.track(name, handle);
    } catch (e: any) {
      this.tree.fail(name, e.message ?? String(e));
      this.emit({ type: "branch_failed", name, error: e.message ?? String(e) });
    }
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Get a snapshot of the current state. */
  state(): {
    mainLength: number;
    activeBranches: number;
    pendingMerges: number;
    branches: Array<{ name: string; status: string; trigger: string; vmId?: string }>;
  } {
    return {
      mainLength: this.tree.main.length,
      activeBranches: this.tree.activeBranches(),
      pendingMerges: this.tree.pendingMerges(),
      branches: this.tree.listBranches().map((b) => ({
        name: b.name,
        status: b.status,
        trigger: b.trigger,
        vmId: b.vmId,
      })),
    };
  }

  /** Get main's conversation history. */
  history(): TreeNode[] {
    return this.tree.mainHistory();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private emit(event: AgentEvent): void {
    this.config.onEvent?.(event);
  }
}
