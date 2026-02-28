import { describe, test, expect } from "bun:test";
import { ConversationTree } from "./tree.js";
import type { MergeArtifacts } from "./tree.js";

describe("ConversationTree", () => {
  // ===========================================================================
  // Main branch
  // ===========================================================================

  describe("main branch", () => {
    test("starts empty", () => {
      const tree = new ConversationTree();
      expect(tree.main).toEqual([]);
      expect(tree.head()).toBe(-1);
    });

    test("append adds nodes", () => {
      const tree = new ConversationTree();
      const n1 = tree.append("system", "You are a reef agent.");
      const n2 = tree.append("user", "Build a cron service.");

      expect(tree.main.length).toBe(2);
      expect(tree.head()).toBe(1);
      expect(n1.role).toBe("system");
      expect(n2.role).toBe("user");
      expect(n1.id).not.toBe(n2.id);
      expect(n1.timestamp).toBeNumber();
    });

    test("mainHistory returns a copy", () => {
      const tree = new ConversationTree();
      tree.append("system", "hello");
      const history = tree.mainHistory();
      history.push({ id: "fake", role: "user", content: "injected", timestamp: 0 });
      expect(tree.main.length).toBe(1);
    });
  });

  // ===========================================================================
  // Branching
  // ===========================================================================

  describe("branching", () => {
    test("fork creates a branch at current head", () => {
      const tree = new ConversationTree();
      tree.append("system", "You are a reef agent.");
      tree.append("merge", "Previously built the store service.");

      const branch = tree.fork("build-cron", "Build a cron service with scheduling.");
      expect(branch.name).toBe("build-cron");
      expect(branch.status).toBe("pending");
      expect(branch.forkPoint).toBe(1);
      expect(branch.trigger).toBe("Build a cron service with scheduling.");
      expect(branch.nodes).toEqual([]);
      expect(branch.createdAt).toBeNumber();
    });

    test("fork from empty main", () => {
      const tree = new ConversationTree();
      const branch = tree.fork("first-task", "Do something.");
      expect(branch.forkPoint).toBe(-1);
    });

    test("duplicate branch name throws", () => {
      const tree = new ConversationTree();
      tree.fork("task-1", "First task.");
      expect(() => tree.fork("task-1", "Duplicate.")).toThrow('Branch "task-1" already exists');
    });

    test("start marks branch running with VM", () => {
      const tree = new ConversationTree();
      const branch = tree.fork("task", "Do work.");
      tree.start("task", "vm-abc123");

      expect(branch.status).toBe("running");
      expect(branch.vmId).toBe("vm-abc123");
      expect(branch.startedAt).toBeNumber();
    });

    test("complete marks branch done with artifacts", () => {
      const tree = new ConversationTree();
      tree.fork("task", "Do work.");
      tree.start("task", "vm-abc123");

      const artifacts: MergeArtifacts = {
        summary: "Built the thing.",
        filesChanged: ["services/thing/index.ts"],
        testsRun: { passed: 5, failed: 0 },
      };
      tree.complete("task", artifacts);

      const branch = tree.getBranch("task");
      expect(branch.status).toBe("done");
      expect(branch.artifacts).toEqual(artifacts);
      expect(branch.completedAt).toBeNumber();
    });

    test("fail marks branch error", () => {
      const tree = new ConversationTree();
      tree.fork("task", "Do work.");
      tree.start("task", "vm-abc123");
      tree.fail("task", "OOM killed");

      const branch = tree.getBranch("task");
      expect(branch.status).toBe("error");
      expect(branch.artifacts?.error).toBe("OOM killed");
    });

    test("getBranch throws for unknown", () => {
      const tree = new ConversationTree();
      expect(() => tree.getBranch("nope")).toThrow('Branch "nope" not found');
    });
  });

  // ===========================================================================
  // Merge
  // ===========================================================================

  describe("merge", () => {
    test("complete queues for merge", () => {
      const tree = new ConversationTree();
      tree.fork("a", "Task A.");
      tree.fork("b", "Task B.");
      tree.start("a", "vm-1");
      tree.start("b", "vm-2");
      tree.complete("a", { summary: "Did A.", filesChanged: [] });
      tree.complete("b", { summary: "Did B.", filesChanged: ["x.ts"] });

      expect(tree.pendingMerges()).toBe(2);
    });

    test("nextMerge returns FIFO order", () => {
      const tree = new ConversationTree();
      tree.fork("a", "Task A.");
      tree.fork("b", "Task B.");
      tree.start("a", "vm-1");
      tree.start("b", "vm-2");
      tree.complete("a", { summary: "Did A.", filesChanged: [] });
      tree.complete("b", { summary: "Did B.", filesChanged: [] });

      const first = tree.nextMerge();
      expect(first?.name).toBe("a");
    });

    test("nextMerge returns null when empty", () => {
      const tree = new ConversationTree();
      expect(tree.nextMerge()).toBeNull();
    });

    test("merge appends node to main", () => {
      const tree = new ConversationTree();
      tree.append("system", "Agent init.");
      tree.fork("task", "Build something.");
      tree.start("task", "vm-1");
      tree.complete("task", {
        summary: "Built the cron service. 36 tests, all pass.",
        filesChanged: ["services/cron/index.ts", "services/cron/cron.test.ts"],
        testsRun: { passed: 36, failed: 0 },
        servicesDeployed: ["cron"],
      });

      const node = tree.merge("task");

      expect(node.role).toBe("merge");
      expect(node.content).toBe("Built the cron service. 36 tests, all pass.");
      expect(node.mergedFrom).toBe("task");
      expect(node.mergeArtifacts?.filesChanged).toEqual([
        "services/cron/index.ts",
        "services/cron/cron.test.ts",
      ]);
      expect(tree.main.length).toBe(2); // system + merge
      expect(tree.getBranch("task").status).toBe("merged");
    });

    test("merge removes from queue", () => {
      const tree = new ConversationTree();
      tree.fork("a", "Task A.");
      tree.start("a", "vm-1");
      tree.complete("a", { summary: "Done.", filesChanged: [] });
      expect(tree.pendingMerges()).toBe(1);

      tree.merge("a");
      expect(tree.pendingMerges()).toBe(0);
    });

    test("merge error branch still works", () => {
      const tree = new ConversationTree();
      tree.fork("bad", "Will fail.");
      tree.start("bad", "vm-1");
      tree.fail("bad", "segfault");

      const node = tree.merge("bad");
      expect(node.role).toBe("merge");
      expect(node.mergeArtifacts?.error).toBe("segfault");
      expect(tree.getBranch("bad").status).toBe("merged");
    });

    test("cannot merge a running branch", () => {
      const tree = new ConversationTree();
      tree.fork("wip", "Still going.");
      tree.start("wip", "vm-1");
      expect(() => tree.merge("wip")).toThrow('Branch "wip" is running, cannot merge');
    });

    test("sequential merge — second merge sees first", () => {
      const tree = new ConversationTree();
      tree.append("system", "Init.");
      tree.fork("a", "Task A.");
      tree.fork("b", "Task B.");
      tree.start("a", "vm-1");
      tree.start("b", "vm-2");
      tree.complete("a", { summary: "Built store.", filesChanged: ["services/store/index.ts"] });
      tree.complete("b", { summary: "Built cron.", filesChanged: ["services/cron/index.ts"] });

      // Merge A first
      tree.merge("a");
      expect(tree.main.length).toBe(2); // system + merge-a

      // Merge B second — main now includes A's merge
      tree.merge("b");
      expect(tree.main.length).toBe(3); // system + merge-a + merge-b

      // B's context would have seen A's merge if it checked
      expect(tree.main[1].mergedFrom).toBe("a");
      expect(tree.main[2].mergedFrom).toBe("b");
    });
  });

  // ===========================================================================
  // Context
  // ===========================================================================

  describe("context", () => {
    test("contextForBranch includes main history + task", () => {
      const tree = new ConversationTree();
      tree.append("system", "You are a reef agent.");
      tree.append("merge", "Built the store service.", {
        mergedFrom: "build-store",
        mergeArtifacts: { summary: "Built the store service.", filesChanged: ["services/store/index.ts"] },
      });

      tree.fork("build-cron", "Build a cron service.");
      const ctx = tree.contextForBranch("build-cron");

      expect(ctx).toContain("[system] You are a reef agent.");
      expect(ctx).toContain("[merged: build-store] Built the store service.");
      expect(ctx).toContain("files: services/store/index.ts");
      expect(ctx).toContain("# Current Task");
      expect(ctx).toContain("Build a cron service.");
    });

    test("context only includes up to fork point", () => {
      const tree = new ConversationTree();
      tree.append("system", "Init.");
      // Fork here (head = 0)
      tree.fork("early", "Early task.");
      // More stuff added to main after fork
      tree.append("merge", "Later merge.", { mergedFrom: "other" });

      const ctx = tree.contextForBranch("early");
      expect(ctx).toContain("[system] Init.");
      expect(ctx).not.toContain("Later merge.");
    });
  });

  // ===========================================================================
  // Query
  // ===========================================================================

  describe("query", () => {
    test("listBranches returns all", () => {
      const tree = new ConversationTree();
      tree.fork("a", "A");
      tree.fork("b", "B");
      expect(tree.listBranches().length).toBe(2);
    });

    test("branchesByStatus filters", () => {
      const tree = new ConversationTree();
      tree.fork("a", "A");
      tree.fork("b", "B");
      tree.start("a", "vm-1");

      expect(tree.branchesByStatus("pending").length).toBe(1);
      expect(tree.branchesByStatus("running").length).toBe(1);
      expect(tree.branchesByStatus("done").length).toBe(0);
    });

    test("activeBranches counts pending + running", () => {
      const tree = new ConversationTree();
      tree.fork("a", "A");
      tree.fork("b", "B");
      tree.start("a", "vm-1");
      tree.complete("a", { summary: "Done.", filesChanged: [] });

      expect(tree.activeBranches()).toBe(1); // b is still pending
    });
  });

  // ===========================================================================
  // Serialization
  // ===========================================================================

  describe("serialization", () => {
    test("round-trip through JSON", () => {
      const tree = new ConversationTree();
      tree.append("system", "Init.");
      tree.fork("task", "Do work.");
      tree.start("task", "vm-1");
      tree.complete("task", { summary: "Done.", filesChanged: ["a.ts"] });
      tree.merge("task");

      const json = tree.toJSON();
      const restored = ConversationTree.fromJSON(json);

      expect(restored.main.length).toBe(2);
      expect(restored.main[0].role).toBe("system");
      expect(restored.main[1].role).toBe("merge");
      expect(restored.branches.size).toBe(1);
      expect(restored.getBranch("task").status).toBe("merged");
    });

    test("fromJSON handles empty data", () => {
      const tree = ConversationTree.fromJSON({});
      expect(tree.main).toEqual([]);
      expect(tree.branches.size).toBe(0);
    });
  });
});
