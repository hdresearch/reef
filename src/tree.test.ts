import { describe, expect, test } from "bun:test";
import { ConversationTree } from "./tree.js";

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
  });
});
