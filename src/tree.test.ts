import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { ConversationTree } from "./tree.js";

const ARCHIVE_TEST_DIR = "data/test-archive";

describe("ConversationTree", () => {
  describe("core", () => {
    test("starts empty", () => {
      const tree = new ConversationTree();
      expect(tree.size()).toBe(0);
      expect(tree.root).toBeNull();
    });

    test("add creates root node", () => {
      const tree = new ConversationTree();
      const node = tree.add(null, "system", "You are a reef agent.");
      expect(tree.size()).toBe(1);
      expect(tree.root).toBe(node.id);
      expect(node.parentId).toBeNull();
      expect(node.role).toBe("system");
    });

    test("add creates child nodes", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Init.");
      const child = tree.add(root.id, "user", "Hello.");
      expect(child.parentId).toBe(root.id);
      expect(tree.size()).toBe(2);
    });

    test("addToRef advances the ref", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Init.");
      tree.setRef("main", root.id);

      const e1 = tree.addToRef("main", "event", "cron fired");
      expect(e1.parentId).toBe(root.id);
      expect(tree.getRef("main")).toBe(e1.id);

      const e2 = tree.addToRef("main", "event", "cron done");
      expect(e2.parentId).toBe(e1.id);
      expect(tree.getRef("main")).toBe(e2.id);
    });

    test("get retrieves node by ID", () => {
      const tree = new ConversationTree();
      const node = tree.add(null, "system", "Test.");
      expect(tree.get(node.id)).toBe(node);
      expect(tree.get("nonexistent")).toBeUndefined();
    });
  });

  describe("traversal", () => {
    test("ancestors walks to root", () => {
      const tree = new ConversationTree();
      const a = tree.add(null, "system", "Root.");
      const b = tree.add(a.id, "user", "Question.");
      const c = tree.add(b.id, "assistant", "Answer.");

      const path = tree.ancestors(c.id);
      expect(path.length).toBe(3);
      expect(path[0].id).toBe(a.id);
      expect(path[2].id).toBe(c.id);
    });

    test("children returns direct children", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Root.");
      const c1 = tree.add(root.id, "user", "A.");
      const _c2 = tree.add(root.id, "event", "B.");
      tree.add(c1.id, "assistant", "Response.");

      const kids = tree.children(root.id);
      expect(kids.length).toBe(2);
    });

    test("forking creates tree structure", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Root.");
      const userA = tree.add(root.id, "user", "Task A.");
      const userB = tree.add(root.id, "user", "Task B.");
      const respA = tree.add(userA.id, "assistant", "Done A.");
      const respB = tree.add(userB.id, "assistant", "Done B.");

      expect(tree.ancestors(respA.id).map((n) => n.content)).toEqual(["Root.", "Task A.", "Done A."]);
      expect(tree.ancestors(respB.id).map((n) => n.content)).toEqual(["Root.", "Task B.", "Done B."]);
      expect(tree.children(root.id).length).toBe(2);
    });
  });

  describe("context", () => {
    test("contextFor builds conversation string", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "You are an agent.");
      const user = tree.add(root.id, "user", "Hello.");
      const ctx = tree.contextFor(user.id);
      expect(ctx).toContain("[system] You are an agent.");
      expect(ctx).toContain("[user] Hello.");
    });

    test("contextFor includes events", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Init.");
      const evt = tree.add(root.id, "event", "cron fired", { eventType: "cron_start" });
      const ctx = tree.contextFor(evt.id);
      expect(ctx).toContain("[cron_start] cron fired");
    });
  });

  describe("tasks", () => {
    test("startTask creates user node and ref", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Init.");
      const userNode = tree.startTask("task-1", "Build a service.", root.id);
      expect(userNode.role).toBe("user");
      expect(userNode.parentId).toBe(root.id);
      expect(tree.getRef("task-1")).toBe(userNode.id);
      expect(tree.getTask("task-1")?.status).toBe("running");
    });

    test("completeTask marks done", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Init.");
      tree.startTask("t", "Work.", root.id);
      tree.completeTask("t", { summary: "Done.", filesChanged: ["a.ts"] });
      expect(tree.getTask("t")?.status).toBe("done");
      expect(tree.getTask("t")?.artifacts?.filesChanged).toEqual(["a.ts"]);
    });

    test("failTask marks error", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Init.");
      tree.startTask("t", "Work.", root.id);
      tree.failTask("t", "OOM");
      expect(tree.getTask("t")?.status).toBe("error");
      expect(tree.getTask("t")?.artifacts?.error).toBe("OOM");
    });

    test("continuation — reply to completed task", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Init.");
      const u1 = tree.startTask("t", "Hello.", root.id);
      const a1 = tree.add(u1.id, "assistant", "Hi!");
      tree.setRef("t", a1.id);
      tree.completeTask("t", { summary: "Hi!", filesChanged: [] });

      tree.reopenTask("t");
      const u2 = tree.add(a1.id, "user", "What is 2+2?");
      tree.setRef("t", u2.id);

      const path = tree.ancestors(u2.id);
      expect(path.map((n) => n.content)).toEqual(["Init.", "Hello.", "Hi!", "What is 2+2?"]);
    });

    test("activeTasks counts running", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Init.");
      tree.startTask("a", "A.", root.id);
      tree.startTask("b", "B.", root.id);
      tree.completeTask("a", { summary: "Done.", filesChanged: [] });
      expect(tree.activeTasks()).toBe(1);
    });
  });

  describe("serialization", () => {
    test("round-trip through JSON", () => {
      const tree = new ConversationTree();
      const root = tree.add(null, "system", "Init.");
      tree.setRef("main", root.id);
      tree.startTask("task-1", "Work.", root.id);
      tree.completeTask("task-1", { summary: "Done.", filesChanged: [] });

      const restored = ConversationTree.fromJSON(tree.toJSON());
      expect(restored.size()).toBe(2);
      expect(restored.root).toBe(root.id);
      expect(restored.getRef("main")).toBe(root.id);
      expect(restored.getTask("task-1")?.status).toBe("done");
    });

    test("fromJSON handles empty data", () => {
      const tree = ConversationTree.fromJSON({});
      expect(tree.size()).toBe(0);
      expect(tree.root).toBeNull();
    });

    test("round-trip preserves archivedTasks", () => {
      const tree = new ConversationTree();
      tree.add(null, "system", "Init.");
      // Manually mark a task as archived for serialization test
      (tree as any).archivedTasks.add("old-task");
      const restored = ConversationTree.fromJSON(tree.toJSON());
      expect(restored.isArchived("old-task")).toBe(true);
    });
  });

  describe("archive", () => {
    afterAll(() => {
      if (existsSync(ARCHIVE_TEST_DIR)) rmSync(ARCHIVE_TEST_DIR, { recursive: true });
    });

    function makeTree(): ConversationTree {
      if (existsSync(ARCHIVE_TEST_DIR)) rmSync(ARCHIVE_TEST_DIR, { recursive: true });
      mkdirSync(ARCHIVE_TEST_DIR, { recursive: true });
      const tree = new ConversationTree();
      tree.persist(`${ARCHIVE_TEST_DIR}/tree.json`);
      return tree;
    }

    test("archiveTask moves subtree to disk", () => {
      const tree = makeTree();
      const root = tree.add(null, "system", "Init.");
      const u = tree.startTask("t1", "Do something.", root.id);
      const tool = tree.add(u.id, "tool_call", "bash", { toolName: "bash" });
      const result = tree.add(tool.id, "tool_result", "ok");
      const asst = tree.add(u.id, "assistant", "Done.");
      tree.setRef("t1", asst.id);
      tree.completeTask("t1", { summary: "Done.", filesChanged: [] });

      const sizeBefore = tree.size();
      expect(tree.archiveTask("t1")).toBe(true);

      // Subtree nodes removed (tool, result, assistant) but user node kept
      expect(tree.size()).toBe(sizeBefore - 3); // tool, result, assistant gone
      expect(tree.get(u.id)).toBeTruthy(); // user node stays
      expect(tree.get(tool.id)).toBeUndefined();
      expect(tree.get(result.id)).toBeUndefined();
      expect(tree.get(asst.id)).toBeUndefined();
      expect(tree.isArchived("t1")).toBe(true);
    });

    test("restoreTask brings subtree back", () => {
      const tree = makeTree();
      const root = tree.add(null, "system", "Init.");
      const u = tree.startTask("t2", "Work.", root.id);
      const asst = tree.add(u.id, "assistant", "Result.");
      tree.setRef("t2", asst.id);
      tree.completeTask("t2", { summary: "Result.", filesChanged: [] });

      tree.archiveTask("t2");
      expect(tree.get(asst.id)).toBeUndefined();

      expect(tree.restoreTask("t2")).toBe(true);
      expect(tree.get(asst.id)).toBeTruthy();
      expect(tree.get(asst.id)!.content).toBe("Result.");
      expect(tree.isArchived("t2")).toBe(false);
    });

    test("restored subtree has correct parent-child links", () => {
      const tree = makeTree();
      const root = tree.add(null, "system", "Init.");
      const u = tree.startTask("t3", "Build.", root.id);
      const a = tree.add(u.id, "assistant", "Built.");
      tree.setRef("t3", a.id);
      tree.completeTask("t3", { summary: "Built.", filesChanged: [] });

      tree.archiveTask("t3");
      tree.restoreTask("t3");

      // Children of user node should be back
      const kids = tree.children(u.id);
      expect(kids.length).toBe(1);
      expect(kids[0].id).toBe(a.id);

      // Ancestors from assistant should walk back to root
      const path = tree.ancestors(a.id);
      expect(path.map((n) => n.role)).toEqual(["system", "user", "assistant"]);
    });

    test("archiveTask refuses running tasks", () => {
      const tree = makeTree();
      const root = tree.add(null, "system", "Init.");
      tree.startTask("running", "Still going.", root.id);
      expect(tree.archiveTask("running")).toBe(false);
    });

    test("archiveTask returns false without persist", () => {
      const tree = new ConversationTree(); // no persist()
      const root = tree.add(null, "system", "Init.");
      tree.startTask("t", "Work.", root.id);
      tree.completeTask("t", { summary: "Done.", filesChanged: [] });
      expect(tree.archiveTask("t")).toBe(false);
    });

    test("restoreTask returns false for non-archived", () => {
      const tree = makeTree();
      expect(tree.restoreTask("nonexistent")).toBe(false);
    });

    test("pruneToLimit archives oldest completed tasks", () => {
      const tree = makeTree();
      tree.hotLimit = 2;
      const root = tree.add(null, "system", "Init.");

      // Create 4 completed tasks
      for (let i = 0; i < 4; i++) {
        const u = tree.startTask(`task-${i}`, `Task ${i}.`, root.id);
        const a = tree.add(u.id, "assistant", `Done ${i}.`);
        tree.setRef(`task-${i}`, a.id);
        tree.completeTask(`task-${i}`, { summary: `Done ${i}.`, filesChanged: [] });
      }

      const archived = tree.pruneToLimit();
      expect(archived).toBe(2); // 4 completed - 2 hotLimit = 2 archived
      expect(tree.isArchived("task-0")).toBe(true);
      expect(tree.isArchived("task-1")).toBe(true);
      expect(tree.isArchived("task-2")).toBe(false);
      expect(tree.isArchived("task-3")).toBe(false);
    });

    test("pruneToLimit skips running tasks", () => {
      const tree = makeTree();
      tree.hotLimit = 0;
      const root = tree.add(null, "system", "Init.");

      tree.startTask("running", "In progress.", root.id);
      const u = tree.startTask("done", "Finished.", root.id);
      tree.add(u.id, "assistant", "Result.");
      tree.completeTask("done", { summary: "Result.", filesChanged: [] });

      const archived = tree.pruneToLimit();
      expect(archived).toBe(1);
      expect(tree.isArchived("done")).toBe(true);
      expect(tree.isArchived("running")).toBe(false);
    });

    test("contextFor still works after archive+restore", () => {
      const tree = makeTree();
      const root = tree.add(null, "system", "You are reef.");
      const u = tree.startTask("ctx-test", "Hello.", root.id);
      const a = tree.add(u.id, "assistant", "Hi there.");
      tree.setRef("ctx-test", a.id);
      tree.completeTask("ctx-test", { summary: "Hi.", filesChanged: [] });

      tree.archiveTask("ctx-test");
      tree.restoreTask("ctx-test");

      const ctx = tree.contextFor(a.id);
      expect(ctx).toContain("[system] You are reef.");
      expect(ctx).toContain("[user] Hello.");
      expect(ctx).toContain("[assistant] Hi there.");
    });
  });
});
