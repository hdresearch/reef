/**
 * Merge Queue
 *
 * Processes completed branches sequentially, merging their results into main.
 * This is the serialization point — branches execute concurrently, but merge
 * one at a time in FIFO order.
 *
 * Merge involves:
 *   1. Pulling changed files from the branch VM to main's workspace
 *   2. Applying changes (git merge / file copy)
 *   3. Appending a merge node to the conversation tree
 *   4. Cleaning up the branch VM
 *
 * The queue runs as a background loop — call start() to begin processing,
 * stop() to halt. It wakes up whenever a branch completes.
 */

import { ConversationTree, type MergeArtifacts } from "./tree.js";
import { scpFromVm, sshExec } from "./branch.js";
import type { BranchHandle } from "./branch.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// =============================================================================
// Types
// =============================================================================

export interface MergeQueueConfig {
  /** Local workspace directory (where main's files live). */
  workspaceDir: string;

  /** Called after each successful merge — for persistence, notifications, etc. */
  onMerge?: (branchName: string, artifacts: MergeArtifacts) => void | Promise<void>;

  /** Called on merge failure. */
  onError?: (branchName: string, error: Error) => void | Promise<void>;
}

// =============================================================================
// MergeQueue
// =============================================================================

export class MergeQueue {
  private tree: ConversationTree;
  private config: MergeQueueConfig;
  private running = false;
  private handles = new Map<string, BranchHandle>();
  private inflight = new Set<string>(); // branches still executing
  private wakeup: (() => void) | null = null;

  constructor(tree: ConversationTree, config: MergeQueueConfig) {
    this.tree = tree;
    this.config = config;
  }

  /**
   * Track a branch. Waits for the handle to complete in the background,
   * then queues it for merge.
   */
  track(name: string, handle: BranchHandle): void {
    this.handles.set(name, handle);
    this.inflight.add(name);
    this.waitAndQueue(name, handle);
  }

  /** Start the merge processing loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.processLoop();
  }

  /** Stop the merge processing loop gracefully. */
  stop(): void {
    this.running = false;
    if (this.wakeup) this.wakeup();
  }

  /** Number of branches in-flight or waiting to merge. */
  size(): number {
    return this.inflight.size + this.tree.pendingMerges();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async waitAndQueue(name: string, handle: BranchHandle): Promise<void> {
    try {
      const artifacts = await handle.wait();
      this.tree.complete(name, artifacts);
    } catch (e: any) {
      this.tree.fail(name, e.message ?? String(e));
    }
    this.inflight.delete(name);
    // Wake up the processing loop
    if (this.wakeup) this.wakeup();
  }

  private async processLoop(): Promise<void> {
    while (this.running) {
      const branch = this.tree.nextMerge();

      if (!branch) {
        // Nothing to merge — sleep until woken
        await new Promise<void>((resolve) => {
          this.wakeup = resolve;
        });
        this.wakeup = null;
        continue;
      }

      try {
        await this.processMerge(branch.name);
      } catch (e: any) {
        await this.config.onError?.(branch.name, e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  private async processMerge(name: string): Promise<void> {
    const branch = this.tree.getBranch(name);
    const handle = this.handles.get(name);

    // Pull changed files from the branch VM to local workspace
    if (handle && branch.artifacts?.filesChanged.length) {
      await this.pullFiles(handle, branch.artifacts.filesChanged);
    }

    // Merge into the tree (appends merge node to main)
    this.tree.merge(name);

    // Notify
    if (branch.artifacts) {
      await this.config.onMerge?.(name, branch.artifacts);
    }

    // Cleanup — delete the VM
    if (handle) {
      await handle.cleanup().catch(() => {});
      this.handles.delete(name);
    }
  }

  /**
   * Pull changed files from a branch VM to the local workspace.
   * Uses tar over SSH — one round trip for all files.
   */
  private async pullFiles(handle: BranchHandle, files: string[]): Promise<void> {
    const keyPath = join(tmpdir(), "reef-ssh-keys", `reef-${handle.vmId.slice(0, 12)}.pem`);
    const tarRemotePath = "/tmp/branch-changes.tar.gz";
    const tarLocalPath = join(tmpdir(), `reef-merge-${handle.vmId.slice(0, 12)}.tar.gz`);

    // Create tarball of changed files on the VM
    const fileList = files.map((f) => f.replace(/'/g, "'\\''")).join("\\n");
    await sshExec(keyPath, handle.vmId,
      `cd /root/workspace && printf '${fileList}' | tar czf ${tarRemotePath} -T - 2>/dev/null || true`
    );

    // Pull tarball via SCP
    const scpResult = await scpFromVm(keyPath, handle.vmId, tarRemotePath, tarLocalPath);
    if (scpResult.exitCode !== 0) {
      console.error(`[merge] SCP pull failed for ${handle.vmId}: ${scpResult.stderr}`);
      return;
    }

    // Extract into local workspace
    await mkdir(this.config.workspaceDir, { recursive: true });
    const { execSync } = await import("child_process");
    execSync(`tar xzf ${tarLocalPath} -C ${this.config.workspaceDir}`, { stdio: "pipe" });
  }
}
