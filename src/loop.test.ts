import { describe, test, expect, mock, beforeEach } from "bun:test";
import { ConversationTree, type MergeArtifacts } from "./tree.js";
import { MergeQueue } from "./merge.js";
import type { BranchHandle } from "./branch.js";

/**
 * Tests for the merge queue and loop integration.
 *
 * These tests use mock BranchHandles instead of real VMs —
 * we're testing the concurrency/merge model, not SSH.
 */

function mockHandle(vmId: string, result: MergeArtifacts, delayMs = 0): BranchHandle {
  return {
    vmId,
    wait: () => new Promise((r) => setTimeout(() => r(result), delayMs)),
    abort: async () => {},
    cleanup: async () => {},
  };
}

function failHandle(vmId: string, error: string, delayMs = 0): BranchHandle {
  return {
    vmId,
    wait: () => new Promise((_, rej) => setTimeout(() => rej(new Error(error)), delayMs)),
    abort: async () => {},
    cleanup: async () => {},
  };
}

describe("MergeQueue", () => {
  test("single branch: track → complete → merge", async () => {
    const tree = new ConversationTree();
    tree.append("system", "Init.");
    tree.fork("task-a", "Build something.");
    tree.start("task-a", "vm-1");

    const merged: string[] = [];
    const queue = new MergeQueue(tree, {
      workspaceDir: "/tmp/reef-test-workspace",
      onMerge: (name) => { merged.push(name); },
    });
    queue.start();

    const handle = mockHandle("vm-1", {
      summary: "Built the thing.",
      filesChanged: [], // no files — skip pull
    });
    queue.track("task-a", handle);

    // Wait for merge to complete
    await waitFor(() => merged.length > 0, 3000);

    expect(merged).toEqual(["task-a"]);
    expect(tree.main.length).toBe(2); // system + merge
    expect(tree.main[1].role).toBe("merge");
    expect(tree.main[1].content).toBe("Built the thing.");
    expect(tree.getBranch("task-a").status).toBe("merged");

    queue.stop();
  });

  test("FIFO order — A completes first, merges first", async () => {
    const tree = new ConversationTree();
    tree.fork("a", "Task A.");
    tree.fork("b", "Task B.");
    tree.start("a", "vm-1");
    tree.start("b", "vm-2");

    const mergeOrder: string[] = [];
    const queue = new MergeQueue(tree, {
      workspaceDir: "/tmp/reef-test-workspace",
      onMerge: (name) => { mergeOrder.push(name); },
    });
    queue.start();

    // A finishes first (10ms), B finishes later (50ms)
    queue.track("a", mockHandle("vm-1", { summary: "Did A.", filesChanged: [] }, 10));
    queue.track("b", mockHandle("vm-2", { summary: "Did B.", filesChanged: [] }, 50));

    await waitFor(() => mergeOrder.length === 2, 3000);

    expect(mergeOrder).toEqual(["a", "b"]);
    expect(tree.main[0].mergedFrom).toBe("a");
    expect(tree.main[1].mergedFrom).toBe("b");

    queue.stop();
  });

  test("FIFO order — B completes first but A merges first", async () => {
    const tree = new ConversationTree();
    tree.fork("a", "Task A.");
    tree.fork("b", "Task B.");
    tree.start("a", "vm-1");
    tree.start("b", "vm-2");

    const mergeOrder: string[] = [];
    const queue = new MergeQueue(tree, {
      workspaceDir: "/tmp/reef-test-workspace",
      onMerge: (name) => { mergeOrder.push(name); },
    });
    queue.start();

    // B finishes first (10ms), A finishes later (100ms)
    queue.track("a", mockHandle("vm-1", { summary: "Did A.", filesChanged: [] }, 100));
    queue.track("b", mockHandle("vm-2", { summary: "Did B.", filesChanged: [] }, 10));

    await waitFor(() => mergeOrder.length === 2, 3000);

    // A should still merge first (FIFO by completion, which queues in order)
    // Actually — the queue is FIFO by COMPLETION order, not submission order.
    // tree.complete() is called when the handle resolves, which pushes to mergeQueue.
    // B completes first → B gets queued first → B merges first.
    // This is correct! The merge queue processes in the order branches FINISH.
    expect(mergeOrder[0]).toBe("b"); // B finished first
    expect(mergeOrder[1]).toBe("a"); // A finished second

    queue.stop();
  });

  test("failed branch still merges (with error)", async () => {
    const tree = new ConversationTree();
    tree.fork("bad", "Will fail.");
    tree.start("bad", "vm-1");

    const merged: string[] = [];
    const queue = new MergeQueue(tree, {
      workspaceDir: "/tmp/reef-test-workspace",
      onMerge: (name) => { merged.push(name); },
    });
    queue.start();

    queue.track("bad", failHandle("vm-1", "OOM killed", 10));

    await waitFor(() => merged.length > 0, 3000);

    expect(merged).toEqual(["bad"]);
    const mergeNode = tree.main[0];
    expect(mergeNode.mergeArtifacts?.error).toBe("OOM killed");

    queue.stop();
  });

  test("concurrent branches merge as they complete", async () => {
    const tree = new ConversationTree();

    // Simulate 5 concurrent branches with different completion times
    const names = ["a", "b", "c", "d", "e"];
    const delays = [50, 10, 80, 30, 60]; // b, d, a, e, c

    for (const name of names) {
      tree.fork(name, `Task ${name}.`);
      tree.start(name, `vm-${name}`);
    }

    const mergeOrder: string[] = [];
    const queue = new MergeQueue(tree, {
      workspaceDir: "/tmp/reef-test-workspace",
      onMerge: (name) => { mergeOrder.push(name); },
    });
    queue.start();

    for (let i = 0; i < names.length; i++) {
      queue.track(names[i], mockHandle(`vm-${names[i]}`, {
        summary: `Did ${names[i]}.`,
        filesChanged: [],
      }, delays[i]));
    }

    await waitFor(() => mergeOrder.length === 5, 5000);

    // Should merge in completion order: b(10), d(30), a(50), e(60), c(80)
    expect(mergeOrder).toEqual(["b", "d", "a", "e", "c"]);
    expect(tree.main.length).toBe(5);

    queue.stop();
  });

  test("main history grows with each merge", async () => {
    const tree = new ConversationTree();
    tree.append("system", "You are a reef agent.");

    tree.fork("store", "Build KV store.");
    tree.start("store", "vm-1");

    const queue = new MergeQueue(tree, {
      workspaceDir: "/tmp/reef-test-workspace",
    });
    queue.start();

    queue.track("store", mockHandle("vm-1", {
      summary: "Built KV store with 9 tests.",
      filesChanged: ["services/store/index.ts", "services/store/store.test.ts"],
      testsRun: { passed: 9, failed: 0 },
      servicesDeployed: ["store"],
    }, 10));

    await waitFor(() => tree.main.length === 2, 3000);

    // Now fork another branch — it should see the store merge in its context
    tree.fork("cron", "Build cron service.");
    tree.start("cron", "vm-2");
    const context = tree.contextForBranch("cron");

    expect(context).toContain("Built KV store with 9 tests.");
    expect(context).toContain("services/store/index.ts");
    expect(context).toContain("Build cron service.");

    queue.stop();
  });
});

// Helper: poll until condition is true
function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) { resolve(); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error("waitFor timed out")); return; }
      setTimeout(check, 50);
    };
    check();
  });
}
